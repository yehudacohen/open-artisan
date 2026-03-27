/**
 * prompt.ts — Bridge prompt building methods.
 *
 * prompt.build:      Build the workflow system prompt for a session.
 * prompt.compaction: Build compaction preservation context for a session.
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler } from "../server"
import type { PromptBuildParams } from "../protocol"
import { SESSION_NOT_FOUND, INVALID_PARAMS } from "../protocol"
import { buildWorkflowSystemPrompt, buildSubagentContext } from "../../core/hooks/system-transform"
import { buildCompactionContext } from "../../core/hooks/compaction"

export const handlePromptBuild: MethodHandler = async (params, ctx) => {
  const p = params as PromptBuildParams
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const { store, sessions } = ctx.engine!

  // Child session handling: ephemeral children get parent's subagent context,
  // sub-workflow children get their own workflow prompt.
  const parentId = sessions.getParent(p.sessionId)
  if (parentId) {
    const childState = store.get(p.sessionId)
    if (!childState) {
      // Ephemeral child — return parent's subagent context
      const parentState = store.get(parentId)
      if (!parentState) return null
      return buildSubagentContext(parentState)
    }
    // Sub-workflow child — fall through to build its own prompt
  }

  const state = store.get(p.sessionId)
  if (!state) return null

  return buildWorkflowSystemPrompt(state)
}

export const handlePromptCompaction: MethodHandler = async (params, ctx) => {
  const p = params as PromptBuildParams
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const state = ctx.engine!.store.get(p.sessionId)
  if (!state) return null

  return buildCompactionContext(state)
}
