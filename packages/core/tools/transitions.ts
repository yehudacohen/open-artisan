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
  WorkflowState,
  StateMachine,
  WorkflowEvent,
  ArtifactKey,
} from "../types"
import type { MarkSatisfiedArgs } from "../review-types"
import type { AnalyzeTaskBoundaryChangeArgs, ApplyTaskBoundaryChangeArgs } from "../tool-types"
import { evaluateMarkSatisfied, countExpectedBlockingCriteria, type MarkSatisfiedResult } from "./mark-satisfied"
import { processMarkScanComplete } from "./mark-scan-complete"
import { processMarkAnalyzeComplete } from "./mark-analyze-complete"
import { getAcceptanceCriteria } from "../hooks/system-transform"
import { PHASE_TO_ARTIFACT } from "../artifacts"
import { MAX_REVIEW_ITERATIONS, MAX_FEEDBACK_CHARS, PHASE_ORDER } from "../constants"
import type { MarkAnalyzeCompleteArgs } from "./mark-analyze-complete"
import type { MarkScanCompleteArgs } from "./mark-scan-complete"

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
  if (state.phaseState !== "DRAFT" && state.phaseState !== "CONVENTIONS" && state.phaseState !== "REVISE") {
    return { success: false, error: `request_review can only be called in DRAFT, CONVENTIONS, REVISE, or REVIEW state (current: ${state.phase}/${state.phaseState}).` }
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
    const submittedBlockingCount = criteriaMet.filter((c) => {
      const sev = c.severity ?? "blocking"
      return sev === "blocking" || sev === "design-invariant"
    }).length
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
  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
    return { success: false, error: `propose_backtrack can only be called from DRAFT or REVISE state (current: ${state.phase}/${state.phaseState}).` }
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

  // Clear impl DAG when backtracking from or past IMPLEMENTATION
  const implPlanIdx = PHASE_ORDER.indexOf("IMPL_PLAN")
  const clearImplDag = state.phase === "IMPLEMENTATION" || targetIdx <= implPlanIdx

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

export interface TaskBoundaryChangeAnalysis {
  taskId: string
  impactedTaskIds: string[]
  completedTaskIdsToReset: string[]
  ownershipConflicts: string[]
  nextExpectedFiles: string[]
  nextExpectedTests: string[]
  message: string
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)))
}

function computeRevisedList(existing: string[] | undefined, add: string[] | undefined, remove: string[] | undefined): string[] {
  const next = new Set(existing ?? [])
  for (const value of uniqueStrings(remove)) next.delete(value)
  for (const value of uniqueStrings(add)) next.add(value)
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
): { success: true; analysis: TaskBoundaryChangeAnalysis } | { success: false; error: string } {
  if (state.phase !== "IMPLEMENTATION") {
    return { success: false, error: `Task boundary changes can only be analyzed during IMPLEMENTATION (current: ${state.phase}).` }
  }
  if (!state.implDag || state.implDag.length === 0) {
    return { success: false, error: "No implementation DAG found to analyze." }
  }
  if (!args.task_id?.trim()) {
    return { success: false, error: "task_id is required." }
  }
  if (!args.reason?.trim() || args.reason.trim().length < 20) {
    return { success: false, error: "reason must be at least 20 characters." }
  }

  const target = state.implDag.find((task) => task.id === args.task_id)
  if (!target) {
    return { success: false, error: `Task "${args.task_id}" not found in the implementation DAG.` }
  }

  const nextExpectedFiles = computeRevisedList(target.expectedFiles, args.add_files, args.remove_files)
  const nextExpectedTests = computeRevisedList(target.expectedTests, args.add_expected_tests, args.remove_expected_tests)

  if (state.mode === "INCREMENTAL") {
    const allowlist = new Set(state.fileAllowlist)
    const disallowedFiles = nextExpectedFiles.filter((file) => !allowlist.has(file))
    const disallowedTests = nextExpectedTests.filter((file) => !allowlist.has(file))
    if (disallowedFiles.length > 0 || disallowedTests.length > 0) {
      const detailParts: string[] = []
      if (disallowedFiles.length > 0) detailParts.push(`files: ${disallowedFiles.join(", ")}`)
      if (disallowedTests.length > 0) detailParts.push(`tests: ${disallowedTests.join(", ")}`)
      return {
        success: false,
        error:
          `Proposed boundary change exceeds the approved INCREMENTAL allowlist (${detailParts.join("; ")}). ` +
          `Revise PLANNING/IMPL_PLAN or request an allowlist change before applying this boundary update.`,
      }
    }
  }

  const impacted = new Set<string>([target.id])
  const ownershipConflicts = new Set<string>()
  const addedFiles = uniqueStrings(args.add_files)
  const addedTests = uniqueStrings(args.add_expected_tests)

  for (const task of state.implDag) {
    if (task.id === target.id) continue
    const overlappingFiles = addedFiles.filter((file) => (task.expectedFiles ?? []).includes(file))
    const overlappingTests = addedTests.filter((file) => (task.expectedTests ?? []).includes(file))
    if (overlappingFiles.length === 0 && overlappingTests.length === 0) continue
    impacted.add(task.id)
    for (const file of overlappingFiles) ownershipConflicts.add(`${task.id}:file:${file}`)
    for (const file of overlappingTests) ownershipConflicts.add(`${task.id}:test:${file}`)
  }

  const downstream = collectDownstreamTaskIds(state.implDag, impacted)
  const completedTaskIdsToReset = Array.from(downstream).filter((taskId) => {
    const task = state.implDag?.find((candidate) => candidate.id === taskId)
    return task?.status === "complete"
  })

  const impactedTaskIds = Array.from(downstream)
  return {
    success: true,
    analysis: {
      taskId: target.id,
      impactedTaskIds,
      completedTaskIdsToReset,
      ownershipConflicts: Array.from(ownershipConflicts),
      nextExpectedFiles,
      nextExpectedTests,
      message:
        `Boundary analysis for ${target.id}: impacted tasks=${impactedTaskIds.join(", ") || target.id}; ` +
        `${completedTaskIdsToReset.length > 0 ? `completed tasks to reset=${completedTaskIdsToReset.join(", ")}` : "no completed tasks need reset"}.`,
    },
  }
}

export function applyTaskBoundaryChange(
  args: ApplyTaskBoundaryChangeArgs,
  state: WorkflowState,
): { success: true; updatedNodes: NonNullable<WorkflowState["implDag"]>; message: string } | { success: false; error: string } {
  const analyzed = analyzeTaskBoundaryChange(args, state)
  if (!analyzed.success) return analyzed

  const { analysis } = analyzed
  const expectedImpacted = uniqueStrings(args.expected_impacted_tasks)
  if (expectedImpacted.length > 0) {
    const actual = new Set(analysis.impactedTaskIds)
    if (expectedImpacted.some((taskId) => !actual.has(taskId)) || analysis.impactedTaskIds.some((taskId) => !expectedImpacted.includes(taskId))) {
      return { success: false, error: `Impacted task acknowledgement mismatch. Expected: ${expectedImpacted.join(", ")}. Actual: ${analysis.impactedTaskIds.join(", ")}.` }
    }
  }

  const expectedReset = uniqueStrings(args.expected_reset_tasks)
  if (expectedReset.length > 0) {
    const actual = new Set(analysis.completedTaskIdsToReset)
    if (expectedReset.some((taskId) => !actual.has(taskId)) || analysis.completedTaskIdsToReset.some((taskId) => !expectedReset.includes(taskId))) {
      return { success: false, error: `Reset task acknowledgement mismatch. Expected: ${expectedReset.join(", ")}. Actual: ${analysis.completedTaskIdsToReset.join(", ")}.` }
    }
  }

  const addFiles = new Set(uniqueStrings(args.add_files))
  const addTests = new Set(uniqueStrings(args.add_expected_tests))
  const updatedNodes = state.implDag!.map((task) => {
    if (task.id === analysis.taskId) {
      return {
        ...task,
        expectedFiles: analysis.nextExpectedFiles,
        expectedTests: analysis.nextExpectedTests,
      }
    }

    const nextTaskExpectedFiles = (task.expectedFiles ?? []).filter((file) => !addFiles.has(file))
    const nextTaskExpectedTests = (task.expectedTests ?? []).filter((file) => !addTests.has(file))
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
    updatedNodes,
    message:
      `Task boundary change applied to ${analysis.taskId}. ` +
      `${analysis.completedTaskIdsToReset.length > 0 ? `Reset completed task(s): ${analysis.completedTaskIdsToReset.join(", ")}. ` : ""}` +
      `Impacted tasks: ${analysis.impactedTaskIds.join(", ")}.`,
  }
}
