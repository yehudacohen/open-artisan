/**
 * Tests for the state machine — pure logic, no side effects.
 * All tests import the implementation module, which does not exist yet → tests fail.
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { StateMachine } from "#plugin/types"

// Will fail until implementation exists:
import { createStateMachine } from "#plugin/state-machine"

let sm: StateMachine

beforeEach(() => {
  sm = createStateMachine()
})

// ---------------------------------------------------------------------------
// Happy path: full greenfield flow
// ---------------------------------------------------------------------------
describe("StateMachine — greenfield happy path", () => {
  it("MODE_SELECT/DRAFT + mode_selected (REFACTOR) → DISCOVERY/SCAN", () => {
    const result = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", "REFACTOR")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("SCAN")
  })

  it("DISCOVERY/SCAN + scan_complete → DISCOVERY/ANALYZE", () => {
    const result = sm.transition("DISCOVERY", "SCAN", "scan_complete", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("ANALYZE")
  })

  it("DISCOVERY/ANALYZE + analyze_complete → DISCOVERY/CONVENTIONS", () => {
    const result = sm.transition("DISCOVERY", "ANALYZE", "analyze_complete", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("CONVENTIONS")
  })

  it("DISCOVERY/CONVENTIONS + draft_complete → DISCOVERY/REVIEW", () => {
    const result = sm.transition("DISCOVERY", "CONVENTIONS", "draft_complete", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("REVIEW")
  })

  it("DISCOVERY/REVIEW + self_review_pass → DISCOVERY/USER_GATE", () => {
    const result = sm.transition("DISCOVERY", "REVIEW", "self_review_pass", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("USER_GATE")
  })

  it("DISCOVERY/USER_GATE + user_approve → PLANNING/DRAFT", () => {
    const result = sm.transition("DISCOVERY", "USER_GATE", "user_approve", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("DRAFT")
  })

  it("PLANNING/DRAFT + draft_complete → PLANNING/REVIEW", () => {
    const result = sm.transition("PLANNING", "DRAFT", "draft_complete", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("REVIEW")
  })

  it("PLANNING/USER_GATE + user_approve → INTERFACES/DRAFT", () => {
    const result = sm.transition("PLANNING", "USER_GATE", "user_approve", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("INTERFACES")
    expect(result.nextPhaseState).toBe("DRAFT")
  })

  it("INTERFACES/USER_GATE + user_approve → TESTS/DRAFT", () => {
    const result = sm.transition("INTERFACES", "USER_GATE", "user_approve", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("TESTS")
    expect(result.nextPhaseState).toBe("DRAFT")
  })

  it("TESTS/USER_GATE + user_approve → IMPL_PLAN/DRAFT", () => {
    const result = sm.transition("TESTS", "USER_GATE", "user_approve", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("IMPL_PLAN")
    expect(result.nextPhaseState).toBe("DRAFT")
  })

  it("IMPL_PLAN/USER_GATE + user_approve → IMPLEMENTATION/DRAFT", () => {
    const result = sm.transition("IMPL_PLAN", "USER_GATE", "user_approve", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("IMPLEMENTATION")
    expect(result.nextPhaseState).toBe("DRAFT")
  })

  it("IMPLEMENTATION/USER_GATE + user_approve → DONE/DRAFT", () => {
    const result = sm.transition("IMPLEMENTATION", "USER_GATE", "user_approve", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DONE")
    expect(result.nextPhaseState).toBe("DRAFT")
  })
})

// ---------------------------------------------------------------------------
// GREENFIELD: skips DISCOVERY entirely
// ---------------------------------------------------------------------------
describe("StateMachine — greenfield mode skips discovery", () => {
  it("MODE_SELECT/DRAFT + mode_selected → PLANNING/DRAFT when mode=GREENFIELD", () => {
    const result = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("DRAFT")
  })

  it("MODE_SELECT/DRAFT + mode_selected → DISCOVERY/SCAN when mode=INCREMENTAL", () => {
    const result = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", "INCREMENTAL")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("SCAN")
  })

  it("MODE_SELECT/DRAFT + mode_selected → DISCOVERY/SCAN when mode=REFACTOR", () => {
    const result = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", "REFACTOR")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("SCAN")
  })
})

// ---------------------------------------------------------------------------
// Self-review loop
// ---------------------------------------------------------------------------
describe("StateMachine — self-review fail loops within REVIEW", () => {
  it("PLANNING/REVIEW + self_review_fail → PLANNING/REVIEW (stays in review)", () => {
    const result = sm.transition("PLANNING", "REVIEW", "self_review_fail", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("REVIEW")
  })

  it("INTERFACES/REVIEW + self_review_fail → INTERFACES/REVIEW", () => {
    const result = sm.transition("INTERFACES", "REVIEW", "self_review_fail", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("INTERFACES")
    expect(result.nextPhaseState).toBe("REVIEW")
  })
})

// ---------------------------------------------------------------------------
// Revision loop
// ---------------------------------------------------------------------------
describe("StateMachine — revision loop", () => {
  it("PLANNING/USER_GATE + user_feedback → PLANNING/REVISE", () => {
    const result = sm.transition("PLANNING", "USER_GATE", "user_feedback", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("REVISE")
  })

  it("PLANNING/REVISE + revision_complete → PLANNING/REVIEW", () => {
    const result = sm.transition("PLANNING", "REVISE", "revision_complete", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("REVIEW")
  })

  it("INTERFACES/USER_GATE + user_feedback → INTERFACES/REVISE", () => {
    const result = sm.transition("INTERFACES", "USER_GATE", "user_feedback", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("INTERFACES")
    expect(result.nextPhaseState).toBe("REVISE")
  })
})

// ---------------------------------------------------------------------------
// Invariant: feedback never routes to DRAFT
// ---------------------------------------------------------------------------
describe("StateMachine — invariant: feedback never produces DRAFT", () => {
  const feedbackEvents = ["user_feedback", "self_review_fail"] as const

  for (const event of feedbackEvents) {
    it(`${event} never produces nextPhaseState=DRAFT`, () => {
      const phases = ["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"] as const
      const phaseStates = ["DRAFT", "REVIEW", "USER_GATE", "REVISE"] as const
      for (const phase of phases) {
        for (const phaseState of phaseStates) {
          const result = sm.transition(phase, phaseState, event, "GREENFIELD")
          if (result.success) {
            expect(result.nextPhaseState).not.toBe("DRAFT")
          }
        }
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Invalid transitions return failures
// ---------------------------------------------------------------------------
describe("StateMachine — invalid transitions", () => {
  it("scan_complete in MODE_SELECT is invalid", () => {
    const result = sm.transition("MODE_SELECT", "DRAFT", "scan_complete", null)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("INVALID_EVENT")
  })

  it("user_approve in DRAFT state is invalid", () => {
    const result = sm.transition("PLANNING", "DRAFT", "user_approve", "GREENFIELD")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("INVALID_EVENT")
  })

  it("draft_complete in DONE is invalid", () => {
    const result = sm.transition("DONE", "DRAFT", "draft_complete", "GREENFIELD")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("INVALID_EVENT")
  })

  it("SCAN phaseState is invalid in PLANNING phase", () => {
    const result = sm.transition("PLANNING", "SCAN", "draft_complete", "GREENFIELD")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("INVALID_PHASE_STATE")
  })
})

// ---------------------------------------------------------------------------
// DISCOVERY revision loop (N4 gap)
// ---------------------------------------------------------------------------
describe("StateMachine — DISCOVERY revision loop", () => {
  it("DISCOVERY/USER_GATE + user_feedback → DISCOVERY/REVISE", () => {
    const result = sm.transition("DISCOVERY", "USER_GATE", "user_feedback", "REFACTOR")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("REVISE")
  })

  it("DISCOVERY/REVISE + revision_complete → DISCOVERY/REVIEW", () => {
    const result = sm.transition("DISCOVERY", "REVISE", "revision_complete", "REFACTOR")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("REVIEW")
  })

  it("DISCOVERY/REVIEW + self_review_fail loops back to DISCOVERY/REVIEW", () => {
    const result = sm.transition("DISCOVERY", "REVIEW", "self_review_fail", "INCREMENTAL")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("REVIEW")
  })

  it("DISCOVERY revision feedback never produces nextPhaseState=DRAFT", () => {
    const result = sm.transition("DISCOVERY", "USER_GATE", "user_feedback", "REFACTOR")
    if (result.success) {
      expect(result.nextPhaseState).not.toBe("DRAFT")
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
describe("StateMachine — helpers", () => {
  it("isUserGate returns true for USER_GATE states", () => {
    expect(sm.isUserGate("PLANNING", "USER_GATE")).toBe(true)
    expect(sm.isUserGate("INTERFACES", "USER_GATE")).toBe(true)
    expect(sm.isUserGate("DONE", "DRAFT")).toBe(false)
  })

  it("isAgentActive returns true for DRAFT, REVIEW, REVISE, SCAN, ANALYZE, CONVENTIONS", () => {
    expect(sm.isAgentActive("PLANNING", "DRAFT")).toBe(true)
    expect(sm.isAgentActive("PLANNING", "REVIEW")).toBe(true)
    expect(sm.isAgentActive("PLANNING", "REVISE")).toBe(true)
    expect(sm.isAgentActive("DISCOVERY", "SCAN")).toBe(true)
    expect(sm.isAgentActive("PLANNING", "USER_GATE")).toBe(false)
    expect(sm.isAgentActive("DONE", "DRAFT")).toBe(false)
  })

  it("validEvents for PLANNING/DRAFT returns only draft_complete", () => {
    const events = sm.validEvents("PLANNING", "DRAFT")
    expect(events).toEqual(["draft_complete"])
  })

  it("validEvents for PLANNING/USER_GATE returns user_approve and user_feedback", () => {
    const events = sm.validEvents("PLANNING", "USER_GATE")
    expect(events).toContain("user_approve")
    expect(events).toContain("user_feedback")
    expect(events).not.toContain("draft_complete")
  })
})

// ---------------------------------------------------------------------------
// Review loop — self_review_fail stays in REVIEW, self_review_pass advances
// ---------------------------------------------------------------------------

describe("StateMachine — REVIEW loop behavior", () => {
  it("self_review_fail in PLANNING/REVIEW stays in PLANNING/REVIEW", () => {
    const result = sm.transition("PLANNING", "REVIEW", "self_review_fail", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("REVIEW")
  })

  it("self_review_pass in PLANNING/REVIEW advances to PLANNING/USER_GATE", () => {
    const result = sm.transition("PLANNING", "REVIEW", "self_review_pass", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("USER_GATE")
  })

  it("self_review_pass can be used to force escalation after iteration cap (used by index.ts)", () => {
    // The index.ts uses self_review_pass even on failure when iterationCount >= MAX_REVIEW_ITERATIONS.
    // Verify the state machine correctly advances to USER_GATE on self_review_pass regardless of content.
    const result = sm.transition("INTERFACES", "REVIEW", "self_review_pass", "INCREMENTAL")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhaseState).toBe("USER_GATE")
  })
})

// ---------------------------------------------------------------------------
// validEvents — mode filtering (M2)
// ---------------------------------------------------------------------------
describe("validEvents — mode filtering (M2)", () => {
  it("returns only GREENFIELD transition when mode is GREENFIELD", () => {
    const events = sm.validEvents("MODE_SELECT", "DRAFT", "GREENFIELD")
    expect(events).toContain("mode_selected")
    expect(events).toHaveLength(1)
  })

  it("returns only non-GREENFIELD transition when mode is REFACTOR", () => {
    const events = sm.validEvents("MODE_SELECT", "DRAFT", "REFACTOR")
    expect(events).toContain("mode_selected")
    expect(events).toHaveLength(1)
  })

  it("returns both mode_selected variants when mode is undefined", () => {
    const events = sm.validEvents("MODE_SELECT", "DRAFT")
    expect(events).toContain("mode_selected")
    expect(events).toHaveLength(1)
  })

  it("returns escalate_to_user in REVIEW state", () => {
    const events = sm.validEvents("PLANNING", "REVIEW")
    expect(events).toContain("escalate_to_user")
  })
})

// ---------------------------------------------------------------------------
// escalate_to_user event (M12)
// ---------------------------------------------------------------------------
describe("escalate_to_user event (M12)", () => {
  it("transitions PLANNING/REVIEW → PLANNING/USER_GATE on escalate_to_user", () => {
    const result = sm.transition("PLANNING", "REVIEW", "escalate_to_user", "GREENFIELD")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("USER_GATE")
  })

  it("transitions DISCOVERY/REVIEW → DISCOVERY/USER_GATE on escalate_to_user", () => {
    const result = sm.transition("DISCOVERY", "REVIEW", "escalate_to_user", "REFACTOR")
    expect(result.success).toBe(true)
  })

  it("rejects escalate_to_user from DRAFT state", () => {
    const result = sm.transition("PLANNING", "DRAFT", "escalate_to_user", "GREENFIELD")
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ESCAPE_HATCH state machine transitions
// ---------------------------------------------------------------------------
describe("StateMachine — ESCAPE_HATCH transitions", () => {
  const standardPhases = ["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"] as const

  for (const phase of standardPhases) {
    it(`${phase}/USER_GATE + escape_hatch_triggered → ${phase}/ESCAPE_HATCH`, () => {
      const result = sm.transition(phase, "USER_GATE", "escape_hatch_triggered", "GREENFIELD")
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.nextPhase).toBe(phase)
      expect(result.nextPhaseState).toBe("ESCAPE_HATCH")
    })

    it(`${phase}/ESCAPE_HATCH + user_feedback → ${phase}/REVISE`, () => {
      const result = sm.transition(phase, "ESCAPE_HATCH", "user_feedback", "GREENFIELD")
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.nextPhase).toBe(phase)
      expect(result.nextPhaseState).toBe("REVISE")
    })

    it(`${phase}/ESCAPE_HATCH + user_approve → rejected (structural guarantee)`, () => {
      const result = sm.transition(phase, "ESCAPE_HATCH", "user_approve", "GREENFIELD")
      expect(result.success).toBe(false)
    })
  }

  // DISCOVERY phase
  it("DISCOVERY/USER_GATE + escape_hatch_triggered → DISCOVERY/ESCAPE_HATCH", () => {
    const result = sm.transition("DISCOVERY", "USER_GATE", "escape_hatch_triggered", "REFACTOR")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("ESCAPE_HATCH")
  })

  it("DISCOVERY/ESCAPE_HATCH + user_feedback → DISCOVERY/REVISE", () => {
    const result = sm.transition("DISCOVERY", "ESCAPE_HATCH", "user_feedback", "REFACTOR")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("DISCOVERY")
    expect(result.nextPhaseState).toBe("REVISE")
  })

  it("DISCOVERY/ESCAPE_HATCH + user_approve → rejected (structural guarantee)", () => {
    const result = sm.transition("DISCOVERY", "ESCAPE_HATCH", "user_approve", "REFACTOR")
    expect(result.success).toBe(false)
  })

  // Helper checks
  it("ESCAPE_HATCH is in isUserGate() — returns true", () => {
    expect(sm.isUserGate("PLANNING", "ESCAPE_HATCH")).toBe(true)
    expect(sm.isUserGate("INTERFACES", "ESCAPE_HATCH")).toBe(true)
    expect(sm.isUserGate("DISCOVERY", "ESCAPE_HATCH")).toBe(true)
  })

  it("ESCAPE_HATCH is NOT in isAgentActive() — returns false", () => {
    expect(sm.isAgentActive("PLANNING", "ESCAPE_HATCH")).toBe(false)
    expect(sm.isAgentActive("INTERFACES", "ESCAPE_HATCH")).toBe(false)
    expect(sm.isAgentActive("DISCOVERY", "ESCAPE_HATCH")).toBe(false)
  })

  it("validEvents from ESCAPE_HATCH includes user_feedback but NOT user_approve", () => {
    const events = sm.validEvents("PLANNING", "ESCAPE_HATCH")
    expect(events).toContain("user_feedback")
    expect(events).not.toContain("user_approve")
  })
})
