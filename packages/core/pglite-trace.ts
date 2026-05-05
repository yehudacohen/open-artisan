/**
 * pglite-trace.ts — opt-in PGlite lifecycle tracing.
 *
 * Set OPENARTISAN_PGLITE_TRACE=1 to emit JSONL trace records. By default records
 * go to stderr; set OPENARTISAN_PGLITE_TRACE_FILE to append to a file instead.
 */

import { appendFileSync } from "node:fs"

type TraceValue = string | number | boolean | null | undefined

export type PGliteTraceFields = Record<string, TraceValue>

export function isPGliteTraceEnabled(): boolean {
  return process.env.OPENARTISAN_PGLITE_TRACE === "1"
}

export function tracePGlite(event: string, fields: PGliteTraceFields = {}): void {
  if (!isPGliteTraceEnabled()) return
  const record = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...fields,
  })
  const traceFile = process.env.OPENARTISAN_PGLITE_TRACE_FILE
  if (traceFile) {
    appendFileSync(traceFile, `${record}\n`, "utf-8")
    return
  }
  process.stderr.write(`${record}\n`)
}
