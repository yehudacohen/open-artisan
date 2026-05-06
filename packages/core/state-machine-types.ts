import type { Phase, PhaseState, WorkflowEvent, WorkflowMode } from "./workflow-primitives"

/**
 * Successful pure FSM transition lookup.
 */
export interface TransitionSuccess {
  ok: true
  nextPhase: Phase
  nextPhaseState: PhaseState
}

/**
 * Structured transition failure contract for illegal FSM event/state combinations.
 */
export interface TransitionFailure {
  ok: false
  /** Machine-readable error code */
  code: "INVALID_EVENT" | "INVARIANT_VIOLATED" | "INVALID_PHASE_STATE"
  /** Human-readable explanation */
  message: string
}

/**
 * Result of a pure FSM transition lookup.
 */
export type TransitionOutcome = TransitionSuccess | TransitionFailure

export interface StateMachine {
  /**
   * Compute the next state for a given event.
   * Pure function - does NOT mutate the state object.
   * Returns TransitionFailure if the transition is invalid or violates an invariant.
   *
   * Key invariant enforced: user_feedback and self_review_fail never produce
   * a nextPhaseState of "DRAFT". All feedback routes to REVISE.
   */
  transition(
    currentPhase: Phase,
    currentPhaseState: PhaseState,
    event: WorkflowEvent,
    mode: WorkflowMode | null,
  ): TransitionOutcome

  /** Returns all valid events in the given phase/state. When mode is provided,
   *  only events whose mode predicate matches are returned. */
  validEvents(phase: Phase, phaseState: PhaseState, mode?: WorkflowMode | null): WorkflowEvent[]

  /** True iff the state requires the agent to be idle, waiting for the user */
  isUserGate(phase: Phase, phaseState: PhaseState): boolean

  /** True iff the state is an auto-continuation state (agent should keep working) */
  isAgentActive(phase: Phase, phaseState: PhaseState): boolean
}
