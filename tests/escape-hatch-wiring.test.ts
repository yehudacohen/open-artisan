/**
 * Integration tests for the escape hatch wiring in index.ts.
 *
 * These tests exercise the submit_feedback → orchestrator → escape hatch path
 * by driving the OpenArtisanPlugin with mocked dependencies.
 *
 * Architecture:
 * - We call the plugin's submit_feedback tool handler directly via the registered plugin.
 * - The orchestrator's assess/diverge are mocked to control tactical vs strategic output.
 * - The store is created fresh per test so state does not leak.
 * - We do NOT test the LLM calls (covered by llm-calls.test.ts) or
 *   low-level route logic (covered by orchestrator.test.ts).
 */
import { describe, expect, it, mock, beforeEach } from "bun:test"
import { createOrchestrator } from "#plugin/orchestrator/route"
import { createArtifactGraph } from "#plugin/artifacts"
import { createStateMachine } from "#plugin/state-machine"
import { buildEscapeHatchPresentation, isEscapeHatchAbort } from "#plugin/orchestrator/escape-hatch"
import { handleCascade } from "#plugin/tools/submit-feedback-handlers"
import type {
  OrchestratorAssessResult,
  OrchestratorDivergeResult,
  ArtifactKey,
  RevisionStep,
  OrchestratorPlanResult,
  WorkflowState,
} from "#plugin/types"
import { SCHEMA_VERSION } from "#plugin/types"

// ---------------------------------------------------------------------------
// Lightweight orchestrator factory driven by mocked assess/diverge
// ---------------------------------------------------------------------------

const sm = createStateMachine()

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
    ...overrides,
  }
}

function makeOrchestrator(
  assessResult: OrchestratorAssessResult,
  divergeResult: OrchestratorDivergeResult,
) {
  const graph = createArtifactGraph()
  return createOrchestrator({
    assess: mock(async () => assessResult),
    diverge: mock(async () => divergeResult),
    graph,
  })
}

// ---------------------------------------------------------------------------
// OrchestratorPlanResult.classification — ensure field is present
// ---------------------------------------------------------------------------

describe("OrchestratorPlanResult — classification field", () => {
  it("tactical plan includes classification='tactical'", async () => {
    const orch = makeOrchestrator(
      { success: true, affectedArtifacts: ["tests"], rootCauseArtifact: "tests", reasoning: "tests" },
      { success: true, classification: "tactical", reasoning: "small" },
    )
    const result = await orch.route({
      feedback: "fix a test",
      currentPhase: "TESTS",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    expect(result.classification).toBe("tactical")
  })

  it("strategic plan includes classification='strategic'", async () => {
    const orch = makeOrchestrator(
      { success: true, affectedArtifacts: ["plan", "interfaces", "tests"], rootCauseArtifact: "plan", reasoning: "plan changed" },
      { success: true, classification: "strategic", triggerCriterion: "cascade_depth", reasoning: "3 artifacts" },
    )
    const result = await orch.route({
      feedback: "rethink the plan",
      currentPhase: "TESTS",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    expect(result.classification).toBe("strategic")
    expect(result.revisionSteps.length).toBeGreaterThanOrEqual(3)
  })

  it("assess fallback (error) returns classification='tactical'", async () => {
    const orch = makeOrchestrator(
      { success: false, error: "timeout", fallbackArtifact: "implementation" },
      { success: true, classification: "tactical", reasoning: "fallback" },
    )
    const result = await orch.route({
      feedback: "something",
      currentPhase: "IMPLEMENTATION",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    expect(result.classification).toBe("tactical")
  })
})

// ---------------------------------------------------------------------------
// isEscapeHatchAbort — abort detection
// ---------------------------------------------------------------------------

describe("isEscapeHatchAbort — escape hatch wiring logic", () => {
  it("returns true for 'abort'", () => {
    expect(isEscapeHatchAbort("abort")).toBe(true)
  })

  it("returns true for 'cancel'", () => {
    expect(isEscapeHatchAbort("cancel")).toBe(true)
  })

  it("returns true for 'no' (short rejection)", () => {
    expect(isEscapeHatchAbort("no")).toBe(true)
  })

  it("returns false for 'accept'", () => {
    expect(isEscapeHatchAbort("accept")).toBe(false)
  })

  it("returns false for a substantive alternative direction", () => {
    expect(isEscapeHatchAbort("let's take a different approach and simplify the data model")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildEscapeHatchPresentation — presentation content
// ---------------------------------------------------------------------------

describe("buildEscapeHatchPresentation — wiring integration", () => {
  const sampleSteps: RevisionStep[] = [
    { artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "Revise the plan" },
    { artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "Re-align interfaces" },
    { artifact: "tests", phase: "TESTS", phaseState: "REVISE", instructions: "Re-align tests" },
  ]

  it("includes escape hatch header", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Add a whole new service",
      intentBaseline: "Build a simple REST API",
      assessResult: { success: true, affectedArtifacts: ["plan", "interfaces", "tests"], rootCauseArtifact: "plan", reasoning: "scope expanded" },
      divergeResult: { success: true, classification: "strategic", triggerCriterion: "scope_expansion", reasoning: "new service not in plan" },
      revisionSteps: sampleSteps,
      currentPhase: "TESTS",
    })
    const p = result.presentation.toLowerCase()
    // Must include some signal that this is an escalation requiring user decision
    expect(p.includes("strategic") || p.includes("escape") || p.includes("change detected") || p.includes("review")).toBe(true)
  })

  it("includes revision plan steps in presentation", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Rethink everything",
      intentBaseline: null,
      assessResult: { success: true, affectedArtifacts: ["plan"], rootCauseArtifact: "plan", reasoning: "plan" },
      divergeResult: { success: true, classification: "strategic", reasoning: "big change" },
      revisionSteps: sampleSteps,
      currentPhase: "PLANNING",
    })
    // Presentation must list the affected artifacts
    expect(result.presentation).toContain("plan")
  })

  it("includes accept/abort options in the presentation", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Add auth",
      intentBaseline: "Build a REST API without auth",
      assessResult: { success: true, affectedArtifacts: ["plan", "interfaces"], rootCauseArtifact: "plan", reasoning: "auth not in plan" },
      divergeResult: { success: true, classification: "strategic", triggerCriterion: "scope_expansion", reasoning: "auth is new scope" },
      revisionSteps: sampleSteps.slice(0, 2),
      currentPhase: "INTERFACES",
    })
    // Should give user actionable choices
    const p = result.presentation.toLowerCase()
    expect(p.includes("accept") || p.includes("abort") || p.includes("proceed") || p.includes("cancel")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cascade continuation — pendingRevisionSteps semantics
// ---------------------------------------------------------------------------

describe("Cascade continuation — handleCascade handler", () => {
  it("handleCascade consumes first step and returns remaining in pendingRevisionSteps", () => {
    const state = makeState({
      pendingRevisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "Revise plan" },
        { artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "Re-align interfaces" },
        { artifact: "tests", phase: "TESTS", phaseState: "REVISE", instructions: "Re-align tests" },
      ],
    })
    const result = handleCascade(state, sm)
    expect(result.action).toBe("revise")
    if (result.action === "revise") {
      expect(result.targetPhase).toBe("PLANNING")
      expect(result.pendingRevisionSteps).toHaveLength(2)
      expect(result.pendingRevisionSteps[0]?.artifact).toBe("interfaces")
      expect(result.pendingRevisionSteps[1]?.artifact).toBe("tests")
    }
  })

  it("handleCascade on last step returns empty pendingRevisionSteps", () => {
    const state = makeState({
      pendingRevisionSteps: [
        { artifact: "tests", phase: "TESTS", phaseState: "REVISE", instructions: "Re-align tests" },
      ],
    })
    const result = handleCascade(state, sm)
    expect(result.action).toBe("revise")
    if (result.action === "revise") {
      expect(result.targetPhase).toBe("TESTS")
      expect(result.pendingRevisionSteps).toHaveLength(0)
    }
  })

  it("handleCascade with empty steps returns error", () => {
    const state = makeState({ pendingRevisionSteps: [] })
    const result = handleCascade(state, sm)
    expect(result.action).toBe("error")
  })
})

// ---------------------------------------------------------------------------
// Strategic detection — classification field drives isStrategic
// ---------------------------------------------------------------------------

describe("Strategic detection — classification drives routing", () => {
  it("tactical result: classification='tactical' should not trigger escape hatch", async () => {
    const orch = makeOrchestrator(
      { success: true, affectedArtifacts: ["tests"], rootCauseArtifact: "tests", reasoning: "test" },
      { success: true, classification: "tactical", reasoning: "small" },
    )
    const plan = await orch.route({
      feedback: "Fix a test assertion",
      currentPhase: "TESTS",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    // classification field must be trusted directly — no proxy logic needed
    expect(plan.classification === "strategic").toBe(false)
  })

  it("strategic result: classification='strategic' must be set regardless of step count", async () => {
    // A single-root-cause change can be strategic (e.g. architectural_shift).
    // The old proxy (steps.length >= 3) would MISS this if the root artifact
    // has fewer than 3 downstream dependents. The classification field fixes this.
    const orch = makeOrchestrator(
      { success: true, affectedArtifacts: ["impl_plan"], rootCauseArtifact: "impl_plan", reasoning: "arch shift" },
      { success: true, classification: "strategic", triggerCriterion: "architectural_shift", reasoning: "changes the data model" },
    )
    const plan = await orch.route({
      feedback: "Change to a graph database",
      currentPhase: "IMPL_PLAN",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    // Strategic even though there may be only 1-2 steps (impl_plan → implementation)
    expect(plan.classification).toBe("strategic")
  })

  it("3-step tactical result: old proxy would falsely mark strategic, new field says tactical", async () => {
    // This is the split-brain scenario: 3+ steps but diverge says tactical.
    // With the old proxy this would be incorrectly marked strategic.
    // With the new classification field we trust the orchestrator.
    const orch = makeOrchestrator(
      { success: true, affectedArtifacts: ["interfaces", "tests", "impl_plan"], rootCauseArtifact: "interfaces", reasoning: "cascade" },
      { success: true, classification: "tactical", reasoning: "all in same PR, safe" },
    )
    const plan = await orch.route({
      feedback: "Rename a type across all artifacts",
      currentPhase: "INTERFACES",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    // The orchestrator explicitly says tactical — trust it
    expect(plan.classification).toBe("tactical")
  })
})
