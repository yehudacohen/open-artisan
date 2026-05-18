/**
 * task-boundary-tools.ts - OpenCode task-boundary repair tool definitions.
 */

import type { ToolContext } from "@opencode-ai/plugin"
import type { NotificationSink } from "../../../packages/core/logger"
import { AnalyzeTaskBoundaryChangeSchema, ApplyTaskBoundaryChangeSchema, formatZodError } from "../../../packages/core/schemas"
import { ensureState } from "../../../packages/core/tool-runtime"
import type { AnalyzeTaskBoundaryChangeArgs, ApplyTaskBoundaryChangeArgs } from "../../../packages/core/tool-types"
import { analyzeTaskBoundaryChange, applyTaskBoundaryChange } from "../../../packages/core/tools/transitions"
import { resolveSessionId } from "../../../packages/core/utils"
import type { SessionStateStore } from "../../../packages/core/workflow-state-types"

type ToolExecuteContext = ToolContext & { sessionId?: string; session_id?: string; session?: { id: string }; [key: string]: unknown }

export function createTaskBoundaryTools(
  tool: any,
  ctx: { store: SessionStateStore; notify?: NotificationSink; projectRoot: string },
) {
  return {
    analyze_task_boundary_change: tool({
      description:
        "Analyze a proposed DAG task-boundary change during IMPLEMENTATION. " +
        "Reports impacted tasks, ownership conflicts, and completed-task impacts that must be handled with future corrective work.",
      args: {
        task_id: tool.schema.string().describe("The DAG task whose boundary is being revised."),
        add_files: tool.schema.array(tool.schema.string()).optional().describe("File paths to add to the task's owned files."),
        remove_files: tool.schema.array(tool.schema.string()).optional().describe("File paths to remove from the task's owned files."),
        add_expected_tests: tool.schema.array(tool.schema.string()).optional().describe("Expected tests to add to the task."),
        remove_expected_tests: tool.schema.array(tool.schema.string()).optional().describe("Expected tests to remove from the task."),
        reason: tool.schema.string().describe("Why the boundary change is needed."),
      },
      async execute(
        args: { task_id: string; add_files?: string[]; remove_files?: string[]; add_expected_tests?: string[]; remove_expected_tests?: string[]; reason: string },
        context: ToolExecuteContext,
      ) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        const state = await ensureState(ctx.store, sessionId, ctx.notify)
        const parsedArgs = AnalyzeTaskBoundaryChangeSchema.safeParse(args)
        if (!parsedArgs.success) return `Error: ${formatZodError(parsedArgs.error)}`
        const result = analyzeTaskBoundaryChange(parsedArgs.data as AnalyzeTaskBoundaryChangeArgs, state, context.directory || ctx.projectRoot)
        if (!result.success) return `Error: ${result.error.message}`
        const { analysis } = result
        const conflictMessages = analysis.conflicts.map((conflict) => conflict.message)
        return (
          `Task boundary analysis for ${analysis.taskId}.\n` +
          `Impacted tasks: ${analysis.impactedTaskIds.join(", ")}.\n` +
          `${analysis.completedTaskIdsToReset.length > 0 ? `completed task(s) requiring future corrective work: ${analysis.completedTaskIdsToReset.join(", ")}.\n` : ""}` +
          `${conflictMessages.length > 0 ? `Conflicts: ${conflictMessages.join(" | ")}.\n` : ""}` +
          `Overlapping owned files: ${analysis.overlappingOwnedFiles.join(", ") || "(none)"}.\n` +
          `Overlapping expected tests: ${analysis.overlappingExpectedTests.join(", ") || "(none)"}.\n` +
          `Next add files: ${analysis.addFiles.join(", ") || "(none)"}.\n` +
          `Next remove files: ${analysis.removeFiles.join(", ") || "(none)"}.\n` +
          `Next add expected tests: ${analysis.addExpectedTests.join(", ") || "(none)"}.\n` +
          `Next remove expected tests: ${analysis.removeExpectedTests.join(", ") || "(none)"}.`
        )
      },
    }),

    apply_task_boundary_change: tool({
      description:
        "Apply an approved DAG task-boundary change during IMPLEMENTATION. " +
        "Reassigns overlapping ownership for unfinished tasks and rejects completed-task resets so forward corrective tasks can be planned explicitly.",
      args: {
        task_id: tool.schema.string().describe("The DAG task whose boundary is being revised."),
        add_files: tool.schema.array(tool.schema.string()).optional().describe("File paths to add to the task's owned files."),
        remove_files: tool.schema.array(tool.schema.string()).optional().describe("File paths to remove from the task's owned files."),
        add_expected_tests: tool.schema.array(tool.schema.string()).optional().describe("Expected tests to add to the task."),
        remove_expected_tests: tool.schema.array(tool.schema.string()).optional().describe("Expected tests to remove from the task."),
        expected_impacted_tasks: tool.schema.array(tool.schema.string()).optional().describe("Explicit acknowledgement of the impacted tasks returned by analysis."),
        expected_reset_tasks: tool.schema.array(tool.schema.string()).optional().describe("Legacy acknowledgement field; completed-task resets are rejected and must be handled by future corrective tasks."),
        reason: tool.schema.string().describe("Why the boundary change is needed."),
      },
      async execute(
        args: { task_id: string; add_files?: string[]; remove_files?: string[]; add_expected_tests?: string[]; remove_expected_tests?: string[]; expected_impacted_tasks?: string[]; expected_reset_tasks?: string[]; reason: string },
        context: ToolExecuteContext,
      ) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        const state = await ensureState(ctx.store, sessionId, ctx.notify)
        const parsedArgs = ApplyTaskBoundaryChangeSchema.safeParse(args)
        if (!parsedArgs.success) return `Error: ${formatZodError(parsedArgs.error)}`
        const result = applyTaskBoundaryChange(parsedArgs.data as ApplyTaskBoundaryChangeArgs, state, context.directory || ctx.projectRoot)
        if (!result.success) return `Error: ${result.error.message}`

        await ctx.store.update(sessionId, (draft) => {
          draft.implDag = result.updatedNodes
          draft.currentTaskId = args.task_id
          draft.phase = "IMPLEMENTATION"
          draft.phaseState = "DRAFT"
          draft.taskCompletionInProgress = null
          draft.taskReviewCount = 0
          draft.reviewArtifactHash = null
          draft.reviewArtifactFiles = []
          draft.latestReviewResults = null
        })

        return result.message
      },
    }),
  }
}
