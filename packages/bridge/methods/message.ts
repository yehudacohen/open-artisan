/**
 * message.ts — Bridge message processing method.
 *
 * message.process: Process a user message, inject routing hints at USER_GATE.
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler } from "../server"
import type { MessageProcessParams, MessageProcessResult } from "../protocol"
import { SESSION_NOT_FOUND, INVALID_PARAMS } from "../protocol"
import { processUserMessage } from "../../core/hooks/chat-message"

export const handleMessageProcess: MethodHandler = async (params, ctx) => {
  const p = params as MessageProcessParams
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  if (!Array.isArray(p.parts)) {
    throw new JSONRPCErrorException("parts must be an array", INVALID_PARAMS)
  }

  const { store } = ctx.engine!
  const state = store.get(p.sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${p.sessionId}" not found`, SESSION_NOT_FOUND)
  }

  const result = processUserMessage(state, p.parts)

  // If the message was intercepted (user at USER_GATE), mark that a real
  // user message was received (prevents agent from self-approving).
  if (result.intercepted) {
    await store.update(p.sessionId, (draft) => {
      draft.userGateMessageReceived = true
    })

    // Capture intent baseline from the first user message
    if (!state.intentBaseline) {
      const textContent = p.parts
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text!)
        .join(" ")
        .trim()
      if (textContent) {
        await store.update(p.sessionId, (draft) => {
          if (!draft.intentBaseline) {
            draft.intentBaseline = textContent.slice(0, 2000)
          }
        })
      }
    }
  }

  return {
    parts: result.parts,
    intercepted: result.intercepted,
  } satisfies MessageProcessResult
}
