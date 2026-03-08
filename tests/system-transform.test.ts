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
