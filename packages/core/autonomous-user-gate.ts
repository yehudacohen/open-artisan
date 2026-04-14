import type { AutoApproveRequest, AutoApproveSuccess } from "./auto-approve"
import type { ArtifactKey, Phase, StateMachine, TransitionOutcome, WorkflowMode, WorkflowState } from "./types"

export function isRobotArtisanSession(state: Pick<WorkflowState, "activeAgent">): boolean {
  return state.activeAgent === "robot-artisan"
}

export function buildAutoApproveRequest(
  state: Pick<WorkflowState, "phase" | "mode" | "artifactDiskPaths" | "featureName" | "sessionModel">,
  sessionId?: string,
  isEscalation = false,
): AutoApproveRequest {
  return {
    phase: state.phase,
    mode: state.mode,
    artifactDiskPaths: state.artifactDiskPaths as Partial<Record<ArtifactKey, string>>,
    featureName: state.featureName,
    conventionsPath: state.artifactDiskPaths["conventions"] ?? null,
    ...(sessionId ? { parentSessionId: sessionId } : {}),
    ...(state.sessionModel != null ? { parentModel: state.sessionModel } : {}),
    ...(isEscalation ? { isEscalation: true } : {}),
  }
}

export function buildRobotArtisanIdleReprompt(phase: Phase, retryCount: number, maxRetries: number): string {
  return (
    `Robot-artisan stalled at ${phase}/USER_GATE. ` +
    `The autonomous review result was not applied. ` +
    `Do not wait for user input. Resolve the gate autonomously by either continuing after approval ` +
    `or moving the artifact back into revision work. ` +
    `(Retry ${retryCount}/${maxRetries})`
  )
}

export function buildRobotArtisanAutoApproveFailureFeedback(reason: string): string {
  return (
    `Robot-artisan auto-approval could not complete: ${reason}. ` +
    `Do not wait for user input. Re-evaluate the current artifact, make any needed fixes, ` +
    `and call request_review again once the artifact is ready.`
  )
}

export function computeAutoApproveTransition(
  sm: StateMachine,
  phase: Phase,
  mode: WorkflowMode | null,
  decision: AutoApproveSuccess | { approve: boolean },
): TransitionOutcome {
  return sm.transition(phase, "USER_GATE", decision.approve ? "user_approve" : "user_feedback", mode)
}
