/**
 * opencode-patch-suggestion-tools.ts - OpenCode patch suggestion tool definitions.
 */

import type { ToolContext } from "@opencode-ai/plugin"
import {
  handleApplyPatchSuggestion,
  handleResolvePatchSuggestion,
  handleRoutePatchSuggestions,
} from "../../../packages/bridge/methods/patch-suggestion-tool-handlers"
import type { BridgeContext } from "../../../packages/bridge/server"
import { resolveSessionId } from "../../../packages/core/utils"

type ToolExecuteContext = ToolContext & { sessionId?: string; session_id?: string; session?: { id: string }; [key: string]: unknown }

export function createOpenCodePatchSuggestionTools(
  tool: any,
  ctx: { projectRoot: string; bridgeCtx: BridgeContext },
) {
  function requireSessionState(sessionId: string): string | null {
    return ctx.bridgeCtx.engine?.store.get(sessionId) ? null : "Error: No workflow state for this session."
  }

  return {
    route_patch_suggestions: tool({
      description: "List pending reviewer patch suggestions and classify whether to apply now, defer, backtrack, or ask the user.",
      args: {},
      async execute(args: Record<string, never>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        if (ctx.bridgeCtx.openArtisanServices) {
          const stateError = requireSessionState(sessionId)
          if (stateError) return stateError
        }
        return handleRoutePatchSuggestions(args, { sessionId, directory: context.directory || ctx.projectRoot }, ctx.bridgeCtx)
      },
    }),

    resolve_patch_suggestion: tool({
      description: "Record the disposition of a persisted reviewer patch suggestion after applying, deferring, rejecting, or escalating it.",
      args: {
        patch_suggestion_id: tool.schema.string().describe("The patch suggestion id to resolve."),
        resolution: tool.schema.string().describe("One of: applied, failed, deferred, rejected, escalated."),
        message: tool.schema.string().optional().describe("Optional resolution detail."),
        applied_by: tool.schema.string().optional().describe("agent, orchestrator, or user."),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context) ?? ""
        return handleResolvePatchSuggestion(args, { sessionId, directory: context.directory || ctx.projectRoot }, ctx.bridgeCtx)
      },
    }),

    apply_patch_suggestion: tool({
      description: "Apply a pending reviewer patch suggestion to the worktree and record the DB application result.",
      args: {
        patch_suggestion_id: tool.schema.string().describe("The patch suggestion id to apply."),
        force: tool.schema.boolean().optional().describe("Apply even if routing says defer/backtrack/ask-user. Use only after user approval."),
        applied_by: tool.schema.string().optional().describe("agent, orchestrator, or user."),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        if (ctx.bridgeCtx.openArtisanServices) {
          const stateError = requireSessionState(sessionId)
          if (stateError) return stateError
        }
        return handleApplyPatchSuggestion(args, { sessionId, directory: context.directory || ctx.projectRoot }, ctx.bridgeCtx)
      },
    }),
  }
}
