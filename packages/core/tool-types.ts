/**
 * tool-types.ts — Workflow tool argument and task-boundary contracts.
 */

import type { TaskNode } from "./dag"
import type { WorkflowMode } from "./types"

export interface SelectModeArgs {
  mode: WorkflowMode
  /** Required feature subdirectory name for artifact isolation (kebab-case) */
  feature_name: string
}

export interface MarkScanCompleteArgs {
  /** Brief summary of what was scanned and key observations */
  scan_summary: string
}

export interface MarkAnalyzeCompleteArgs {
  /** Brief summary of what was analyzed and key architectural/convention findings */
  analysis_summary: string
}

/**
 * Public workflow-tool arguments for submit_feedback.
 *
 * This contract intentionally carries both ordinary approval/revision feedback and
 * the planning-gate allowlist replacement used in INCREMENTAL mode.
 */
export interface SubmitFeedbackArgs {
  /** The user's raw feedback text */
  feedback_text: string
  /** Whether the user approved or is requesting a revision */
  feedback_type: "approve" | "revise"
  /**
   * Optional: list of absolute file paths to allow writes to (for PLANNING/USER_GATE approval in INCREMENTAL mode).
   * When approving the PLANNING phase in INCREMENTAL mode, pass the approved file allowlist here.
   * This is the full replacement allowlist approved at the planning gate, not an incremental patch.
   */
  approved_files?: string[]
  /**
   * Optional: list of human-gated task IDs that the user confirms are resolved.
   * Only valid at IMPLEMENTATION/HUMAN_GATE. Each listed task must have status "human-gated".
   * The user is confirming they have completed the required infrastructure/credential setup.
   */
  resolved_human_gates?: string[]
}

export interface ResolveHumanGateArgs {
  /** The DAG task ID of the human-gate task being activated */
  task_id: string
  /** Description of what the human needs to do */
  what_is_needed: string
  /** Why this human action is needed for the implementation */
  why: string
  /** Steps the human can take to verify the gate is resolved */
  verification_steps: string
}

export interface SpawnSubWorkflowArgs {
  /** The DAG task ID to delegate to a child sub-workflow */
  task_id: string
  /** Feature name for the child workflow (kebab-case, used as directory name) */
  feature_name: string
}

/** Absolute project file path approved for ownership/test targeting in boundary-revision flows. */
export type AbsoluteFilePath = string & { readonly __absoluteFilePathBrand: "AbsoluteFilePath" }

/** Non-empty human/agent-authored rationale carried through boundary-revision review. */
export type NonEmptyBoundaryChangeReason = string & { readonly __nonEmptyBoundaryChangeReasonBrand: "NonEmptyBoundaryChangeReason" }

/**
 * Input contract for implementation-time task-boundary analysis.
 *
 * Path fields use branded absolute-path types so later phases can distinguish
 * ownership/test file references from arbitrary free-form strings.
 */
export interface AnalyzeTaskBoundaryChangeArgs {
  /** The task whose ownership boundary is being revised */
  task_id: string
  /** Absolute file paths to add to the task's owned file set */
  add_files?: AbsoluteFilePath[]
  /** Absolute file paths to remove from the task's owned file set */
  remove_files?: AbsoluteFilePath[]
  /** Expected test file paths to add to the task */
  add_expected_tests?: AbsoluteFilePath[]
  /** Expected test file paths to remove from the task */
  remove_expected_tests?: AbsoluteFilePath[]
  /**
   * Why the boundary change is needed.
   * Must be a non-empty user/agent-authored explanation that can be surfaced in review.
   */
  reason: NonEmptyBoundaryChangeReason
}

/**
 * Apply-time acknowledgement contract for a previously analyzed task-boundary revision.
 */
export interface ApplyTaskBoundaryChangeArgs extends AnalyzeTaskBoundaryChangeArgs {
  /** Explicit acknowledgement of which tasks are expected to be impacted by the change */
  expected_impacted_tasks?: string[]
  /** Explicit acknowledgement of which completed tasks are expected to be reset */
  expected_reset_tasks?: string[]
}

export type TaskBoundaryChangeConflictKind =
  | "task-not-found"
  | "file-overlap"
  | "expected-test-overlap"
  | "dependency-adjacency-change"
  | "parallelism-break"
  | "allowlist-violation"
  | "completed-task-reset-required"
  | "illegal-phase"
  | "review-acknowledgement-mismatch"

/**
 * A concrete incompatibility or review-surface hazard discovered while analyzing
 * a proposed task-boundary revision.
 */
export interface TaskBoundaryChangeConflict {
  kind: TaskBoundaryChangeConflictKind
  message: string
  taskIds?: string[]
  filePaths?: AbsoluteFilePath[]
  expectedTests?: AbsoluteFilePath[]
}

/**
 * Full impact analysis for a proposed task-boundary revision.
 *
 * This is the public analysis contract that later TESTS/IMPLEMENTATION work relies on
 * when determining whether a boundary change is legal, what it invalidates, and which
 * downstream tasks/reviews are affected.
 */
export interface TaskBoundaryChangeAnalysis {
  taskId: string
  impactedTaskIds: string[]
  completedTaskIdsToReset: string[]
  overlappingOwnedFiles: AbsoluteFilePath[]
  overlappingExpectedTests: AbsoluteFilePath[]
  addFiles: AbsoluteFilePath[]
  removeFiles: AbsoluteFilePath[]
  addExpectedTests: AbsoluteFilePath[]
  removeExpectedTests: AbsoluteFilePath[]
  preservesAllowlist: boolean
  preservesDependencyOrdering: boolean
  preservesParallelism: boolean
  conflicts: TaskBoundaryChangeConflict[]
  rationale: NonEmptyBoundaryChangeReason
}

export interface TaskBoundaryChangeError extends String {
  code:
    | "TASK_BOUNDARY_CHANGE_NOT_ALLOWED"
    | "TASK_BOUNDARY_CHANGE_INVALID_ARGS"
    | "TASK_BOUNDARY_CHANGE_CONFLICT"
    | "TASK_BOUNDARY_CHANGE_ACKNOWLEDGEMENT_MISMATCH"
  message: string
  error: string
}

export type TaskBoundaryChangeAnalysisResult =
  | { success: true; analysis: TaskBoundaryChangeAnalysis }
  | { success: false; error: TaskBoundaryChangeError }

export type TaskBoundaryChangeApplyResult =
  | {
      success: true
      analysis: TaskBoundaryChangeAnalysis
      updatedNodes: TaskNode[]
      message: string
    }
  | { success: false; error: TaskBoundaryChangeError }
