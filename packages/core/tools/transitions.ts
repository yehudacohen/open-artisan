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
  MarkSatisfiedArgs,
  ArtifactKey,
} from "../types"
import { evaluateMarkSatisfied, countExpectedBlockingCriteria } from "./mark-satisfied"
import { processMarkAnalyzeComplete } from "./mark-analyze-complete"
import { getAcceptanceCriteria } from "../hooks/system-transform"
import { PHASE_TO_ARTIFACT } from "../artifacts"
import { MAX_REVIEW_ITERATIONS, MAX_FEEDBACK_CHARS } from "../constants"

// ---------------------------------------------------------------------------
// mark_satisfied — agent self-review (no isolated reviewer)
// ---------------------------------------------------------------------------

export interface MarkSatisfiedTransition {
  nextPhase: Phase
  nextPhaseState: PhaseState
  nextIterationCount: number
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
    severity?: "blocking" | "suggestion"; score?: string | number
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
  const iterationInfo = { current: state.iterationCount + 1, max: MAX_REVIEW_ITERATIONS }
  const result = evaluateMarkSatisfied({ criteria_met: criteriaMet }, expectedBlocking, iterationInfo)

  const nextIterationCount = result.passed ? 0 : state.iterationCount + 1
  const hitCap = !result.passed && nextIterationCount >= MAX_REVIEW_ITERATIONS
  const event: WorkflowEvent = result.passed ? "self_review_pass" : hitCap ? "escalate_to_user" : "self_review_fail"
  const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
  if (!outcome.success) return { success: false, error: outcome.message }

  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      nextIterationCount,
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
  args: { analysis_summary?: string },
  state: WorkflowState,
  sm: StateMachine,
): { success: true; transition: MarkAnalyzeCompleteTransition } | { success: false; error: string } {
  if (state.phase !== "DISCOVERY" || state.phaseState !== "ANALYZE") {
    return { success: false, error: `mark_analyze_complete can only be called in DISCOVERY/ANALYZE (current: ${state.phase}/${state.phaseState}).` }
  }

  const result = processMarkAnalyzeComplete(args as any)
  const outcome = sm.transition(state.phase, state.phaseState, "analyze_complete", state.mode)
  if (!outcome.success) return { success: false, error: outcome.message }

  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      analysisSummary: args.analysis_summary?.trim() ?? null,
      responseMessage: result.responseMessage,
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
): { success: true; transition: SubmitFeedbackReviseTransition } | { success: false; error: string } {
  const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
  if (!outcome.success) return { success: false, error: outcome.message }

  return {
    success: true,
    transition: {
      nextPhase: outcome.nextPhase,
      nextPhaseState: outcome.nextPhaseState,
      feedbackEntry: {
        phase: state.phase,
        feedback: feedbackText.slice(0, MAX_FEEDBACK_CHARS),
        timestamp: Date.now(),
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

const PHASE_ORDER: Phase[] = [
  "MODE_SELECT", "DISCOVERY", "PLANNING", "INTERFACES",
  "TESTS", "IMPL_PLAN", "IMPLEMENTATION", "DONE",
]

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
        timestamp: Date.now(),
      },
      responseMessage: `Backtrack accepted. Moved to ${args.target_phase}/DRAFT. ${args.reason}`,
    },
  }
}
