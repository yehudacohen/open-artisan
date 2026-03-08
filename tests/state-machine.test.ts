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
  it("MODE_SELECT/DRAFT + mode_selected → DISCOVERY/SCAN", () => {
    const result = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", null)
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
// INCREMENTAL: skips DISCOVERY entirely
// ---------------------------------------------------------------------------
describe("StateMachine — incremental mode skips discovery", () => {
  it("MODE_SELECT/DRAFT + mode_selected → PLANNING/DRAFT when mode=INCREMENTAL", () => {
    const result = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", "INCREMENTAL")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.nextPhase).toBe("PLANNING")
    expect(result.nextPhaseState).toBe("DRAFT")
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
