/**
 * Tests for Logger.child() — core logger child creation with bound context.
 */
import { describe, expect, it, mock } from "bun:test"
import { createLogger } from "#core/logger"
import type { NotificationSink } from "#core/logger"

const noopNotify: NotificationSink = { toast() {} }

describe("Logger.child", () => {
  it("creates a child logger", () => {
    const log = createLogger(noopNotify)
    const child = log.child({ traceId: "abc" })
    // Should not throw
    child.info("test message")
    child.warn("warn message")
    child.error("error message")
    child.debug("debug message")
  })

  it("child.child creates nested children", () => {
    const log = createLogger(noopNotify)
    const child1 = log.child({ traceId: "abc" })
    const child2 = child1.child({ sessionId: "s1" })
    // Should not throw
    child2.info("nested message")
  })

  it("child logger passes through to parent notification sink", () => {
    const toastCalls: string[] = []
    const notify: NotificationSink = {
      toast(_title, message) { toastCalls.push(message) },
    }
    const log = createLogger(notify)
    const child = log.child({ traceId: "xyz" })
    child.error("child error")
    expect(toastCalls.length).toBeGreaterThan(0)
    expect(toastCalls[0]).toContain("child error")
  })
})
