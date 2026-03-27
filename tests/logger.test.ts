/**
 * Tests for the persistent error log in logger.ts.
 * Verifies that errors and warnings are appended to the log file,
 * and that the logger gracefully handles write failures.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createLogger } from "#core/logger"
import type { NotificationSink } from "#core/logger"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockNotify(): NotificationSink {
  return {
    toast: () => {},
  }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "logger-test-"))
})

afterEach(() => {
  try { rmSync(tempDir, { recursive: true }) } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// Persistent error log — creation and content
// ---------------------------------------------------------------------------

describe("Persistent error log — file creation", () => {
  it("creates openartisan-errors.log on first error", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.error("test error")
    const logPath = join(tempDir, "openartisan-errors.log")
    expect(existsSync(logPath)).toBe(true)
  })

  it("creates openartisan-errors.log on first warning", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.warn("test warning")
    const logPath = join(tempDir, "openartisan-errors.log")
    expect(existsSync(logPath)).toBe(true)
  })

  it("does NOT create log file for info messages", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.info("test info")
    const logPath = join(tempDir, "openartisan-errors.log")
    expect(existsSync(logPath)).toBe(false)
  })

  it("does NOT create log file for debug messages", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.debug("test debug")
    const logPath = join(tempDir, "openartisan-errors.log")
    expect(existsSync(logPath)).toBe(false)
  })
})

describe("Persistent error log — content format", () => {
  it("writes JSON lines with ts, level, and message", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.error("disk write failed")
    const logPath = join(tempDir, "openartisan-errors.log")
    const content = readFileSync(logPath, "utf-8").trim()
    const entry = JSON.parse(content)
    expect(entry.level).toBe("error")
    expect(entry.message).toBe("disk write failed")
    expect(typeof entry.ts).toBe("string")
    // Should be ISO 8601 timestamp
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts)
  })

  it("includes detail field when provided", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.error("store update failed", { detail: "validation error: invalid phase" })
    const logPath = join(tempDir, "openartisan-errors.log")
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim())
    expect(entry.detail).toBe("validation error: invalid phase")
  })

  it("includes sessionId field when provided", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.warn("retryCount reset failed", { sessionId: "sess-123" })
    const logPath = join(tempDir, "openartisan-errors.log")
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim())
    expect(entry.sessionId).toBe("sess-123")
  })

  it("omits detail field when not provided", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.error("simple error")
    const logPath = join(tempDir, "openartisan-errors.log")
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim())
    expect(entry.detail).toBeUndefined()
  })

  it("omits sessionId field when not provided", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.error("simple error")
    const logPath = join(tempDir, "openartisan-errors.log")
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim())
    expect(entry.sessionId).toBeUndefined()
  })

  it("writes warn level for warnings", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.warn("non-fatal issue")
    const logPath = join(tempDir, "openartisan-errors.log")
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim())
    expect(entry.level).toBe("warn")
  })
})

describe("Persistent error log — append behavior", () => {
  it("appends multiple entries as separate JSON lines", () => {
    const log = createLogger(makeMockNotify(), tempDir)
    log.error("first error")
    log.error("second error")
    log.warn("first warning")
    const logPath = join(tempDir, "openartisan-errors.log")
    const lines = readFileSync(logPath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!).message).toBe("first error")
    expect(JSON.parse(lines[1]!).message).toBe("second error")
    expect(JSON.parse(lines[2]!).message).toBe("first warning")
  })
})

describe("NotificationSink — toast calls", () => {
  it("calls notify.toast on error", () => {
    const toastMock = mock(() => {})
    const log = createLogger({ toast: toastMock }, tempDir)
    log.error("test error", { detail: "details here" })
    expect(toastMock).toHaveBeenCalledTimes(1)
    const [title, message, level] = toastMock.mock.calls[0] as [string, string, string]
    expect(title).toBe("Workflow Error")
    expect(message).toContain("test error")
    expect(message).toContain("details here")
    expect(level).toBe("error")
  })

  it("calls notify.toast on warn", () => {
    const toastMock = mock(() => {})
    const log = createLogger({ toast: toastMock }, tempDir)
    log.warn("test warning")
    expect(toastMock).toHaveBeenCalledTimes(1)
    const [, , level] = toastMock.mock.calls[0] as [string, string, string]
    expect(level).toBe("warning")
  })

  it("calls notify.toast on info", () => {
    const toastMock = mock(() => {})
    const log = createLogger({ toast: toastMock }, tempDir)
    log.info("test info")
    expect(toastMock).toHaveBeenCalledTimes(1)
    const [, , level] = toastMock.mock.calls[0] as [string, string, string]
    expect(level).toBe("info")
  })

  it("does NOT call notify.toast on debug", () => {
    const toastMock = mock(() => {})
    const log = createLogger({ toast: toastMock }, tempDir)
    log.debug("test debug")
    expect(toastMock).not.toHaveBeenCalled()
  })
})

describe("Persistent error log — graceful degradation", () => {
  it("does not throw when stateDir is not provided", () => {
    const log = createLogger(makeMockNotify()) // no stateDir
    expect(() => log.error("should not throw")).not.toThrow()
    expect(() => log.warn("should not throw")).not.toThrow()
  })

  it("does not throw when stateDir does not exist", () => {
    const log = createLogger(makeMockNotify(), "/nonexistent/path/that/does/not/exist")
    // Should swallow the error — appendFileSync will fail but try/catch handles it
    expect(() => log.error("should not throw")).not.toThrow()
  })

  it("does not throw when notify.toast throws", () => {
    const brokenNotify: NotificationSink = {
      toast() { throw new Error("TUI not available") },
    }
    const log = createLogger(brokenNotify, tempDir)
    expect(() => log.error("no tui available")).not.toThrow()
    // Error should still be persisted to file
    const logPath = join(tempDir, "openartisan-errors.log")
    expect(existsSync(logPath)).toBe(true)
  })
})
