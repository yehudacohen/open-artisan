/**
 * structured-log.ts — Pino-based structured logger for the bridge server.
 *
 * Writes JSONL to `.openartisan/.bridge.log`. Supports child loggers
 * with traceId correlation (each JSON-RPC request gets a unique traceId).
 *
 * Also adapts the pino logger to the core `Logger` interface so the
 * EngineContext can use it seamlessly.
 */
import { join } from "node:path"
import pino from "pino"
import type { Logger, NotificationSink } from "../core/logger"

/**
 * Create a pino logger that writes to the bridge log file.
 *
 * @param stateDir - Directory for the log file (e.g., ".openartisan/")
 */
export function createBridgeLogger(stateDir: string) {
  const logPath = join(stateDir, ".bridge.log")
  const level = process.env["OPENARTISAN_DEBUG"] ? "debug" : "info"

  const transport = pino.transport({
    target: "pino/file",
    options: { destination: logPath, mkdir: true },
  })

  const logger = pino({ level }, transport)

  return logger
}

/**
 * Adapt a pino logger to the core Logger interface.
 *
 * The core engine uses `Logger` with `error/warn/info/debug(message, opts?)`.
 * Pino uses `logger.error({ detail }, message)`. This adapter bridges the gap.
 */
export function adaptPinoToLogger(pinoLogger: pino.Logger, notify: NotificationSink): Logger {
  return {
    error(message: string, opts?: { detail?: string; sessionId?: string }) {
      pinoLogger.error({ ...(opts ?? {}), component: "engine" }, message)
      try { notify.toast("Error", message, "error") } catch { /* ignore */ }
    },
    warn(message: string, opts?: { detail?: string; sessionId?: string }) {
      pinoLogger.warn({ ...(opts ?? {}), component: "engine" }, message)
      try { notify.toast("Warning", message, "warning") } catch { /* ignore */ }
    },
    info(message: string, opts?: { detail?: string }) {
      pinoLogger.info({ ...(opts ?? {}), component: "engine" }, message)
    },
    debug(message: string, opts?: { detail?: string }) {
      pinoLogger.debug({ ...(opts ?? {}), component: "engine" }, message)
    },
    child(bindings: Record<string, unknown>): Logger {
      return adaptPinoToLogger(pinoLogger.child(bindings), notify)
    },
  }
}
