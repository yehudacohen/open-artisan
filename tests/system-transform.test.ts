/**
 * Tests for system-transform hook — system prompt building.
 * Covers G11: ANALYZE sub-state now correctly mentions mark_analyze_complete.
 */
import { describe, expect, it } from "bun:test"
import { buildSubagentContext, buildWorkflowSystemPrompt } from "#core/hooks/system-transform"
import type { WorkflowState } from "#core/workflow-state-types"
import { makeWorkflowState } from "./helpers/workflow-state"

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return makeWorkflowState(overrides)
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

  it("does not recommend submit_feedback outside USER_GATE or ESCAPE_HATCH", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        mode: "INCREMENTAL",
        phase: "PLANNING",
        phaseState: "DRAFT",
        fileAllowlist: ["/project/src/allowed.ts"],
      }),
    )
    expect(prompt).not.toContain("submit_feedback")
  })

  it("instructs agents to resolve uncertainty with documented decisions", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "DRAFT" }))
    expect(prompt).toContain("Uncertainty Handling")
    expect(prompt).toContain("make the best decision yourself")
    expect(prompt).toContain("alternatives considered")
    expect(prompt).toContain("tradeoffs/risks")
  })
})

describe("buildWorkflowSystemPrompt — REVIEW sub-state", () => {
  it("mentions mark_satisfied", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "REVIEW" }))
    expect(prompt).toContain("mark_satisfied")
  })

  it("uses isolated review guidance when requested", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "REVIEW" }), { reviewMode: "isolated" })
    expect(prompt).toContain("Do not call `mark_satisfied`")
    expect(prompt).toContain("isolated reviewer")
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

  it("requires uncertainty decisions and tradeoffs to be surfaced at USER_GATE", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "USER_GATE" }))
    expect(prompt).toContain("summarize any decisions you made under uncertainty")
    expect(prompt).toContain("alternatives considered")
    expect(prompt).toContain("tradeoffs/risks")
  })

  it("shows escape hatch warning when phaseState is ESCAPE_HATCH", () => {
    const state = makeState({ phaseState: "ESCAPE_HATCH", phase: "INTERFACES", escapePending: true })
    const prompt = buildWorkflowSystemPrompt(state)
    expect(prompt.toUpperCase()).toContain("ESCAPE HATCH")
  })

  it("does NOT show escape hatch warning at USER_GATE", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "USER_GATE" }))
    expect(prompt.toUpperCase()).not.toContain("ESCAPE HATCH")
  })
})

describe("buildWorkflowSystemPrompt — REVISE sub-state", () => {
  it("mentions request_review for after revision", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "REVISE" }))
    expect(prompt).toContain("request_review")
  })

  it("does not recommend submit_feedback while still in REVISE", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({
        mode: "INCREMENTAL",
        phase: "INTERFACES",
        phaseState: "REVISE",
      }),
    )
    expect(prompt).not.toContain("submit_feedback")
  })

  it("forbids stopping when revision feedback leaves viable alternatives", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phaseState: "REVISE" }))
    expect(prompt).toContain("multiple viable fixes")
    expect(prompt).toContain("choose the best one")
    expect(prompt).toContain("alternatives/tradeoffs")
  })
})

describe("buildWorkflowSystemPrompt — structural workflow sub-states", () => {
  it("surfaces backtrack provenance during PLANNING/REDRAFT", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "PLANNING",
      phaseState: "REDRAFT",
      mode: "INCREMENTAL",
      backtrackContext: {
        sourcePhase: "INTERFACES",
        targetPhase: "PLANNING",
        reason: "Interface review found structural drift that requires a redraft.",
      },
    }))
    expect(prompt).toContain("REDRAFT")
    expect(prompt).toContain("INTERFACES")
    expect(prompt).toContain("Interface review found structural drift")
  })

  it("treats INTERFACES/SKIP_CHECK as an active structural decision state rather than ordinary drafting", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "INTERFACES",
      phaseState: "SKIP_CHECK",
      mode: "INCREMENTAL",
    }))
    expect(prompt).toContain("SKIP_CHECK")
    expect(prompt).toContain("phase_skipped")
    expect(prompt).toContain("scheduling_complete")
  })

  it("treats INTERFACES/CASCADE_CHECK as an explicit cascade decision state", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "INTERFACES",
      phaseState: "CASCADE_CHECK",
      mode: "INCREMENTAL",
    }))
    expect(prompt).toContain("CASCADE_CHECK")
    expect(prompt).toContain("cascade_step_skipped")
    expect(prompt).toContain("scheduling_complete")
  })

  it("treats IMPLEMENTATION/SCHEDULING as dispatch work rather than authoring", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "SCHEDULING",
      mode: "INCREMENTAL",
      implDag: [],
    }))
    expect(prompt).toContain("SCHEDULING")
    expect(prompt).toContain("scheduling_complete")
    expect(prompt).not.toContain("You are drafting the IMPLEMENTATION artifact")
  })

  it("routes blocked IMPLEMENTATION/DRAFT DAG conflicts through propose_backtrack, not submit_feedback", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      mode: "INCREMENTAL",
      featureName: "structural-state-machine-rigor",
      currentTaskId: "T2",
      implDag: [
        {
          id: "T1",
          description: "Earlier task aborted after truthful backtrack.",
          dependencies: [],
          expectedTests: [],
          expectedFiles: ["/project/src/t1.ts"],
          estimatedComplexity: "small",
          status: "aborted",
          category: "integration",
        },
        {
          id: "T2",
          description: "Blocked downstream task.",
          dependencies: ["T1"],
          expectedTests: [],
          expectedFiles: ["/project/src/t2.ts"],
          estimatedComplexity: "small",
          status: "pending",
          category: "integration",
        },
      ],
    }))
    expect(prompt).toContain("DAG BLOCKED")
    expect(prompt).toContain("propose_backtrack")
    expect(prompt).not.toContain("Call `submit_feedback` to alert the user of the scheduling conflict")
  })

  it("treats IMPLEMENTATION/TASK_REVIEW as waiting for submit_task_review", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "TASK_REVIEW",
      mode: "INCREMENTAL",
    }))
    expect(prompt).toContain("TASK_REVIEW")
    expect(prompt).toContain("submit_task_review")
  })

  it("treats IMPLEMENTATION/TASK_REVISE as targeted repair before returning to task review", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "TASK_REVISE",
      mode: "INCREMENTAL",
    }))
    expect(prompt).toContain("TASK_REVISE")
    expect(prompt).toContain("revision_complete")
    expect(prompt).not.toContain("submit_feedback")
  })

  it("treats IMPLEMENTATION/HUMAN_GATE as manual-action waiting rather than a user approval gate", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "HUMAN_GATE",
      mode: "INCREMENTAL",
    }))
    expect(prompt).toContain("HUMAN_GATE")
    expect(prompt).toContain("manual action")
    expect(prompt).not.toContain("submit_feedback")
  })

  it("treats IMPLEMENTATION/DELEGATED_WAIT as waiting on delegated sub-workflow completion", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "DELEGATED_WAIT",
      mode: "INCREMENTAL",
    }))
    expect(prompt).toContain("DELEGATED_WAIT")
    expect(prompt).toContain("delegated_task_completed")
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
    expect(prompt).toContain("real interface/type/schema files")
    expect(prompt).toContain("Every function/method has input types")
  })

  it("injects Tests acceptance criteria at TESTS/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "TESTS", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("real runnable test/spec files")
    expect(prompt).toContain("At least one test per interface method")
  })

  it("injects ImplPlan acceptance criteria at IMPL_PLAN/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "IMPL_PLAN", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("Every interface method is covered")
  })

  it("includes deployment and integration seam criteria in IMPL_PLAN/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "IMPL_PLAN", phaseState: "REVIEW" }))
    expect(prompt).toContain("Deployment tasks present")
    expect(prompt).toContain("Integration seams covered")
  })

  it("includes deployment criterion in PLANNING/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "REVIEW" }))
    expect(prompt).toContain("Deployment & infrastructure addressed")
  })

  it("injects bespoke structural gates for plan, interfaces, and tests review", () => {
    const planning = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "REVIEW" }))
    const interfaces = buildWorkflowSystemPrompt(makeState({ phase: "INTERFACES", phaseState: "REVIEW" }))
    const tests = buildWorkflowSystemPrompt(makeState({ phase: "TESTS", phaseState: "REVIEW" }))

    expect(planning).toContain("Bespoke structural gate — Plan review")
    expect(planning).toContain("protocol/API coverage")
    expect(interfaces).toContain("Bespoke structural gate — Interfaces review")
    expect(interfaces).toContain("structure is encoded in types/schemas/APIs")
    expect(tests).toContain("Bespoke structural gate — Tests review")
    expect(tests).toContain("helper-only implementations")
  })

  it("injects Implementation acceptance criteria at IMPLEMENTATION/REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "IMPLEMENTATION", phaseState: "REVIEW" }))
    expect(prompt).toContain("Acceptance Criteria")
    expect(prompt).toContain("Implementation matches approved interface signatures")
  })

  it("includes substantive implementation gate criteria for placeholders and partial integrations", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "IMPLEMENTATION", phaseState: "REVIEW" }))
    expect(prompt).toContain("No placeholder tests for claimed-complete scope")
    expect(prompt).toContain("No helper-only or half-integrated implementations")
    expect(prompt).toContain("No partial client integration for shared runtime paths")
    expect(prompt).toContain("No duplicated policy or gate logic without justification")
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

  it("includes expected blocking criteria count at REVIEW", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "REVIEW" }))
    // Should include the exact count so the agent knows how many to submit
    expect(prompt).toMatch(/You must provide exactly \*\*\d+\*\* blocking criteria/)
  })

  it("does NOT include criteria count at DRAFT (no mark_satisfied at DRAFT)", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "DRAFT" }))
    expect(prompt).not.toContain("You must provide exactly")
  })

  it("does NOT inject full acceptance criteria at DRAFT state (preview only)", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "DRAFT" }))
    // Full criteria header should not appear
    expect(prompt).not.toContain("### Acceptance Criteria —")
    // But the preview header should appear
    expect(prompt).toContain("Acceptance Criteria Preview")
    expect(prompt).toContain("What the Reviewer Will Evaluate")
  })

  it("does NOT inject acceptance criteria at USER_GATE state", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "USER_GATE" }))
    expect(prompt).not.toContain("Acceptance Criteria Preview")
    // The full criteria header also should not appear
    expect(prompt).not.toContain("### Acceptance Criteria —")
  })
})

describe("buildSubagentContext — implementation scoring visibility", () => {
  it("shows implementation subagents the final scoring rubric", () => {
    const context = buildSubagentContext(makeState({ phase: "IMPLEMENTATION", phaseState: "DRAFT" }))

    expect(context).toContain("Final Implementation Review Rubric")
    expect(context).toContain("minimum 9/10")
    expect(context).toContain("No helper-only or half-integrated implementations")
    expect(context).toContain("Bespoke structural gate — Implementation review")
  })
})

// ---------------------------------------------------------------------------
// Acceptance criteria preview at DRAFT/CONVENTIONS/REVISE
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — acceptance criteria preview at authoring states", () => {
  it("injects the required review rubric before every reviewable phase artifact is submitted", () => {
    const cases: Array<{ name: string; overrides: Partial<WorkflowState>; expected: string }> = [
      {
        name: "DISCOVERY/CONVENTIONS refactor",
        overrides: { phase: "DISCOVERY", phaseState: "CONVENTIONS", mode: "REFACTOR" },
        expected: "Existing architecture accurately described",
      },
      {
        name: "DISCOVERY/CONVENTIONS incremental",
        overrides: { phase: "DISCOVERY", phaseState: "CONVENTIONS", mode: "INCREMENTAL" },
        expected: "Naming conventions documented",
      },
      {
        name: "PLANNING/DRAFT",
        overrides: { phase: "PLANNING", phaseState: "DRAFT", mode: "GREENFIELD" },
        expected: "All user requirements explicitly addressed",
      },
      {
        name: "INTERFACES/DRAFT",
        overrides: { phase: "INTERFACES", phaseState: "DRAFT" },
        expected: "Every function/method has input types",
      },
      {
        name: "TESTS/DRAFT",
        overrides: { phase: "TESTS", phaseState: "DRAFT" },
        expected: "At least one test per interface method",
      },
      {
        name: "IMPL_PLAN/DRAFT",
        overrides: { phase: "IMPL_PLAN", phaseState: "DRAFT" },
        expected: "Every interface method is covered by at least one task",
      },
      {
        name: "IMPLEMENTATION/DRAFT",
        overrides: { phase: "IMPLEMENTATION", phaseState: "DRAFT" },
        expected: "Implementation matches approved interface signatures exactly",
      },
    ]

    for (const c of cases) {
      const prompt = buildWorkflowSystemPrompt(makeState(c.overrides))
      expect(prompt, c.name).toContain("Required Review Rubric")
      expect(prompt, c.name).toContain("implementation contract for this phase")
      expect(prompt, c.name).toContain(c.expected)
      expect(prompt, c.name).toContain("Quality criteria")
    }
  })

  it("injects criteria preview at PLANNING/DRAFT", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "DRAFT" }))
    expect(prompt).toContain("Acceptance Criteria Preview")
    expect(prompt).toContain("All user requirements explicitly addressed")
  })

  it("injects criteria preview at INTERFACES/DRAFT", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "INTERFACES", phaseState: "DRAFT" }))
    expect(prompt).toContain("Acceptance Criteria Preview")
    expect(prompt).toContain("Every function/method has input types")
  })

  it("injects criteria preview at TESTS/REVISE", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "TESTS", phaseState: "REVISE" }))
    expect(prompt).toContain("Acceptance Criteria Preview")
    expect(prompt).toContain("At least one test per interface method")
  })

  it("injects criteria preview at DISCOVERY/CONVENTIONS in REFACTOR mode", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "CONVENTIONS", mode: "REFACTOR" }),
    )
    expect(prompt).toContain("Acceptance Criteria Preview")
    expect(prompt).toContain("Existing architecture accurately described")
  })

  it("does NOT inject criteria preview at USER_GATE", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "USER_GATE" }))
    expect(prompt).not.toContain("Acceptance Criteria Preview")
  })

  it("does NOT inject criteria preview at SCAN", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "SCAN", mode: "REFACTOR" }),
    )
    expect(prompt).not.toContain("Acceptance Criteria Preview")
  })

  it("does NOT inject criteria preview at ANALYZE", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "ANALYZE", mode: "REFACTOR" }),
    )
    expect(prompt).not.toContain("Acceptance Criteria Preview")
  })

  it("preview tells agent to self-evaluate and prepare for strict reviewer", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "DRAFT" }))
    expect(prompt).toContain("Self-evaluate your artifact against EVERY criterion")
    expect(prompt).toContain("reviewer is intentionally rigorous")
    expect(prompt).toContain("push back if the reviewer asks for work")
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
// Phase progress indicator
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — phase progress indicator", () => {
  it("shows progress for PLANNING (phase 2/6 in GREENFIELD)", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "PLANNING", phaseState: "DRAFT", mode: "GREENFIELD" }))
    expect(prompt).toContain("Phase 1 of 5")
  })

  it("shows progress for INTERFACES (phase 3/6 in REFACTOR)", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "INTERFACES", phaseState: "DRAFT", mode: "REFACTOR" }))
    expect(prompt).toContain("Phase 3 of 6")
  })

  it("shows progress for IMPLEMENTATION (last phase)", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "IMPLEMENTATION", phaseState: "DRAFT", mode: "GREENFIELD" }))
    expect(prompt).toContain("Phase 5 of 5")
  })

  it("does NOT show progress at MODE_SELECT", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null }))
    expect(prompt).not.toMatch(/Phase \d+ of \d+/)
  })

  it("does NOT show progress at DONE", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "DONE", phaseState: "DRAFT" }))
    expect(prompt).not.toMatch(/Phase \d+ of \d+/)
  })

  it("INCREMENTAL mode shows DISCOVERY as phase 1 of 6", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "DISCOVERY", phaseState: "SCAN", mode: "INCREMENTAL" }))
    expect(prompt).toContain("Phase 1 of 6")
  })
})

// ---------------------------------------------------------------------------
// IMPLEMENTATION/DRAFT — "all tasks done" signal
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — IMPLEMENTATION DAG completion signal", () => {
  it("tells agent to call request_review when DAG reports all tasks complete", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [
        { id: "T1", description: "First task", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Second task", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ],
    }))
    expect(prompt).toContain("request_review")
    // The DAG status message should clearly direct the agent
    expect(prompt).toContain("All")
    expect(prompt.toLowerCase()).toContain("complete")
  })

  it("shows next task when DAG has pending tasks", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [
        { id: "T1", description: "First task", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Second task", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium", status: "pending" },
      ],
    }))
    expect(prompt).toContain("T2")
    expect(prompt).toContain("Implementation Task")
  })
})

// ---------------------------------------------------------------------------
// MODE_SELECT — lists REFACTOR with description
// ---------------------------------------------------------------------------

describe("buildWorkflowSystemPrompt — MODE_SELECT lists all three modes", () => {
  it("lists REFACTOR mode with description", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null }))
    expect(prompt).toContain("REFACTOR")
    expect(prompt.toLowerCase()).toContain("restructure")
  })

  it("lists GREENFIELD mode with description", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null }))
    expect(prompt).toContain("GREENFIELD")
  })

  it("lists INCREMENTAL mode with description", () => {
    const prompt = buildWorkflowSystemPrompt(makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null }))
    expect(prompt).toContain("INCREMENTAL")
  })
})

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Blocked tools in system prompt (M10)
// ---------------------------------------------------------------------------

describe("blocked tools in system prompt (M10)", () => {
  it("includes blocked tools section for DISCOVERY phase", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "DISCOVERY", phaseState: "SCAN", mode: "REFACTOR" }),
    )
    expect(prompt).toContain("Blocked Tools")
    expect(prompt).toContain("write")
    expect(prompt).toContain("bash")
  })

  it("omits blocked tools section for MODE_SELECT", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "MODE_SELECT", phaseState: "DRAFT", mode: null }),
    )
    expect(prompt).not.toContain("Blocked Tools")
  })

  it("includes blocked tools for INTERFACES phase", () => {
    const prompt = buildWorkflowSystemPrompt(
      makeState({ phase: "INTERFACES", phaseState: "DRAFT", mode: "GREENFIELD" }),
    )
    expect(prompt).toContain("Blocked Tools")
    expect(prompt).toContain("bash")
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
