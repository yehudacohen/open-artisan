import { describe, expect, it, afterEach, mock } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createDiagnosticTrace } from "#core/diagnostic-trace"

const previousTrace = process.env["OPENARTISAN_TRACE"]

afterEach(() => {
  if (previousTrace === undefined) {
    delete process.env["OPENARTISAN_TRACE"]
  } else {
    process.env["OPENARTISAN_TRACE"] = previousTrace
  }
})

describe("diagnostic trace", () => {
  it("reports trace write failures once without throwing", () => {
    process.env["OPENARTISAN_TRACE"] = "1"
    const tempDir = mkdtempSync(join(tmpdir(), "trace-failure-"))
    try {
      const stateDirFile = join(tempDir, ".openartisan")
      writeFileSync(stateDirFile, "not a directory")
      const onWriteError = mock(() => {})
      const trace = createDiagnosticTrace(stateDirFile, "test", { onWriteError })

      expect(() => trace.record("first.failure")).not.toThrow()
      expect(() => trace.record("second.failure")).not.toThrow()

      expect(onWriteError).toHaveBeenCalledTimes(1)
      const calls = onWriteError.mock.calls as unknown as Array<[Error, string]>
      const [error, tracePath] = calls[0]!
      expect(error).toBeInstanceOf(Error)
      expect(tracePath).toBe(join(stateDirFile, "openartisan-trace.jsonl"))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
