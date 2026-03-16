/**
 * logger.ts — Structured logging for the open-artisan plugin.
 *
 * All plugin output goes through this logger instead of raw console.* calls.
 * User-facing messages are displayed as TUI toast notifications.
 * Internal debug messages are suppressed unless OPENARTISAN_DEBUG is set.
 *
 * Usage:
 *   const log = createLogger(client)
 *   log.warn("Discovery fleet failed", { detail: errMsg })
 *   log.debug("Rebuttal accepted")
 */

import type { PluginClient } from "./client-types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Logger {
  /** User-facing error — shown as red toast. Use for failures that affect workflow. */
  error(message: string, opts?: { detail?: string }): void

  /** User-facing warning — shown as yellow toast. Use for degradation that doesn't block. */
  warn(message: string, opts?: { detail?: string }): void

  /** User-facing info — shown as blue toast. Use for state transitions, progress. */
  info(message: string, opts?: { detail?: string }): void

  /** Internal debug — suppressed unless OPENARTISAN_DEBUG env var is set. Never shown in TUI. */
  debug(message: string, opts?: { detail?: string }): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEBUG_ENABLED = !!process.env["OPENARTISAN_DEBUG"]

const PREFIX = "[open-artisan]"

/**
 * Creates a logger bound to the plugin client's TUI toast API.
 * Safe to call even if `client.tui` is undefined (graceful no-op).
 */
export function createLogger(client: PluginClient): Logger {
  function toast(
    title: string,
    message: string,
    variant: "info" | "warning" | "error" | "success",
    duration = 5000,
  ): void {
    try {
      client.tui?.showToast?.({
        body: { title, message, variant, duration },
      })
    } catch {
      // TUI not available — silent
    }
  }

  return {
    error(message: string, opts?: { detail?: string }) {
      const detail = opts?.detail ? `: ${opts.detail}` : ""
      toast("Workflow Error", `${message}${detail}`, "error", 8000)
    },

    warn(message: string, opts?: { detail?: string }) {
      const detail = opts?.detail ? `: ${opts.detail}` : ""
      toast("Workflow Warning", `${message}${detail}`, "warning", 6000)
    },

    info(message: string, opts?: { detail?: string }) {
      const detail = opts?.detail ? ` — ${opts.detail}` : ""
      toast("Workflow", `${message}${detail}`, "info", 4000)
    },

    debug(message: string, opts?: { detail?: string }) {
      if (!DEBUG_ENABLED) return
      const detail = opts?.detail ? ` ${opts.detail}` : ""
      // Debug goes to stderr only — never to TUI
      console.error(`${PREFIX} [debug] ${message}${detail}`)
    },
  }
}
