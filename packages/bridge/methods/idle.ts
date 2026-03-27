/**
 * idle.ts — Bridge idle check method.
 *
 * idle.check: Returns the idle decision for a session (reprompt/escalate/ignore).
 *             The adapter acts on the decision by sending the message to the LLM.
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler } from "../server"
import type { IdleCheckParams, IdleCheckResult } from "../protocol"
import { SESSION_NOT_FOUND, INVALID_PARAMS } from "../protocol"
import { handleIdle } from "../../core/hooks/idle-handler"

export const handleIdleCheck: MethodHandler = async (params, ctx) => {
  const p = params as IdleCheckParams
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const state = ctx.engine!.store.get(p.sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${p.sessionId}" not found`, SESSION_NOT_FOUND)
  }

  const decision = handleIdle(state)

  if (decision.action === "ignore") {
    return { action: "ignore" } satisfies IdleCheckResult
  }

  if (decision.action === "reprompt") {
    // Persist the incremented retryCount so escalation eventually triggers
    await ctx.engine!.store.update(p.sessionId, (draft) => {
      draft.retryCount = decision.retryCount
    })
    return {
      action: "reprompt",
      message: decision.message,
      retryCount: decision.retryCount,
    } satisfies IdleCheckResult
  }

  // Escalation — reset retryCount so the agent gets fresh attempts after user input
  await ctx.engine!.store.update(p.sessionId, (draft) => {
    draft.retryCount = 0
  })
  return { action: "escalate", message: decision.message } satisfies IdleCheckResult
}
