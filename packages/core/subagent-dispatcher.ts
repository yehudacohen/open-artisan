/**
 * subagent-dispatcher.ts — Platform-agnostic interface for ephemeral LLM subagent sessions.
 *
 * All 7 subagent-dispatching modules (self-review, orchestrator/llm-calls, auto-approve,
 * task-review, task-drift, discovery, intent-comparison) follow the same lifecycle:
 *
 *   1. Create an isolated session with a title, agent name, optional parent, and model
 *   2. Send a prompt and receive a text response
 *   3. Delete the session (best-effort cleanup)
 *
 * This interface abstracts that lifecycle so the core modules don't depend on the
 * OpenCode client SDK (client.session.create/prompt/delete) directly. Each platform
 * adapter provides its own implementation.
 *
 * The response text extraction (extractTextFromPromptResult, extractEphemeralSessionId)
 * is handled INSIDE the adapter implementation, not by the callers. Callers receive
 * a plain string response.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentCreateOptions {
  /** Human-readable title for the session (shown in TUI session tree) */
  title: string
  /** Agent identifier (e.g. "workflow-reviewer", "workflow-orchestrator", "auto-approver") */
  agent: string
  /**
   * Parent session ID for TUI nesting.
   * When present, the child is nested under the parent for UI visibility. The
   * dispatcher still owns the created child session and must clean it up.
   */
  parentId?: string
  /**
   * Model to use. Inherit from parent when possible.
   *
   * - string: shorthand model identifier to be normalized by the adapter
   * - object: explicit provider/model routing contract passed through as-is
   */
  model?: string | { modelID: string; providerID?: string }
}

export interface SubagentSession {
  /** Platform-assigned session identifier */
  id: string
  /**
   * Send a prompt and return the response text.
   * The adapter handles response envelope parsing internally.
   */
  prompt(text: string, options?: SubagentPromptOptions): Promise<string>
  /** Destroy the session (best-effort — failures are silently ignored). */
  destroy(): Promise<void>
}

export interface SubagentPromptOptions {
  /** Called by adapters when the child session makes meaningful progress. */
  onProgress?: (message?: string) => void
  /**
   * Adapter-native structured output request. Adapters that support model-level
   * JSON schema enforcement should pass this through to the underlying LLM API;
   * adapters that do not support it may ignore it and rely on prompt validation.
   */
  responseFormat?: {
    type: "json_schema"
    schema: Record<string, unknown>
  }
  /**
   * Preferred reviewer submission tool for adapters that can expose local tools
   * to the isolated subagent. When available, the reviewer should submit typed
   * arguments through this tool instead of relying on final-message JSON text.
   */
  submissionTool?: {
    name: string
    /** Runtime context for optional incremental reviewer progress tools. */
    progress?: {
      kind: "task" | "phase"
      subject: string
      attemptId?: string
    }
    /**
     * When true, assistant text is not an acceptable fallback. Adapters that
     * support local submission capture must return an encoded tool payload or
     * fail closed so callers do not try to JSON-repair prose.
     */
    required?: boolean
  }
}

const SUBAGENT_TOOL_SUBMISSION_PREFIX = "__OPEN_ARTISAN_TOOL_SUBMISSION__"

export function encodeSubagentToolSubmission(toolName: string, payload: string): string {
  return `${SUBAGENT_TOOL_SUBMISSION_PREFIX}:${toolName}\n${payload}`
}

export function decodeSubagentToolSubmission(text: string, expectedToolName: string): { success: true; payload: string } | { success: false; error: string } {
  const prefix = `${SUBAGENT_TOOL_SUBMISSION_PREFIX}:`
  if (!text.startsWith(prefix)) {
    return {
      success: false,
      error: `Expected ${expectedToolName} tool submission, but isolated reviewer returned assistant text instead. Text/prose fallback is disabled for this review.`,
    }
  }
  const newline = text.indexOf("\n")
  if (newline === -1) return { success: false, error: `Malformed ${expectedToolName} tool submission envelope.` }
  const toolName = text.slice(prefix.length, newline)
  if (toolName !== expectedToolName) {
    return { success: false, error: `Expected ${expectedToolName} tool submission, got ${toolName}.` }
  }
  return { success: true, payload: text.slice(newline + 1) }
}

/**
 * Platform-agnostic interface for creating isolated ephemeral LLM sessions.
 * Used by self-review, orchestrator, auto-approve, task-review, task-drift,
 * discovery, and intent-comparison modules.
 */
export interface SubagentDispatcher {
  /**
   * Create an isolated ephemeral session and return a handle for prompting and cleanup.
   * The adapter is responsible for:
   *   - Creating the session via the platform's API
   *   - Extracting the session ID from the platform's response envelope
   *   - Wrapping prompt() to extract text from the platform's response format
   *   - Implementing destroy() with best-effort cleanup (skip if parentId is set)
   */
  createSession(opts: SubagentCreateOptions): Promise<SubagentSession>
}
