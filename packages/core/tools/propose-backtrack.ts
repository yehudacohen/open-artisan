/**
 * propose-backtrack.ts — Pure handler for agent-initiated backtrack proposals.
 *
 * The agent calls propose_backtrack when it discovers during DRAFT or REVISE
 * that an upstream artifact is fundamentally flawed. The orchestrator validates
 * the proposal via assess() + diverge():
 *
 *   - backtrack / strategic → execute immediately (skip REVIEW → USER_GATE)
 *   - tactical              → reject; agent should fix in-place
 *
 * This handler has no side effects — it returns an outcome struct that the
 * caller (index.ts) applies to the store.
 */

import type {
  Phase,
  WorkflowState,
} from "../types"
import type { DivergenceClass, Orchestrator, OrchestratorPlanResult, RevisionStep } from "../orchestrator-types"

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

export interface ProposeBacktrackExecute {
  action: "execute"
  /** Orchestrator's actual target phase (may differ from agent's proposal) */
  targetPhase: Phase
  /** "DRAFT" for backtrack, "REVISE" for strategic */
  targetPhaseState: "DRAFT" | "REVISE"
  /** Remaining cascade steps after the first */
  pendingRevisionSteps: RevisionStep[]
  /** The orchestrator's classification */
  classification: "backtrack" | "strategic"
  message: string
}

export interface ProposeBacktrackReject {
  action: "reject"
  /** Guidance for fixing in-place */
  message: string
}

export interface ProposeBacktrackError {
  action: "error"
  message: string
}

export type ProposeBacktrackOutcome =
  | ProposeBacktrackExecute
  | ProposeBacktrackReject
  | ProposeBacktrackError

import { PHASE_ORDER } from "../constants"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleProposeBacktrack(
  args: { target_phase: Phase; reason: string },
  state: WorkflowState,
  orchestrator: Orchestrator,
): Promise<ProposeBacktrackOutcome> {
  // 1. PhaseState guard — only valid from agent-active working states
  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
    return {
      action: "error",
      message:
        `propose_backtrack can only be called from DRAFT or REVISE state ` +
        `(current: ${state.phase}/${state.phaseState}).`,
    }
  }

  // 2. Phase guard — can't backtrack from MODE_SELECT, DISCOVERY, or DONE
  if (
    state.phase === "MODE_SELECT" ||
    state.phase === "DISCOVERY" ||
    state.phase === "DONE"
  ) {
    return {
      action: "error",
      message:
        `propose_backtrack cannot be called from ${state.phase} — ` +
        `there is no earlier phase to backtrack to.`,
    }
  }

  // 3. Target phase must be strictly earlier than current
  const currentIdx = PHASE_ORDER.indexOf(state.phase)
  const targetIdx = PHASE_ORDER.indexOf(args.target_phase)
  if (targetIdx === -1) {
    return {
      action: "error",
      message: `"${args.target_phase}" is not a valid phase.`,
    }
  }
  if (targetIdx >= currentIdx) {
    return {
      action: "error",
      message:
        `target_phase "${args.target_phase}" is not earlier than current phase ` +
        `"${state.phase}". Backtracking must go to an earlier phase.`,
    }
  }

  // 4. Reason must be substantive
  if (!args.reason || args.reason.trim().length < 20) {
    return {
      action: "error",
      message:
        "reason must be at least 20 characters — explain specifically why backtracking is needed.",
    }
  }

  // 5. Route through orchestrator
  let plan: OrchestratorPlanResult
  try {
    plan = await orchestrator.route({
      feedback: args.reason,
      currentPhase: state.phase,
      currentPhaseState: state.phaseState,
      mode: state.mode ?? "GREENFIELD",
      approvedArtifacts: state.approvedArtifacts,
    })
  } catch {
    return {
      action: "error",
      message:
        "Orchestrator unavailable — cannot validate backtrack proposal. " +
        "Continue working in the current phase. If you believe a backtrack is essential, " +
        "complete the current draft and explain the issue at the next USER_GATE.",
    }
  }

  const { revisionSteps, classification } = plan

  // 6. Tactical → reject; agent should fix in-place
  if (classification === "tactical") {
    const firstStep = revisionSteps[0]
    const guidance = firstStep
      ? `\n\nOrchestrator guidance: ${firstStep.instructions}`
      : ""
    return {
      action: "reject",
      message:
        `Backtrack proposal rejected — the orchestrator classified this as a **tactical** change ` +
        `that can be addressed in the current phase.${guidance}\n\n` +
        `Continue working in ${state.phase}/${state.phaseState}. Apply the fix here rather than backtracking.`,
    }
  }

  // 7. Backtrack or strategic → execute immediately
  const firstStep = revisionSteps[0]
  if (!firstStep) {
    return {
      action: "error",
      message: "Orchestrator returned no revision steps for the proposed backtrack.",
    }
  }

  const classLabel =
    classification === "backtrack" ? "Backtracking" : "Strategic revision"

  return {
    action: "execute",
    targetPhase: firstStep.phase,
    targetPhaseState: firstStep.phaseState as "DRAFT" | "REVISE",
    pendingRevisionSteps: revisionSteps.slice(1),
    classification,
    message:
      `**${classLabel} approved** — moving to ${firstStep.phase}/${firstStep.phaseState}.\n\n` +
      `${firstStep.instructions}\n\n` +
      (classification === "backtrack"
        ? `The ${firstStep.artifact} artifact will be restarted from scratch. ` +
          `Downstream artifacts that depend on it will need re-approval after this phase completes.`
        : `The ${firstStep.artifact} artifact needs revision.` +
          (revisionSteps.length > 1
            ? ` After completing this step, ${revisionSteps.length - 1} more artifact(s) will need revision: ${revisionSteps.slice(1).map((s) => s.artifact).join(" → ")}.`
            : "")),
  }
}
