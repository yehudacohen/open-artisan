/**
 * transitions.ts — Shared state transition logic for agent-only tool handlers.
 *
 * These functions encapsulate the validation, state machine transitions, and
 * state mutation logic that both the bridge and future platform adapters need
 * when operating without SubagentDispatcher (agent-only mode).
 *
 * Each function is pure (no side effects) — it returns a transition descriptor
 * that the caller applies to the store. This keeps I/O in the caller.
 */

import type {
  Phase,
  PhaseState,
  WorkflowEvent,
  ArtifactKey,
} from "../workflow-primitives"
import type { WorkflowState } from "../workflow-state-types"
import type { StateMachine } from "../state-machine-types"
import type { MarkSatisfiedArgs } from "../review-types"
import type { AnalyzeTaskBoundaryChangeArgs, ApplyTaskBoundaryChangeArgs, TaskBoundaryChangeAnalysis as PublicTaskBoundaryChangeAnalysis, TaskBoundaryChangeAnalysisResult, TaskBoundaryChangeApplyResult, TaskBoundaryChangeConflict, TaskBoundaryChangeError } from "../tool-types"
import { evaluateMarkSatisfied, countExpectedBlockingCriteria, countSubmittedBlockingCriteria, type MarkSatisfiedResult } from "./mark-satisfied"
import { processMarkScanComplete } from "./mark-scan-complete"
import { processMarkAnalyzeComplete } from "./mark-analyze-complete"
import { getAcceptanceCriteria } from "../hooks/system-transform"
import { PHASE_TO_ARTIFACT } from "../artifacts"
import { MAX_REVIEW_ITERATIONS, MAX_FEEDBACK_CHARS, PHASE_ORDER } from "../constants"
import type { MarkAnalyzeCompleteArgs } from "./mark-analyze-complete"
import type { MarkScanCompleteArgs } from "./mark-scan-complete"
import { normalizeWorkflowPaths } from "../path-normalization"

// ---------------------------------------------------------------------------
// request_review — shared draft/revision completion transition
// ---------------------------------------------------------------------------

export interface RequestReviewTransition {
  event: WorkflowEvent
  nextPhase: Phase
  nextPhaseState: PhaseState
}

export function computeRequestReviewTransition(
  state: WorkflowState,
  sm: StateMachine,
): { success: true; transition: RequestReviewTransition } | { success: false; error: string } {
  if (state.phaseState === "REVIEW") {
    return { success: false, error: "request_review resubmission does not use a state-machine transition." }
  }
  if (state.phaseState !== "DRAFT" && state.phaseState !== "REDRAFT" && state.phaseState !== "CONVENTIONS" && state.phaseState !== "REVISE") {
    return { success: false, error: `request_review can only be called in DRAFT, REDRAFT, CONVENTIONS, REVISE, or REVIEW state (current: ${state.phase}/${state.phaseState}).` }
  }
  const event: WorkflowEvent = state.phaseState === "REVISE" ? "revision_complete" : "draft_complete"
  const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
  if (!outcome.ok) return { success: false, error: outcome.message }
  return {
    success: true,
    transition: {
      event,
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
    },
  }
}

// ---------------------------------------------------------------------------
// mark_scan_complete — shared DISCOVERY/SCAN transition
// ---------------------------------------------------------------------------

export interface MarkScanCompleteTransition {
  nextPhase: Phase
  nextPhaseState: PhaseState
  responseMessage: string
}

export function computeMarkScanCompleteTransition(
  args: MarkScanCompleteArgs,
  state: WorkflowState,
  sm: StateMachine,
): { success: true; transition: MarkScanCompleteTransition } | { success: false; error: string } {
  if (state.phase !== "DISCOVERY" || state.phaseState !== "SCAN") {
    return { success: false, error: `mark_scan_complete can only be called in DISCOVERY/SCAN (current: ${state.phase}/${state.phaseState}).` }
  }
  const outcome = sm.transition(state.phase, state.phaseState, "scan_complete", state.mode)
  if (!outcome.ok) return { success: false, error: outcome.message }
  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      responseMessage: processMarkScanComplete(args).responseMessage,
    },
  }
}

// ---------------------------------------------------------------------------
// mark_satisfied — agent self-review (no isolated reviewer)
// ---------------------------------------------------------------------------

export interface MarkSatisfiedTransition {
  nextPhase: Phase
  nextPhaseState: PhaseState
  nextIterationCount: number
  event: WorkflowEvent
  responseMessage: string
  latestReviewResults: Array<{ criterion: string; met: boolean; evidence: string; score?: string }>
  clearReviewArtifactHash: boolean
  resetUserGateMessage: boolean
  clearRevisionBaseline: boolean
}

/**
 * Validate and compute the mark_satisfied transition in agent-only mode.
 * Returns a transition descriptor or an error string.
 *
 * Handles: phaseState validation, structural gate (reviewArtifactFiles),
 * score parsing, INCREMENTAL allowlist criterion, criteria evaluation,
 * iteration counting, and escalation routing.
 */
export function computeMarkSatisfiedTransition(
  rawCriteria: Array<{
    criterion: string; met: boolean; evidence: string;
    severity?: "blocking" | "suggestion" | "design-invariant"; score?: string | number
  }>,
  state: WorkflowState,
  sm: StateMachine,
): { success: true; transition: MarkSatisfiedTransition } | { success: false; error: string } {
  if (state.phaseState !== "REVIEW") {
    return { success: false, error: `mark_satisfied can only be called in REVIEW state (current: ${state.phaseState}).` }
  }

  // Structural gate: file-based phases require explicit artifact files
  const isFileBased = ["INTERFACES", "TESTS", "IMPLEMENTATION"].includes(state.phase)
  if (isFileBased && state.reviewArtifactFiles.length === 0) {
    return {
      success: false,
      error: `No artifact files registered for the ${state.phase} review.\n\n` +
        `Call \`request_review\` with \`artifact_files\` listing the files to review, then call \`mark_satisfied\` again.`,
    }
  }

  // Reject empty criteria as a validation error — NOT a review fail.
  // Without this check, empty criteria would flow through evaluateMarkSatisfied as
  // passed:false → self_review_fail → REVISE, which is a state transition that
  // should not happen for a malformed tool call.
  if (!rawCriteria || rawCriteria.length === 0) {
    return {
      success: false,
      error: "criteria_met is empty. You must evaluate every acceptance criterion " +
        "for this phase and provide a non-empty array. Re-read the criteria and call " +
        "mark_satisfied again with your per-criterion assessments.",
    }
  }

  // Parse scores (JSON-RPC may send as strings)
  const criteriaMet: MarkSatisfiedArgs["criteria_met"] = rawCriteria.map((c) => ({
    criterion: c.criterion,
    met: c.met,
    evidence: c.evidence,
    ...(c.severity ? { severity: c.severity } : {}),
    ...(c.score !== undefined ? { score: typeof c.score === "string" ? parseInt(c.score, 10) : c.score } : {}),
  }))

  // INCREMENTAL allowlist criterion enforcement
  if (state.mode === "INCREMENTAL" && state.phase === "PLANNING" && state.fileAllowlist.length > 0) {
    const hasAllowlist = criteriaMet.some((c) => c.criterion.toLowerCase().includes("allowlist adequacy"))
    if (!hasAllowlist) {
      criteriaMet.push({
        criterion: "Allowlist adequacy",
        met: false,
        evidence: "Agent did not assess allowlist adequacy. Add this criterion.",
        severity: "blocking" as const,
      })
    }
  }

  const criteriaText = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, state.artifactDiskPaths?.design ?? null)
  const expectedBlocking = countExpectedBlockingCriteria(criteriaText)

  // Reject insufficient blocking criteria as a validation error — NOT a review fail.
  // Same pattern as the empty criteria check above: malformed tool calls must not
  // trigger state transitions (self_review_fail → REVISE).
  if (expectedBlocking > 0) {
    const submittedBlockingCount = countSubmittedBlockingCriteria(criteriaMet)
    if (submittedBlockingCount < expectedBlocking) {
      return {
        success: false,
        error: `Only ${submittedBlockingCount} blocking criteria submitted, but this phase requires ${expectedBlocking}. ` +
          `You must evaluate ALL blocking criteria independently. Re-read the acceptance criteria and call ` +
          `mark_satisfied again with assessments for all ${expectedBlocking} blocking criteria.`,
      }
    }
  }

  const iterationInfo = { current: state.iterationCount + 1, max: MAX_REVIEW_ITERATIONS }
  const result = evaluateMarkSatisfied({ criteria_met: criteriaMet }, expectedBlocking, iterationInfo)

  return computeMarkSatisfiedTransitionFromResult(result, criteriaMet, state, sm)
}

export function computeMarkSatisfiedTransitionFromResult(
  result: MarkSatisfiedResult,
  criteriaMet: Array<{ criterion: string; met: boolean; evidence: string; score?: string | number }>,
  state: WorkflowState,
  sm: StateMachine,
): { success: true; transition: MarkSatisfiedTransition } | { success: false; error: string } {
  const nextIterationCount = result.passed ? 0 : state.iterationCount + 1
  const hitCap = !result.passed && nextIterationCount >= MAX_REVIEW_ITERATIONS
  const event: WorkflowEvent = result.passed ? "self_review_pass" : hitCap ? "escalate_to_user" : "self_review_fail"
  const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
  if (!outcome.ok) return { success: false, error: outcome.message }

  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      nextIterationCount,
      event,
      responseMessage: result.responseMessage,
      latestReviewResults: criteriaMet.map((c) => ({
        criterion: c.criterion,
        met: c.met,
        evidence: c.evidence,
        ...(c.score !== undefined ? { score: String(c.score) } : {}),
      })),
      clearReviewArtifactHash: outcome.nextPhaseState !== "REVIEW",
      resetUserGateMessage: outcome.nextPhaseState === "USER_GATE",
      clearRevisionBaseline: outcome.nextPhaseState === "REVISE",
    },
  }
}

// ---------------------------------------------------------------------------
// mark_analyze_complete — accept scan summary directly
// ---------------------------------------------------------------------------

export interface MarkAnalyzeCompleteTransition {
  nextPhase: Phase
  nextPhaseState: PhaseState
  analysisSummary: string | null
  responseMessage: string
}

/**
 * Validate and compute the mark_analyze_complete transition.
 * Used in agent-only mode where the discovery fleet is not available.
 */
export function computeMarkAnalyzeCompleteTransition(
  args: MarkAnalyzeCompleteArgs,
  state: WorkflowState,
  sm: StateMachine,
): { success: true; transition: MarkAnalyzeCompleteTransition } | { success: false; error: string } {
  if (state.phase !== "DISCOVERY" || state.phaseState !== "ANALYZE") {
    return { success: false, error: `mark_analyze_complete can only be called in DISCOVERY/ANALYZE (current: ${state.phase}/${state.phaseState}).` }
  }

  const result = processMarkAnalyzeComplete(args)
  const outcome = sm.transition(state.phase, state.phaseState, "analyze_complete", state.mode)
  if (!outcome.ok) return { success: false, error: outcome.message }

  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      analysisSummary: args.analysis_summary?.trim() || null,
      responseMessage: result.responseMessage,
    },
  }
}

// ---------------------------------------------------------------------------
// submit_feedback(approve) — shared approval state-machine transition
// ---------------------------------------------------------------------------

export interface SubmitFeedbackApproveTransition {
  nextPhase: Phase
  nextPhaseState: PhaseState
  phaseCount: number
  newApprovalCount: number
  artifactKey: ArtifactKey | null
  responseMessage: string
}

/**
 * Compute the structural approval transition. Adapter-specific approval side
 * effects (checkpoints, allowlists, DAG parsing, artifact markers) stay in the
 * caller because they depend on platform/runtime services.
 */
export function computeSubmitFeedbackApproveTransition(
  state: WorkflowState,
  sm: StateMachine,
): { success: true; transition: SubmitFeedbackApproveTransition } | { success: false; error: string } {
  if (state.phaseState !== "USER_GATE") {
    return {
      success: false,
      error: `submit_feedback(approve) can only approve from USER_GATE (current: ${state.phase}/${state.phaseState}).`,
    }
  }

  const outcome = sm.transition(state.phase, state.phaseState, "user_approve", state.mode)
  if (!outcome.ok) return { success: false, error: outcome.message }

  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      phaseCount: (state.phaseApprovalCounts[state.phase] ?? 0) + 1,
      newApprovalCount: state.approvalCount + 1,
      artifactKey: PHASE_TO_ARTIFACT[state.phase] ?? null,
      responseMessage: `Approved. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}. Continue immediately in this same turn; do not stop.`,
    },
  }
}

// ---------------------------------------------------------------------------
// submit_feedback(revise) — direct route to REVISE (no orchestrator)
// ---------------------------------------------------------------------------

export interface SubmitFeedbackReviseTransition {
  nextPhase: Phase
  nextPhaseState: PhaseState
  feedbackEntry: { phase: Phase; feedback: string; timestamp: number }
  responseMessage: string
}

/**
 * Compute the submit_feedback(revise) transition in agent-only mode.
 * Routes directly to REVISE without orchestrator classification.
 */
export function computeSubmitFeedbackReviseTransition(
  feedbackText: string,
  state: WorkflowState,
  sm: StateMachine,
  now = Date.now(),
): { success: true; transition: SubmitFeedbackReviseTransition } | { success: false; error: string } {
  const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
  if (!outcome.ok) return { success: false, error: outcome.message }

  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      feedbackEntry: {
        phase: state.phase,
        feedback: feedbackText.slice(0, MAX_FEEDBACK_CHARS),
        timestamp: now,
      },
      responseMessage:
        `Revision requested. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}. ` +
        `Apply the feedback and call \`request_review\` when done.`,
    },
  }
}

// ---------------------------------------------------------------------------
// propose_backtrack — direct backtrack (no orchestrator validation)
// ---------------------------------------------------------------------------

export interface ProposeBacktrackTransition {
  targetPhase: Phase
  clearedArtifactKeys: ArtifactKey[]
  clearImplDag: boolean
  feedbackEntry: { phase: Phase; feedback: string; timestamp: number }
  responseMessage: string
}

/**
 * Validate and compute the propose_backtrack transition in agent-only mode.
 * Accepts the backtrack without orchestrator validation. Computes which
 * artifacts and state fields need to be cleared.
 */
export function computeProposeBacktrackTransition(
  args: { target_phase: string; reason: string },
  state: WorkflowState,
  now = Date.now(),
): { success: true; transition: ProposeBacktrackTransition } | { success: false; error: string } {
  const isBacktrackAuthoringState =
    state.phaseState === "DRAFT" ||
    state.phaseState === "REVISE" ||
    (state.phase === "IMPLEMENTATION" && state.phaseState === "TASK_REVISE") ||
    (state.phase === "IMPLEMENTATION" && state.phaseState === "HUMAN_GATE")
  if (!isBacktrackAuthoringState) {
    return { success: false, error: `propose_backtrack can only be called from DRAFT, REVISE, IMPLEMENTATION/TASK_REVISE, or IMPLEMENTATION/HUMAN_GATE state (current: ${state.phase}/${state.phaseState}).` }
  }
  if (state.phase === "MODE_SELECT" || state.phase === "DISCOVERY" || state.phase === "DONE") {
    return { success: false, error: `propose_backtrack cannot be called from ${state.phase} — there is no earlier phase to backtrack to.` }
  }
  if (!args.target_phase) return { success: false, error: "target_phase is required." }
  if (!args.reason || args.reason.length < 20) return { success: false, error: "reason must be at least 20 characters." }

  const currentIdx = PHASE_ORDER.indexOf(state.phase)
  const targetIdx = PHASE_ORDER.indexOf(args.target_phase as Phase)
  if (targetIdx === -1) return { success: false, error: `"${args.target_phase}" is not a valid phase.` }
  if (targetIdx >= currentIdx) return { success: false, error: `target_phase "${args.target_phase}" is not earlier than current phase "${state.phase}".` }

  // Compute which artifacts to clear (target + all downstream)
  const clearedArtifactKeys: ArtifactKey[] = []
  for (let i = targetIdx; i < PHASE_ORDER.length; i++) {
    const phaseKey = PHASE_ORDER[i]!
    const artifactKey = PHASE_TO_ARTIFACT[phaseKey]
    if (artifactKey) clearedArtifactKeys.push(artifactKey)
  }

  // Preserve implementation DAG history on backtracks. Completed tasks are
  // fast-forwarded as immutable audit records; revised IMPL_PLAN approvals add
  // future corrective tasks instead of clearing or rewriting prior work.
  const implPlanIdx = PHASE_ORDER.indexOf("IMPL_PLAN")
  const hasCompletedTasks = Boolean(state.implDag?.some((task) => task.status === "complete"))
  const clearImplDag = !hasCompletedTasks && (state.phase === "IMPLEMENTATION" || targetIdx <= implPlanIdx)

  return {
    success: true,
    transition: {
      targetPhase: args.target_phase as Phase,
      clearedArtifactKeys,
      clearImplDag,
      feedbackEntry: {
        phase: state.phase,
        feedback: `[propose_backtrack → ${args.target_phase}] ${args.reason.slice(0, MAX_FEEDBACK_CHARS - 50)}`,
        timestamp: now,
      },
      responseMessage: `Backtrack accepted. Moved to ${args.target_phase}/REDRAFT. ${args.reason}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Task boundary revision analysis/apply
// ---------------------------------------------------------------------------

function buildTaskBoundaryChangeError(
  code: TaskBoundaryChangeError["code"],
  message: string,
  error: string = message,
): TaskBoundaryChangeError {
  return { code, message, error }
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)))
}

function uniquePathStrings(values: string[] | undefined, cwd?: string): string[] {
  return cwd ? normalizeWorkflowPaths(values, cwd) : uniqueStrings(values)
}

function computeRevisedPathList(existing: string[] | undefined, add: string[] | undefined, remove: string[] | undefined, cwd?: string): string[] {
  const next = new Set(uniquePathStrings(existing, cwd))
  for (const value of uniquePathStrings(remove, cwd)) next.delete(value)
  for (const value of uniquePathStrings(add, cwd)) next.add(value)
  return Array.from(next)
}

function collectDownstreamTaskIds(implDag: NonNullable<WorkflowState["implDag"]>, seed: Set<string>): Set<string> {
  const impacted = new Set(seed)
  let changed = true
  while (changed) {
    changed = false
    for (const task of implDag) {
      if (impacted.has(task.id)) continue
      if (task.dependencies.some((dependency) => impacted.has(dependency))) {
        impacted.add(task.id)
        changed = true
      }
    }
  }
  return impacted
}

export function analyzeTaskBoundaryChange(
  args: AnalyzeTaskBoundaryChangeArgs,
  state: WorkflowState,
  cwd?: string,
): TaskBoundaryChangeAnalysisResult {
  if (state.phase !== "IMPLEMENTATION") {
    return {
      success: false,
      error: buildTaskBoundaryChangeError(
        "TASK_BOUNDARY_CHANGE_NOT_ALLOWED",
        `Task boundary changes can only be analyzed during IMPLEMENTATION (current: ${state.phase}).`,
      ),
    }
  }
  if (!state.implDag || state.implDag.length === 0) {
    return {
      success: false,
      error: buildTaskBoundaryChangeError(
        "TASK_BOUNDARY_CHANGE_NOT_ALLOWED",
        "No implementation DAG found to analyze.",
      ),
    }
  }
  if (!args.task_id?.trim()) {
    return {
      success: false,
      error: buildTaskBoundaryChangeError(
        "TASK_BOUNDARY_CHANGE_INVALID_ARGS",
        "task_id is required.",
      ),
    }
  }
  if (!args.reason?.trim() || args.reason.trim().length < 20) {
    return {
      success: false,
      error: buildTaskBoundaryChangeError(
        "TASK_BOUNDARY_CHANGE_INVALID_ARGS",
        "reason must be at least 20 characters.",
      ),
    }
  }

  const target = state.implDag.find((task) => task.id === args.task_id)
  if (!target) {
    return {
      success: false,
      error: buildTaskBoundaryChangeError(
        "TASK_BOUNDARY_CHANGE_INVALID_ARGS",
        `Task "${args.task_id}" not found in the implementation DAG.`,
      ),
    }
  }

  const addFiles = uniquePathStrings(args.add_files, cwd)
  const removeFiles = uniquePathStrings(args.remove_files, cwd)
  const addExpectedTests = uniquePathStrings(args.add_expected_tests, cwd)
  const removeExpectedTests = uniquePathStrings(args.remove_expected_tests, cwd)
  const nextExpectedFiles = computeRevisedPathList(target.expectedFiles, addFiles, removeFiles, cwd)
  const nextExpectedTests = computeRevisedPathList(target.expectedTests, addExpectedTests, removeExpectedTests, cwd)

  let preservesAllowlist = true
  if (state.mode === "INCREMENTAL") {
    const allowlist = new Set(uniquePathStrings(state.fileAllowlist, cwd))
    const disallowedFiles = nextExpectedFiles.filter((file) => !allowlist.has(file))
    const disallowedTests = nextExpectedTests.filter((file) => !allowlist.has(file))
    if (disallowedFiles.length > 0 || disallowedTests.length > 0) {
      preservesAllowlist = false
      const allowlistConflict: TaskBoundaryChangeConflict = {
        kind: "allowlist-violation",
        message:
          `Proposed boundary change exceeds the approved INCREMENTAL allowlist.` +
          `${disallowedFiles.length > 0 ? ` files: ${disallowedFiles.join(", ")}.` : ""}` +
          `${disallowedTests.length > 0 ? ` tests: ${disallowedTests.join(", ")}.` : ""}`,
        ...(disallowedFiles.length > 0 ? { filePaths: disallowedFiles as PublicTaskBoundaryChangeAnalysis["overlappingOwnedFiles"] } : {}),
        ...(disallowedTests.length > 0 ? { expectedTests: disallowedTests as PublicTaskBoundaryChangeAnalysis["overlappingExpectedTests"] } : {}),
      }
      return {
        success: false,
        error: buildTaskBoundaryChangeError(
          "TASK_BOUNDARY_CHANGE_CONFLICT",
          `${allowlistConflict.message} This is the global INCREMENTAL allowlist gate, not the task-boundary gate. If the user has approved these files for the active task, call approve_current_task_scope_expansion to update both the allowlist and task boundary atomically; otherwise route it as a planning scope decision.`,
        ),
      }
    }
  }

  const impacted = new Set<string>([target.id])
  const overlappingOwnedFiles = new Set<string>()
  const overlappingExpectedTests = new Set<string>()
  const conflicts: TaskBoundaryChangeConflict[] = []

  for (const task of state.implDag) {
    if (task.id === target.id) continue
    const taskExpectedFiles = uniquePathStrings(task.expectedFiles, cwd)
    const taskExpectedTests = uniquePathStrings(task.expectedTests, cwd)
    const taskOverlappingFiles = addFiles.filter((file) => taskExpectedFiles.includes(file))
    const taskOverlappingTests = addExpectedTests.filter((file) => taskExpectedTests.includes(file))
    if (taskOverlappingFiles.length === 0 && taskOverlappingTests.length === 0) continue
    impacted.add(task.id)

    if (taskOverlappingFiles.length > 0) {
      taskOverlappingFiles.forEach((file) => overlappingOwnedFiles.add(file))
      conflicts.push({
        kind: "file-overlap",
        message: `Task "${task.id}" already owns file(s): ${taskOverlappingFiles.join(", ")}.`,
        taskIds: [target.id, task.id],
        filePaths: taskOverlappingFiles as PublicTaskBoundaryChangeAnalysis["overlappingOwnedFiles"],
      })
    }
    if (taskOverlappingTests.length > 0) {
      taskOverlappingTests.forEach((file) => overlappingExpectedTests.add(file))
      conflicts.push({
        kind: "expected-test-overlap",
        message: `Task "${task.id}" already expects test file(s): ${taskOverlappingTests.join(", ")}.`,
        taskIds: [target.id, task.id],
        expectedTests: taskOverlappingTests as PublicTaskBoundaryChangeAnalysis["overlappingExpectedTests"],
      })
    }
  }

  const downstream = collectDownstreamTaskIds(state.implDag, impacted)
  const impactedTaskIds = Array.from(downstream)
  const completedTaskIdsToReset = impactedTaskIds.filter((taskId) => {
    const task = state.implDag?.find((candidate) => candidate.id === taskId)
    return task?.status === "complete"
  })
  if (completedTaskIdsToReset.length > 0) {
    conflicts.push({
      kind: "completed-task-reset-required",
      message: `Completed task(s) are impacted and must be preserved with future corrective work: ${completedTaskIdsToReset.join(", ")}.`,
      taskIds: completedTaskIdsToReset,
    })
  }

  const preservesParallelism = overlappingOwnedFiles.size === 0 && overlappingExpectedTests.size === 0
  const analysis: PublicTaskBoundaryChangeAnalysis = {
    taskId: target.id,
    impactedTaskIds,
    completedTaskIdsToReset,
    overlappingOwnedFiles: Array.from(overlappingOwnedFiles) as PublicTaskBoundaryChangeAnalysis["overlappingOwnedFiles"],
    overlappingExpectedTests: Array.from(overlappingExpectedTests) as PublicTaskBoundaryChangeAnalysis["overlappingExpectedTests"],
    addFiles: addFiles as PublicTaskBoundaryChangeAnalysis["addFiles"],
    removeFiles: removeFiles as PublicTaskBoundaryChangeAnalysis["removeFiles"],
    addExpectedTests: addExpectedTests as PublicTaskBoundaryChangeAnalysis["addExpectedTests"],
    removeExpectedTests: removeExpectedTests as PublicTaskBoundaryChangeAnalysis["removeExpectedTests"],
    preservesAllowlist,
    preservesDependencyOrdering: true,
    preservesParallelism,
    conflicts,
    rationale: args.reason,
  }
  return { success: true, analysis }
}

export function applyTaskBoundaryChange(
  args: ApplyTaskBoundaryChangeArgs,
  state: WorkflowState,
  cwd?: string,
): TaskBoundaryChangeApplyResult {
  const analyzed = analyzeTaskBoundaryChange(args, state, cwd)
  if (!analyzed.success) return analyzed

  const { analysis } = analyzed
  const expectedImpacted = uniqueStrings(args.expected_impacted_tasks)
  if (expectedImpacted.length > 0) {
    const actual = new Set(analysis.impactedTaskIds)
    const mismatch =
      expectedImpacted.some((taskId) => !actual.has(taskId)) ||
      analysis.impactedTaskIds.some((taskId) => !expectedImpacted.includes(taskId))
    if (mismatch) {
      return {
        success: false,
        error: buildTaskBoundaryChangeError(
          "TASK_BOUNDARY_CHANGE_ACKNOWLEDGEMENT_MISMATCH",
          `Impacted task acknowledgement mismatch. Expected: ${expectedImpacted.join(", ")}. Actual: ${analysis.impactedTaskIds.join(", ")}.`,
        ),
      }
    }
  }

  const expectedReset = uniqueStrings(args.expected_reset_tasks)
  if (analysis.completedTaskIdsToReset.length > 0) {
    return {
      success: false,
      error: buildTaskBoundaryChangeError(
        "TASK_BOUNDARY_CHANGE_CONFLICT",
        `Completed task(s) cannot be reset by task-boundary repair: ${analysis.completedTaskIdsToReset.join(", ")}. Add a future corrective, revert, or superseding task in the IMPL_PLAN instead.`,
      ),
    }
  }
  if (expectedReset.length > 0) {
    const actual = new Set(analysis.completedTaskIdsToReset)
    const mismatch =
      expectedReset.some((taskId) => !actual.has(taskId)) ||
      analysis.completedTaskIdsToReset.some((taskId) => !expectedReset.includes(taskId))
    if (mismatch) {
      return {
        success: false,
        error: buildTaskBoundaryChangeError(
          "TASK_BOUNDARY_CHANGE_ACKNOWLEDGEMENT_MISMATCH",
          `Reset task acknowledgement mismatch. Expected: ${expectedReset.join(", ")}. Actual: ${analysis.completedTaskIdsToReset.join(", ")}.`,
        ),
      }
    }
  }

  const addFiles = new Set(uniquePathStrings(args.add_files, cwd))
  const addTests = new Set(uniquePathStrings(args.add_expected_tests, cwd))
  const targetTask = state.implDag!.find((task) => task.id === analysis.taskId)
  const targetNextExpectedFiles = computeRevisedPathList(
    targetTask?.expectedFiles,
    args.add_files,
    args.remove_files,
    cwd,
  )
  const targetNextExpectedTests = computeRevisedPathList(
    targetTask?.expectedTests,
    args.add_expected_tests,
    args.remove_expected_tests,
    cwd,
  )
  const updatedNodes = state.implDag!.map((task) => {
    if (task.id === analysis.taskId) {
      return {
        ...task,
        expectedFiles: targetNextExpectedFiles,
        expectedTests: targetNextExpectedTests,
      }
    }

    const nextTaskExpectedFiles = uniquePathStrings(task.expectedFiles, cwd).filter((file) => !addFiles.has(file))
    const nextTaskExpectedTests = uniquePathStrings(task.expectedTests, cwd).filter((file) => !addTests.has(file))
    const nextStatus = analysis.completedTaskIdsToReset.includes(task.id) ? "pending" : task.status
    return {
      ...task,
      expectedFiles: nextTaskExpectedFiles,
      expectedTests: nextTaskExpectedTests,
      status: nextStatus,
    }
  })

  return {
    success: true,
    analysis,
    updatedNodes,
    message:
      `Task boundary change applied to ${analysis.taskId}. ` +
      `${analysis.completedTaskIdsToReset.length > 0 ? `Reset completed task(s): ${analysis.completedTaskIdsToReset.join(", ")}. ` : ""}` +
      `Impacted tasks: ${analysis.impactedTaskIds.join(", ")}.`,
  }
}
