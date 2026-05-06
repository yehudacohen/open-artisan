/**
 * query-workflow-tools.ts - OpenCode query_parent/query_child tool definitions.
 */

import type { SessionStateStore } from "../../../packages/core/workflow-state-types"
import {
  processQueryChildWorkflow,
  processQueryParentWorkflow,
  QUERY_CHILD_WORKFLOW_DESCRIPTION,
  QUERY_PARENT_WORKFLOW_DESCRIPTION,
} from "../../../packages/core/tools/query-workflow"
import { resolveSessionId } from "../../../packages/core/utils"
import type { ToolExecuteContext } from "./client-types"

export function createQueryWorkflowTools(tool: any, ctx: { store: SessionStateStore }) {
  return {
    query_parent_workflow: tool({
      description: QUERY_PARENT_WORKFLOW_DESCRIPTION,
      args: {},
      async execute(
        _args: Record<string, never>,
        context: ToolExecuteContext,
      ) {
        const { store } = ctx
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."

        const state = store.get(sessionId)
        if (!state) return "Error: No workflow state for this session."

        const parentState = state.parentWorkflow
          ? store.findByFeatureName(state.parentWorkflow.featureName)
          : null
        const result = processQueryParentWorkflow(state, parentState)
        if (result.error) return `Error: ${result.error}`

        const lines: string[] = [
          `## Parent Workflow: ${result.parentFeatureName}`,
          "",
          `**Phase:** ${result.phase}/${result.phaseState}`,
          `**Mode:** ${result.mode ?? "not set"}`,
        ]
        if (result.intentBaseline) {
          lines.push(`**Intent:** ${result.intentBaseline}`)
        }
        if (result.conventions) {
          lines.push("", "### Conventions", "", result.conventions)
        }
        if (result.artifactDiskPaths && Object.keys(result.artifactDiskPaths).length > 0) {
          lines.push("", "### Artifact Paths")
          for (const [key, path] of Object.entries(result.artifactDiskPaths)) {
            lines.push(`- **${key}:** ${path}`)
          }
        }
        return lines.join("\n")
      },
    }),

    query_child_workflow: tool({
      description: QUERY_CHILD_WORKFLOW_DESCRIPTION,
      args: {
        task_id: tool.schema.string().describe(
          "The DAG task ID that was delegated to the child sub-workflow.",
        ),
      },
      async execute(
        args: { task_id: string },
        context: ToolExecuteContext,
      ) {
        const { store } = ctx
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."

        const state = store.get(sessionId)
        if (!state) return "Error: No workflow state for this session."

        const childEntry = state.childWorkflows.find((c) => c.taskId === args.task_id)
        const childState = childEntry
          ? store.findByFeatureName(childEntry.featureName)
          : null
        const result = processQueryChildWorkflow(state, args.task_id, childState)
        if (result.error) return `Error: ${result.error}`

        const taskDesc = state.implDag?.find((t) => t.id === args.task_id)?.description
        const lines: string[] = [
          `## Child Workflow: ${result.childFeatureName}`,
          "",
          `**Delegated task:** ${result.taskId}${taskDesc ? ` - ${taskDesc}` : ""}`,
          `**Child status:** ${result.childStatus}`,
        ]
        if (result.phase) {
          lines.push(`**Phase:** ${result.phase}/${result.phaseState}`)
          lines.push(`**Mode:** ${result.mode ?? "not set"}`)
          if (result.currentTaskId) {
            lines.push(`**Current task:** ${result.currentTaskId}`)
          }
          if (result.implDagProgress) {
            const p = result.implDagProgress
            lines.push(`**DAG progress:** ${p.complete}/${p.total} complete${p.delegated > 0 ? `, ${p.delegated} delegated` : ""}`)
          }
        } else {
          lines.push("", "_Child workflow state not yet available (may not have started)._")
        }
        return lines.join("\n")
      },
    }),
  }
}
