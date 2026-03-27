/**
 * opencode-subagent-dispatcher.ts — OpenCode-specific implementation of SubagentDispatcher.
 *
 * Wraps the OpenCode client.session.{create, prompt, delete} API with:
 *   - Session ID extraction from the SDK response envelope
 *   - Text extraction from prompt result parts
 *   - Model format normalization (string → { modelID } object)
 *   - Conditional cleanup (skip delete when parentId is set — parent session owns the child)
 *
 * This is the only file that imports PluginClient. All core modules use SubagentDispatcher.
 */

import type { PluginClient } from "./client-types"
import type { SubagentDispatcher, SubagentSession, SubagentCreateOptions } from "../../../packages/core/subagent-dispatcher"
import { extractEphemeralSessionId, extractTextFromPromptResult } from "../../../packages/core/utils"

export function createOpenCodeSubagentDispatcher(client: PluginClient): SubagentDispatcher {
  return {
    async createSession(opts: SubagentCreateOptions): Promise<SubagentSession> {
      if (!client.session) {
        throw new Error("client.session is not available — cannot dispatch subagent")
      }

      // Normalize model format: string → { modelID } for the SDK
      const modelConfig = typeof opts.model === "string"
        ? { modelID: opts.model }
        : opts.model

      const created = await client.session.create({
        body: {
          title: opts.title,
          agent: opts.agent,
          ...(opts.parentId ? { parentID: opts.parentId } : {}),
          ...(modelConfig ? { model: modelConfig } : {}),
        },
      })

      const sessionId = extractEphemeralSessionId(created, opts.title)
      const hasParent = !!opts.parentId

      return {
        id: sessionId,

        async prompt(text: string): Promise<string> {
          // Generate a unique part ID with "prt" prefix — required by the OpenCode API
          const partId = `prt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          const result = await client.session!.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: "text", text, id: partId }],
            },
          })
          return extractTextFromPromptResult(result, opts.title)
        },

        async destroy(): Promise<void> {
          // Skip cleanup when session has a parent — parent session owns the lifecycle.
          // This matches the existing behavior in all 7 subagent modules.
          if (hasParent) return
          try {
            await client.session!.delete({ path: { id: sessionId } })
          } catch {
            // Best-effort — ignore cleanup errors
          }
        },
      }
    },
  }
}
