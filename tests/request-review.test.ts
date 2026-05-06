/**
 * Tests for processRequestReview.
 */
import { describe, expect, it } from "bun:test"
import { processRequestReview } from "#core/tools/request-review"

function requestReviewArgs(overrides: { summary: string; artifact_description: string }) {
  return { ...overrides, artifact_files: ["/tmp/artifact.md"] }
}

describe("processRequestReview — response message", () => {
  it("includes the summary in the response message", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "Implemented user auth service",
      artifact_description: "auth.ts — 3 functions exported",
    }))
    expect(result.responseMessage).toContain("Implemented user auth service")
  })

  it("includes the artifact description in the response message", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "Done",
      artifact_description: "types.ts — 5 interfaces",
    }))
    expect(result.responseMessage).toContain("types.ts — 5 interfaces")
  })

  it("response message mentions REVIEW state", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.responseMessage).toContain("REVIEW")
  })

  it("response message instructs to call mark_satisfied", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.responseMessage).toContain("mark_satisfied")
  })
})

describe("processRequestReview — phase instructions", () => {
  it("includes acceptance criteria instructions", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.phaseInstructions).toContain("acceptance criteria")
  })

  it("instructs to call mark_satisfied", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.phaseInstructions).toContain("mark_satisfied")
  })

  it("both responseMessage and phaseInstructions are non-empty strings", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "anything",
      artifact_description: "any artifact",
    }))
    expect(typeof result.responseMessage).toBe("string")
    expect(result.responseMessage.length).toBeGreaterThan(0)
    expect(typeof result.phaseInstructions).toBe("string")
    expect(result.phaseInstructions.length).toBeGreaterThan(0)
  })

  it("handles empty summary and description gracefully", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "",
      artifact_description: "",
    }))
    expect(result.responseMessage.length).toBeGreaterThan(0)
    expect(result.phaseInstructions.length).toBeGreaterThan(0)
  })

  it("preserves special characters in summary", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "Built types<T> and Promise<Result>",
      artifact_description: "api.ts",
    }))
    expect(result.responseMessage).toContain("types<T>")
  })

  it("instructs to read actual files before evaluating", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    // Ensures the review instructions emphasize file reading
    expect(result.phaseInstructions.toLowerCase()).toContain("read")
  })
})
