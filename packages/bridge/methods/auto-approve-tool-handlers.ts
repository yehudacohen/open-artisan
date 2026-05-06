import { JSONRPCErrorException } from "json-rpc-2.0"

import type { MethodHandler, BridgeContext } from "../server"
import { INVALID_PARAMS, SESSION_NOT_FOUND } from "../protocol"
import type { ArtifactKey } from "../../core/workflow-primitives"
import type { WorkflowState } from "../../core/workflow-state-types"
import { PHASE_TO_ARTIFACT } from "../../core/artifacts"
import { buildAutoApprovePrompt, parseAutoApproveResult, type AutoApproveResult } from "../../core/auto-approve"
import {
  buildAutoApproveRequest,
  buildRobotArtisanAutoApproveFailureFeedback,
  computeAutoApproveTransition,
} from "../../core/autonomous-user-gate"
import { SubmitAutoApproveToolSchema } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import { computeSubmitFeedbackReviseTransition } from "../../core/tools/transitions"
import type { ToolHandler } from "./tool-handler-types"

type ApprovedArtifactMarker = (state: WorkflowState, artifactKey: ArtifactKey) => string

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

export function createAutoApproveToolHandlers(buildApprovedArtifactMarker: ApprovedArtifactMarker) {
  const handleSubmitAutoApprove: ToolHandler = async (args, toolCtx, ctx) => {
    const { store, sm } = ctx.engine!
    const state = requireState(ctx, toolCtx.sessionId)

    if (state.phaseState !== "USER_GATE") {
      return "Error: submit_auto_approve can only be called at USER_GATE."
    }
    if (state.activeAgent !== "robot-artisan") {
      return "Error: submit_auto_approve requires robot-artisan mode."
    }

    const parsedArgs = parseToolArgs(SubmitAutoApproveToolSchema, args)
    if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
    const reviewOutput = parsedArgs.data.review_output.trim()

    const result = parseAutoApproveResult(reviewOutput) as AutoApproveResult
    if (!result.success) {
      const feedbackText = buildRobotArtisanAutoApproveFailureFeedback(result.error)
      const reviseResult = computeSubmitFeedbackReviseTransition(feedbackText, state, sm)
      if (!reviseResult.success) return `Error: ${reviseResult.error}`
      const t = reviseResult.transition
      await store.update(toolCtx.sessionId, (draft) => {
        draft.phase = t.nextPhase
        draft.phaseState = t.nextPhaseState
        draft.retryCount = 0
        draft.reviewArtifactHash = null
        draft.latestReviewResults = null
        draft.reviewArtifactFiles = []
        draft.pendingRevisionSteps = null
        draft.feedbackHistory.push(t.feedbackEntry)
      })
      return `Auto-approve failed. ${t.responseMessage}`
    }

    const autoTransition = computeAutoApproveTransition(sm, state.phase, state.mode, result)
    if (!autoTransition.ok) return `Error: ${autoTransition.message}`

    if (result.approve) {
      const phaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
      const autoArtifactKey = PHASE_TO_ARTIFACT[state.phase]
      const autoArtifactMarker = autoArtifactKey
        ? buildApprovedArtifactMarker(state, autoArtifactKey)
        : null
      await store.update(toolCtx.sessionId, (draft) => {
        draft.phase = autoTransition.nextPhase
        draft.phaseState = autoTransition.nextPhaseState
        draft.approvalCount++
        draft.phaseApprovalCounts[state.phase] = phaseCount
        draft.iterationCount = 0
        draft.retryCount = 0
        draft.userGateMessageReceived = false
        draft.reviewArtifactHash = null
        draft.latestReviewResults = null
        draft.reviewArtifactFiles = []
        if (autoArtifactKey && autoArtifactMarker) {
          draft.approvedArtifacts[autoArtifactKey] = autoArtifactMarker
        }
      })
      return `Auto-approved (confidence: ${result.confidence.toFixed(2)}). Transitioning to ${autoTransition.nextPhase}/${autoTransition.nextPhaseState}.`
    }

    const feedbackText = result.feedback || result.reasoning || "Auto-approver rejected — needs improvement."
    const reviseResult = computeSubmitFeedbackReviseTransition(feedbackText, state, sm)
    if (!reviseResult.success) return `Error: ${reviseResult.error}`
    const t = reviseResult.transition
    await store.update(toolCtx.sessionId, (draft) => {
      draft.phase = t.nextPhase
      draft.phaseState = t.nextPhaseState
      draft.retryCount = 0
      draft.reviewArtifactHash = null
      draft.latestReviewResults = null
      draft.reviewArtifactFiles = []
      draft.pendingRevisionSteps = null
      draft.feedbackHistory.push(t.feedbackEntry)
    })
    return `Auto-approve rejected (confidence: ${result.confidence.toFixed(2)}). ${t.responseMessage}`
  }

  const handleAutoApproveContext: MethodHandler = async (params, ctx) => {
    const p = params as { sessionId?: string }
    if (!p.sessionId) {
      throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
    }
    const state = ctx.engine!.store.get(p.sessionId)
    if (!state || state.phaseState !== "USER_GATE" || state.activeAgent !== "robot-artisan") return null

    return `**Gate:** USER_GATE\n` + buildAutoApprovePrompt(buildAutoApproveRequest(state, p.sessionId))
  }

  return { handleSubmitAutoApprove, handleAutoApproveContext }
}
