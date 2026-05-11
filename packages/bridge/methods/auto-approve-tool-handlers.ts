import { JSONRPCErrorException } from "json-rpc-2.0"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

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
import { extractApprovedFileAllowlist } from "../../core/tools/plan-allowlist"
import { computeForwardSkip } from "../../core/fast-forward"
import { REVIEW_SUBMISSION_TOKEN_BYTES, REVIEW_SUBMISSION_TOKEN_TTL_MS } from "../../core/constants"
import type { ToolHandler } from "./tool-handler-types"
import { artifactFilesHash } from "./review-feedback-tool-handlers"

type ApprovedArtifactMarker = (state: WorkflowState, artifactKey: ArtifactKey) => string

function cleanupExpiredAutoApproveTokens(ctx: BridgeContext): void {
  const tokens = ctx.reviewSubmissionTokens
  if (!tokens) return
  const now = Date.now()
  for (const [token, record] of tokens.entries()) {
    if (record.expiresAt <= now) tokens.delete(token)
  }
}

function issueAutoApproveToken(ctx: BridgeContext, sessionId: string, phase: string, artifactHash?: string | null): string {
  cleanupExpiredAutoApproveTokens(ctx)
  const token = randomBytes(REVIEW_SUBMISSION_TOKEN_BYTES).toString("hex")
  const tokens = ctx.reviewSubmissionTokens ?? new Map()
  tokens.set(token, {
    sessionId,
    kind: "auto-approve",
    subject: phase,
    expiresAt: Date.now() + REVIEW_SUBMISSION_TOKEN_TTL_MS,
    ...(artifactHash ? { artifactHash } : {}),
  })
  ctx.reviewSubmissionTokens = tokens
  return token
}

function consumeAutoApproveToken(ctx: BridgeContext, token: string, sessionId: string, phase: string, consume = true): { error: string | null; artifactHash: string | null } {
  cleanupExpiredAutoApproveTokens(ctx)
  const record = ctx.reviewSubmissionTokens?.get(token)
  if (!record) return { error: "Invalid or expired auto-approver token. Request a fresh auto-approval context and retry.", artifactHash: null }
  if (record.sessionId !== sessionId || record.kind !== "auto-approve" || record.subject !== phase) {
    return { error: "Auto-approver token does not match the pending gate. Request a fresh auto-approval context and retry.", artifactHash: null }
  }
  if (consume) ctx.reviewSubmissionTokens?.delete(token)
  return { error: null, artifactHash: record.artifactHash ?? null }
}

function autoApproveArtifactHash(state: WorkflowState, directory: string): string | null {
  if (state.reviewArtifactFiles.length > 0) return artifactFilesHash(state.reviewArtifactFiles, directory)
  return state.reviewArtifactHash
}

function appendAutoApproveTokenInstruction(prompt: string, token: string): string {
  return `${prompt}\n\n---\n\nOPEN_ARTISAN_REVIEW_TOKEN: ${token}\nAdapters must include this one-time token as \`review_token\` when submitting the auto-approver result.`
}

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

function readArtifactContent(state: WorkflowState, artifactKey: ArtifactKey): string | undefined {
  const diskPath = state.artifactDiskPaths[artifactKey]
  if (!diskPath) return undefined
  try {
    return readFileSync(diskPath, "utf-8")
  } catch {
    return undefined
  }
}

function effectiveIncrementalAllowlist(state: WorkflowState, cwd: string): string[] {
  if (state.mode !== "INCREMENTAL") return state.fileAllowlist
  if (state.fileAllowlist.length > 0) return state.fileAllowlist
  const planContent = readArtifactContent(state, "plan")
  return planContent ? extractApprovedFileAllowlist(planContent, cwd) : []
}

function resolveAutoApprovalTarget(
  state: WorkflowState,
  nextPhase: WorkflowState["phase"],
  nextPhaseState: WorkflowState["phaseState"],
  effectiveAllowlist: string[],
  ctx: BridgeContext,
): { phase: WorkflowState["phase"]; phaseState: WorkflowState["phaseState"]; message: string } {
  if (nextPhaseState !== "SKIP_CHECK") return { phase: nextPhase, phaseState: nextPhaseState, message: "" }
  const forwardSkip = computeForwardSkip(nextPhase, state.mode, effectiveAllowlist)
  if (forwardSkip) {
    return { phase: forwardSkip.targetPhase, phaseState: forwardSkip.targetPhaseState, message: ` ${forwardSkip.message}` }
  }
  const outcome = ctx.engine!.sm.transition(nextPhase, "SKIP_CHECK", "scheduling_complete", state.mode)
  if (!outcome.ok) return { phase: nextPhase, phaseState: nextPhaseState, message: ` Warning: Could not auto-resolve ${nextPhase}/SKIP_CHECK: ${outcome.message}` }
  return { phase: outcome.nextPhase, phaseState: outcome.nextPhaseState, message: ` Structural skip check complete; continuing with ${outcome.nextPhase}/${outcome.nextPhaseState}.` }
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
    const tokenResult = consumeAutoApproveToken(ctx, parsedArgs.data.review_token, toolCtx.sessionId, state.phase, false)
    if (tokenResult.error) return `Error: ${tokenResult.error}`
    const currentArtifactHash = autoApproveArtifactHash(state, toolCtx.directory)
    if (tokenResult.artifactHash && (!currentArtifactHash || tokenResult.artifactHash !== currentArtifactHash)) {
      return "Error: The gate artifact files changed after auto-approval context was issued. Request a fresh auto-approval context and retry."
    }
    ctx.reviewSubmissionTokens?.delete(parsedArgs.data.review_token)

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
      const effectiveAllowlist = effectiveIncrementalAllowlist(state, toolCtx.directory)
      if (state.mode === "INCREMENTAL" && state.phase === "PLANNING" && effectiveAllowlist.length === 0) {
        const feedbackText = "Auto-approver cannot approve INCREMENTAL planning without an explicit file allowlist in the plan artifact. Add an Allowlist section before approval."
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
        return `Auto-approve rejected (missing INCREMENTAL allowlist). ${t.responseMessage}`
      }
      const target = resolveAutoApprovalTarget(state, autoTransition.nextPhase, autoTransition.nextPhaseState, effectiveAllowlist, ctx)
      const phaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
      const autoArtifactKey = PHASE_TO_ARTIFACT[state.phase]
      const autoArtifactMarker = autoArtifactKey
        ? buildApprovedArtifactMarker(state, autoArtifactKey)
        : null
      await store.update(toolCtx.sessionId, (draft) => {
        draft.phase = target.phase
        draft.phaseState = target.phaseState
        draft.approvalCount++
        draft.phaseApprovalCounts[state.phase] = phaseCount
        draft.iterationCount = 0
        draft.retryCount = 0
        draft.userGateMessageReceived = false
        draft.reviewArtifactHash = null
        draft.latestReviewResults = null
        draft.reviewArtifactFiles = []
        if (state.mode === "INCREMENTAL" && draft.fileAllowlist.length === 0 && effectiveAllowlist.length > 0) {
          draft.fileAllowlist = effectiveAllowlist
        }
        if (autoArtifactKey && autoArtifactMarker) {
          draft.approvedArtifacts[autoArtifactKey] = autoArtifactMarker
        }
      })
      return `Auto-approved (confidence: ${result.confidence.toFixed(2)}). Transitioning to ${target.phase}/${target.phaseState}.${target.message}`
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

    const directory = ctx.projectDir ?? process.cwd()
    const artifactHash = autoApproveArtifactHash(state, directory)
    if (state.reviewArtifactFiles.length > 0 && !artifactHash) return null
    const token = issueAutoApproveToken(ctx, p.sessionId, state.phase, artifactHash)
    return appendAutoApproveTokenInstruction(`**Gate:** USER_GATE\n` + buildAutoApprovePrompt(buildAutoApproveRequest(state, p.sessionId)), token)
  }

  return { handleSubmitAutoApprove, handleAutoApproveContext }
}
