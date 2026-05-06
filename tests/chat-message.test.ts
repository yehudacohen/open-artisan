/**
 * Tests for the chat-message hook — approval hint injection logic.
 * Covers G6: processUserMessage and the new buildUserGateHint export.
 */
import { describe, expect, it } from "bun:test"
import { processUserMessage, buildUserGateHint } from "#core/hooks/chat-message"
import { SCHEMA_VERSION, type WorkflowState } from "#core/workflow-state-types"

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
    modeDetectionNote: null,
    discoveryReport: null,
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    currentTaskId: null,
    feedbackHistory: [],
    userGateMessageReceived: false,
    artifactDiskPaths: {},
    featureName: null,
    revisionBaseline: null,
    activeAgent: null,
    taskCompletionInProgress: null,
    taskReviewCount: 0,
    pendingFeedback: null,
    userMessages: [],
    cachedPriorState: null,
    priorWorkflowChecked: false,
    sessionModel: null,
    reviewArtifactHash: null,
    latestReviewResults: null,
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
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
    "ok, approved",
    "yes and proceed",
    "approved, thanks",
    "yes please",
    "do you think this design is the right design? If you do, I approve",
    "if so, approved",
    "I approve this change",
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
    "I don't approve of this",
    "approved but I have concerns",
    "approved, but I have one concern",
    "approved, please fix the missing test",
    "yes, but add logging first",
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

describe("processUserMessage — at USER_GATE, review clarification", () => {
  const clarificationMessages = [
    "okay, so what am i reviewing?",
    "What should I review here?",
    "Which files am I reviewing?",
    "Where are the review assets?",
    "Can you summarize what I am reviewing?",
    "have we implemented all the implementation tasks? How has your experience with open-artisan been?",
    "Did all tests pass?",
    "How was your experience with Open Artisan?",
    "Do you think this design is right?",
    "Can you update me on progress?",
    "What changed since the last review?",
  ]

  for (const msg of clarificationMessages) {
    it(`does not route clarification as feedback: "${msg}"`, () => {
      const state = makeState({ phaseState: "USER_GATE", phase: "IMPLEMENTATION" })
      const parts = [{ type: "text", text: msg }]
      const result = processUserMessage(state, parts)
      expect(result.intercepted).toBe(false)
      expect(result.feedbackType).toBeNull()
      expect(result.parts).toBe(parts)
    })
  }

  it("still routes change-request questions as feedback", () => {
    const state = makeState({ phaseState: "USER_GATE" })
    const result = processUserMessage(state, [{ type: "text", text: "Can you add section on authentication?" }])
    expect(result.intercepted).toBe(true)
    expect(result.feedbackType).toBe("feedback")
  })
})

describe("processUserMessage — ESCAPE_HATCH clarification", () => {
  it("does not route escape-hatch clarification as a decision", () => {
    const state = makeState({ phaseState: "ESCAPE_HATCH", phase: "PLANNING" })
    const parts = [{ type: "text", text: "What is the escape hatch and what are my options?" }]
    const result = processUserMessage(state, parts)
    expect(result.intercepted).toBe(false)
    expect(result.feedbackType).toBeNull()
    expect(result.parts).toBe(parts)
  })

  it("still routes actual escape-hatch decisions", () => {
    const state = makeState({ phaseState: "ESCAPE_HATCH", phase: "PLANNING" })
    const result = processUserMessage(state, [{ type: "text", text: "accept the strategic change" }])
    expect(result.intercepted).toBe(true)
    expect(result.feedbackType).toBe("feedback")
  })
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
// processUserMessage — DONE state is a no-op (reset handled in index.ts)
// ---------------------------------------------------------------------------

describe("processUserMessage — at DONE phase", () => {
  it("does not intercept when phase is DONE (phaseState DRAFT)", () => {
    const state = makeState({ phase: "DONE", phaseState: "DRAFT" })
    const parts = [{ type: "text", text: "Build me a new feature" }]
    const result = processUserMessage(state, parts)
    expect(result.intercepted).toBe(false)
    expect(result.feedbackType).toBeNull()
    expect(result.parts).toBe(parts) // same reference — not mutated
  })

  it("does not intercept at MODE_SELECT either", () => {
    const state = makeState({ phase: "MODE_SELECT", phaseState: "DRAFT" })
    const parts = [{ type: "text", text: "Start a new task" }]
    const result = processUserMessage(state, parts)
    expect(result.intercepted).toBe(false)
    expect(result.feedbackType).toBeNull()
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

  it("instructs agent to route artifact decisions through submit_feedback", () => {
    const hint = buildUserGateHint("PLANNING", "USER_GATE")
    expect(hint).toContain("submit_feedback")
    expect(hint).toContain("artifact decision")
  })

  it("does not instruct the agent to submit clarification questions as feedback", () => {
    const hint = buildUserGateHint("IMPLEMENTATION", "USER_GATE")
    expect(hint).toContain("what am I reviewing")
    expect(hint).toContain("Do not call `submit_feedback` for clarification")
    expect(hint).not.toContain("If the user requests changes or asks questions")
  })
})
