/**
 * state.ts — Bridge state inspection method.
 *
 * state.get: Returns the WorkflowState for a session (or null if not found).
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler } from "../server"
import { INVALID_PARAMS } from "../protocol"
import type { StateGetParams } from "../protocol"

export const handleStateGet: MethodHandler = async (params, ctx) => {
  const p = params as Partial<StateGetParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const state = ctx.engine!.store.get(p.sessionId)
  // Return a deep copy for serialization safety
  return state ? structuredClone(state) : null
}
