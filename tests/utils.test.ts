/**
 * Tests for utils.ts — shared utilities.
 *
 * Covers:
 * - resolveSessionId: all ID shape variants
 * - withTimeout: resolves on time, rejects on timeout, clears timer on resolve
 */
import { describe, expect, it } from "bun:test"
import { resolveSessionId, withTimeout } from "#plugin/utils"

// ---------------------------------------------------------------------------
// resolveSessionId
// ---------------------------------------------------------------------------

describe("resolveSessionId", () => {
  it("returns sessionID (capital D) — official ToolContext shape", () => {
    expect(resolveSessionId({ sessionID: "abc" })).toBe("abc")
  })

  it("returns sessionId (camelCase) when sessionID absent", () => {
    expect(resolveSessionId({ sessionId: "def" })).toBe("def")
  })

  it("returns session.id when both top-level variants absent", () => {
    expect(resolveSessionId({ session: { id: "ghi" } })).toBe("ghi")
  })

  it("returns null when no known key present", () => {
    expect(resolveSessionId({})).toBeNull()
  })

  it("prefers sessionID over sessionId", () => {
    expect(resolveSessionId({ sessionID: "capital", sessionId: "lower" })).toBe("capital")
  })
})

// ---------------------------------------------------------------------------
// withTimeout — resolves before timeout
// ---------------------------------------------------------------------------

describe("withTimeout — resolves before timeout", () => {
  it("resolves with the promise value when it settles before timeout", async () => {
    const p = Promise.resolve(42)
    const result = await withTimeout(p, 5_000, "test")
    expect(result).toBe(42)
  })

  it("resolves with a string value", async () => {
    const p = Promise.resolve("hello")
    const result = await withTimeout(p, 5_000, "test")
    expect(result).toBe("hello")
  })

  it("resolves with null", async () => {
    const p = Promise.resolve(null)
    const result = await withTimeout(p, 5_000, "test")
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// withTimeout — rejects on timeout
// ---------------------------------------------------------------------------

describe("withTimeout — rejects on timeout", () => {
  it("rejects with a timeout error when promise takes too long", async () => {
    const neverResolves = new Promise<number>(() => {/* intentionally stalled */})
    await expect(withTimeout(neverResolves, 10, "slow-op")).rejects.toThrow("slow-op timed out after 10ms")
  })

  it("includes the label in the error message", async () => {
    const neverResolves = new Promise<void>(() => {})
    let err: unknown
    try {
      await withTimeout(neverResolves, 10, "self-review")
    } catch (e) {
      err = e
    }
    expect(err instanceof Error).toBe(true)
    expect((err as Error).message).toContain("self-review")
  })
})

// ---------------------------------------------------------------------------
// withTimeout — propagates rejection
// ---------------------------------------------------------------------------

describe("withTimeout — propagates underlying rejection", () => {
  it("propagates rejection from the original promise (before timeout)", async () => {
    const rejected = Promise.reject(new Error("original failure"))
    await expect(withTimeout(rejected, 5_000, "test")).rejects.toThrow("original failure")
  })
})

// ---------------------------------------------------------------------------
// withTimeout — label in error message
// ---------------------------------------------------------------------------

describe("withTimeout — label appears in timeout error", () => {
  it("includes the ms value in the error message", async () => {
    const neverResolves = new Promise<void>(() => {})
    let err: unknown
    try {
      await withTimeout(neverResolves, 50, "discovery scanner")
    } catch (e) {
      err = e
    }
    expect(err instanceof Error).toBe(true)
    expect((err as Error).message).toContain("50ms")
    expect((err as Error).message).toContain("discovery scanner")
  })
})
