/**
 * Tests for system-transform hook — system prompt building.
 * Covers G11: ANALYZE sub-state now correctly mentions mark_analyze_complete.
 */
import { describe, expect, it } from "bun:test"
import { buildWorkflowSystemPrompt } from "#plugin/hooks/system-transform"
import type { WorkflowState } from "#plugin/types"
import { SCHEMA_VERSION } from "#plugin/types"

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "GREENFIELD",
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
    escapePending: false,
    pendingRevisionSteps: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// State header
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — state header", () => {
  it("includes phase and phaseState", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "DRAFT" }))
    expect(prompt).toContain("PLANNING")
    expect(prompt).toContain("DRAFT")
  })

  it("includes mode", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ mode: "INCREMENTAL" }))
    expect(prompt).toContain("INCREMENTAL")
  })

  it("includes iteration count when > 0", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ iterationCount: 3 }))
    expect(prompt).toContain("3")
  })

  it("does not include iteration when 0", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ iterationCount: 0 }))
    expect(prompt).not.toContain("Iteration: 0")
  })

  it("includes last checkpoint tag when present", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ lastCheckpointTag: "workflow/planning-v1" }))
    expect(prompt).toContain("workflow/planning-v1")
  })
})

// ---------------------------------------------------------------------------
// Sub-state context
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — SCAN sub-state", () => {
  it("mentions mark_scan_complete", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "SCAN", mode: "REFACTOR" }),
    )
    expect(prompt).toContain("mark_scan_complete")
  })
})

describe("buildWorkflowSystemPrompt — ANALYZE sub-state (G11)", () => {
  it("mentions mark_analyze_complete (G11 fix)", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "ANALYZE", mode: "REFACTOR" }),
    )
    expect(prompt).toContain("mark_analyze_complete")
  })

  it("does NOT tell agent to start drafting from ANALYZE (G11 fix)", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "ANALYZE", mode: "REFACTOR" }),
    )
    // Should not say "proceed to draft" without calling mark_analyze_complete first
    expect(prompt).not.toMatch(/proceed to draft the conventions document[^.]*\./i)
  })
})

describe("buildWorkflowSystemPrompt — DRAFT sub-state", () => {
  it("mentions request_review", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "DRAFT" }))
    expect(prompt).toContain("request_review")
  })
})

describe("buildWorkflowSystemPrompt — REVIEW sub-state", () => {
  it("mentions mark_satisfied", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "REVIEW" }))
    expect(prompt).toContain("mark_satisfied")
  })
})

describe("buildWorkflowSystemPrompt — USER_GATE sub-state", () => {
  it("tells agent to wait for user response", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "USER_GATE" }))
    expect(prompt.toLowerCase()).toContain("wait")
  })

  it("mentions submit_feedback", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "USER_GATE" }))
    expect(prompt).toContain("submit_feedback")
  })

  it("shows escape hatch warning when escapePending is true", () => {
    // Cast to any to set the extra field without TypeScript error in test
    const state = makeState({ phaseState: "USER_GATE", phase: "INTERFACES" }) as WorkflowState & { escapePending: boolean }
    state.escapePending = true
    const prompt = buildWorkflowSystemPrompt(state)
    expect(prompt.toUpperCase()).toContain("ESCAPE HATCH")
  })

  it("does NOT show escape hatch warning when escapePending is false", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "USER_GATE" }))
    expect(prompt.toUpperCase()).not.toContain("ESCAPE HATCH")
  })
})

describe("buildWorkflowSystemPrompt — REVISE sub-state", () => {
  it("mentions request_review for after revision", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "REVISE" }))
    expect(prompt).toContain("request_review")
  })
})

// ---------------------------------------------------------------------------
// Mode constraints
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — INCREMENTAL mode constraints", () => {
  it("includes do-no-harm directive", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ mode: "INCREMENTAL", phase: "IMPLEMENTATION", phaseState: "DRAFT" }),
    )
    expect(prompt.toLowerCase()).toContain("do-no-harm")
  })

  it("lists allowlisted files when present", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        mode: "INCREMENTAL",
        phase: "IMPLEMENTATION",
        phaseState: "DRAFT",
        fileAllowlist: ["/project/src/foo.ts", "/project/src/bar.ts"],
      }),
    )
    expect(prompt).toContain("/project/src/foo.ts")
    expect(prompt).toContain("/project/src/bar.ts")
  })
})

describe("buildWorkflowSystemPrompt — conventions injection", () => {
  it("injects conventions when present (non-GREENFIELD)", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        mode: "REFACTOR",
        conventions: "## My Conventions\nUse snake_case.",
        phase: "PLANNING",
        phaseState: "DRAFT",
      }),
    )
    expect(prompt).toContain("My Conventions")
    expect(prompt).toContain("snake_case")
  })

  it("does NOT inject conventions in GREENFIELD mode", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        mode: "GREENFIELD",
        conventions: "## Conventions\nSome rule.",
        phase: "PLANNING",
        phaseState: "DRAFT",
      }),
    )
    expect(prompt).not.toContain("Conventions Document (from Discovery Phase)")
  })
})

// ---------------------------------------------------------------------------
// MODE_SELECT — must tell agent to call select_mode, not draft
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — MODE_SELECT phase", () => {
  it("mentions select_mode at MODE_SELECT", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null }))
    expect(prompt).toContain("select_mode")
  })

  it("does NOT tell agent to call request_review at MODE_SELECT", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null }))
    // request_review is wrong at MODE_SELECT — should only be select_mode
    expect(prompt).not.toContain("request_review")
  })

  it("shows auto-detection note when modeDetectionNote is set", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        phase: "MODE_SELECT",
        phaseState: "DRAFT",
        mode: null,
        modeDetectionNote: "[Auto-detected workflow mode suggestion: INCREMENTAL]\nReasoning: x",
      }),
    )
    expect(prompt).toContain("Auto-Detection Result")
    expect(prompt).toContain("INCREMENTAL")
  })

  it("does NOT show auto-detection section when modeDetectionNote is null", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        phase: "MODE_SELECT",
        phaseState: "DRAFT",
        mode: null,
        modeDetectionNote: null,
        intentBaseline: "Add user authentication to the API",
      }),
    )
    expect(prompt).not.toContain("Auto-Detection Result")
  })
})

// ---------------------------------------------------------------------------
// DONE phase — must say workflow is complete, not draft
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — DONE phase", () => {
  it("does NOT tell agent to call request_review at DONE", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "DONE", phaseState: "DRAFT" }))
    expect(prompt).not.toContain("request_review")
  })

  it("says workflow is complete at DONE", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "DONE", phaseState: "DRAFT" }))
    expect(prompt.toLowerCase()).toContain("complete")
  })
})

// ---------------------------------------------------------------------------
// Acceptance criteria injection at REVIEW state
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — acceptance criteria at REVIEW", () => {
  it("injects Planning acceptance criteria at PLANNING/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("All user requirements explicitly addressed")
  })

  it("injects Interfaces acceptance criteria at INTERFACES/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "INTERFACES", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("Every function/method has input types")
  })

  it("injects Tests acceptance criteria at TESTS/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "TESTS", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("At least one test per interface method")
  })

  it("injects ImplPlan acceptance criteria at IMPL_PLAN/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "IMPL_PLAN", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("Every interface method is covered")
  })

  it("injects Implementation acceptance criteria at IMPLEMENTATION/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "IMPLEMENTATION", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("Implementation matches approved interface signatures")
  })

  it("injects Discovery/Refactor acceptance criteria at DISCOVERY/REVIEW in REFACTOR mode", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "REVIEW", mode: "REFACTOR" }),
    )
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("Existing architecture accurately described")
  })

  it("injects Discovery/Incremental acceptance criteria at DISCOVERY/REVIEW in INCREMENTAL mode", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "REVIEW", mode: "INCREMENTAL" }),
    )
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("Naming conventions documented")
  })

  it("does NOT inject acceptance criteria at DRAFT state", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "DRAFT" }))
    expect(prompt).not.toContain("Acceptance Criteria")
  })

  it("does NOT inject acceptance criteria at USER_GATE state", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "USER_GATE" }))
    expect(prompt).not.toContain("Acceptance Criteria")
  })
})

// ---------------------------------------------------------------------------
// MAX_CONVENTIONS_CHARS truncation
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — conventions truncation", () => {
  it("truncates conventions longer than 12000 chars with truncation notice", () => {
    const longConventions = "x".repeat(13_000)
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        mode: "REFACTOR",
        conventions: longConventions,
        phase: "PLANNING",
        phaseState: "DRAFT",
      }),
    )
    expect(prompt).toContain("conventions truncated at 12000 chars")
    expect(prompt).not.toContain("x".repeat(13_000)) // full text must NOT appear
  })

  it("does NOT truncate conventions under 12000 chars", () => {
    const shortConventions = "# Rules\n" + "y".repeat(100)
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        mode: "REFACTOR",
        conventions: shortConventions,
        phase: "PLANNING",
        phaseState: "DRAFT",
      }),
    )
    expect(prompt).toContain(shortConventions)
    expect(prompt).not.toContain("truncated")
  })
})

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — pure function", () => {
  it("returns a non-empty string", () => {
    const prompt = buildWorkflowSystemPrompt(makeState())
    expect(typeof prompt).toBe("string")
    expect(prompt.length).toBeGreaterThan(0)
  })

  it("does not mutate state", () => {
    const state = makeState({ iterationCount: 5 })
    buildWorkflowSystemPrompt(state)
    expect(state.iterationCount).toBe(5)
  })
})
