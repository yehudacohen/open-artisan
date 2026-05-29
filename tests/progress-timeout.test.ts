import { describe, expect, it } from "bun:test"

import { runWithProgressTimeout } from "#core/progress-timeout"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("runWithProgressTimeout", () => {
  it("resolves completed work", async () => {
    const result = await runWithProgressTimeout({
      policy: { label: "quick", idleTimeoutMs: 50, hardTimeoutMs: 200 },
      async run() {
        await sleep(5)
        return "ok"
      },
    })
    expect(result).toBe("ok")
  })

  it("extends idle timeout on meaningful progress", async () => {
    const result = await runWithProgressTimeout({
      policy: { label: "progress", idleTimeoutMs: 30, hardTimeoutMs: 200 },
      async run(signal) {
        await sleep(20)
        signal.progress("step 1")
        await sleep(20)
        signal.progress("step 2")
        await sleep(20)
        return "ok"
      },
    })
    expect(result).toBe("ok")
  })

  it("runs idle cleanup before rejecting", async () => {
    let cleaned = false
    await expect(runWithProgressTimeout({
      policy: { label: "idle", idleTimeoutMs: 10, hardTimeoutMs: 200 },
      async run() {
        await sleep(100)
        return "late"
      },
      onIdleTimeout() {
        cleaned = true
      },
    })).rejects.toThrow("idle idle timeout")
    expect(cleaned).toBe(true)
  })

  it("does not treat synthetic heartbeat messages as meaningful progress", async () => {
    let cleaned = false
    await expect(runWithProgressTimeout({
      policy: { label: "heartbeat", idleTimeoutMs: 20, hardTimeoutMs: 200 },
      async run(signal) {
        for (let i = 0; i < 5; i++) {
          await sleep(8)
          signal.progress("reviewer prompt still running")
        }
        return "late"
      },
      onIdleTimeout() {
        cleaned = true
      },
    })).rejects.toThrow("heartbeat idle timeout")
    expect(cleaned).toBe(true)
  })

  it("does not extend beyond hard timeout", async () => {
    let cleaned = false
    await expect(runWithProgressTimeout({
      policy: { label: "hard", idleTimeoutMs: 30, hardTimeoutMs: 50 },
      async run(signal) {
        for (let i = 0; i < 10; i++) {
          await sleep(10)
          signal.progress("tick")
        }
        return "late"
      },
      onHardTimeout() {
        cleaned = true
      },
    })).rejects.toThrow("hard hard timeout")
    expect(cleaned).toBe(true)
  })
})
