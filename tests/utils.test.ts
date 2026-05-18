/**
 * Tests for utils.ts — shared utilities.
 *
 * Covers:
 * - resolveSessionId: all ID shape variants
 * - withTimeout: resolves on time, rejects on timeout, clears timer on resolve
 */
import { describe, expect, it } from "bun:test"
import { resolveSessionId, withTimeout, getNextActionForState, extractEphemeralSessionId, extractTextFromPromptResult } from "#core/utils"

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

describe("extractEphemeralSessionId", () => {
  it("extracts data.id from SDK create envelopes", () => {
    expect(extractEphemeralSessionId({ data: { id: "ses-data" } })).toBe("ses-data")
  })

  it("extracts nested session id variants from OpenCode create envelopes", () => {
    expect(extractEphemeralSessionId({ data: { session: { id: "ses-nested" } } })).toBe("ses-nested")
    expect(extractEphemeralSessionId({ data: { info: { sessionID: "ses-info" } } })).toBe("ses-info")
    expect(extractEphemeralSessionId({ result: { sessionId: "ses-result" } })).toBe("ses-result")
  })

  it("extracts event-shaped and array-wrapped session ids", () => {
    expect(extractEphemeralSessionId({ properties: { info: { id: "ses-event" } } })).toBe("ses-event")
    expect(extractEphemeralSessionId({ data: [{ session_id: "ses-array" }] })).toBe("ses-array")
  })

  it("includes a response summary when session id extraction fails", () => {
    expect(() => extractEphemeralSessionId({ properties: { info: { title: "missing" } } }, "reviewer")).toThrow("reviewer: could not extract session ID from session.create() response:")
  })
})

describe("extractTextFromPromptResult", () => {
  it("extracts text from data.parts prompt envelopes", () => {
    expect(extractTextFromPromptResult({ data: { parts: [{ type: "text", text: "hello" }] } })).toBe("hello")
  })

  it("extracts text from nested OpenCode prompt envelopes", () => {
    expect(extractTextFromPromptResult({ data: { message: { parts: [{ type: "text", text: "nested" }] } } })).toBe("nested")
    expect(extractTextFromPromptResult({ result: { output: { parts: [{ content: "content text" }] } } })).toBe("content text")
  })

  it("extracts text from message history arrays", () => {
    expect(extractTextFromPromptResult({ data: [{ info: { id: "msg-1" }, parts: [{ type: "text", text: "history" }] }] })).toBe("history")
  })

  it("throws a diagnostic for metadata-only prompt envelopes", () => {
    expect(() => extractTextFromPromptResult({ data: { info: { id: "msg-1", role: "assistant" } } }, "reviewer"))
      .toThrow("Cannot extract text from reviewer result")
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

// ---------------------------------------------------------------------------
// getNextActionForState — shared next-action mapping
// ---------------------------------------------------------------------------

describe("getNextActionForState", () => {
  it("returns completion message for DONE", () => {
    expect(getNextActionForState("DONE", "DRAFT")).toContain("complete")
  })

  it("returns mode selection instruction for MODE_SELECT", () => {
    const result = getNextActionForState("MODE_SELECT", "DRAFT")
    expect(result).toContain("select_mode")
    expect(result).toContain("GREENFIELD")
  })

  it("returns mark_scan_complete for SCAN", () => {
    const result = getNextActionForState("DISCOVERY", "SCAN")
    expect(result).toContain("mark_scan_complete")
    expect(result).toContain("do not wait for user input")
  })

  it("returns mark_analyze_complete for ANALYZE", () => {
    const result = getNextActionForState("DISCOVERY", "ANALYZE")
    expect(result).toContain("mark_analyze_complete")
    expect(result).toContain("do not wait for user input")
  })

  it("returns request_review for DRAFT", () => {
    const result = getNextActionForState("PLANNING", "DRAFT")
    expect(result).toContain("request_review")
    expect(result).toContain("do not wait for user input")
  })

  it("returns request_review for CONVENTIONS", () => {
    expect(getNextActionForState("DISCOVERY", "CONVENTIONS")).toContain("request_review")
  })

  it("returns mark_satisfied for REVIEW", () => {
    const result = getNextActionForState("INTERFACES", "REVIEW")
    expect(result).toContain("mark_satisfied")
    expect(result).toContain("do not wait for user input")
  })

  it("returns wait instruction for USER_GATE", () => {
    const result = getNextActionForState("TESTS", "USER_GATE")
    expect(result.toLowerCase()).toContain("wait")
  })

  it("returns request_review for REVISE", () => {
    expect(getNextActionForState("IMPL_PLAN", "REVISE")).toContain("request_review")
  })

  it("includes phase name in DRAFT instruction", () => {
    expect(getNextActionForState("PLANNING", "DRAFT")).toContain("PLANNING")
  })

  it("returns generic fallback for unknown sub-state", () => {
    const result = getNextActionForState("PLANNING", "UNKNOWN_STATE")
    expect(result).toContain("PLANNING")
    expect(result).toContain("UNKNOWN_STATE")
  })
})
