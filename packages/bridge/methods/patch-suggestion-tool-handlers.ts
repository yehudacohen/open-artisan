import { createHash } from "node:crypto"
import { JSONRPCErrorException } from "json-rpc-2.0"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import { ApplyPatchSuggestionSchema, ResolvePatchSuggestionSchema } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import { workflowDbId } from "../../core/runtime-persistence"
import { routePatchSuggestions } from "../../core/patch-suggestion-routing"
import { applyPatchSuggestionToWorktree } from "../../core/patch-suggestion-application"
import type { ToolHandler } from "./tool-handler-types"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

export const handleRoutePatchSuggestions: ToolHandler = async (_args, toolCtx, ctx) => {
  if (!ctx.openArtisanServices) return "Error: DB-backed patch suggestion services are not enabled."
  const state = requireState(ctx, toolCtx.sessionId)
  const workflowId = workflowDbId(state)
  const suggestions = await ctx.openArtisanServices.patchSuggestions.listSuggestions(workflowId, "pending")
  if (!suggestions.ok) return `Error: ${suggestions.error.message}`
  return JSON.stringify({ ok: true, value: routePatchSuggestions(state, suggestions.value) }, null, 2)
}

export const handleResolvePatchSuggestion: ToolHandler = async (args, _toolCtx, ctx) => {
  if (!ctx.openArtisanServices) return "Error: DB-backed patch suggestion services are not enabled."
  const parsedArgs = parseToolArgs(ResolvePatchSuggestionSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const { patch_suggestion_id: suggestionId, resolution } = parsedArgs.data
  const message = parsedArgs.data.message ?? ""
  const now = new Date().toISOString()
  if (resolution === "applied" || resolution === "failed") {
    const applied = await ctx.openArtisanServices.patchSuggestions.applySuggestion({
      id: stableId(suggestionId, resolution, now),
      patchSuggestionId: suggestionId,
      appliedBy: parsedArgs.data.applied_by ?? "agent",
      result: resolution,
      ...(message ? { message } : {}),
      createdAt: now,
    })
    if (!applied.ok) return `Error: ${applied.error.message}`
    return JSON.stringify({ ok: true, value: applied.value }, null, 2)
  }
  const status = resolution === "escalated" ? "escalated" : resolution === "deferred" ? "deferred" : "rejected"
  const updated = await ctx.openArtisanServices.patchSuggestions.updateStatus(suggestionId, status, now)
  if (!updated.ok) return `Error: ${updated.error.message}`
  return JSON.stringify({ ok: true, value: updated.value }, null, 2)
}

export const handleApplyPatchSuggestion: ToolHandler = async (args, toolCtx, ctx) => {
  if (!ctx.openArtisanServices) return "Error: DB-backed patch suggestion services are not enabled."
  const parsedArgs = parseToolArgs(ApplyPatchSuggestionSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const state = requireState(ctx, toolCtx.sessionId)
  const result = await applyPatchSuggestionToWorktree({
    services: ctx.openArtisanServices,
    state,
    cwd: toolCtx.directory,
    patchSuggestionId: parsedArgs.data.patch_suggestion_id,
    appliedBy: parsedArgs.data.applied_by ?? "agent",
    ...(parsedArgs.data.force === undefined ? {} : { force: parsedArgs.data.force }),
  })
  return JSON.stringify(result, null, 2)
}
