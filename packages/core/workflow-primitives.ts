export type WorkflowMode = "GREENFIELD" | "REFACTOR" | "INCREMENTAL"

export type Phase =
  | "MODE_SELECT"
  | "DISCOVERY"
  | "PLANNING"
  | "INTERFACES"
  | "TESTS"
  | "IMPL_PLAN"
  | "IMPLEMENTATION"
  | "DONE"

/**
 * Sub-states within a phase.
 * SCAN/ANALYZE/CONVENTIONS are only valid in the DISCOVERY phase.
 * DRAFT/REVIEW/USER_GATE/REVISE are valid in PLANNING, INTERFACES, TESTS, IMPL_PLAN, IMPLEMENTATION.
 * MODE_SELECT and DONE have no sub-state (use "DRAFT" as a sentinel).
 */
export type PhaseState =
  | "SCAN"
  | "ANALYZE"
  | "CONVENTIONS"
  | "DRAFT"
  | "REVIEW"
  | "USER_GATE"
  | "ESCAPE_HATCH"
  | "REVISE"
  | "REDRAFT"
  | "SKIP_CHECK"
  | "CASCADE_CHECK"
  | "SCHEDULING"
  | "TASK_REVIEW"
  | "TASK_REVISE"
  | "HUMAN_GATE"
  | "DELEGATED_WAIT"

/**
 * Which PhaseStates are valid for each Phase.
 * Enforced by the state machine at transition time.
 */
export const VALID_PHASE_STATES: Record<Phase, PhaseState[]> = {
  MODE_SELECT: ["DRAFT"],
  DISCOVERY: ["SCAN", "ANALYZE", "CONVENTIONS", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  PLANNING: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  INTERFACES: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  TESTS: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  IMPL_PLAN: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  IMPLEMENTATION: ["DRAFT", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE", "SCHEDULING", "TASK_REVIEW", "TASK_REVISE", "HUMAN_GATE", "DELEGATED_WAIT"],
  DONE: ["DRAFT"],
}

export type WorkflowEvent =
  | "mode_selected"           // MODE_SELECT -> DISCOVERY or PLANNING
  | "scan_complete"           // DISCOVERY/SCAN -> DISCOVERY/ANALYZE
  | "analyze_complete"        // DISCOVERY/ANALYZE -> DISCOVERY/CONVENTIONS
  | "draft_complete"          // */DRAFT or */REDRAFT -> */REVIEW
  | "self_review_pass"        // */REVIEW -> */USER_GATE
  | "self_review_fail"        // */REVIEW -> */REVISE (address feedback, increments iterationCount)
  | "escalate_to_user"        // */REVIEW -> */USER_GATE (iteration cap reached - M12)
  | "user_approve"            // */USER_GATE -> next structural state
  | "user_feedback"           // */USER_GATE or */ESCAPE_HATCH -> orchestrator -> */REVISE
  | "escape_hatch_triggered"  // */USER_GATE -> */ESCAPE_HATCH (strategic pivot detected)
  | "revision_complete"       // */REVISE or */TASK_REVISE -> corresponding review state
  | "phase_skipped"
  | "cascade_step_skipped"
  | "task_review_pass"
  | "task_review_fail"
  | "human_gate_resolved"
  | "delegated_task_completed"
  | "scheduling_complete"

export type ArtifactKey =
  | "design"
  | "conventions"
  | "plan"
  | "interfaces"
  | "tests"
  | "impl_plan"
  | "implementation"
