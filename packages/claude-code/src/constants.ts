/**
 * constants.ts — Paths and defaults for the Claude Code adapter.
 */
import { join } from "node:path"

// Re-export PID_FILENAME from bridge — single source of truth
export { PID_FILENAME } from "#bridge/pid-file"

/** Default directory for open-artisan state, relative to project root. */
export const DEFAULT_STATE_DIR_NAME = ".openartisan"

/** Socket filename within the state directory. */
export const SOCKET_FILENAME = ".bridge.sock"

/** Local auth token filename used by the Unix socket transport. */
export const SOCKET_TOKEN_FILENAME = ".bridge-token"

/** Active session file within the state directory. */
export const ACTIVE_SESSION_FILENAME = ".active-session"

/** Enabled flag file — when present, hooks are active. */
export const ENABLED_FILENAME = ".enabled"

/**
 * Env var marker set on the isolated reviewer/approver subprocess spawned by the
 * adapter (runOwnedReviewerCommand). When present, every hook handler no-ops so
 * the subprocess is fully transparent to the workflow: it is not gated by the
 * guard, does not re-dispatch reviews from its own Stop hook, does not clobber
 * the `.active-session` pointer, and receives no injected workflow context.
 * Without this, the reviewer (which runs in the project dir and inherits the
 * project's open-artisan hooks) gets reprompted by its own Stop hook and exits
 * non-zero, and overwrites the authoring session's active-session pointer.
 */
export const REVIEWER_SUBPROCESS_ENV = "OPEN_ARTISAN_REVIEWER_SUBPROCESS"

/** Resolve the socket path from a state directory. */
export function getSocketPath(stateDir: string): string {
  return join(stateDir, SOCKET_FILENAME)
}

/** Resolve the socket auth token path from a state directory. */
export function getSocketTokenPath(stateDir: string): string {
  return join(stateDir, SOCKET_TOKEN_FILENAME)
}

/** Resolve the active session file path from a state directory. */
export function getActiveSessionPath(stateDir: string): string {
  return join(stateDir, ACTIVE_SESSION_FILENAME)
}

/** Resolve the enabled flag path from a state directory. */
export function getEnabledPath(stateDir: string): string {
  return join(stateDir, ENABLED_FILENAME)
}

/** Default connection timeout for socket clients (ms). */
export const CLIENT_TIMEOUT_MS = 10_000

/** Default connection timeout for socket server connections (ms). */
export const SERVER_CONNECTION_TIMEOUT_MS = 30_000
