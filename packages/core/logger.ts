/**
 * logger.ts — Structured logging for the open-artisan plugin.
 *
 * All plugin output goes through this logger instead of raw console.* calls.
 * User-facing messages are displayed via a NotificationSink (platform-specific).
 * Internal debug messages are suppressed unless OPENARTISAN_DEBUG is set.
 *
 * Persistent error log: errors and warnings are always appended to
 * .opencode/openartisan-errors.log as structured JSON lines. This file
 * survives agent recovery and can be inspected after the fact.
 *
 * Usage:
 *   const log = createLogger(notify, stateDir)
 *   log.warn("Discovery fleet failed", { detail: errMsg })
 *   log.debug("Rebuttal accepted")
 */

import { join } from "node:path"
import { appendFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Platform-agnostic notification sink for user-facing messages.
 * Each platform adapter provides its own implementation.
 */
export interface NotificationSink {
  toast(title: string, message: string, level: "info" | "warning" | "error"): void
}

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
 * Module-level default stateDir for error log persistence.
 * Set once at plugin init via `setDefaultStateDir()`. This allows
 * callsites that don't have direct access to stateDir (e.g. self-review,
 * auto-approve, orchestrator) to still persist errors to disk.
 */
let defaultStateDir: string | null = null

/**
 * Sets the module-level default stateDir. Call once at plugin init.
 * After this, any `createLogger(notify)` call (without explicit stateDir)
 * will persist errors to `<stateDir>/openartisan-errors.log`.
 */
export function setDefaultStateDir(dir: string): void {
  defaultStateDir = dir
}

/**
 * Creates a logger bound to a NotificationSink for user-facing messages.
 * Safe to call with a no-op sink (e.g. `{ toast: () => {} }`).
 *
 * @param notify   Platform-specific notification sink for toasts/alerts
 * @param stateDir Directory for the persistent error log file (.opencode/).
 *                 Falls back to the module-level default set via `setDefaultStateDir()`.
 */
export function createLogger(notify: NotificationSink, stateDir?: string): Logger {
  const effectiveStateDir = stateDir ?? defaultStateDir
  const errorLogPath = effectiveStateDir ? join(effectiveStateDir, "openartisan-errors.log") : null

  /**
   * Appends a structured JSON line to the persistent error log.
   * Best-effort — never throws on write failure.
   */
  function persistError(level: "error" | "warn" | "debug", message: string, detail?: string, sessionId?: string): void {
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
      try { notify.toast("Workflow Error", `${message}${detail}`, "error") } catch { /* sink unavailable */ }
      persistError("error", message, opts?.detail, opts?.sessionId)
    },

    warn(message: string, opts?: { detail?: string; sessionId?: string }) {
      const detail = opts?.detail ? `: ${opts.detail}` : ""
      try { notify.toast("Workflow Warning", `${message}${detail}`, "warning") } catch { /* sink unavailable */ }
      persistError("warn", message, opts?.detail, opts?.sessionId)
    },

    info(message: string, opts?: { detail?: string }) {
      const detail = opts?.detail ? ` — ${opts.detail}` : ""
      try { notify.toast("Workflow", `${message}${detail}`, "info") } catch { /* sink unavailable */ }
    },

    debug(message: string, opts?: { detail?: string }) {
      if (!DEBUG_ENABLED) return
      const detail = opts?.detail ? ` ${opts.detail}` : ""
      persistError("debug", message, opts?.detail)
      console.error(`${PREFIX} [debug] ${message}${detail}`)
    },
  }
}
