/**
 * Tests for bridge structured logging with pino.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"

import { createBridgeLogger, adaptPinoToLogger } from "#bridge/structured-log"
import type { NotificationSink } from "#core/logger"

let tmpDir: string

const noopNotify: NotificationSink = { toast() {} }

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-log-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("createBridgeLogger", () => {
  it("creates a pino logger that writes to .bridge.log", async () => {
    const logger = createBridgeLogger(tmpDir)
    logger.info({ component: "test" }, "hello from test")
    // Flush by allowing async transport to write
    await new Promise((r) => setTimeout(r, 200))
    const logPath = join(tmpDir, ".bridge.log")
    expect(existsSync(logPath)).toBe(true)
    const content = await readFile(logPath, "utf-8")
    expect(content).toContain("hello from test")
  })
})

describe("Logger.child", () => {
  it("pino adapter child propagates traceId to all entries", async () => {
    const pinoLogger = createBridgeLogger(tmpDir)
    const coreLogger = adaptPinoToLogger(pinoLogger, noopNotify)
    const childLogger = coreLogger.child({ traceId: "req-456" })

    childLogger.info("child info message")
    childLogger.warn("child warn message")

    await new Promise((r) => setTimeout(r, 200))
    const content = await readFile(join(tmpDir, ".bridge.log"), "utf-8")
    expect(content).toContain("req-456")
    expect(content).toContain("child info message")
    expect(content).toContain("child warn message")
  })

  it("nested child merges bindings", async () => {
    const pinoLogger = createBridgeLogger(tmpDir)
    const coreLogger = adaptPinoToLogger(pinoLogger, noopNotify)
    const child1 = coreLogger.child({ traceId: "req-789" })
    const child2 = child1.child({ sessionId: "s1" })

    child2.info("nested child message")

    await new Promise((r) => setTimeout(r, 200))
    const content = await readFile(join(tmpDir, ".bridge.log"), "utf-8")
    expect(content).toContain("req-789")
    expect(content).toContain("s1")
    expect(content).toContain("nested child message")
  })
})

describe("adaptPinoToLogger", () => {
  it("adapts pino to the core Logger interface", async () => {
    const pinoLogger = createBridgeLogger(tmpDir)
    const coreLogger = adaptPinoToLogger(pinoLogger, noopNotify)

    coreLogger.info("info message", { detail: "some detail" })
    coreLogger.warn("warn message")
    coreLogger.error("error message")
    coreLogger.debug("debug message") // may not appear if level is "info"

    await new Promise((r) => setTimeout(r, 200))
    const content = await readFile(join(tmpDir, ".bridge.log"), "utf-8")
    expect(content).toContain("info message")
    expect(content).toContain("warn message")
    expect(content).toContain("error message")
    expect(content).toContain("engine") // component field
  })
})
