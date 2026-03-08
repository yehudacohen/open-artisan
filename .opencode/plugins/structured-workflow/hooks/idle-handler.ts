/**
 * idle-handler.ts — Handles session.idle events to prevent premature agent stops.
 *
 * When the agent goes idle while NOT at a user gate, it has stopped prematurely.
 * This handler re-prompts the agent with a continuation message, up to 3 times.
 * On the 4th retry, it escalates to the user via a toast notification.
 *
 * When the agent is at a user gate (USER_GATE), idle is expected — the agent
 * should be waiting for user input. No re-prompt in that case.
 */
import type { WorkflowState, Phase, PhaseState } from "../types"

export const MAX_RETRIES = 3

// ---------------------------------------------------------------------------
// Idle decision
// ---------------------------------------------------------------------------

export type IdleDecision =
  | { action: "reprompt"; message: string; retryCount: number }
  | { action: "escalate"; message: string }
  | { action: "ignore" }

/**
 * Determines what to do when the session goes idle.
 * Pure function — does NOT mutate the state (caller must apply retryCount increment).
 */
export function handleIdle(state: WorkflowState): IdleDecision {
  // Expected idle states: USER_GATE and DONE
  if (state.phaseState === "USER_GATE" || state.phase === "DONE") {
    return { action: "ignore" }
  }

  // MODE_SELECT: agent should be presenting options — also expected idle
  if (state.phase === "MODE_SELECT") {
    return { action: "ignore" }
  }

  // Check retry limit
  if (state.retryCount >= MAX_RETRIES) {
    return {
      action: "escalate",
      message: buildEscalationMessage(state.phase, state.phaseState, state.retryCount),
    }
  }

  const nextRetry = state.retryCount + 1
  return {
    action: "reprompt",
    retryCount: nextRetry,
    message: buildRepromptMessage(state.phase, state.phaseState, nextRetry),
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildRepromptMessage(phase: Phase, phaseState: PhaseState, retryCount: number): string {
  const action = getExpectedAction(phase, phaseState)
  return (
    `You stopped, but the ${phaseState} sub-state of the ${phase} phase is not yet complete. ` +
    `${action} ` +
    `(Retry ${retryCount}/${MAX_RETRIES})`
  )
}

function buildEscalationMessage(phase: Phase, phaseState: PhaseState, retries: number): string {
  return (
    `Workflow stalled: the agent stopped ${retries} times during the ${phase}/${phaseState} ` +
    `phase without completing it. Please provide input or instructions to continue.`
  )
}

function getExpectedAction(phase: Phase, phaseState: PhaseState): string {
  if (phaseState === "SCAN") {
    return "Continue scanning the codebase using read-only tools. Call `mark_scan_complete` when finished."
  }
  if (phaseState === "ANALYZE") {
    return "Continue analyzing the scan results. Synthesize findings into a coherent picture. Call `mark_analyze_complete` when analysis is complete."
  }
  if (phaseState === "DRAFT" || phaseState === "CONVENTIONS") {
    return `Continue drafting the ${phase} artifact. Call \`request_review\` when the draft is complete.`
  }
  if (phaseState === "REVIEW") {
    return `Continue self-reviewing the ${phase} artifact against the acceptance criteria. Call \`mark_satisfied\` when review is complete.`
  }
  if (phaseState === "REVISE") {
    return `Continue revising the ${phase} artifact based on the feedback provided. Call \`request_review\` when revision is complete.`
  }
  return `Continue working on the ${phase} phase.`
}
