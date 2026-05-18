import type { Phase, PhaseState } from "./workflow-primitives"

export type WorkflowNextActionKind =
  | "author_continue"
  | "adapter_drain"
  | "stop_user_gate"
  | "stop_human_gate"
  | "stop_escape_hatch"
  | "stop_done"
  | "stop_error"

export interface WorkflowNextAction {
  nextAction: WorkflowNextActionKind
  shouldContinue: boolean
  requiresAdapterAction: boolean
  stopReason: string | null
  continuationMessage: string | null
}

export interface WorkflowNextActionState {
  phase: Phase | string
  phaseState: PhaseState | string
  currentTaskId?: string | null
  taskCompletionInProgress?: string | null
}

const AUTHORING_PHASE_STATES = new Set(["DRAFT", "REDRAFT", "REVISE"])
const STRUCTURAL_ADAPTER_PHASE_STATES = new Set(["SKIP_CHECK", "CASCADE_CHECK", "SCHEDULING"])

function buildAuthorContinuationMessage(state: WorkflowNextActionState): string {
  if (state.phase === "IMPLEMENTATION" && state.phaseState === "TASK_REVISE") {
    const task = state.currentTaskId || state.taskCompletionInProgress || "current task"
    return `Continue repairing ${task} in IMPLEMENTATION/TASK_REVISE. Do not stop until the task is ready for review, a real user gate is reached, or a runtime error blocks progress.`
  }
  if (state.phase === "MODE_SELECT") {
    return "Continue the Open Artisan workflow from MODE_SELECT. Select the appropriate mode for the user's request, then keep working until a real user gate or runtime error."
  }
  return `Continue authoring ${state.phase}/${state.phaseState}. Do not stop at authoring states; keep working until REVIEW, USER_GATE, HUMAN_GATE, ESCAPE_HATCH, DONE, or a runtime error.`
}

export function classifyWorkflowNextAction(state: WorkflowNextActionState | null | undefined): WorkflowNextAction {
  if (!state) {
    return {
      nextAction: "stop_error",
      shouldContinue: false,
      requiresAdapterAction: false,
      stopReason: "workflow state is unavailable",
      continuationMessage: null,
    }
  }

  if (state.phase === "DONE") {
    return {
      nextAction: "stop_done",
      shouldContinue: false,
      requiresAdapterAction: false,
      stopReason: "workflow is complete",
      continuationMessage: null,
    }
  }

  if (state.phaseState === "USER_GATE") {
    return {
      nextAction: "stop_user_gate",
      shouldContinue: false,
      requiresAdapterAction: false,
      stopReason: `awaiting user gate at ${state.phase}`,
      continuationMessage: null,
    }
  }

  if (state.phaseState === "HUMAN_GATE") {
    return {
      nextAction: "stop_human_gate",
      shouldContinue: false,
      requiresAdapterAction: false,
      stopReason: `awaiting human gate at ${state.phase}`,
      continuationMessage: null,
    }
  }

  if (state.phaseState === "ESCAPE_HATCH") {
    return {
      nextAction: "stop_escape_hatch",
      shouldContinue: false,
      requiresAdapterAction: false,
      stopReason: `escape hatch reached at ${state.phase}`,
      continuationMessage: null,
    }
  }

  if (state.phase === "IMPLEMENTATION" && state.phaseState === "TASK_REVIEW") {
    const task = state.taskCompletionInProgress || state.currentTaskId || "current task"
    return {
      nextAction: "adapter_drain",
      shouldContinue: true,
      requiresAdapterAction: true,
      stopReason: null,
      continuationMessage: `Dispatch isolated task review for ${task}.`,
    }
  }

  if (state.phaseState === "REVIEW") {
    return {
      nextAction: "adapter_drain",
      shouldContinue: true,
      requiresAdapterAction: true,
      stopReason: null,
      continuationMessage: `Dispatch isolated phase review for ${state.phase}.`,
    }
  }

  if (STRUCTURAL_ADAPTER_PHASE_STATES.has(String(state.phaseState))) {
    return {
      nextAction: "adapter_drain",
      shouldContinue: true,
      requiresAdapterAction: true,
      stopReason: null,
      continuationMessage: `Resolve structural workflow state for ${state.phase}/${state.phaseState}.`,
    }
  }

  if (AUTHORING_PHASE_STATES.has(String(state.phaseState)) || (state.phase === "IMPLEMENTATION" && state.phaseState === "TASK_REVISE")) {
    return {
      nextAction: "author_continue",
      shouldContinue: true,
      requiresAdapterAction: false,
      stopReason: null,
      continuationMessage: buildAuthorContinuationMessage(state),
    }
  }

  return {
    nextAction: "stop_error",
    shouldContinue: false,
    requiresAdapterAction: false,
    stopReason: `No structural continuation rule for ${state.phase}/${state.phaseState}.`,
    continuationMessage: null,
  }
}
