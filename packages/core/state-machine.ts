/**
 * state-machine.ts — Pure state machine. No side effects, no I/O.
 * All transitions are determined by a lookup table; no switch soup.
 */
import {
  VALID_PHASE_STATES,
  type Phase,
  type PhaseState,
  type WorkflowEvent,
  type WorkflowMode,
} from "./workflow-primitives"
import type { StateMachine, TransitionOutcome } from "./state-machine-types"
import { PHASE_ORDER } from "./constants"

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

type ModePredicate = ((mode: WorkflowMode | null) => boolean) | null

interface TableEntry {
  from: [Phase, PhaseState]
  event: WorkflowEvent
  modePredicate: ModePredicate
  to: [Phase, PhaseState]
}

function nextPhase(current: Phase): Phase {
  const idx = PHASE_ORDER.indexOf(current)
  const next = PHASE_ORDER[idx + 1]
  if (!next) throw new Error(`No next phase after ${current}`)
  return next
}

const STANDARD_PHASES: Phase[] = [
  "PLANNING",
  "INTERFACES",
  "TESTS",
  "IMPL_PLAN",
  "IMPLEMENTATION",
]

const ARTIFACT_PHASES: Phase[] = ["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN"]

function buildTable(): TableEntry[] {
  const table: TableEntry[] = []

  // MODE_SELECT → PLANNING (GREENFIELD) or DISCOVERY (REFACTOR/INCREMENTAL)
  table.push({
    from: ["MODE_SELECT", "DRAFT"],
    event: "mode_selected",
    modePredicate: (m) => m === "GREENFIELD",
    to: ["PLANNING", "DRAFT"],
  })
  table.push({
    from: ["MODE_SELECT", "DRAFT"],
    event: "mode_selected",
    modePredicate: (m) => m !== "GREENFIELD",
    to: ["DISCOVERY", "SCAN"],
  })

  // DISCOVERY sub-states
  table.push({ from: ["DISCOVERY", "SCAN"], event: "scan_complete", modePredicate: null, to: ["DISCOVERY", "ANALYZE"] })
  table.push({ from: ["DISCOVERY", "ANALYZE"], event: "analyze_complete", modePredicate: null, to: ["DISCOVERY", "CONVENTIONS"] })
  table.push({ from: ["DISCOVERY", "CONVENTIONS"], event: "draft_complete", modePredicate: null, to: ["DISCOVERY", "REVIEW"] })
  table.push({ from: ["DISCOVERY", "REVIEW"], event: "self_review_pass", modePredicate: null, to: ["DISCOVERY", "USER_GATE"] })
  table.push({ from: ["DISCOVERY", "REVIEW"], event: "self_review_fail", modePredicate: null, to: ["DISCOVERY", "REVISE"] })
  table.push({ from: ["DISCOVERY", "REVIEW"], event: "escalate_to_user", modePredicate: null, to: ["DISCOVERY", "USER_GATE"] })
  table.push({ from: ["DISCOVERY", "USER_GATE"], event: "user_approve", modePredicate: null, to: ["PLANNING", "DRAFT"] })
  table.push({ from: ["DISCOVERY", "USER_GATE"], event: "user_feedback", modePredicate: null, to: ["DISCOVERY", "REVISE"] })
  table.push({ from: ["DISCOVERY", "USER_GATE"], event: "escape_hatch_triggered", modePredicate: null, to: ["DISCOVERY", "ESCAPE_HATCH"] })
  table.push({ from: ["DISCOVERY", "ESCAPE_HATCH"], event: "user_feedback", modePredicate: null, to: ["DISCOVERY", "REVISE"] })
  table.push({ from: ["DISCOVERY", "REVISE"], event: "revision_complete", modePredicate: null, to: ["DISCOVERY", "REVIEW"] })

  // Standard phases with DRAFT→REVIEW→USER_GATE→(ESCAPE_HATCH?)→REVISE cycle
  for (const phase of STANDARD_PHASES) {
    const next = nextPhase(phase)
    table.push({ from: [phase, "DRAFT"], event: "draft_complete", modePredicate: null, to: [phase, "REVIEW"] })
    table.push({ from: [phase, "REVIEW"], event: "self_review_pass", modePredicate: null, to: [phase, "USER_GATE"] })
    table.push({ from: [phase, "REVIEW"], event: "self_review_fail", modePredicate: null, to: [phase, "REVISE"] })
    table.push({ from: [phase, "REVIEW"], event: "escalate_to_user", modePredicate: null, to: [phase, "USER_GATE"] })
    table.push({ from: [phase, "USER_GATE"], event: "user_feedback", modePredicate: null, to: [phase, "REVISE"] })
    // ESCAPE_HATCH: strategic pivot detected at USER_GATE → structural guard
    // user_approve is NOT valid in ESCAPE_HATCH — the SM will reject it.
    // Only user_feedback (the escape hatch response) exits ESCAPE_HATCH → REVISE.
    table.push({ from: [phase, "USER_GATE"], event: "escape_hatch_triggered", modePredicate: null, to: [phase, "ESCAPE_HATCH"] })
    table.push({ from: [phase, "ESCAPE_HATCH"], event: "user_feedback", modePredicate: null, to: [phase, "REVISE"] })
    table.push({ from: [phase, "REVISE"], event: "revision_complete", modePredicate: null, to: [phase, "REVIEW"] })

    if (phase === "IMPLEMENTATION") {
      table.push({ from: [phase, "USER_GATE"], event: "user_approve", modePredicate: null, to: [next, "DRAFT"] })
      continue
    }

    table.push({ from: [phase, "REDRAFT"], event: "draft_complete", modePredicate: null, to: [phase, "REVIEW"] })

    if (phase === "IMPL_PLAN") {
      table.push({ from: [phase, "USER_GATE"], event: "user_approve", modePredicate: (m) => m === "INCREMENTAL", to: ["IMPLEMENTATION", "SCHEDULING"] })
    } else {
      table.push({ from: [phase, "USER_GATE"], event: "user_approve", modePredicate: (m) => m === "INCREMENTAL", to: [next, "SKIP_CHECK"] })
    }
    table.push({ from: [phase, "USER_GATE"], event: "user_approve", modePredicate: (m) => m !== "INCREMENTAL", to: [next, "DRAFT"] })

    table.push({ from: [phase, "SKIP_CHECK"], event: "scheduling_complete", modePredicate: null, to: [phase, "DRAFT"] })
    table.push({ from: [phase, "CASCADE_CHECK"], event: "scheduling_complete", modePredicate: null, to: [phase, "REVISE"] })
  }

  for (const phase of ARTIFACT_PHASES) {
    const next = nextPhase(phase)
    if (phase === "IMPL_PLAN") {
      table.push({ from: [phase, "SKIP_CHECK"], event: "phase_skipped", modePredicate: null, to: ["IMPLEMENTATION", "SCHEDULING"] })
      table.push({ from: [phase, "CASCADE_CHECK"], event: "cascade_step_skipped", modePredicate: null, to: ["IMPLEMENTATION", "SCHEDULING"] })
      continue
    }

    table.push({ from: [phase, "SKIP_CHECK"], event: "phase_skipped", modePredicate: null, to: [next, "SKIP_CHECK"] })
    table.push({ from: [phase, "CASCADE_CHECK"], event: "cascade_step_skipped", modePredicate: null, to: [next, "CASCADE_CHECK"] })
  }

  table.push({ from: ["IMPLEMENTATION", "SCHEDULING"], event: "scheduling_complete", modePredicate: null, to: ["IMPLEMENTATION", "DRAFT"] })
  table.push({ from: ["IMPLEMENTATION", "TASK_REVIEW"], event: "task_review_pass", modePredicate: null, to: ["IMPLEMENTATION", "SCHEDULING"] })
  table.push({ from: ["IMPLEMENTATION", "TASK_REVIEW"], event: "task_review_fail", modePredicate: null, to: ["IMPLEMENTATION", "TASK_REVISE"] })
  table.push({ from: ["IMPLEMENTATION", "TASK_REVISE"], event: "revision_complete", modePredicate: null, to: ["IMPLEMENTATION", "TASK_REVIEW"] })
  table.push({ from: ["IMPLEMENTATION", "HUMAN_GATE"], event: "human_gate_resolved", modePredicate: null, to: ["IMPLEMENTATION", "SCHEDULING"] })
  table.push({ from: ["IMPLEMENTATION", "DELEGATED_WAIT"], event: "delegated_task_completed", modePredicate: null, to: ["IMPLEMENTATION", "SCHEDULING"] })

  return table
}

const TRANSITION_TABLE = buildTable()

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function findTransition(
  phase: Phase,
  phaseState: PhaseState,
  event: WorkflowEvent,
  mode: WorkflowMode | null,
): [Phase, PhaseState] | null {
  for (const entry of TRANSITION_TABLE) {
    if (
      entry.from[0] === phase &&
      entry.from[1] === phaseState &&
      entry.event === event &&
      (entry.modePredicate === null || entry.modePredicate(mode))
    ) {
      return entry.to
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Invariant: feedback events never produce DRAFT
// ---------------------------------------------------------------------------

const FEEDBACK_EVENTS: WorkflowEvent[] = ["user_feedback", "self_review_fail"]

function checkInvariants(event: WorkflowEvent, toPhaseState: PhaseState): string | null {
  if (FEEDBACK_EVENTS.includes(event) && toPhaseState === "DRAFT") {
    return `Invariant violated: ${event} must not produce phaseState=DRAFT`
  }
  return null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStateMachine(): StateMachine {
  return {
    transition(
      currentPhase: Phase,
      currentPhaseState: PhaseState,
      event: WorkflowEvent,
      mode: WorkflowMode | null,
    ): TransitionOutcome {
      // Validate phaseState is legal for phase
      const validStates = VALID_PHASE_STATES[currentPhase]
      if (!validStates.includes(currentPhaseState)) {
        return {
          ok: false,
          code: "INVALID_PHASE_STATE",
          message: `PhaseState "${currentPhaseState}" is not valid in phase "${currentPhase}". Valid: ${validStates.join(", ")}`,
        }
      }

      const result = findTransition(currentPhase, currentPhaseState, event, mode)
      if (!result) {
        return {
          ok: false,
          code: "INVALID_EVENT",
          message: `Event "${event}" is not valid in ${currentPhase}/${currentPhaseState}`,
        }
      }

      const [nextPhase, nextPhaseState] = result
      const invariantError = checkInvariants(event, nextPhaseState)
      if (invariantError) {
        return { ok: false, code: "INVARIANT_VIOLATED", message: invariantError }
      }

      return { ok: true, nextPhase, nextPhaseState }
    },

    validEvents(phase: Phase, phaseState: PhaseState, mode?: WorkflowMode | null): WorkflowEvent[] {
      return TRANSITION_TABLE
        .filter((e) =>
          e.from[0] === phase &&
          e.from[1] === phaseState &&
          (mode === undefined || e.modePredicate === null || e.modePredicate(mode)),
        )
        .map((e) => e.event)
        .filter((ev, i, arr) => arr.indexOf(ev) === i) // dedupe mode-predicate variants
    },

    isUserGate(phase: Phase, phaseState: PhaseState): boolean {
      return (phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH") && phase !== "DONE"
    },

    isAgentActive(phase: Phase, phaseState: PhaseState): boolean {
      if (phase === "DONE") return false
      if (phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH") return false
      return true
    },
  }
}
