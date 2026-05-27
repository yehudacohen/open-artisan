import { createStateMachine } from "../state-machine"
import type { WorkflowEvent } from "../workflow-primitives"
import type { WorkflowState } from "../workflow-state-types"

export function applyValidatedStructuralTransition(
  state: WorkflowState,
  event: WorkflowEvent,
): { success: true } | { success: false; error: string } {
  const transition = createStateMachine().transition(state.phase, state.phaseState, event, state.mode)
  if (!transition.ok) return { success: false, error: transition.message }
  state.phase = transition.nextPhase
  state.phaseState = transition.nextPhaseState
  return { success: true }
}
