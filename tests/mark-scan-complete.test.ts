/**
 * mark-scan-complete.test.ts — Tests for mark_scan_complete tool handler.
 */
import { describe, it, expect } from "bun:test"
import { processMarkScanComplete } from "#core/tools/mark-scan-complete"

describe("processMarkScanComplete", () => {
  it("returns a response message containing the summary", () => {
    const result = processMarkScanComplete({ scan_summary: "Found 42 source files" })
    expect(result.responseMessage).toContain("Found 42 source files")
  })

  it("includes transition instructions for ANALYZE state", () => {
    const result = processMarkScanComplete({ scan_summary: "Scanned everything" })
    expect(result.responseMessage).toContain("ANALYZE")
    expect(result.responseMessage).toContain("mark_analyze_complete")
  })

  it("truncates long summaries at 500 chars", () => {
    const long = "x".repeat(600)
    const result = processMarkScanComplete({ scan_summary: long })
    expect(result.responseMessage).toContain("...")
    expect(result.responseMessage).not.toContain("x".repeat(600))
  })

  it("does not truncate short summaries", () => {
    const short = "Short summary."
    const result = processMarkScanComplete({ scan_summary: short })
    expect(result.responseMessage).toContain(short)
    expect(result.responseMessage).not.toContain("...")
  })

  it("handles empty summary gracefully", () => {
    const result = processMarkScanComplete({ scan_summary: "" })
    expect(result.responseMessage).toContain("Warning: Empty scan summary")
    expect(result.responseMessage).toContain("ANALYZE")
  })

  it("response message is a string", () => {
    const result = processMarkScanComplete({ scan_summary: "test" })
    expect(typeof result.responseMessage).toBe("string")
  })

  it("preserves special characters in summary", () => {
    const result = processMarkScanComplete({ scan_summary: "Found <html> & 'quoted' files" })
    expect(result.responseMessage).toContain("<html>")
    expect(result.responseMessage).toContain("&")
  })

  it("handles whitespace-only summary like empty", () => {
    const result = processMarkScanComplete({ scan_summary: "   " })
    expect(result.responseMessage).toContain("Warning: Empty scan summary")
    expect(result.responseMessage).toContain("ANALYZE")
  })
})
