/**
 * Tests for processRequestReview.
 */
import { describe, expect, it } from "bun:test"
import { processRequestReview } from "#plugin/tools/request-review"

describe("processRequestReview — response message", () => {
  it("includes the summary in the response message", () => {
    const result = processRequestReview({
      summary: "Implemented user auth service",
      artifact_description: "auth.ts — 3 functions exported",
    })
    expect(result.responseMessage).toContain("Implemented user auth service")
  })

  it("includes the artifact description in the response message", () => {
    const result = processRequestReview({
      summary: "Done",
      artifact_description: "types.ts — 5 interfaces",
    })
    expect(result.responseMessage).toContain("types.ts — 5 interfaces")
  })

  it("response message mentions REVIEW state", () => {
    const result = processRequestReview({
      summary: "s",
      artifact_description: "a",
    })
    expect(result.responseMessage).toContain("REVIEW")
  })

  it("response message instructs to call mark_satisfied", () => {
    const result = processRequestReview({
      summary: "s",
      artifact_description: "a",
    })
    expect(result.responseMessage).toContain("mark_satisfied")
  })
})

describe("processRequestReview — phase instructions", () => {
  it("includes acceptance criteria instructions", () => {
    const result = processRequestReview({
      summary: "s",
      artifact_description: "a",
    })
    expect(result.phaseInstructions).toContain("acceptance criteria")
  })

  it("instructs to call mark_satisfied", () => {
    const result = processRequestReview({
      summary: "s",
      artifact_description: "a",
    })
    expect(result.phaseInstructions).toContain("mark_satisfied")
  })

  it("both responseMessage and phaseInstructions are non-empty strings", () => {
    const result = processRequestReview({
      summary: "anything",
      artifact_description: "any artifact",
    })
    expect(typeof result.responseMessage).toBe("string")
    expect(result.responseMessage.length).toBeGreaterThan(0)
    expect(typeof result.phaseInstructions).toBe("string")
    expect(result.phaseInstructions.length).toBeGreaterThan(0)
  })
})
