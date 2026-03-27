/**
 * Tests for the orchestrator routing logic (non-LLM parts).
 * The LLM classification calls are mocked.
 */
import { describe, expect, it, mock, beforeEach } from "bun:test"

import { createOrchestrator } from "#core/orchestrator/route"
import { createArtifactGraph } from "#core/artifacts"
import type { OrchestratorAssessResult, OrchestratorDivergeResult, OrchestratorDeps, ArtifactKey } from "#core/types"

// Typed mocks — cast to any to allow .mockImplementation() / .mock access
// (Bun's mock() return type doesn't expose these on the function overload)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAssess = mock(
  async (_feedback: string, _currentArtifact: ArtifactKey): Promise<OrchestratorAssessResult> => ({
    success: true,
    affectedArtifacts: ["interfaces"],
    rootCauseArtifact: "interfaces",
    reasoning: "The feedback targets the interface definitions",
  }),
) as any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDiverge = mock(
  async (
    _assess: OrchestratorAssessResult,
    _approvedArtifacts: Partial<Record<ArtifactKey, string>>,
  ): Promise<OrchestratorDivergeResult> => ({
    success: true,
    classification: "tactical",
    reasoning: "Small targeted change",
  }),
) as any

let graph: ReturnType<typeof createArtifactGraph>

beforeEach(() => {
  // @ts-ignore — bun mock reset
  mockAssess.mockClear()
  // @ts-ignore — bun mock reset
  mockDiverge.mockClear()
  graph = createArtifactGraph()
})

describe("Orchestrator — tactical routing", () => {
  it("tactical: routes to INTERFACES/REVISE when interfaces is root cause", async () => {
    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "The interface for X is wrong",
      currentPhase: "INTERFACES",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    expect(result.revisionSteps[0]?.phase).toBe("INTERFACES")
    expect(result.revisionSteps[0]?.phaseState).toBe("REVISE")
  })

  it("tactical: only includes directly affected artifact, not all dependents", async () => {
    mockDiverge.mockImplementation(async () => ({
      success: true,
      classification: "tactical" as const,
      reasoning: "Small change",
    }))
    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "Fix this interface",
      currentPhase: "INTERFACES",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    // Tactical: only the root cause, not all downstream cascades
    expect(result.revisionSteps).toHaveLength(1)
    expect(result.revisionSteps[0]?.phase).toBe("INTERFACES")
  })

  it("tactical: returns classification='tactical' in plan result", async () => {
    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "Small fix",
      currentPhase: "TESTS",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    expect(result.classification).toBe("tactical")
  })
})

describe("Orchestrator — strategic routing", () => {
  it("strategic: includes root cause + all downstream dependents", async () => {
    mockAssess.mockImplementation(async () => ({
      success: true,
      affectedArtifacts: ["plan", "interfaces", "tests", "impl_plan", "implementation"],
      rootCauseArtifact: "plan" as ArtifactKey,
      reasoning: "Plan needs rethinking",
    }))
    mockDiverge.mockImplementation(async () => ({
      success: true,
      classification: "strategic" as const,
      triggerCriterion: "scope_expansion" as const,
      reasoning: "Scope expanded significantly",
    }))

    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "Actually we need to rethink the whole approach",
      currentPhase: "IMPLEMENTATION",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })

    // Strategic: plan + all its dependents
    const phases = result.revisionSteps.map((s) => s.phase)
    expect(phases).toContain("PLANNING")
    expect(phases).toContain("INTERFACES")
    expect(phases).toContain("TESTS")
  })

  it("strategic: returns classification='strategic' in plan result", async () => {
    mockAssess.mockImplementation(async () => ({
      success: true,
      affectedArtifacts: ["plan", "interfaces"],
      rootCauseArtifact: "plan" as ArtifactKey,
      reasoning: "Plan changed",
    }))
    mockDiverge.mockImplementation(async () => ({
      success: true,
      classification: "strategic" as const,
      reasoning: "Large change",
    }))
    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "Rethink everything",
      currentPhase: "INTERFACES",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })
    expect(result.classification).toBe("strategic")
  })

  it("strategic: steps are in dependency order (planning before interfaces)", async () => {
    mockAssess.mockImplementation(async () => ({
      success: true,
      affectedArtifacts: ["plan", "interfaces"],
      rootCauseArtifact: "plan" as ArtifactKey,
      reasoning: "Root: plan",
    }))
    mockDiverge.mockImplementation(async () => ({
      success: true,
      classification: "strategic" as const,
      reasoning: "Large change",
    }))

    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "Major rework",
      currentPhase: "TESTS",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })

    const phases = result.revisionSteps.map((s) => s.phase)
    const planIdx = phases.indexOf("PLANNING")
    const ifaceIdx = phases.indexOf("INTERFACES")
    expect(planIdx).toBeLessThan(ifaceIdx)
  })
})

describe("Orchestrator — fallback on assess error", () => {
  it("uses fallbackArtifact when assess fails, classifies as tactical", async () => {
    mockAssess.mockImplementation(async () => ({
      success: false,
      error: "LLM timed out",
      fallbackArtifact: "interfaces" as ArtifactKey,
    }))

    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "something",
      currentPhase: "INTERFACES",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })

    expect(result.revisionSteps[0]?.phase).toBe("INTERFACES")
    expect(result.revisionSteps[0]?.phaseState).toBe("REVISE")
    // Fallback must always be tactical
    expect(result.classification).toBe("tactical")
  })
})

describe("Orchestrator — hard-throw fallback (assess throws)", () => {
  it("falls back to tactical revision of current-phase artifact when assess throws", async () => {
    mockAssess.mockImplementation(async () => {
      throw new Error("Network timeout")
    })

    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "something",
      currentPhase: "INTERFACES",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })

    // Must still return a valid plan — current-phase artifact, REVISE
    expect(result.revisionSteps).toHaveLength(1)
    expect(result.revisionSteps[0]?.phase).toBe("INTERFACES")
    expect(result.revisionSteps[0]?.phaseState).toBe("REVISE")
  })

  it("does NOT call diverge when assess throws", async () => {
    mockAssess.mockImplementation(async () => {
      throw new Error("Timeout")
    })

    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    await orchestrator.route({
      feedback: "something",
      currentPhase: "PLANNING",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: {},
    })

    // diverge should NOT have been called — early exit on hard throw
    expect(mockDiverge).not.toHaveBeenCalled()
  })
})

describe("Orchestrator — accumulated drift detection", () => {
  it("passes approvedArtifacts through to diverge so it can detect drift", async () => {
    mockAssess.mockImplementation(async () => ({
      success: true,
      affectedArtifacts: ["tests"],
      rootCauseArtifact: "tests" as ArtifactKey,
      reasoning: "Test feedback",
    }))

    mockDiverge.mockImplementation(async () => ({
      success: true,
      classification: "strategic" as const,
      triggerCriterion: "accumulated_drift" as const,
      reasoning: "Many artifacts have drifted from baseline",
    }))

    const approvedArtifacts = { plan: "abc123", interfaces: "def456", tests: "ghi789" }
    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })

    await orchestrator.route({
      feedback: "Another small tweak",
      currentPhase: "TESTS",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts,
    })

    // Verify the orchestrator wires approvedArtifacts into the diverge call
    expect(mockDiverge).toHaveBeenCalledTimes(1)
    const divergeCallArgs = mockDiverge.mock.calls[0]
    // Second argument to diverge must be the approvedArtifacts map
    expect(divergeCallArgs?.[1]).toEqual(approvedArtifacts)
  })

  it("routes strategically when diverge returns accumulated_drift", async () => {
    mockAssess.mockImplementation(async () => ({
      success: true,
      affectedArtifacts: ["tests"],
      rootCauseArtifact: "tests" as ArtifactKey,
      reasoning: "Test feedback",
    }))

    mockDiverge.mockImplementation(async () => ({
      success: true,
      classification: "strategic" as const,
      triggerCriterion: "accumulated_drift" as const,
      reasoning: "Many artifacts have drifted from baseline",
    }))

    const orchestrator = createOrchestrator({ assess: mockAssess, diverge: mockDiverge, graph })
    const result = await orchestrator.route({
      feedback: "Another small tweak",
      currentPhase: "TESTS",
      currentPhaseState: "USER_GATE",
      mode: "GREENFIELD",
      approvedArtifacts: { plan: "abc123", interfaces: "def456", tests: "ghi789" },
    })

    // Strategic: tests + its dependents (impl_plan, implementation)
    expect(result.revisionSteps.length).toBeGreaterThan(1)
    const phases = result.revisionSteps.map((s) => s.phase)
    expect(phases).toContain("TESTS")
  })
})
