/**
 * Tests for the idle-handler — re-prompt logic.
 * Covers G12: ANALYZE sub-state handling, plus full coverage of all states.
 */
import { describe, expect, it } from "bun:test"
import { handleIdle, MAX_RETRIES } from "#plugin/hooks/idle-handler"
import type { WorkflowState } from "#plugin/types"
import { SCHEMA_VERSION } from "#plugin/types"

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "REFACTOR",
    phase: "PLANNING",
    phaseState: "DRAFT",
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Ignore cases (expected idle)
// ---------------------------------------------------------------------------

describe("handleIdle — ignore at expected idle states", () => {
  it("ignores at USER_GATE (agent should be waiting)", () => {
    const state = makeState({ phaseState: "USER_GATE" })
    expect(handleIdle(state).action).toBe("ignore")
  })

  it("ignores at DONE phase", () => {
    const state = makeState({ phase: "DONE", phaseState: "DRAFT" })
    expect(handleIdle(state).action).toBe("ignore")
  })

  it("ignores at MODE_SELECT (agent presenting options)", () => {
    const state = makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null })
    expect(handleIdle(state).action).toBe("ignore")
  })
})

// ---------------------------------------------------------------------------
// Reprompt cases
// ---------------------------------------------------------------------------

describe("handleIdle — reprompt for active states", () => {
  it("reprompts in DRAFT state", () => {
    const state = makeState({ phaseState: "DRAFT", retryCount: 0 })
    const decision = handleIdle(state)
    expect(decision.action).toBe("reprompt")
    if (decision.action !== "reprompt") return
    expect(decision.retryCount).toBe(1)
    expect(decision.message).toBeTruthy()
  })

  it("reprompts in REVIEW state", () => {
    const state = makeState({ phaseState: "REVIEW", retryCount: 0 })
    const decision = handleIdle(state)
    expect(decision.action).toBe("reprompt")
  })

  it("reprompts in REVISE state", () => {
    const state = makeState({ phaseState: "REVISE", retryCount: 0 })
    const decision = handleIdle(state)
    expect(decision.action).toBe("reprompt")
  })

  it("reprompts in SCAN state", () => {
    const state = makeState({ phase: "DISCOVERY", phaseState: "SCAN", retryCount: 0 })
    const decision = handleIdle(state)
    expect(decision.action).toBe("reprompt")
    if (decision.action !== "reprompt") return
    expect(decision.message).toContain("mark_scan_complete")
  })

  // G12: ANALYZE sub-state was previously falling through to generic message
  it("reprompts in ANALYZE state and mentions mark_analyze_complete (G12)", () => {
    const state = makeState({ phase: "DISCOVERY", phaseState: "ANALYZE", retryCount: 0 })
    const decision = handleIdle(state)
    expect(decision.action).toBe("reprompt")
    if (decision.action !== "reprompt") return
    expect(decision.message).toContain("mark_analyze_complete")
  })

  it("increments retryCount on each reprompt", () => {
    const state = makeState({ phaseState: "DRAFT", retryCount: 1 })
    const decision = handleIdle(state)
    expect(decision.action).toBe("reprompt")
    if (decision.action !== "reprompt") return
    expect(decision.retryCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

describe("handleIdle — escalate after MAX_RETRIES", () => {
  it("escalates when retryCount >= MAX_RETRIES", () => {
    const state = makeState({ phaseState: "DRAFT", retryCount: MAX_RETRIES })
    const decision = handleIdle(state)
    expect(decision.action).toBe("escalate")
  })

  it("still reprompts when retryCount === MAX_RETRIES - 1", () => {
    const state = makeState({ phaseState: "DRAFT", retryCount: MAX_RETRIES - 1 })
    const decision = handleIdle(state)
    expect(decision.action).toBe("reprompt")
  })

  it("escalation message mentions the phase and sub-state", () => {
    const state = makeState({ phase: "INTERFACES", phaseState: "REVIEW", retryCount: MAX_RETRIES })
    const decision = handleIdle(state)
    expect(decision.action).toBe("escalate")
    if (decision.action !== "escalate") return
    expect(decision.message).toContain("INTERFACES")
    expect(decision.message).toContain("REVIEW")
  })
})

// ---------------------------------------------------------------------------
// Pure function invariant
// ---------------------------------------------------------------------------

describe("handleIdle — pure function", () => {
  it("does not mutate state", () => {
    const state = makeState({ phaseState: "DRAFT", retryCount: 0 })
    const retryBefore = state.retryCount
    handleIdle(state)
    expect(state.retryCount).toBe(retryBefore)
  })
})
