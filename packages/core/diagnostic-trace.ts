import { createHash } from "node:crypto"
import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"

export interface DiagnosticTrace {
  record(event: string, fields?: Record<string, unknown>): void
  hashText(text: string): string
}

export interface DiagnosticTraceOptions {
  onWriteError?: (error: Error, tracePath: string) => void
}

export function createDiagnosticTrace(stateDir: string, component: string, options: DiagnosticTraceOptions = {}): DiagnosticTrace {
  const tracePath = join(stateDir, "openartisan-trace.jsonl")
  let reportedWriteFailure = false

  function enabled(): boolean {
    return process.env["OPENARTISAN_TRACE"] === "1"
  }

  return {
    record(event, fields = {}) {
      if (!enabled()) return
      try {
        mkdirSync(stateDir, { recursive: true })
        const entry = {
          ts: new Date().toISOString(),
          component,
          event,
          ...fields,
        }
        appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, "utf-8")
      } catch (error) {
        // Diagnostic tracing must never affect workflow/runtime behavior.
        if (!reportedWriteFailure) {
          reportedWriteFailure = true
          options.onWriteError?.(error instanceof Error ? error : new Error(String(error)), tracePath)
        }
      }
    },

    hashText(text) {
      return createHash("sha256").update(text).digest("hex").slice(0, 16)
    },
  }
}
