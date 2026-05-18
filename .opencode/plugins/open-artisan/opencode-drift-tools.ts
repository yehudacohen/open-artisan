/**
 * opencode-drift-tools.ts - OpenCode drift-report/repair tool definitions.
 */

import type { ToolContext } from "@opencode-ai/plugin"
import { createDriftToolHandlers } from "../../../packages/bridge/methods/drift-tool-handlers"
import type { BridgeContext } from "../../../packages/bridge/server"
import type { DriftToolCallPlan } from "../../../packages/core/drift"
import { resolveSessionId } from "../../../packages/core/utils"

type ToolExecuteContext = ToolContext & { sessionId?: string; session_id?: string; session?: { id: string }; [key: string]: unknown }

export function createOpenCodeDriftTools(
  tool: any,
  ctx: {
    projectRoot: string
    bridgeCtx: BridgeContext
    executeToolCall(toolCall: DriftToolCallPlan, sessionId: string, context: ToolExecuteContext): Promise<string>
  },
) {
  const handlers = createDriftToolHandlers((toolCall, toolCtx) =>
    ctx.executeToolCall(toolCall, toolCtx.sessionId, {
      sessionId: toolCtx.sessionId,
      directory: toolCtx.directory,
    } as ToolExecuteContext),
  )

  return {
    report_drift: tool({
      description: "Report workflow drift using artifact, task, worktree, DB, and changed-file signals.",
      args: {
        scope: tool.schema.string().optional().describe("current-task, current-phase, workflow, or roadmap."),
        include_worktree: tool.schema.boolean().optional(),
        include_artifacts: tool.schema.boolean().optional(),
        include_db: tool.schema.boolean().optional(),
        changed_files: tool.schema.array(tool.schema.string()).optional(),
        drifted_artifact_keys: tool.schema.array(tool.schema.string()).optional(),
        task_ids: tool.schema.array(tool.schema.string()).optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        if (!ctx.bridgeCtx.engine?.store.get(sessionId)) return "Error: No workflow state for this session."
        return handlers.handleReportDrift(args, { sessionId, directory: context.directory || ctx.projectRoot }, ctx.bridgeCtx)
      },
    }),

    plan_drift_repair: tool({
      description: "Build a graph-native repair plan for a reported drift report.",
      args: {
        drift_report_id: tool.schema.string().optional(),
        strategy: tool.schema.string().optional().describe("minimal, safe-auto, or ask-first."),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        return handlers.handlePlanDriftRepair(args, { sessionId, directory: context.directory || ctx.projectRoot }, ctx.bridgeCtx)
      },
    }),

    apply_drift_repair: tool({
      description: "Apply approved drift repair actions through existing workflow tools.",
      args: {
        repair_plan_id: tool.schema.string(),
        approved_actions: tool.schema.array(tool.schema.string()).optional(),
        apply_safe_actions: tool.schema.boolean().optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        return handlers.handleApplyDriftRepair(args, { sessionId, directory: context.directory || ctx.projectRoot }, ctx.bridgeCtx)
      },
    }),
  }
}
