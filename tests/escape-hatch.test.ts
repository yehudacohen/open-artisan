/**
 * Tests for escape-hatch module — O_USER_DECIDE presentation builder.
 */
import { describe, expect, it } from "bun:test"
import {
  buildEscapeHatchPresentation,
  isEscapeHatchAbort,
  isEscapeHatchAccept,
  isEscapeHatchAmbiguous,
} from "#plugin/orchestrator/escape-hatch"
import type { OrchestratorAssessResult, OrchestratorDivergeResult, RevisionStep } from "#plugin/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssessSuccess(root: string = "interfaces"): OrchestratorAssessResult {
  return {
    success: true,
    affectedArtifacts: [root as "interfaces", "tests", "impl_plan"] as "interfaces"[],
    rootCauseArtifact: root as "interfaces",
    reasoning: "The interface has incorrect types",
  }
}

function makeDivergeStrategic(): OrchestratorDivergeResult {
  return {
    success: true,
    classification: "strategic",
    triggerCriterion: "cascade_depth",
    reasoning: "3 or more artifacts affected",
  }
}

function makeRevisionSteps(): RevisionStep[] {
  return [
    { artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "Revise interface types" },
    { artifact: "tests",      phase: "TESTS",      phaseState: "REVISE", instructions: "Re-align tests" },
    { artifact: "impl_plan",  phase: "IMPL_PLAN",  phaseState: "REVISE", instructions: "Re-align impl plan" },
  ]
}

// ---------------------------------------------------------------------------
// buildEscapeHatchPresentation
// ---------------------------------------------------------------------------

describe("buildEscapeHatchPresentation — structure", () => {
  it("returns a non-empty presentation string", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "The API shape needs to change",
      intentBaseline: "Add user authentication",
      assessResult: makeAssessSuccess(),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(),
      currentPhase: "INTERFACES",
    })
    expect(typeof result.presentation).toBe("string")
    expect(result.presentation.length).toBeGreaterThan(100)
  })

  it("includes original intent in presentation", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change the API",
      intentBaseline: "Add user authentication to the API",
      assessResult: makeAssessSuccess(),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(),
      currentPhase: "INTERFACES",
    })
    expect(result.presentation).toContain("Add user authentication to the API")
  })

  it("includes feedback in presentation", () => {
    const feedback = "The API shape needs a major redesign"
    const result = buildEscapeHatchPresentation({
      feedback,
      intentBaseline: null,
      assessResult: makeAssessSuccess(),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(),
      currentPhase: "INTERFACES",
    })
    expect(result.presentation).toContain(feedback)
  })

  it("includes all revision steps in proposed change plan", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Redesign",
      intentBaseline: null,
      assessResult: makeAssessSuccess(),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(),
      currentPhase: "INTERFACES",
    })
    expect(result.presentation).toContain("interfaces")
    expect(result.presentation).toContain("tests")
    expect(result.presentation).toContain("impl_plan")
  })

  it("includes user options (accept, abort)", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change",
      intentBaseline: null,
      assessResult: makeAssessSuccess(),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(),
      currentPhase: "INTERFACES",
    })
    expect(result.presentation.toLowerCase()).toContain("accept")
    expect(result.presentation.toLowerCase()).toContain("abort")
  })

  it("returns correct affectedCount", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change",
      intentBaseline: null,
      assessResult: makeAssessSuccess("plan"),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(),
      currentPhase: "PLANNING",
    })
    // affectedArtifacts has 3 entries in makeAssessSuccess
    expect(result.affectedCount).toBe(3)
  })

  it("sets isCascade true when 3+ revision steps", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change",
      intentBaseline: null,
      assessResult: makeAssessSuccess(),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(), // 3 steps
      currentPhase: "INTERFACES",
    })
    expect(result.isCascade).toBe(true)
  })

  it("sets isCascade false when only 1 revision step", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change",
      intentBaseline: null,
      assessResult: makeAssessSuccess(),
      divergeResult: { success: true, classification: "strategic", reasoning: "scope change" },
      revisionSteps: [{ artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "Fix" }],
      currentPhase: "INTERFACES",
    })
    expect(result.isCascade).toBe(false)
  })

  it("handles null intentBaseline gracefully", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change",
      intentBaseline: null,
      assessResult: makeAssessSuccess(),
      divergeResult: makeDivergeStrategic(),
      revisionSteps: makeRevisionSteps(),
      currentPhase: "INTERFACES",
    })
    expect(result.presentation).toContain("No baseline intent")
  })

  it("formats cascade_depth trigger correctly", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change",
      intentBaseline: null,
      assessResult: makeAssessSuccess(),
      divergeResult: { success: true, classification: "strategic", triggerCriterion: "cascade_depth", reasoning: "3+ artifacts" },
      revisionSteps: makeRevisionSteps(),
      currentPhase: "INTERFACES",
    })
    expect(result.triggerCriterion).toBe("cascade_depth")
    expect(result.presentation.toLowerCase()).toContain("cascade")
  })
})

// ---------------------------------------------------------------------------
// Divergence context — explain why escape hatch was triggered
// ---------------------------------------------------------------------------

describe("buildEscapeHatchPresentation — divergence context", () => {
  it("includes a human-readable explanation of what diverged", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Change the database to NoSQL",
      intentBaseline: "Build a REST API with PostgreSQL",
      assessResult: makeAssessSuccess("plan"),
      divergeResult: {
        success: true,
        classification: "strategic",
        triggerCriterion: "architectural_shift",
        reasoning: "The change replaces the fundamental data storage architecture",
      },
      revisionSteps: makeRevisionSteps(),
      currentPhase: "PLANNING",
    })
    // Should explain WHY this is strategic — the trigger and reasoning
    expect(result.presentation).toContain("Architectural Shift")
    expect(result.presentation).toContain("The change replaces the fundamental data storage architecture")
  })

  it("includes scope_expansion explanation", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "Add WebSocket support too",
      intentBaseline: "Add REST endpoints",
      assessResult: makeAssessSuccess("plan"),
      divergeResult: {
        success: true,
        classification: "strategic",
        triggerCriterion: "scope_expansion",
        reasoning: "WebSocket adds new protocol and infrastructure requirements",
      },
      revisionSteps: makeRevisionSteps(),
      currentPhase: "PLANNING",
    })
    expect(result.presentation).toContain("Scope Expansion")
  })

  it("includes accumulated_drift explanation", () => {
    const result = buildEscapeHatchPresentation({
      feedback: "One more small change",
      intentBaseline: "Original intent",
      assessResult: makeAssessSuccess("plan"),
      divergeResult: {
        success: true,
        classification: "strategic",
        triggerCriterion: "accumulated_drift",
        reasoning: "Multiple small changes have collectively shifted the design",
      },
      revisionSteps: makeRevisionSteps(),
      currentPhase: "PLANNING",
    })
    expect(result.presentation).toContain("Accumulated Drift")
  })
})

// ---------------------------------------------------------------------------
// isEscapeHatchAbort
// ---------------------------------------------------------------------------

describe("isEscapeHatchAbort", () => {
  it("returns true for 'abort'", () => expect(isEscapeHatchAbort("abort")).toBe(true))
  it("returns true for 'abort change'", () => expect(isEscapeHatchAbort("abort change")).toBe(true))
  it("returns true for 'no'", () => expect(isEscapeHatchAbort("no")).toBe(true))
  it("returns true for 'cancel'", () => expect(isEscapeHatchAbort("cancel")).toBe(true))
  it("returns true for '  ABORT  ' (case+whitespace)", () => expect(isEscapeHatchAbort("  ABORT  ")).toBe(true))
  it("returns false for 'accept'", () => expect(isEscapeHatchAbort("accept")).toBe(false))
  it("returns false for 'proceed'", () => expect(isEscapeHatchAbort("proceed")).toBe(false))
  it("returns false for substantive alternative direction", () => {
    expect(isEscapeHatchAbort("Let's use a different approach — use REST instead of GraphQL")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isEscapeHatchAccept
// ---------------------------------------------------------------------------

describe("isEscapeHatchAccept", () => {
  it("returns true for 'accept'", () => expect(isEscapeHatchAccept("accept")).toBe(true))
  it("returns true for 'proceed'", () => expect(isEscapeHatchAccept("proceed")).toBe(true))
  it("returns true for 'yes'", () => expect(isEscapeHatchAccept("yes")).toBe(true))
  it("returns true for 'ok'", () => expect(isEscapeHatchAccept("ok")).toBe(true))
  it("returns true for '  OK  ' (case+whitespace)", () => expect(isEscapeHatchAccept("  OK  ")).toBe(true))
  it("returns false for 'abort'", () => expect(isEscapeHatchAccept("abort")).toBe(false))
  it("returns false for alternative direction text", () => {
    expect(isEscapeHatchAccept("Use REST instead of GraphQL")).toBe(false)
  })

  it("returns true for expanded accept words (go ahead, sure, lgtm)", () => {
    expect(isEscapeHatchAccept("go ahead")).toBe(true)
    expect(isEscapeHatchAccept("sure")).toBe(true)
    expect(isEscapeHatchAccept("lgtm")).toBe(true)
    expect(isEscapeHatchAccept("continue")).toBe(true)
    expect(isEscapeHatchAccept("do it")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isEscapeHatchAmbiguous
// ---------------------------------------------------------------------------

describe("isEscapeHatchAmbiguous", () => {
  it("returns true for short text not matching any keyword", () => {
    expect(isEscapeHatchAmbiguous("hmm")).toBe(true)
    expect(isEscapeHatchAmbiguous("maybe")).toBe(true)
    expect(isEscapeHatchAmbiguous("idk")).toBe(true)
    expect(isEscapeHatchAmbiguous("what?")).toBe(true)
  })

  it("returns false for recognized abort words", () => {
    expect(isEscapeHatchAmbiguous("abort")).toBe(false)
    expect(isEscapeHatchAmbiguous("no")).toBe(false)
    expect(isEscapeHatchAmbiguous("cancel")).toBe(false)
    expect(isEscapeHatchAmbiguous("no thanks")).toBe(false)
  })

  it("returns false for recognized accept words", () => {
    expect(isEscapeHatchAmbiguous("yes")).toBe(false)
    expect(isEscapeHatchAmbiguous("ok")).toBe(false)
    expect(isEscapeHatchAmbiguous("proceed")).toBe(false)
  })

  it("returns false for new direction prefix", () => {
    expect(isEscapeHatchAmbiguous("new direction: x")).toBe(false)
  })

  it("returns false for text longer than 15 chars (treated as alternative direction)", () => {
    expect(isEscapeHatchAmbiguous("this is a longer alternative direction that should not be ambiguous")).toBe(false)
  })
})

describe("isEscapeHatchAbort — expanded abort words", () => {
  it("returns true for 'no thanks'", () => expect(isEscapeHatchAbort("no thanks")).toBe(true))
  it("returns true for 'nope'", () => expect(isEscapeHatchAbort("nope")).toBe(true))
  it("returns true for 'skip'", () => expect(isEscapeHatchAbort("skip")).toBe(true))
  it("returns true for 'decline'", () => expect(isEscapeHatchAbort("decline")).toBe(true))
  it("returns true for 'nevermind'", () => expect(isEscapeHatchAbort("nevermind")).toBe(true))
})
