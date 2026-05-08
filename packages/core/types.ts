/**
 * types.ts — Public compatibility barrel plus explicit workflow vocabulary contract.
 *
 * Decision note: this file is the public source-of-truth compatibility surface for
 * structural-state-machine-rigor. It must expose the concrete workflow vocabulary
 * directly so downstream tests and implementations do not have to infer the contract
 * by following internal re-export chains.
 */

/** Fully enumerated workflow modes. */
export type WorkflowMode = "GREENFIELD" | "REFACTOR" | "INCREMENTAL"

/** Fully enumerated top-level workflow phases. */
export type Phase =
  | "MODE_SELECT"
  | "DISCOVERY"
  | "PLANNING"
  | "INTERFACES"
  | "TESTS"
  | "IMPL_PLAN"
  | "IMPLEMENTATION"
  | "DONE"

/** Fully enumerated workflow sub-states. */
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

/** Fully enumerated workflow events. */
export type WorkflowEvent =
  | "mode_selected"
  | "scan_complete"
  | "analyze_complete"
  | "draft_complete"
  | "self_review_pass"
  | "self_review_fail"
  | "escalate_to_user"
  | "user_approve"
  | "user_feedback"
  | "escape_hatch_triggered"
  | "revision_complete"
  | "phase_skipped"
  | "cascade_step_skipped"
  | "task_review_pass"
  | "task_review_fail"
  | "human_gate_resolved"
  | "delegated_task_completed"
  | "scheduling_complete"

/** Artifact kinds tracked by workflow review/approval state. */
export type ArtifactKey =
  | "design"
  | "conventions"
  | "plan"
  | "interfaces"
  | "tests"
  | "impl_plan"
  | "implementation"

/** Valid sub-states for each top-level phase. */
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

export * from "./workflow-state-types"
export * from "./state-machine-types"
export * from "./structural-workflow-types"
export * from "./artifact-types"
export * from "./session-registry-types"
export type { StateBackend, StateBackendError } from "./state-backend-types"
export * from "./roadmap-types"
export * from "./orchestrator-types"
export * from "./review-types"
export * from "./tool-types"
export * from "./phase-tool-policy-types"
export * from "./git-checkpoint-types"
export * from "./mode-detection-types"

/** Fully enumerated public workflow modes. */
export const WORKFLOW_MODES: readonly WorkflowMode[] = ["GREENFIELD", "REFACTOR", "INCREMENTAL"]

/** Fully enumerated top-level workflow phases. */
export const WORKFLOW_PHASES: readonly Phase[] = [
  "MODE_SELECT",
  "DISCOVERY",
  "PLANNING",
  "INTERFACES",
  "TESTS",
  "IMPL_PLAN",
  "IMPLEMENTATION",
  "DONE",
]

/** Fully enumerated workflow sub-states exposed at the public contract boundary. */
export const WORKFLOW_PHASE_STATES: readonly PhaseState[] = [
  "SCAN",
  "ANALYZE",
  "CONVENTIONS",
  "DRAFT",
  "REVIEW",
  "USER_GATE",
  "ESCAPE_HATCH",
  "REVISE",
  "REDRAFT",
  "SKIP_CHECK",
  "CASCADE_CHECK",
  "SCHEDULING",
  "TASK_REVIEW",
  "TASK_REVISE",
  "HUMAN_GATE",
  "DELEGATED_WAIT",
]

/** Fully enumerated workflow events exposed at the public contract boundary. */
export const WORKFLOW_EVENTS: readonly WorkflowEvent[] = [
  "mode_selected",
  "scan_complete",
  "analyze_complete",
  "draft_complete",
  "self_review_pass",
  "self_review_fail",
  "escalate_to_user",
  "user_approve",
  "user_feedback",
  "escape_hatch_triggered",
  "revision_complete",
  "phase_skipped",
  "cascade_step_skipped",
  "task_review_pass",
  "task_review_fail",
  "human_gate_resolved",
  "delegated_task_completed",
  "scheduling_complete",
]

/**
 * Stable summary contract for external consumers that need the concrete structural
 * workflow vocabulary without reading the runtime source modules individually.
 */
export interface WorkflowVocabularyContract {
  modes: readonly WorkflowMode[]
  phases: readonly Phase[]
  phaseStates: readonly PhaseState[]
  events: readonly WorkflowEvent[]
}

export const WORKFLOW_VOCABULARY_CONTRACT: WorkflowVocabularyContract = {
  modes: WORKFLOW_MODES,
  phases: WORKFLOW_PHASES,
  phaseStates: WORKFLOW_PHASE_STATES,
  events: WORKFLOW_EVENTS,
}
