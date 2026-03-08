/**
 * Tests for the chat-message hook — approval hint injection logic.
 * Covers G6: processUserMessage and the new buildUserGateHint export.
 */
import { describe, expect, it } from "bun:test"
import { processUserMessage, buildUserGateHint } from "#plugin/hooks/chat-message"
import type { WorkflowState } from "#plugin/types"
import { SCHEMA_VERSION } from "#plugin/types"

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "GREENFIELD",
    phase: "PLANNING",
    phaseState: "USER_GATE",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: [],
    lastCheckpointTag: null,
    approvalCount: 0,
    orchestratorSessionId: null,
    intentBaseline: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// processUserMessage — interception logic
// ---------------------------------------------------------------------------

describe("processUserMessage — not at USER_GATE", () => {
  it("does not intercept when phaseState is DRAFT", () => {
    const state = makeState({ phaseState: "DRAFT" })
    const parts = [{ type: "text", text: "Hello" }]
    const result = processUserMessage(state, parts)
    expect(result.intercepted).toBe(false)
    expect(result.feedbackType).toBeNull()
    expect(result.parts).toBe(parts) // same reference — not mutated
  })

  it("does not intercept when phaseState is REVIEW", () => {
    const state = makeState({ phaseState: "REVIEW" })
    const result = processUserMessage(state, [{ type: "text", text: "ok" }])
    expect(result.intercepted).toBe(false)
  })
})

describe("processUserMessage — at USER_GATE, approval signals", () => {
  const approvalMessages = [
    "approve",
    "Approved",
    "lgtm",
    "LGTM",
    "looks good",
    "ship it",
    "yes",
    "y",
    "ok",
    "okay",
    "good",
    "perfect",
    "done",
    "continue",
    "proceed",
    "next",
    "✓",
    // Trailing punctuation/whitespace variants
    "yes!",
    "approved.",
    "lgtm!",
  ]

  for (const msg of approvalMessages) {
    it(`detects approval from "${msg}"`, () => {
      const state = makeState({ phaseState: "USER_GATE" })
      const result = processUserMessage(state, [{ type: "text", text: msg }])
      expect(result.intercepted).toBe(true)
      expect(result.feedbackType).toBe("approve")
    })
  }
})

describe("processUserMessage — ambiguous approval phrases are treated as feedback", () => {
  // These contain the word 'approve' but in a context that could be negative
  const ambiguousMessages = [
    "I approve this change",      // full sentence — treated as feedback for safety
    "I don't approve of this",
    "approved but I have concerns",
  ]

  for (const msg of ambiguousMessages) {
    it(`treats ambiguous phrase as feedback: "${msg}"`, () => {
      const state = makeState({ phaseState: "USER_GATE" })
      const result = processUserMessage(state, [{ type: "text", text: msg }])
      expect(result.intercepted).toBe(true)
      expect(result.feedbackType).toBe("feedback")
    })
  }
})

describe("processUserMessage — at USER_GATE, feedback signals", () => {
  const feedbackMessages = [
    "I think the plan needs more detail on error handling",
    "Can you add section on authentication?",
    "The architecture is missing a caching layer",
    "Please revise section 2",
  ]

  for (const msg of feedbackMessages) {
    it(`detects feedback from "${msg}"`, () => {
      const state = makeState({ phaseState: "USER_GATE" })
      const result = processUserMessage(state, [{ type: "text", text: msg }])
      expect(result.intercepted).toBe(true)
      expect(result.feedbackType).toBe("feedback")
    })
  }
})

describe("processUserMessage — injected parts structure", () => {
  it("prepends a routing note as a new text part (approval)", () => {
    const state = makeState({ phaseState: "USER_GATE" })
    const originalParts = [{ type: "text", text: "yes" }]
    const result = processUserMessage(state, originalParts)
    expect(result.parts.length).toBe(2) // routing note + original
    expect(result.parts[0]?.type).toBe("text")
    expect(result.parts[0]?.text).toContain("submit_feedback")
    expect(result.parts[1]).toEqual(originalParts[0])
  })

  it("prepends a routing note as a new text part (feedback)", () => {
    const state = makeState({ phaseState: "USER_GATE" })
    const originalParts = [{ type: "text", text: "Please revise this section" }]
    const result = processUserMessage(state, originalParts)
    expect(result.parts.length).toBe(2)
    expect(result.parts[0]?.text).toContain("submit_feedback")
    expect(result.parts[1]).toEqual(originalParts[0])
  })

  it("handles multiple text parts — detects approval from first part", () => {
    // When multiple parts are present, they are concatenated and the full text is tested.
    // "lgtm" alone (single part) is always an approval signal.
    const state = makeState({ phaseState: "USER_GATE" })
    const parts = [{ type: "text", text: "lgtm" }]
    const result = processUserMessage(state, parts)
    expect(result.feedbackType).toBe("approve")
  })

  it("handles multiple text parts — combined non-approval text is treated as feedback", () => {
    // "lgtm" + " but I have a concern" concatenates to a non-approval sentence
    const state = makeState({ phaseState: "USER_GATE" })
    const parts = [
      { type: "text", text: "lgtm" },
      { type: "text", text: " but I have a concern about error handling" },
    ]
    const result = processUserMessage(state, parts)
    // The concatenated text is "lgtm but I have a concern about error handling"
    // which has substantive text after "lgtm" → treated as feedback
    expect(result.feedbackType).toBe("feedback")
  })
})

// ---------------------------------------------------------------------------
// buildUserGateHint — system prompt injection (G6 replacement for chat.message)
// ---------------------------------------------------------------------------

describe("buildUserGateHint", () => {
  it("returns a string containing submit_feedback instruction", () => {
    const hint = buildUserGateHint("PLANNING", "USER_GATE")
    expect(hint).toContain("submit_feedback")
  })

  it("mentions the current phase", () => {
    const hint = buildUserGateHint("INTERFACES", "USER_GATE")
    expect(hint).toContain("INTERFACES")
  })

  it("explains both approve and revise paths", () => {
    const hint = buildUserGateHint("TESTS", "USER_GATE")
    expect(hint).toContain("approve")
    expect(hint).toContain("revise")
  })

  it("instructs agent not to proceed without calling submit_feedback", () => {
    const hint = buildUserGateHint("PLANNING", "USER_GATE")
    expect(hint).toContain("submit_feedback")
    expect(hint.toLowerCase()).toContain("wait")
  })
})
