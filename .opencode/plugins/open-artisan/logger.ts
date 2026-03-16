/**
 * logger.ts — Structured logging for the open-artisan plugin.
 *
 * All plugin output goes through this logger instead of raw console.* calls.
 * User-facing messages are displayed as TUI toast notifications.
 * Internal debug messages are suppressed unless OPENARTISAN_DEBUG is set.
 *
 * Persistent error log: errors and warnings are always appended to
 * .opencode/openartisan-errors.log as structured JSON lines. This file
 * survives agent recovery and can be inspected after the fact.
 *
 * Usage:
 *   const log = createLogger(client, stateDir)
 *   log.warn("Discovery fleet failed", { detail: errMsg })
 *   log.debug("Rebuttal accepted")
 */

import { join } from "node:path"
import { appendFileSync } from "node:fs"
import type { PluginClient } from "./client-types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Logger {
  /** User-facing error — shown as red toast. Always persisted to error log. */
  error(message: string, opts?: { detail?: string; sessionId?: string }): void

  /** User-facing warning — shown as yellow toast. Always persisted to error log. */
  warn(message: string, opts?: { detail?: string; sessionId?: string }): void

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
 *
 * @param client   Plugin client for TUI toast access
 * @param stateDir Directory for the persistent error log file (.opencode/)
 */
export function createLogger(client: PluginClient, stateDir?: string): Logger {
  const errorLogPath = stateDir ? join(stateDir, "openartisan-errors.log") : null

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

  /**
   * Appends a structured JSON line to the persistent error log.
   * Best-effort — never throws on write failure.
   */
  function persistError(level: "error" | "warn", message: string, detail?: string, sessionId?: string): void {
    if (!errorLogPath) return
    try {
      const entry = {
        ts: new Date().toISOString(),
        level,
        message,
        ...(detail ? { detail } : {}),
        ...(sessionId ? { sessionId } : {}),
      }
      appendFileSync(errorLogPath, JSON.stringify(entry) + "\n")
    } catch {
      // Can't write to log file — nothing we can do
    }
  }

  return {
    error(message: string, opts?: { detail?: string; sessionId?: string }) {
      const detail = opts?.detail ? `: ${opts.detail}` : ""
      toast("Workflow Error", `${message}${detail}`, "error", 8000)
      persistError("error", message, opts?.detail, opts?.sessionId)
    },

    warn(message: string, opts?: { detail?: string; sessionId?: string }) {
      const detail = opts?.detail ? `: ${opts.detail}` : ""
      toast("Workflow Warning", `${message}${detail}`, "warning", 6000)
      persistError("warn", message, opts?.detail, opts?.sessionId)
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
