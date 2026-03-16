/**
 * client-types.ts — Minimal typed interface for the OpenCode plugin client.
 *
 * Replaces the `type Client = any` pattern used across the codebase.
 * Defines only the methods the plugin actually uses, keeping it narrow
 * enough to remain compatible across SDK versions while providing real
 * type safety at call sites.
 *
 * The actual client object provided by OpenCode at runtime may have many
 * more methods — this interface only constrains the subset we depend on.
 */

// ---------------------------------------------------------------------------
// Session API — used by self-review, discovery fleet, orchestrator LLM calls
// ---------------------------------------------------------------------------

export interface SessionCreateOptions {
  body: {
    /** Human-readable title for the session (shown in TUI) */
    title?: string
    /** System prompt text — injected as the session's initial system message */
    system?: string
    /** Parent session ID — creates a child session visible under the parent in TUI */
    parentID?: string
    /** Agent identifier to use for this session */
    agent?: string
  }
  /** v1 SDK: path params (not used for create, but present in the envelope) */
  path?: Record<string, string>
}

export interface SessionPromptOptions {
  path: { id: string }
  body: {
    /** When true, the session does not expect a reply (fire-and-forget) */
    noReply?: boolean
    parts: Array<{ type: string; text: string }>
  }
}

export interface SessionDeleteOptions {
  path: { id: string }
}

export interface SessionAPI {
  create(opts: SessionCreateOptions): Promise<unknown>
  prompt(opts: SessionPromptOptions): Promise<unknown>
  delete(opts: SessionDeleteOptions): Promise<unknown>
}

// ---------------------------------------------------------------------------
// TUI API — optional toast notifications
// ---------------------------------------------------------------------------

export interface ToastOptions {
  body: {
    title: string
    message: string
    variant?: "info" | "warning" | "error" | "success"
    duration?: number
  }
}

export interface TuiAPI {
  showToast?(opts: ToastOptions): void
}

// ---------------------------------------------------------------------------
// Composite client interface
// ---------------------------------------------------------------------------

/**
 * Minimal plugin client interface — covers all methods used by the plugin.
 *
 * `session` may be absent in degraded environments (the plugin logs a warning
 * at startup in this case). `tui` may be absent if the TUI is not available.
 *
 * Callers should use optional chaining (`client.session?.create(...)`) for
 * graceful degradation, matching the existing error-handling patterns.
 */
export interface PluginClient {
  session?: SessionAPI
  tui?: TuiAPI
}
