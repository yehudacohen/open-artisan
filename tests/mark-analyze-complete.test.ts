/**
 * mark-analyze-complete.test.ts — Tests for mark_analyze_complete tool handler.
 */
import { describe, it, expect } from "bun:test"
import { processMarkAnalyzeComplete } from "#plugin/tools/mark-analyze-complete"

describe("processMarkAnalyzeComplete", () => {
  it("returns a response message containing the summary", () => {
    const result = processMarkAnalyzeComplete({ analysis_summary: "Architecture is modular" })
    expect(result.responseMessage).toContain("Architecture is modular")
  })

  it("includes transition instructions for CONVENTIONS state", () => {
    const result = processMarkAnalyzeComplete({ analysis_summary: "Analysis done" })
    expect(result.responseMessage).toContain("CONVENTIONS")
    expect(result.responseMessage).toContain("request_review")
  })

  it("includes conventions document structure guidance", () => {
    const result = processMarkAnalyzeComplete({ analysis_summary: "All good" })
    expect(result.responseMessage).toContain("Naming conventions")
    expect(result.responseMessage).toContain("Architecture patterns")
    expect(result.responseMessage).toContain("Testing conventions")
  })

  it("truncates long summaries at 500 chars", () => {
    const long = "y".repeat(600)
    const result = processMarkAnalyzeComplete({ analysis_summary: long })
    expect(result.responseMessage).toContain("...")
    expect(result.responseMessage).not.toContain("y".repeat(600))
  })

  it("does not truncate short summaries", () => {
    const short = "Brief analysis."
    const result = processMarkAnalyzeComplete({ analysis_summary: short })
    expect(result.responseMessage).toContain(short)
    expect(result.responseMessage).not.toContain("...")
  })

  it("handles empty summary gracefully", () => {
    const result = processMarkAnalyzeComplete({ analysis_summary: "" })
    expect(result.responseMessage).toContain("Analysis complete")
  })

  it("response message is a string", () => {
    const result = processMarkAnalyzeComplete({ analysis_summary: "test" })
    expect(typeof result.responseMessage).toBe("string")
  })

  it("preserves special characters in summary", () => {
    const result = processMarkAnalyzeComplete({ analysis_summary: "Pattern: fn<T>() => Promise<T>" })
    expect(result.responseMessage).toContain("fn<T>")
  })

  it("handles whitespace-only summary like empty", () => {
    const result = processMarkAnalyzeComplete({ analysis_summary: "   " })
    expect(result.responseMessage).toContain("Analysis complete")
  })
})
