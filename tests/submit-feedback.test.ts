/**
 * Tests for processSubmitFeedback.
 */
import { describe, expect, it } from "bun:test"
import { processSubmitFeedback } from "#plugin/tools/submit-feedback"

describe("processSubmitFeedback — approve path", () => {
  it("returns feedbackType='approve'", () => {
    const result = processSubmitFeedback({
      feedback_text: "Looks great!",
      feedback_type: "approve",
    })
    expect(result.feedbackType).toBe("approve")
  })

  it("preserves feedback_text in feedbackText", () => {
    const result = processSubmitFeedback({
      feedback_text: "LGTM",
      feedback_type: "approve",
    })
    expect(result.feedbackText).toBe("LGTM")
  })

  it("approve responseMessage mentions checkpoint or advancing", () => {
    const result = processSubmitFeedback({
      feedback_text: "Approved",
      feedback_type: "approve",
    })
    // Should mention git checkpoint and/or next phase
    const msg = result.responseMessage.toLowerCase()
    expect(
      msg.includes("checkpoint") || msg.includes("next phase") || msg.includes("advance"),
    ).toBe(true)
  })
})

describe("processSubmitFeedback — revise path", () => {
  it("returns feedbackType='revise'", () => {
    const result = processSubmitFeedback({
      feedback_text: "Please fix the error handling",
      feedback_type: "revise",
    })
    expect(result.feedbackType).toBe("revise")
  })

  it("preserves feedback_text in feedbackText", () => {
    const result = processSubmitFeedback({
      feedback_text: "Fix the error handling",
      feedback_type: "revise",
    })
    expect(result.feedbackText).toBe("Fix the error handling")
  })

  it("revise responseMessage includes the feedback text (truncated)", () => {
    const feedback = "The function is missing a null check"
    const result = processSubmitFeedback({
      feedback_text: feedback,
      feedback_type: "revise",
    })
    expect(result.responseMessage).toContain(feedback)
  })

  it("revise responseMessage truncates very long feedback at 200 chars", () => {
    const longFeedback = "x".repeat(250)
    const result = processSubmitFeedback({
      feedback_text: longFeedback,
      feedback_type: "revise",
    })
    // Should contain "..." indicating truncation
    expect(result.responseMessage).toContain("...")
    // The message should not contain the full 250-char string verbatim
    expect(result.responseMessage).not.toContain(longFeedback)
  })

  it("revise responseMessage does NOT say 'wait for routing instructions' (M3 fix)", () => {
    const result = processSubmitFeedback({
      feedback_text: "needs changes",
      feedback_type: "revise",
    })
    expect(result.responseMessage.toLowerCase()).not.toContain("wait for routing")
  })

  it("revise responseMessage says to begin revision now (M3 fix)", () => {
    const result = processSubmitFeedback({
      feedback_text: "needs changes",
      feedback_type: "revise",
    })
    const msg = result.responseMessage.toLowerCase()
    expect(msg.includes("begin") || msg.includes("revise") || msg.includes("revision")).toBe(true)
  })
})
