/**
 * submit-feedback-handlers.ts — Pure logic for the three submit_feedback routing paths.
 *
 * Extracted from index.ts to keep the plugin entry point manageable.
 * Each handler receives all the state and dependencies it needs; none of
 * these functions touch the store directly — they return instructions to
 * the caller, which applies mutations and returns the message to the agent.
 *
 * Three paths:
 *   handleEscapeHatch   — escapePending=true; user is responding to the escape hatch
 *   handleCascade       — pendingRevisionSteps non-empty; continuing a multi-step cascade
 *   handleNormalRevise  — standard orchestrator routing path
 *
 * Note on SM transition calls (H5 documentation):
 * Each handler calls sm.transition(user_feedback) to validate that the current state
 * accepts feedback. The SM always produces currentPhase/REVISE as its result, but the
 * orchestrator may route to a *different* upstream phase (cross-phase revision cascade).
 * The SM result's nextPhase is intentionally overridden by the handler's targetPhase.
 * This is by design: the SM validates the event is legal; the orchestrator determines
 * the actual destination phase based on artifact dependency analysis. The SM cannot
 * encode cross-phase jumps without coupling it to the artifact graph.
 */

import type {
  WorkflowState,
  RevisionStep,
  Phase,
  OrchestratorAssessResult,
  OrchestratorDivergeResult,
} from "../types"
import { isEscapeHatchAbort, isEscapeHatchAccept, isEscapeHatchAmbiguous, parseEscapeHatchNewDirection, buildEscapeHatchPresentation } from "../orchestrator/escape-hatch"
import type { Orchestrator } from "../types"
import type { StateMachine } from "../types"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Outcome returned by each handler. Caller applies mutations and emits message. */
export type FeedbackHandlerOutcome =
  | FeedbackHandlerAbort
  | FeedbackHandlerRevise
  | FeedbackHandlerEscapeRepresent
  | FeedbackHandlerError

export interface FeedbackHandlerAbort {
  action: "abort"
  message: string
}

export interface FeedbackHandlerRevise {
  action: "revise"
  /** Target phase for the first revision step */
  targetPhase: Phase
  /** "REVISE" for tactical/strategic, "DRAFT" for backtrack */
  targetPhaseState: "REVISE" | "DRAFT"
  /** Remaining cascade steps (may be empty) */
  pendingRevisionSteps: RevisionStep[]
  /** Whether to clear escapePending */
  clearEscapePending: boolean
  /** If set, replace intentBaseline with this string */
  newIntentBaseline?: string
  message: string
}

export interface FeedbackHandlerEscapeRepresent {
  action: "escape_represent"
  /** Updated pending steps to store */
  pendingRevisionSteps: RevisionStep[]
  message: string
}

export interface FeedbackHandlerError {
  action: "error"
  message: string
}

// ---------------------------------------------------------------------------
// Handler 1: Escape hatch resolution
// ---------------------------------------------------------------------------

export async function handleEscapeHatch(
  feedbackText: string,
  state: WorkflowState,
  sm: StateMachine,
  orchestrator: Orchestrator,
): Promise<FeedbackHandlerOutcome> {
  const feedbackLower = feedbackText.trim().toLowerCase()

  // Option D — abort
  if (isEscapeHatchAbort(feedbackLower)) {
    return {
      action: "abort",
      message:
        `Escape hatch: change aborted. Staying at current ${state.phase}/USER_GATE state.\n` +
        `The last approved checkpoint is \`${state.lastCheckpointTag ?? "none"}\`. ` +
        `You can roll back to it with \`git reset --hard ${state.lastCheckpointTag ?? "<tag>"}\` if needed.\n\n` +
        `Present the artifact again and wait for the user's next response.`,
    }
  }

  // Option C — "new direction: <requirements>"
  const newDirectionText = parseEscapeHatchNewDirection(feedbackText)
  if (newDirectionText) {
    let ndPlan: { revisionSteps: RevisionStep[]; classification: "tactical" | "strategic" | "backtrack" }
    try {
      ndPlan = await orchestrator.route({
        feedback: newDirectionText,
        currentPhase: state.phase,
        currentPhaseState: state.phaseState,
        mode: state.mode ?? "GREENFIELD",
        approvedArtifacts: state.approvedArtifacts,
      })
    } catch {
      ndPlan = { revisionSteps: [], classification: "tactical" }
    }

    if (!ndPlan.revisionSteps.length) {
      return {
        action: "revise",
        targetPhase: state.phase,
        targetPhaseState: "REVISE",
        pendingRevisionSteps: [],
        clearEscapePending: true,
        newIntentBaseline: newDirectionText.slice(0, 2000),
        message: `New direction recorded. Re-present the artifact with this new focus: "${newDirectionText}"`,
      }
    }

    const ndFirst = ndPlan.revisionSteps[0]!
    const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
    if (!outcome.ok) return { action: "error", message: `State transition failed: ${outcome.message}` }

    return {
      action: "revise",
      targetPhase: ndFirst.phase,
      targetPhaseState: ndFirst.phaseState as "REVISE" | "DRAFT",
      pendingRevisionSteps: ndPlan.revisionSteps.slice(1),
      clearEscapePending: true,
      newIntentBaseline: newDirectionText.slice(0, 2000),
      message:
        `Entirely new direction accepted. Intent baseline replaced.\n\n` +
        `**Step 1 of ${ndPlan.revisionSteps.length}:** Revise the **${ndFirst.artifact}** artifact.\n` +
        `${ndFirst.instructions}\n\n` +
        `Begin revision work now. Call \`request_review\` when complete.`,
    }
  }

  // Guard: ambiguous short responses should ask for clarification, not silently accept
  if (isEscapeHatchAmbiguous(feedbackText)) {
    return {
      action: "error",
      message:
        `Ambiguous response: "${feedbackText.trim()}". ` +
        `Please respond with one of: \`accept\`, \`abort\`, \`new direction: <requirements>\`, ` +
        `or provide a longer description of your preferred alternative direction.`,
    }
  }

  // Option A — plain "accept" / "proceed" / "yes" / "ok" / "okay"
  const isAccept = isEscapeHatchAccept(feedbackLower)
  const hasAlternativeDirection = !isAccept && feedbackText.trim().length > 15

  if (hasAlternativeDirection) {
    // Option B — provide alternative direction; re-run orchestrator
    let altPlan: { revisionSteps: RevisionStep[]; classification: "tactical" | "strategic" | "backtrack" }
    try {
      altPlan = await orchestrator.route({
        feedback: feedbackText,
        currentPhase: state.phase,
        currentPhaseState: state.phaseState,
        mode: state.mode ?? "GREENFIELD",
        approvedArtifacts: state.approvedArtifacts,
      })
    } catch {
      altPlan = { revisionSteps: state.pendingRevisionSteps ?? [], classification: "strategic" }
    }

    // If rebuilt plan is itself strategic — re-present escape hatch
    if (altPlan.classification === "strategic") {
      const altStratFirst = altPlan.revisionSteps[0]
      if (!altStratFirst) {
        return { action: "error", message: "Orchestrator returned strategic classification with no revision steps." }
      }
      const summary = buildEscapeHatchPresentation({
        feedback: feedbackText,
        intentBaseline: feedbackText.slice(0, 2000), // updated baseline
        assessResult: {
          success: true,
          affectedArtifacts: altPlan.revisionSteps.map((s) => s.artifact),
          rootCauseArtifact: altStratFirst.artifact,
          reasoning: "orchestrator re-assessment",
        } satisfies OrchestratorAssessResult,
        divergeResult: {
          success: true,
          classification: "strategic",
          reasoning: "alternative direction re-assessed as strategic",
        } satisfies OrchestratorDivergeResult,
        revisionSteps: altPlan.revisionSteps,
        currentPhase: state.phase,
      })
      return {
        action: "escape_represent",
        pendingRevisionSteps: altPlan.revisionSteps,
        message: summary.presentation,
      }
    }

    // Backtrack — route to earlier phase's DRAFT state
    if (altPlan.classification === "backtrack") {
      const altFirst = altPlan.revisionSteps[0]
      if (!altFirst) {
        return { action: "error", message: "Orchestrator returned backtrack classification with no revision steps." }
      }
      const altOutcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
      if (!altOutcome.ok) return { action: "error", message: `State transition failed: ${altOutcome.message}` }

      return {
        action: "revise",
        targetPhase: altFirst.phase,
        targetPhaseState: altFirst.phaseState as "REVISE" | "DRAFT",
        pendingRevisionSteps: altPlan.revisionSteps.slice(1),
        clearEscapePending: true,
        newIntentBaseline: feedbackText.slice(0, 2000),
        message:
          `Alternative direction accepted — scope change detected, backtracking to ${altFirst.phase}.\n\n` +
          `${altFirst.instructions}\n\n` +
          `The ${altFirst.artifact} artifact will be restarted from scratch.`,
      }
    }

    // Tactical — proceed directly
    const altFirst = altPlan.revisionSteps[0]
    if (!altFirst) {
      return { action: "error", message: "Orchestrator returned empty revision steps for tactical change." }
    }
    const altOutcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
    if (!altOutcome.ok) return { action: "error", message: `State transition failed: ${altOutcome.message}` }

    return {
      action: "revise",
      targetPhase: altFirst.phase,
      targetPhaseState: "REVISE",
      pendingRevisionSteps: altPlan.revisionSteps.slice(1),
      clearEscapePending: true,
      newIntentBaseline: feedbackText.slice(0, 2000),
      message:
        `Alternative direction accepted — rebuilding revision plan.\n\n` +
        `**Step 1 of ${altPlan.revisionSteps.length}:** Revise the **${altFirst.artifact}** artifact.\n` +
        `${altFirst.instructions}\n\n` +
        `Begin revision work now. Call \`request_review\` when the revision is complete.`,
    }
  }

  // Plain "accept" — execute pending plan
  const steps = state.pendingRevisionSteps ?? []
  const firstStep = steps[0]
  if (!firstStep) {
    return {
      action: "error",
      message: "No pending revision steps found. Please re-submit feedback.",
    }
  }

  const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
  if (!outcome.ok) return { action: "error", message: `State transition failed: ${outcome.message}` }

  const remainingMsg = steps.length > 1
    ? `\n\n**Revision cascade:** After completing this revision, ${steps.length - 1} more artifact(s) will need re-review: ${steps.slice(1).map((s) => s.artifact).join(" → ")}.`
    : ""

  return {
    action: "revise",
    targetPhase: firstStep.phase,
    targetPhaseState: "REVISE",
    pendingRevisionSteps: steps.slice(1),
    clearEscapePending: true,
    message:
      `Escape hatch resolved — proceeding with revision.\n\n` +
      `**Step 1 of ${steps.length}:** Revise the **${firstStep.artifact}** artifact.\n` +
      `${firstStep.instructions}${remainingMsg}\n\n` +
      `Begin revision work now. Call \`request_review\` when the revision is complete.`,
  }
}

// ---------------------------------------------------------------------------
// Handler 2: Cascade continuation
// ---------------------------------------------------------------------------

export function handleCascade(
  state: WorkflowState,
  sm: StateMachine,
): FeedbackHandlerOutcome {
  const steps = state.pendingRevisionSteps
  if (!steps || steps.length === 0) {
    return { action: "error", message: "Cascade handler called with no pending revision steps." }
  }
  // steps[0] is guaranteed non-null by the length check above, but TS
  // can't narrow array index access after .length — use explicit guard.
  const [nextStep, ...remaining] = steps
  if (!nextStep) {
    return { action: "error", message: "Cascade handler: unexpected empty steps after length check." }
  }

  const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
  if (!outcome.ok) return { action: "error", message: `State transition failed: ${outcome.message}` }

  const remainingMsg = remaining.length > 0
    ? `\n\n**Cascade continues:** ${remaining.length} more artifact(s) after this: ${remaining.map((s) => s.artifact).join(" → ")}.`
    : "\n\n**Final revision step.** Once complete, call `request_review`."

  return {
    action: "revise",
    targetPhase: nextStep.phase,
    targetPhaseState: "REVISE",
    pendingRevisionSteps: remaining,
    clearEscapePending: false,
    message:
      `**Revision cascade — continuing to next artifact.**\n\n` +
      `Revise the **${nextStep.artifact}** artifact.\n` +
      `${nextStep.instructions}${remainingMsg}\n\n` +
      `Begin revision work now. Call \`request_review\` when the revision is complete.`,
  }
}

// ---------------------------------------------------------------------------
// Handler 3: Normal orchestrator revise path
// ---------------------------------------------------------------------------

export async function handleNormalRevise(
  feedbackText: string,
  fallbackMessage: string,
  state: WorkflowState,
  sm: StateMachine,
  orchestrator: Orchestrator,
): Promise<FeedbackHandlerOutcome> {
  let orchestratorPlan: { revisionSteps: RevisionStep[]; classification: "tactical" | "strategic" | "backtrack" }
  try {
    orchestratorPlan = await orchestrator.route({
      feedback: feedbackText,
      currentPhase: state.phase,
      currentPhaseState: state.phaseState,
      mode: state.mode ?? "GREENFIELD",
      approvedArtifacts: state.approvedArtifacts,
    })
  } catch {
    // Orchestrator hard failure — fall back to simple REVISE in current phase
    const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
    if (!outcome.ok) return { action: "error", message: `State transition failed: ${outcome.message}` }
    return {
      action: "revise",
      targetPhase: outcome.nextPhase as Phase,
      targetPhaseState: "REVISE",
      pendingRevisionSteps: [],
      clearEscapePending: false,
      message: fallbackMessage + "\n\n*(Orchestrator unavailable — proceeding with direct revision.)*",
    }
  }

  const { revisionSteps, classification } = orchestratorPlan

  // Backtrack — route to earlier phase's DRAFT state
  if (classification === "backtrack") {
    const firstStep = revisionSteps[0]
    if (!firstStep) {
      return { action: "error", message: "Orchestrator returned backtrack classification with no revision steps." }
    }
    // Use the backtrack event instead of user_feedback — this produces DRAFT, not REVISE
    const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
    if (!outcome.ok) return { action: "error", message: `State transition failed: ${outcome.message}` }

    return {
      action: "revise",
      targetPhase: firstStep.phase,
      targetPhaseState: firstStep.phaseState as "REVISE" | "DRAFT",
      pendingRevisionSteps: revisionSteps.slice(1),
      clearEscapePending: false,
      message:
        `**Scope change detected — backtracking to ${firstStep.phase} phase.**\n\n` +
        `${firstStep.instructions}\n\n` +
        `The ${firstStep.artifact} artifact will be restarted from scratch. ` +
        `Downstream artifacts that depend on it will need re-approval after this phase completes.`,
    }
  }

  const isStrategic = classification === "strategic"

  if (isStrategic) {
    // Fire escape hatch — stay at USER_GATE, store pending plan
    const stratFirst = revisionSteps[0]
    if (!stratFirst) {
      return { action: "error", message: "Orchestrator returned strategic classification with no revision steps." }
    }
    const summary = buildEscapeHatchPresentation({
      feedback: feedbackText,
      intentBaseline: state.intentBaseline,
      assessResult: {
        success: true,
        affectedArtifacts: revisionSteps.map((s) => s.artifact),
        rootCauseArtifact: stratFirst.artifact,
        reasoning: "orchestrator assessment",
      } satisfies OrchestratorAssessResult,
      divergeResult: {
        success: true,
        classification: "strategic",
        reasoning: "cascade depth or upstream revision detected",
      } satisfies OrchestratorDivergeResult,
      revisionSteps,
      currentPhase: state.phase,
    })
    return {
      action: "escape_represent",
      pendingRevisionSteps: revisionSteps,
      message: summary.presentation,
    }
  }

  // Tactical — proceed directly to REVISE
  const firstStep = revisionSteps[0]
  if (!firstStep) {
    return { action: "error", message: "Orchestrator returned empty revision steps for tactical change." }
  }
  const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
  if (!outcome.ok) return { action: "error", message: `State transition failed: ${outcome.message}` }

  return {
    action: "revise",
    targetPhase: firstStep.phase,
    targetPhaseState: "REVISE",
    pendingRevisionSteps: revisionSteps.slice(1),
    clearEscapePending: false,
    message:
      fallbackMessage + "\n\n" +
      `**Orchestrator routing:** Revise **${firstStep.artifact}** artifact.\n` +
      `${firstStep.instructions}` +
      (revisionSteps.length > 1
        ? `\n\n**Revision cascade:** ${revisionSteps.length - 1} more artifact(s) after this: ${revisionSteps.slice(1).map((s) => s.artifact).join(" → ")}.`
        : ""),
  }
}
