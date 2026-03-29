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

/** Active session file within the state directory. */
export const ACTIVE_SESSION_FILENAME = ".active-session"

/** Enabled flag file — when present, hooks are active. */
export const ENABLED_FILENAME = ".enabled"

/** Resolve the socket path from a state directory. */
export function getSocketPath(stateDir: string): string {
  return join(stateDir, SOCKET_FILENAME)
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
