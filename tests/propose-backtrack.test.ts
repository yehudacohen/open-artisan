/**
 * Tests for tools/propose-backtrack.ts — agent-initiated backtrack proposals.
 *
 * The handler is pure (no store/IO), so tests exercise the validation guards
 * and orchestrator-based routing without needing mocks for the session store.
 */
import { describe, expect, it, mock } from "bun:test"
import { handleProposeBacktrack } from "#core/tools/propose-backtrack"
import type { WorkflowState, RevisionStep, Orchestrator, OrchestratorPlanResult } from "#core/types"
import { SCHEMA_VERSION } from "#core/types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "GREENFIELD",
    phase: "TESTS",
    phaseState: "DRAFT",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: { plan: "abc123", interfaces: "def456" },
    conventions: null,
    fileAllowlist: [],
    lastCheckpointTag: "workflow/interfaces-v1",
    approvalCount: 3,
    orchestratorSessionId: null,
    intentBaseline: "Build a REST API",
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

function makeOrchestrator(overrides?: {
  revisionSteps?: RevisionStep[]
  classification?: "tactical" | "strategic" | "backtrack"
  throws?: boolean
}): Orchestrator {
  return {
    route: mock(async (): Promise<OrchestratorPlanResult> => {
      if (overrides?.throws) throw new Error("Orchestrator failure")
      return {
        revisionSteps: overrides?.revisionSteps ?? [
          {
            artifact: "plan",
            phase: "PLANNING",
            phaseState: "DRAFT",
            instructions: "Restart the plan from scratch.",
          },
        ],
        classification: overrides?.classification ?? "backtrack",
      }
    }),
  }
}

const VALID_REASON = "The plan's data model is fundamentally wrong — it uses a single table for both users and sessions"

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

describe("propose_backtrack — validation guards", () => {
  it("rejects when phaseState is REVIEW", async () => {
    const state = makeState({ phaseState: "REVIEW" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("DRAFT or REVISE")
  })

  it("rejects when phaseState is USER_GATE", async () => {
    const state = makeState({ phaseState: "USER_GATE" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("DRAFT or REVISE")
  })

  it("rejects when phaseState is ESCAPE_HATCH", async () => {
    const state = makeState({ phaseState: "ESCAPE_HATCH" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("DRAFT or REVISE")
  })

  it("rejects when phase is MODE_SELECT", async () => {
    const state = makeState({ phase: "MODE_SELECT", phaseState: "DRAFT" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("MODE_SELECT")
  })

  it("rejects when phase is DISCOVERY", async () => {
    const state = makeState({ phase: "DISCOVERY", phaseState: "REVISE" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("DISCOVERY")
  })

  it("rejects when phase is DONE", async () => {
    const state = makeState({ phase: "DONE", phaseState: "DRAFT" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("DONE")
  })

  it("rejects when target_phase is not earlier than current", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const result = await handleProposeBacktrack(
      { target_phase: "IMPL_PLAN", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("not earlier")
  })

  it("rejects when target_phase equals current phase", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const result = await handleProposeBacktrack(
      { target_phase: "TESTS", reason: VALID_REASON },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("not earlier")
  })

  it("rejects when reason is too short", async () => {
    const state = makeState()
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: "too short" },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("at least 20 characters")
  })

  it("rejects empty reason", async () => {
    const state = makeState()
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: "" },
      state,
      makeOrchestrator(),
    )
    expect(result.action).toBe("error")
    expect(result.message).toContain("at least 20 characters")
  })

  it("accepts from DRAFT state", async () => {
    const state = makeState({ phaseState: "DRAFT" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator({ classification: "backtrack" }),
    )
    expect(result.action).toBe("execute")
  })

  it("accepts from REVISE state", async () => {
    const state = makeState({ phaseState: "REVISE" })
    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      makeOrchestrator({ classification: "backtrack" }),
    )
    expect(result.action).toBe("execute")
  })
})

// ---------------------------------------------------------------------------
// Orchestrator classification → outcome mapping
// ---------------------------------------------------------------------------

describe("propose_backtrack — orchestrator routing", () => {
  it("executes backtrack when orchestrator agrees", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "backtrack",
      revisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "DRAFT", instructions: "Redo the plan." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("execute")
    if (result.action !== "execute") throw new Error("unreachable")
    expect(result.targetPhase).toBe("PLANNING")
    expect(result.targetPhaseState).toBe("DRAFT")
    expect(result.classification).toBe("backtrack")
    expect(result.pendingRevisionSteps).toHaveLength(0)
    expect(result.message).toContain("Backtracking approved")
  })

  it("executes strategic when orchestrator classifies as strategic", async () => {
    const state = makeState({ phase: "IMPLEMENTATION", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "strategic",
      revisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "Revise the plan." },
        { artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "Update interfaces." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("execute")
    if (result.action !== "execute") throw new Error("unreachable")
    expect(result.targetPhase).toBe("PLANNING")
    expect(result.targetPhaseState).toBe("REVISE")
    expect(result.classification).toBe("strategic")
    expect(result.pendingRevisionSteps).toHaveLength(1)
    expect(result.pendingRevisionSteps[0]?.artifact).toBe("interfaces")
    expect(result.message).toContain("Strategic revision approved")
  })

  it("rejects tactical — agent should fix in-place", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "tactical",
      revisionSteps: [
        { artifact: "tests", phase: "TESTS", phaseState: "REVISE", instructions: "Fix the test setup." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("reject")
    if (result.action !== "reject") throw new Error("unreachable")
    expect(result.message).toContain("tactical")
    expect(result.message).toContain("Fix the test setup")
    expect(result.message).toContain("Continue working")
  })

  it("returns error when orchestrator throws", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({ throws: true })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("error")
    expect(result.message).toContain("Orchestrator unavailable")
  })

  it("returns error when orchestrator returns empty revisionSteps for backtrack", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "backtrack",
      revisionSteps: [],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("error")
    expect(result.message).toContain("no revision steps")
  })

  it("returns error when orchestrator returns empty revisionSteps for strategic", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "strategic",
      revisionSteps: [],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("error")
    expect(result.message).toContain("no revision steps")
  })
})

// ---------------------------------------------------------------------------
// Orchestrator sees correct input
// ---------------------------------------------------------------------------

describe("propose_backtrack — orchestrator receives correct input", () => {
  it("passes reason as feedback to orchestrator.route()", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT", mode: "INCREMENTAL" })
    const routeMock = mock(async (): Promise<OrchestratorPlanResult> => ({
      revisionSteps: [{ artifact: "plan", phase: "PLANNING", phaseState: "DRAFT", instructions: "Fix it." }],
      classification: "backtrack",
    }))
    const orchestrator: Orchestrator = { route: routeMock }

    await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(routeMock).toHaveBeenCalledTimes(1)
    const callArgs = routeMock.mock.calls[0]?.[0]
    expect(callArgs?.feedback).toBe(VALID_REASON)
    expect(callArgs?.currentPhase).toBe("TESTS")
    expect(callArgs?.currentPhaseState).toBe("DRAFT")
    expect(callArgs?.mode).toBe("INCREMENTAL")
  })

  it("uses orchestrator's target phase, not agent's proposal", async () => {
    const state = makeState({ phase: "IMPLEMENTATION", phaseState: "REVISE" })
    // Agent proposes INTERFACES but orchestrator routes to PLANNING
    const orchestrator = makeOrchestrator({
      classification: "backtrack",
      revisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "DRAFT", instructions: "Restart plan." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "INTERFACES", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("execute")
    if (result.action !== "execute") throw new Error("unreachable")
    expect(result.targetPhase).toBe("PLANNING") // Orchestrator's choice, not "INTERFACES"
  })

  it("defaults mode to GREENFIELD when state.mode is null", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT", mode: null })
    const routeMock = mock(async (): Promise<OrchestratorPlanResult> => ({
      revisionSteps: [{ artifact: "plan", phase: "PLANNING", phaseState: "DRAFT", instructions: "Fix." }],
      classification: "backtrack",
    }))
    const orchestrator: Orchestrator = { route: routeMock }

    await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    const callArgs = routeMock.mock.calls[0]?.[0]
    expect(callArgs?.mode).toBe("GREENFIELD")
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("propose_backtrack — edge cases", () => {
  it("works from IMPLEMENTATION/DRAFT proposing backtrack to DISCOVERY", async () => {
    const state = makeState({ phase: "IMPLEMENTATION", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "backtrack",
      revisionSteps: [
        { artifact: "conventions", phase: "DISCOVERY", phaseState: "DRAFT", instructions: "Redo discovery." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "DISCOVERY", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("execute")
    if (result.action !== "execute") throw new Error("unreachable")
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("DRAFT")
  })

  it("preserves cascade steps from orchestrator", async () => {
    const state = makeState({ phase: "IMPLEMENTATION", phaseState: "REVISE" })
    const orchestrator = makeOrchestrator({
      classification: "backtrack",
      revisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "DRAFT", instructions: "Fix plan." },
        { artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "Update interfaces." },
        { artifact: "tests", phase: "TESTS", phaseState: "REVISE", instructions: "Update tests." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("execute")
    if (result.action !== "execute") throw new Error("unreachable")
    expect(result.pendingRevisionSteps).toHaveLength(2)
    expect(result.pendingRevisionSteps[0]?.artifact).toBe("interfaces")
    expect(result.pendingRevisionSteps[1]?.artifact).toBe("tests")
  })

  it("tactical rejection includes guidance when revisionSteps has instructions", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "tactical",
      revisionSteps: [
        { artifact: "tests", phase: "TESTS", phaseState: "REVISE", instructions: "Just update the test assertions." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("reject")
    if (result.action !== "reject") throw new Error("unreachable")
    expect(result.message).toContain("Just update the test assertions")
  })

  it("tactical rejection works even with empty revisionSteps", async () => {
    const state = makeState({ phase: "TESTS", phaseState: "DRAFT" })
    const orchestrator = makeOrchestrator({
      classification: "tactical",
      revisionSteps: [],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "PLANNING", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("reject")
    expect(result.message).toContain("tactical")
  })

  it("allows PLANNING/REVISE to backtrack to DISCOVERY", async () => {
    const state = makeState({ phase: "PLANNING", phaseState: "REVISE" })
    const orchestrator = makeOrchestrator({
      classification: "backtrack",
      revisionSteps: [
        { artifact: "conventions", phase: "DISCOVERY", phaseState: "DRAFT", instructions: "Re-scan." },
      ],
    })

    const result = await handleProposeBacktrack(
      { target_phase: "DISCOVERY", reason: VALID_REASON },
      state,
      orchestrator,
    )

    expect(result.action).toBe("execute")
    if (result.action !== "execute") throw new Error("unreachable")
    expect(result.targetPhase).toBe("DISCOVERY")
  })
})
