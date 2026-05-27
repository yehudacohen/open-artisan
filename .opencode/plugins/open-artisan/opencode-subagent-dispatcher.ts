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
import { encodeSubagentToolSubmission } from "../../../packages/core/subagent-dispatcher"
import { extractEphemeralSessionId, extractTextFromPromptResult } from "../../../packages/core/utils"
import type { OpencodeClient } from "@opencode-ai/sdk"

export interface ReviewerToolSubmissionStore {
  begin(sessionId: string, toolName: string, context?: { parentSessionId?: string; kind?: "task" | "phase"; subject?: string; attemptId?: string }): void
  take(sessionId: string, toolName: string): string | null
  clear(sessionId: string): void
}

export interface OpenCodeSubagentDispatcherOptions {
  reviewerToolSubmissions?: ReviewerToolSubmissionStore
}

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
  request_allowlist_expansion: false,
  approve_current_task_scope_expansion: false,
  repair_current_task_boundary_from_impl_plan: false,
  summarize_workflow_incident: false,
  propose_change: false,
  disable_open_artisan: false,
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

function summarizeMessages(value: unknown): string {
  const messages = normalizeMessages(value).map((message) => ({
    id: message.id,
    parentId: message.parentId,
    role: message.role,
    hasText: !!message.text,
  }))
  return summarizeResponse({ messages })
}

function findStructuredSubmission(value: unknown, toolName: string | undefined, depth = 0): string | null {
  if (!value || depth > 6) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStructuredSubmission(item, toolName, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (toolName === "submit_task_review_result" && typeof record["passed"] === "boolean") {
    return JSON.stringify(record)
  }
  if (toolName === "submit_phase_review_result" && typeof record["satisfied"] === "boolean" && Array.isArray(record["criteria_results"])) {
    return JSON.stringify(record)
  }
  if (toolName === "submit_change_proposal_review_result" && typeof record["approved"] === "boolean" && typeof record["route"] === "string") {
    return JSON.stringify(record)
  }
  if (toolName === "submit_task_drift_review_result" && typeof record["drift_detected"] === "boolean") {
    return JSON.stringify(record)
  }
  if (toolName === "submit_orchestrator_assess_result" && Array.isArray(record["affected_artifacts"]) && typeof record["root_cause_artifact"] === "string") {
    return JSON.stringify(record)
  }
  if (toolName === "submit_orchestrator_diverge_result" && typeof record["classification"] === "string") {
    return JSON.stringify(record)
  }
  if (toolName === "submit_auto_approve_result" && typeof record["approve"] === "boolean" && (typeof record["confidence"] === "number" || typeof record["confidence"] === "string")) {
    return JSON.stringify(record)
  }
  if (toolName === "submit_rebuttal_review_result" && Array.isArray(record["criteria_results"])) {
    return JSON.stringify(record)
  }
  if (toolName === "submit_intent_comparison_result" && typeof record["classification"] === "string") {
    return JSON.stringify(record)
  }
  for (const key of ["structured", "payload", "arguments", "args", "input", "output", "result", "data", "info", "message", "body", "tool", "toolCall"]) {
    const found = findStructuredSubmission(record[key], toolName, depth + 1)
    if (found) return found
  }
  return null
}

function buildMissingSubmissionToolError(title: string, toolName: string, result: unknown): Error {
  return new Error(
    `${title}: isolated subagent must call ${toolName}; received no captured tool submission. ` +
    `Text/prose fallback is disabled when the local submission tool is available. result=${summarizeResponse(result)}`,
  )
}

function requiresLocalSubmissionTool(toolName: string | undefined): boolean {
  return toolName === "submit_phase_review_result" ||
    toolName === "submit_task_review_result" ||
    toolName === "submit_rebuttal_review_result"
}

function formatSubmissionPayload(toolName: string | undefined, payload: string, required: boolean): string {
  return toolName && required ? encodeSubagentToolSubmission(toolName, payload) : payload
}

type PromptMessageIds = {
  assistantId: string | null
  parentId: string | null
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function extractPromptMessageIds(response: unknown): PromptMessageIds {
  if (!response || typeof response !== "object") return { assistantId: null, parentId: null }
  const data = ((response as Record<string, unknown>)["data"] ?? response) as Record<string, unknown>
  const info = data["info"] as Record<string, unknown> | undefined
  const source = info ?? data
  return {
    assistantId: readString(source, ["id", "messageID", "messageId", "message_id"]),
    parentId: readString(source, ["parentID", "parentId", "parent_id"]),
  }
}

type NormalizedMessage = {
  id: string | null
  parentId: string | null
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
  const id = readString(info, ["id", "messageID", "messageId", "message_id"])
  const parentId = readString(info, ["parentID", "parentId", "parent_id"])
  const role = typeof info.role === "string" ? info.role : null
  const text = extractTextFromParts(record.parts)
  if (!id && !parentId && !role && !text) return null
  return { id, parentId, role, text }
}

function normalizeMessages(value: unknown): NormalizedMessage[] {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) return unwrapped.flatMap((item) => normalizeMessages(item))
  if (!unwrapped || typeof unwrapped !== "object") return []
  const record = unwrapped as Record<string, unknown>
  const messages: NormalizedMessage[] = []
  const message = normalizeMessage(record)
  if (message) messages.push(message)
  for (const key of ["messages", "items", "results", "records", "list", "children", "message", "body", "result", "output"]) {
    messages.push(...normalizeMessages(record[key]))
  }
  return messages
}

function selectAssistantText(value: unknown, messageId?: string | null, parentId?: string | null): string | null {
  const messages = normalizeMessages(value)
  if (messageId) {
    const target = messages.find((message) => message.id === messageId && message.role === "assistant" && message.text)
    if (target?.text) return target.text
  }
  if (parentId) {
    const parentIndex = messages.findIndex((message) => message.id === parentId)
    if (parentIndex !== -1) {
      const nextAssistant = messages.slice(parentIndex + 1).find((message) => message.role === "assistant" && message.text)
      if (nextAssistant?.text) return nextAssistant.text
    }
    const childAssistant = messages.slice().reverse().find((message) => message.parentId === parentId && message.role === "assistant" && message.text)
    if (childAssistant?.text) return childAssistant.text
  }
  const latestAssistant = messages.slice().reverse().find((message) => message.role === "assistant" && message.text)
  return latestAssistant?.text ?? null
}

function selectDirectMessageText(value: unknown, messageId: string): string | null {
  const messages = normalizeMessages(value)
  const target = messages.find((message) => message.id === messageId && message.role === "assistant" && message.text)
  if (target?.text) return target.text
  if (messages.length === 1 && messages[0]?.text) return messages[0].text
  return selectAssistantText(value, messageId)
}

async function fetchPromptMessageText(client: OpencodeClient, sessionId: string, ids: PromptMessageIds): Promise<{ text: string | null; diagnostic: string | null }> {
  if (ids.assistantId && typeof client.session?.message === "function") {
    const result = await client.session.message({ path: { id: sessionId, messageID: ids.assistantId } })
    const text = selectDirectMessageText(result, ids.assistantId)
    if (text) return { text, diagnostic: null }
  }

  if (typeof client.session?.messages === "function") {
    const history = await client.session.messages({ path: { id: sessionId }, query: { limit: 20 } })
    return { text: selectAssistantText(history, ids.assistantId, ids.parentId), diagnostic: summarizeMessages(history) }
  }

  return { text: null, diagnostic: "client.session.messages unavailable" }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type PromptOrSubmissionResult =
  | { kind: "prompt"; result: unknown }
  | { kind: "submission"; payload: string }

async function waitForPromptOrSubmission(args: {
  promptPromise: Promise<unknown>
  takeSubmission?: () => string | null | undefined
}): Promise<PromptOrSubmissionResult> {
  if (!args.takeSubmission) {
    return { kind: "prompt", result: await args.promptPromise }
  }

  let promptSettled = false
  const promptResult = args.promptPromise.then(
    (result): PromptOrSubmissionResult => {
      promptSettled = true
      return { kind: "prompt", result }
    },
    (error) => {
      promptSettled = true
      throw error
    },
  )

  const submissionResult = (async (): Promise<PromptOrSubmissionResult> => {
    while (!promptSettled) {
      const payload = args.takeSubmission?.()
      if (payload) {
        // The OpenCode prompt request can remain open after a local tool result is
        // captured. Swallow its eventual rejection so returning the tool payload
        // does not leave an unhandled promise behind.
        void args.promptPromise.catch(() => {})
        return { kind: "submission", payload }
      }
      await sleep(250)
    }
    return promptResult
  })()

  return await Promise.race([promptResult, submissionResult])
}

export function createOpenCodeSubagentDispatcher(client: OpencodeClient, options: OpenCodeSubagentDispatcherOptions = {}): SubagentDispatcher {
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
          const submissionToolName = promptOptions?.submissionTool?.name
          const requireSubmissionTool = promptOptions?.submissionTool?.required === true ||
            (!!options.reviewerToolSubmissions && requiresLocalSubmissionTool(submissionToolName))
          if (submissionToolName) {
            const progress = promptOptions?.submissionTool?.progress
            options.reviewerToolSubmissions?.begin(sessionId, submissionToolName, {
              ...(opts.parentId ? { parentSessionId: opts.parentId } : {}),
              ...(progress?.kind ? { kind: progress.kind } : {}),
              ...(progress?.subject ? { subject: progress.subject } : {}),
              ...(progress?.attemptId ? { attemptId: progress.attemptId } : {}),
            })
          }
          // Generate a unique part ID with "prt" prefix — required by the OpenCode API
          const partId = `prt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          let result: unknown = null
          try {
            try {
              const promptPromise = client.session!.prompt({
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
              const promptOrSubmission = await waitForPromptOrSubmission({
                promptPromise,
                ...(submissionToolName ? { takeSubmission: () => options.reviewerToolSubmissions?.take(sessionId, submissionToolName) } : {}),
              })
              if (promptOrSubmission.kind === "submission") {
                return formatSubmissionPayload(submissionToolName, promptOrSubmission.payload, requireSubmissionTool)
              }
              result = promptOrSubmission.result
            } catch (promptError) {
              const submitted = submissionToolName ? options.reviewerToolSubmissions?.take(sessionId, submissionToolName) : null
              if (submitted) return formatSubmissionPayload(submissionToolName, submitted, requireSubmissionTool)
              throw promptError
            }
            const submitted = submissionToolName ? options.reviewerToolSubmissions?.take(sessionId, submissionToolName) : null
            if (submitted) return formatSubmissionPayload(submissionToolName, submitted, requireSubmissionTool)
            const structured = findStructuredSubmission(result, submissionToolName)
            if (structured) return formatSubmissionPayload(submissionToolName, structured, requireSubmissionTool)
            if (requireSubmissionTool) throw buildMissingSubmissionToolError(opts.title, submissionToolName!, result)
            return extractTextFromPromptResult(result, opts.title)
          } catch (initialError) {
            const submitted = submissionToolName ? options.reviewerToolSubmissions?.take(sessionId, submissionToolName) : null
            if (submitted) return formatSubmissionPayload(submissionToolName, submitted, requireSubmissionTool)
            const structured = findStructuredSubmission(result, submissionToolName)
            if (structured) return formatSubmissionPayload(submissionToolName, structured, requireSubmissionTool)
            if (result === null) throw initialError
            if (requireSubmissionTool && result !== null) throw buildMissingSubmissionToolError(opts.title, submissionToolName!, result)
            const messageIds = extractPromptMessageIds(result)
            if (!messageIds.assistantId && !messageIds.parentId && typeof client.session?.messages !== "function") throw initialError
            let lastResult: unknown = result
            let lastDiagnostic: string | null = null
            for (let attempt = 0; attempt < 60; attempt++) {
              await sleep(500)
              const fetched = await fetchPromptMessageText(client, sessionId, messageIds)
              lastDiagnostic = fetched.diagnostic
              if (fetched.text) return fetched.text
            }
            if (lastDiagnostic) {
              throw new Error(
                `Cannot extract text from ${opts.title} result after polling session history; ` +
                `ids=${summarizeResponse(messageIds)} history=${lastDiagnostic} original=${summarizeResponse(result)}`,
              )
            }
            return extractTextFromPromptResult(lastResult, opts.title)
          } finally {
            if (submissionToolName) options.reviewerToolSubmissions?.clear(sessionId)
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
