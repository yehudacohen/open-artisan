/**
 * idle-handler.ts — Handles session.idle events to prevent premature agent stops.
 *
 * When the agent goes idle while NOT at a user gate, it has stopped prematurely.
 * This handler re-prompts the agent with a continuation message, up to 3 times.
 * On the 4th retry, it escalates: toast notification + in-session prompt telling
 * the agent to stop and ask the user for help. Retry count resets so the agent
 * gets fresh attempts after the user provides guidance.
 *
 * When the agent is at a user gate (USER_GATE), idle is expected — the agent
 * should be waiting for user input. No re-prompt in that case.
 */
import type { WorkflowState } from "../workflow-state-types"
import type { Phase, PhaseState } from "../workflow-primitives"
import { getNextActionForState } from "../utils"
import { MAX_IDLE_RETRIES } from "../constants"
import { buildRobotArtisanIdleReprompt } from "../autonomous-user-gate"

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
  // Expected idle states: USER_GATE, ESCAPE_HATCH, and DONE
  //
  // Special case for robot-artisan at USER_GATE: after the inline auto-approver
  // executes and returns, the agent should immediately proceed to the next phase.
  // If the agent goes idle at USER_GATE in robot-artisan mode, it means something
  // went wrong (e.g. the auto-approver result message wasn't acted on, or the
  // inline path fell through to the normal USER_GATE message due to an error).
  // Re-prompt so the workflow doesn't silently stall.
  //
  // We check userGateMessageReceived as a secondary signal: the old code path
  // (pre-Fix 3) set this to true before instructing the agent to call submit_feedback.
  // If it's true and the agent is still at USER_GATE, the agent failed to act.
  if (state.retryCount > MAX_IDLE_RETRIES) {
    return { action: "ignore" }
  }

  if (state.phaseState === "USER_GATE") {
    const isRobotArtisan = state.activeAgent === "robot-artisan"
    if (!isRobotArtisan) {
      // Human session — idle at USER_GATE is expected (waiting for user input)
      return { action: "ignore" }
    }
    // Robot-artisan at USER_GATE: re-prompt so the workflow doesn't stall.
    // This path should now be rare because auto-approval approvals advance inline
    // and auto-approval rejections transition directly to REVISE. If we are still
    // here, the agent needs to recover the gate rather than wait for a human.
    if (state.retryCount >= MAX_IDLE_RETRIES) {
      return {
        action: "escalate",
        message: buildEscalationMessage(state.phase, state.phaseState, state.retryCount),
      }
    }
    const nextRetry = state.retryCount + 1
    return {
      action: "reprompt",
      retryCount: nextRetry,
      message: buildRobotArtisanIdleReprompt(state.phase, nextRetry, MAX_IDLE_RETRIES),
    }
  }

  if (state.phaseState === "ESCAPE_HATCH" || state.phaseState === "HUMAN_GATE" || state.phase === "DONE") {
    return { action: "ignore" }
  }

  // MODE_SELECT: agent should be presenting options — also expected idle
  if (state.phase === "MODE_SELECT") {
    return { action: "ignore" }
  }

  // Check retry limit
  if (state.retryCount >= MAX_IDLE_RETRIES) {
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
  const action = getNextActionForState(phase, phaseState)
  return (
    `You stopped, but the ${phaseState} sub-state of the ${phase} phase is not yet complete. ` +
    `${action} ` +
    `(Retry ${retryCount}/${MAX_IDLE_RETRIES})`
  )
}

function buildEscalationMessage(phase: Phase, phaseState: PhaseState, retries: number): string {
  return (
    `Workflow stalled: the agent stopped ${retries} times during the ${phase}/${phaseState} ` +
    `phase without completing it. Please provide input or instructions to continue.`
  )
}
