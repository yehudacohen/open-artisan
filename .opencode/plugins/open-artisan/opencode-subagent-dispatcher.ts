/**
 * opencode-subagent-dispatcher.ts — OpenCode-specific implementation of SubagentDispatcher.
 *
 * Wraps the OpenCode client.session.{create, prompt, delete} API with:
 *   - Session ID extraction from the SDK response envelope
 *   - Text extraction from prompt result parts
 *   - Model routing on session.prompt() when OpenCode provides a full provider/model pair
 *   - Conditional cleanup (skip delete when parentId is set — parent session owns the child)
 *
 * This is the only file that imports OpencodeClient. All core modules use SubagentDispatcher.
 */

import type { SubagentDispatcher, SubagentSession, SubagentCreateOptions, SubagentPromptOptions } from "../../../packages/core/subagent-dispatcher"
import { extractEphemeralSessionId, extractTextFromPromptResult } from "../../../packages/core/utils"
import type { OpencodeClient } from "@opencode-ai/sdk"

const WORKFLOW_TOOL_DENYLIST: Record<string, false> = {
  check_prior_workflow: false,
  select_mode: false,
  mark_scan_complete: false,
  mark_analyze_complete: false,
  mark_satisfied: false,
  mark_task_complete: false,
  resolve_human_gate: false,
  request_review: false,
  submit_feedback: false,
  propose_backtrack: false,
  spawn_sub_workflow: false,
  query_parent_workflow: false,
  query_child_workflow: false,
}

function hasCreateError(response: unknown): boolean {
  return !!response && typeof response === "object" && "error" in response
}

function summarizeResponse(response: unknown): string {
  try {
    return JSON.stringify(response).slice(0, 1000)
  } catch {
    return String(response)
  }
}

function extractMessageId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null
  const data = ((response as Record<string, unknown>)["data"] ?? response) as Record<string, unknown>
  const info = data["info"] as Record<string, unknown> | undefined
  return typeof info?.["id"] === "string" ? info["id"] : null
}

type NormalizedMessage = {
  id: string | null
  role: string | null
  text: string | null
}

function unwrapData(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) return (value as Record<string, unknown>)["data"]
  return value
}

function extractTextFromParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    const record = part as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) return record.text
    if (typeof record.text === "string" && record.text.trim()) return record.text
    if (typeof record.content === "string" && record.content.trim()) return record.content
  }
  return null
}

function normalizeMessage(value: unknown): NormalizedMessage | null {
  const unwrapped = unwrapData(value)
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return null
  const record = unwrapped as Record<string, unknown>
  const info = (record.info && typeof record.info === "object" ? record.info : record) as Record<string, unknown>
  const id = typeof info.id === "string" ? info.id : null
  const role = typeof info.role === "string" ? info.role : null
  const text = extractTextFromParts(record.parts)
  if (!id && !role && !text) return null
  return { id, role, text }
}

function normalizeMessages(value: unknown): NormalizedMessage[] {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) return unwrapped.flatMap((item) => normalizeMessages(item))
  const message = normalizeMessage(unwrapped)
  return message ? [message] : []
}

function selectAssistantText(value: unknown, messageId: string): string | null {
  const messages = normalizeMessages(value)
  const target = messages.find((message) => message.id === messageId && message.text)
  if (target?.text) return target.text
  const latestAssistant = messages.slice().reverse().find((message) => message.role === "assistant" && message.text)
  return latestAssistant?.text ?? null
}

function selectDirectMessageText(value: unknown, messageId: string): string | null {
  const messages = normalizeMessages(value)
  const target = messages.find((message) => message.id === messageId && message.text)
  if (target?.text) return target.text
  if (messages.length === 1 && messages[0]?.text) return messages[0].text
  return selectAssistantText(value, messageId)
}

async function fetchPromptMessageText(client: OpencodeClient, sessionId: string, messageId: string): Promise<string | null> {
  if (typeof client.session?.message === "function") {
    const result = await client.session.message({ path: { id: sessionId, messageID: messageId } })
    const text = selectDirectMessageText(result, messageId)
    if (text) return text
  }

  if (typeof client.session?.messages === "function") {
    const history = await client.session.messages({ path: { id: sessionId }, query: { limit: 20 } })
    return selectAssistantText(history, messageId)
  }

  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createOpenCodeSubagentDispatcher(client: OpencodeClient): SubagentDispatcher {
  return {
    async createSession(opts: SubagentCreateOptions): Promise<SubagentSession> {
      if (!client.session) {
        throw new Error("client.session is not available — cannot dispatch subagent")
      }

      const modelConfig = typeof opts.model === "object" && opts.model.modelID && opts.model.providerID
        ? { providerID: opts.model.providerID, modelID: opts.model.modelID }
        : undefined

      const createAttempts = [
        {
          body: {
            title: opts.title,
            ...(opts.parentId ? { parentID: opts.parentId } : {}),
          },
          hasParent: !!opts.parentId,
        },
        ...(opts.parentId ? [{
          body: { title: opts.title },
          hasParent: false,
        }] : []),
      ]

      let created: unknown = null
      let hasParent = false
      const errors: string[] = []
      for (const attempt of createAttempts) {
        try {
          const response = await client.session.create(attempt)
          if (hasCreateError(response)) {
            errors.push(summarizeResponse(response))
            continue
          }
          created = response
          hasParent = attempt.hasParent
          break
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }

      if (!created) {
        throw new Error(`${opts.title}: session.create failed: ${errors.join(" | ") || "unknown error"}`)
      }

      const sessionId = extractEphemeralSessionId(created, opts.title)

      return {
        id: sessionId,

        async prompt(text: string, promptOptions?: SubagentPromptOptions): Promise<string> {
          // Generate a unique part ID with "prt" prefix — required by the OpenCode API
          const partId = `prt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          const result = await client.session!.prompt({
            path: { id: sessionId },
            body: {
              noReply: false,
              ...(opts.agent ? { agent: opts.agent } : {}),
              ...(modelConfig ? { model: modelConfig } : {}),
              ...(promptOptions?.responseFormat ? { format: promptOptions.responseFormat } : {}),
              tools: WORKFLOW_TOOL_DENYLIST,
              parts: [{ type: "text", text, id: partId }],
            },
          })
          try {
            return extractTextFromPromptResult(result, opts.title)
          } catch (initialError) {
            const messageId = extractMessageId(result)
            if (!messageId) throw initialError
            let lastResult: unknown = result
            for (let attempt = 0; attempt < 60; attempt++) {
              await sleep(500)
              const text = await fetchPromptMessageText(client, sessionId, messageId)
              if (text) return text
            }
            return extractTextFromPromptResult(lastResult, opts.title)
          }
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
