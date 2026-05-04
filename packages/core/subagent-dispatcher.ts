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
   * When present, the parent session owns cleanup/lifecycle visibility and adapters may
   * intentionally skip explicit child-session deletion during destroy().
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
  prompt(text: string): Promise<string>
  /** Destroy the session (best-effort — failures are silently ignored). */
  destroy(): Promise<void>
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
