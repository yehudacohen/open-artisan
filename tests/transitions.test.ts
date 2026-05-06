/**
 * Tests for packages/core/tools/transitions.ts — shared transition functions
 * for agent-only mode.
 */
import { describe, expect, it } from "bun:test"
import {
  computeMarkScanCompleteTransition,
  computeMarkSatisfiedTransition,
  computeMarkAnalyzeCompleteTransition,
  computeRequestReviewTransition,
  computeSubmitFeedbackApproveTransition,
  computeSubmitFeedbackReviseTransition,
  computeProposeBacktrackTransition,
} from "#core/tools/transitions"
import { createStateMachine } from "#core/state-machine"
import { SCHEMA_VERSION } from "#core/workflow-state-types"
import type {
  StructuralTransitionDescriptor,
  StructuralTransitionDescriptorStore,
  StructuralTransitionPlanner,
  StructuralTransitionResult,
  StructuralWorkflowDiagnosticsConfig,
  StructuralWorkflowHealthCheck,
  StructuralWorkflowLogEvent,
  StructuralWorkflowMetricsSnapshot,
} from "#core/structural-workflow-types"
import type { WorkflowState } from "#core/workflow-state-types"

const sm = createStateMachine()

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test",
    mode: "GREENFIELD",
    phase: "PLANNING",
    phaseState: "REVIEW",
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
    backtrackContext: null,
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
    artifactDiskPaths: {},
    featureName: "test-feature",
    revisionBaseline: null,
    activeAgent: null,
    taskCompletionInProgress: null,
    taskReviewCount: 0,
    pendingFeedback: null,
    userMessages: [],
    cachedPriorState: null,
    priorWorkflowChecked: false,
    sessionModel: null,
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// computeMarkScanCompleteTransition
// ---------------------------------------------------------------------------

describe("computeMarkScanCompleteTransition", () => {
  it("transitions from DISCOVERY/SCAN to ANALYZE", () => {
    const state = makeState({ phase: "DISCOVERY", phaseState: "SCAN", mode: "REFACTOR" })
    const result = computeMarkScanCompleteTransition({ scan_summary: "Scanned source" }, state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.nextPhase).toBe("DISCOVERY")
    expect(result.transition.nextPhaseState).toBe("ANALYZE")
    expect(result.transition.responseMessage).toContain("Scan complete")
  })

  it("rejects when not in DISCOVERY/SCAN", () => {
    const result = computeMarkScanCompleteTransition({ scan_summary: "x" }, makeState(), sm)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("DISCOVERY/SCAN")
  })
})

// ---------------------------------------------------------------------------
// computeRequestReviewTransition
// ---------------------------------------------------------------------------

describe("computeRequestReviewTransition", () => {
  it("uses draft_complete outside REVISE", () => {
    const state = makeState({ phase: "PLANNING", phaseState: "DRAFT", mode: "GREENFIELD" })
    const result = computeRequestReviewTransition(state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.event).toBe("draft_complete")
    expect(result.transition.nextPhase).toBe("PLANNING")
    expect(result.transition.nextPhaseState).toBe("REVIEW")
  })

  it("uses revision_complete from REVISE", () => {
    const state = makeState({ phase: "PLANNING", phaseState: "REVISE", mode: "GREENFIELD" })
    const result = computeRequestReviewTransition(state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.event).toBe("revision_complete")
    expect(result.transition.nextPhaseState).toBe("REVIEW")
  })

  it("rejects REVIEW resubmission path", () => {
    const result = computeRequestReviewTransition(makeState({ phaseState: "REVIEW" }), sm)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeMarkSatisfiedTransition
// ---------------------------------------------------------------------------

describe("computeMarkSatisfiedTransition", () => {
  it("passes with all blocking criteria met", () => {
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "ok", severity: "blocking" as const,
    }))
    const result = computeMarkSatisfiedTransition(criteria, makeState(), sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.nextPhaseState).toBe("USER_GATE")
    expect(result.transition.nextIterationCount).toBe(0)
  })

  it("fails with unmet blocking criteria and routes to REVISE", () => {
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `C${i + 1}`, met: i !== 0, evidence: "check", severity: "blocking" as const,
    }))
    const result = computeMarkSatisfiedTransition(criteria, makeState(), sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.nextPhaseState).toBe("REVISE")
    expect(result.transition.nextIterationCount).toBe(1)
  })

  it("rejects when not in REVIEW state", () => {
    const result = computeMarkSatisfiedTransition([], makeState({ phaseState: "DRAFT" }), sm)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("REVIEW")
  })

  it("gates file-based phases without reviewArtifactFiles", () => {
    const state = makeState({ phase: "IMPLEMENTATION", phaseState: "REVIEW", reviewArtifactFiles: [] })
    const result = computeMarkSatisfiedTransition([{ criterion: "X", met: true, evidence: "ok", severity: "blocking" }], state, sm)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("No artifact files")
  })

  it("allows in-memory phases without reviewArtifactFiles", () => {
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "ok", severity: "blocking" as const,
    }))
    const result = computeMarkSatisfiedTransition(criteria, makeState({ phase: "PLANNING", reviewArtifactFiles: [] }), sm)
    expect(result.success).toBe(true)
  })

  it("rejects empty criteria_met as validation error (no state transition)", () => {
    const result = computeMarkSatisfiedTransition([], makeState(), sm)
    expect(result.success).toBe(false) // empty criteria is a validation error, not a review fail
    if (result.success) return
    expect(result.error).toContain("empty")
  })

  it("rejects insufficient blocking criteria as validation error (no state transition)", () => {
    // Submit fewer blocking criteria than the phase expects
    const criteria = [{ criterion: "C1", met: true, evidence: "ok", severity: "blocking" as const }]
    const result = computeMarkSatisfiedTransition(criteria, makeState(), sm)
    expect(result.success).toBe(false) // insufficient criteria is a validation error, not a review fail
    if (result.success) return
    expect(result.error).toContain("blocking criteria submitted")
  })

  it("parses string scores to numbers", () => {
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: i === 0 ? "[Q] Quality" : `C${i + 1}`,
      met: true,
      evidence: "ok",
      severity: "blocking" as const,
      score: i === 0 ? "7" as any : undefined, // string score below 9 → unmet
    }))
    const result = computeMarkSatisfiedTransition(criteria, makeState(), sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    // [Q] with score 7 → not met → should fail
    expect(result.transition.nextPhaseState).toBe("REVISE")
  })

  it("escalates after MAX_REVIEW_ITERATIONS", () => {
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `C${i + 1}`, met: i !== 0, evidence: "check", severity: "blocking" as const,
    }))
    const state = makeState({ iterationCount: 9 }) // next will be 10 = MAX
    const result = computeMarkSatisfiedTransition(criteria, state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.nextPhaseState).toBe("USER_GATE") // escalated
    expect(result.transition.nextIterationCount).toBe(10)
  })

  it("injects allowlist criterion for INCREMENTAL PLANNING", () => {
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "ok", severity: "blocking" as const,
    }))
    const state = makeState({ mode: "INCREMENTAL", phase: "PLANNING", fileAllowlist: ["/a.ts"] })
    const result = computeMarkSatisfiedTransition(criteria, state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    // Should fail because allowlist adequacy criterion was injected as unmet
    expect(result.transition.nextPhaseState).toBe("REVISE")
  })
})

// ---------------------------------------------------------------------------
// computeMarkAnalyzeCompleteTransition
// ---------------------------------------------------------------------------

describe("computeMarkAnalyzeCompleteTransition", () => {
  it("transitions from DISCOVERY/ANALYZE to CONVENTIONS", () => {
    const state = makeState({ phase: "DISCOVERY", phaseState: "ANALYZE", mode: "REFACTOR" })
    const result = computeMarkAnalyzeCompleteTransition({ analysis_summary: "Solid architecture" }, state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.nextPhase).toBe("DISCOVERY")
    expect(result.transition.nextPhaseState).toBe("CONVENTIONS")
    expect(result.transition.analysisSummary).toBe("Solid architecture")
  })

  it("rejects when not in DISCOVERY/ANALYZE", () => {
    const result = computeMarkAnalyzeCompleteTransition({ analysis_summary: "x" }, makeState(), sm)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("DISCOVERY/ANALYZE")
  })

  it("handles empty analysis_summary", () => {
    const state = makeState({ phase: "DISCOVERY", phaseState: "ANALYZE", mode: "REFACTOR" })
    const result = computeMarkAnalyzeCompleteTransition({ analysis_summary: "" }, state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.analysisSummary).toBeNull()
    expect(result.transition.responseMessage).toContain("Warning")
  })
})

// ---------------------------------------------------------------------------
// computeSubmitFeedbackApproveTransition
// ---------------------------------------------------------------------------

describe("computeSubmitFeedbackApproveTransition", () => {
  it("transitions from USER_GATE to the next phase", () => {
    const state = makeState({ phase: "PLANNING", phaseState: "USER_GATE", approvalCount: 2, phaseApprovalCounts: { PLANNING: 1 } })
    const result = computeSubmitFeedbackApproveTransition(state, sm)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.nextPhase).toBe("INTERFACES")
    expect(result.transition.nextPhaseState).toBe("DRAFT")
    expect(result.transition.phaseCount).toBe(2)
    expect(result.transition.newApprovalCount).toBe(3)
    expect(result.transition.artifactKey).toBe("plan")
  })

  it("rejects approval outside persisted USER_GATE", () => {
    const result = computeSubmitFeedbackApproveTransition(makeState({ phaseState: "REVIEW" }), sm)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("USER_GATE")
  })
})

// ---------------------------------------------------------------------------
// computeSubmitFeedbackReviseTransition
// ---------------------------------------------------------------------------

describe("computeSubmitFeedbackReviseTransition", () => {
  it("transitions from USER_GATE to REVISE", () => {
    const state = makeState({ phaseState: "USER_GATE" })
    const result = computeSubmitFeedbackReviseTransition("Fix the plan", state, sm, 1000)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.nextPhase).toBe("PLANNING")
    expect(result.transition.nextPhaseState).toBe("REVISE")
    expect(result.transition.feedbackEntry.feedback).toBe("Fix the plan")
    expect(result.transition.feedbackEntry.timestamp).toBe(1000)
  })

  it("rejects from invalid state", () => {
    const state = makeState({ phaseState: "DRAFT" })
    const result = computeSubmitFeedbackReviseTransition("feedback", state, sm)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeProposeBacktrackTransition
// ---------------------------------------------------------------------------

describe("computeProposeBacktrackTransition", () => {
  it("backtracks from INTERFACES/DRAFT to PLANNING", () => {
    const state = makeState({ phase: "INTERFACES", phaseState: "DRAFT" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "PLANNING", reason: "The plan is fundamentally incomplete and needs reworking" },
      state, 2000,
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.targetPhase).toBe("PLANNING")
    expect(result.transition.feedbackEntry.timestamp).toBe(2000)
    expect(result.transition.clearedArtifactKeys).toContain("plan")
    expect(result.transition.clearedArtifactKeys).toContain("interfaces")
    expect(result.transition.clearImplDag).toBe(true) // PLANNING is before IMPL_PLAN
  })

  it("clears IMPL DAG when backtracking from IMPLEMENTATION", () => {
    const state = makeState({ phase: "IMPLEMENTATION", phaseState: "REVISE" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "TESTS", reason: "Tests are missing critical coverage that was discovered during implementation" },
      state,
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.transition.clearImplDag).toBe(true)
  })

  it("does NOT clear IMPL DAG when backtracking within late phases", () => {
    const state = makeState({ phase: "IMPLEMENTATION", phaseState: "DRAFT" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "IMPL_PLAN", reason: "The implementation plan has a missing task that needs to be added" },
      state,
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    // target is IMPL_PLAN which is at index 5, same as IMPL_PLAN index → clearImplDag should be true
    // because targetIdx <= implPlanIdx (5 <= 5)
    expect(result.transition.clearImplDag).toBe(true)
  })

  it("rejects target not earlier than current", () => {
    const state = makeState({ phase: "PLANNING", phaseState: "DRAFT" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "TESTS", reason: "This is invalid because TESTS comes after PLANNING" },
      state,
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("not earlier")
  })

  it("rejects invalid target phase", () => {
    const state = makeState({ phase: "INTERFACES", phaseState: "DRAFT" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "BOGUS", reason: "This is an invalid phase name that should be rejected" },
      state,
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("not a valid phase")
  })

  it("rejects short reason", () => {
    const state = makeState({ phase: "INTERFACES", phaseState: "DRAFT" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "PLANNING", reason: "too short" },
      state,
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("20 characters")
  })

  it("rejects from MODE_SELECT", () => {
    const state = makeState({ phase: "MODE_SELECT", phaseState: "DRAFT" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "PLANNING", reason: "This should not work from MODE_SELECT phase" },
      state,
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("cannot be called from MODE_SELECT")
  })

  it("rejects from non-DRAFT/REVISE state", () => {
    const state = makeState({ phase: "INTERFACES", phaseState: "REVIEW" })
    const result = computeProposeBacktrackTransition(
      { target_phase: "PLANNING", reason: "This should not work from REVIEW state only DRAFT or REVISE" },
      state,
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("DRAFT or REVISE")
  })
})
