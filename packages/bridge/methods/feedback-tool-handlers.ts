import { JSONRPCErrorException } from "json-rpc-2.0"

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import type { ArtifactKey } from "../../core/workflow-primitives"
import type { OpenArtisanServices } from "../../core/open-artisan-services"
import type { DbAgentLease } from "../../core/open-artisan-repository"
import type { ToolContext, ToolHandler } from "./tool-handler-types"
import type { SchedulerDecision } from "../../core/scheduler"
import { applyDispatch } from "../../core/scheduler"
import { createGitCheckpoint } from "../../core/hooks/git-checkpoint"
import { extractApprovedFileAllowlist } from "../../core/tools/plan-allowlist"
import { parseToolArgs } from "../../core/tool-args"
import { SubmitFeedbackToolSchema } from "../../core/schemas"
import { computeSubmitFeedbackApproveTransition, computeSubmitFeedbackReviseTransition } from "../../core/tools/transitions"
import {
  buildSubmitFeedbackClarificationMessage,
  findReviewedArtifactFilesOutsideAllowlist,
  findUnresolvedHumanGates,
  materializeImplPlanDag,
  normalizeApprovalFilePaths,
  resolveSubmitFeedbackHumanGates,
  stripWorkflowRoutingNotes,
  validateSubmitFeedbackGate,
  validateSubmitFeedbackImplPlanApproval,
} from "../../core/tools/submit-feedback"
import { persistTaskDispatchClaims } from "../../core/runtime-persistence"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

function subagentError(toolName: string, feature: string): string {
  return (
    `Error: ${toolName} requires ${feature}. ` +
    `Use the bridge context/review submission flow or an adapter that declares this capability.`
  )
}

function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function buildApprovedArtifactMarker(
  state: WorkflowState,
  artifactKey: ArtifactKey,
  artifactDiskPath?: string | null,
): string {
  const diskPath = artifactDiskPath ?? state.artifactDiskPaths[artifactKey]
  if (diskPath) {
    try {
      return artifactHash(readFileSync(diskPath, "utf-8"))
    } catch {
      // Fall through to timestamp marker if the artifact path is unavailable.
    }
  }
  return `approved-at-${Date.now()}`
}

function agentKindFromSession(agent: string | null | undefined): DbAgentLease["agentKind"] {
  if (agent === "hermes" || agent === "claude" || agent === "opencode") return agent
  if (agent === "artisan" || agent === "robot-artisan") return "opencode"
  return "other"
}

async function persistCurrentTaskClaim(
  services: OpenArtisanServices | null | undefined,
  state: WorkflowState | null | undefined,
  sessionId: string,
): Promise<void> {
  if (!state?.currentTaskId) return
  await persistTaskDispatchClaims(services, state, state.currentTaskId, sessionId, agentKindFromSession(state.activeAgent))
}

function formatSchedulerDecisionMessage(decision: SchedulerDecision): string {
  switch (decision.action) {
    case "dispatch":
      return decision.prompt
    case "dispatch-batch":
      return `Ready to dispatch ${decision.tasks.length} task(s).`
    case "complete":
    case "blocked":
    case "awaiting-human":
    case "error":
      return decision.message
  }
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

interface IncrementalAllowlistResolver {
  get(): string[]
  getDerived(): string[] | null
  setDerived(files: string[]): void
}

interface ParsedSubmitFeedbackArgs {
  feedback_type: "approve" | "revise"
  feedback_text?: string | undefined
  approved_files?: string[] | undefined
  resolved_human_gates?: string[] | undefined
}

function createIncrementalAllowlistResolver(
  state: WorkflowState,
  approvedFiles: string[] | undefined,
  cwd: string,
): IncrementalAllowlistResolver {
  let derivedApprovedFiles: string[] | null = null
  return {
    get() {
      if (approvedFiles) return normalizeApprovalFilePaths(approvedFiles, cwd)
      if (derivedApprovedFiles) return derivedApprovedFiles
      const planContent = readArtifactContent(state, "plan")
      derivedApprovedFiles = planContent ? extractApprovedFileAllowlist(planContent, cwd) : []
      return derivedApprovedFiles
    },
    getDerived() {
      return derivedApprovedFiles
    },
    setDerived(files: string[]) {
      derivedApprovedFiles = files
    },
  }
}

function buildUnresolvedHumanGateMessage(state: WorkflowState): string | null {
  if (state.phase !== "IMPLEMENTATION" || !state.implDag) return null
  const unresolvedGates = findUnresolvedHumanGates(state)
  if (unresolvedGates.length === 0) return null
  const gateList = unresolvedGates
    .map((t) => `  - **${t.id}:** ${t.humanGate?.whatIsNeeded ?? t.description}`)
    .join("\n")
  return (
    `Cannot approve — ${unresolvedGates.length} unresolved human gate(s):\n\n` +
    `${gateList}\n\n` +
    "Please complete the required actions above, then call `submit_feedback` with `resolved_human_gates`."
  )
}

async function resolveHumanGateFeedback(
  state: WorkflowState,
  resolvedHumanGates: string[],
  toolCtx: ToolContext,
  ctx: BridgeContext,
): Promise<string | null> {
  if (state.phaseState === "HUMAN_GATE" && resolvedHumanGates.length === 0) {
    return "Cannot approve — HUMAN_GATE is a structural manual-action state, not a user approval surface. Resolve human-gated tasks via resolved_human_gates instead."
  }
  if (state.phaseState === "ESCAPE_HATCH") {
    return "Error: Cannot approve while an escape hatch is pending."
  }
  if (state.phase === "IMPLEMENTATION" && state.implDag && resolvedHumanGates.length === 0) {
    return buildUnresolvedHumanGateMessage(state)
  }
  if (state.phase !== "IMPLEMENTATION" || !state.implDag || resolvedHumanGates.length === 0) {
    return null
  }

  const resolutionResult = resolveSubmitFeedbackHumanGates(state, resolvedHumanGates)
  if (!resolutionResult.success) return resolutionResult.error
  const { resolvedIds, updatedNodes, remainingGates, nextDecision } = resolutionResult.resolution
  const { store } = ctx.engine!

  if (remainingGates.length > 0) {
    await store.update(toolCtx.sessionId, (draft) => {
      draft.implDag = updatedNodes
      draft.userGateMessageReceived = false
    })
    return (
      `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
      `**${remainingGates.length} unresolved gate(s) remain.**\n\n` +
      "Please resolve these and call `submit_feedback` again with `resolved_human_gates`."
    )
  }

  if (nextDecision.action === "dispatch") {
    await store.update(toolCtx.sessionId, (draft) => {
      draft.implDag = updatedNodes
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.currentTaskId = nextDecision.task.id
      draft.implDag = applyDispatch(draft, nextDecision.task.id)
      draft.iterationCount = 0
      draft.retryCount = 0
      draft.userGateMessageReceived = false
    })
    await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)
    return (
      `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
      "Returning to IMPLEMENTATION/DRAFT — downstream tasks are now unblocked."
    )
  }

  if (nextDecision.action !== "complete") {
    await store.update(toolCtx.sessionId, (draft) => {
      draft.implDag = updatedNodes
    })
    return (
      `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
      `However, the scheduler reports: ${formatSchedulerDecisionMessage(nextDecision)}`
    )
  }

  if (state.phaseState === "HUMAN_GATE") {
    await store.update(toolCtx.sessionId, (draft) => {
      draft.implDag = updatedNodes
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.currentTaskId = null
      draft.iterationCount = 0
      draft.retryCount = 0
      draft.userGateMessageReceived = false
    })
    return (
      `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
      "All DAG tasks are now complete. Returning to IMPLEMENTATION/DRAFT so the runtime can request final implementation review."
    )
  }

  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = updatedNodes
  })
  return null
}

function validateImplPlanApproval(
  state: WorkflowState,
  cwd: string,
  allowlists: IncrementalAllowlistResolver,
): string | null {
  if (state.phase !== "IMPL_PLAN") return null
  const planContent = readArtifactContent(state, "impl_plan")
  if (!planContent) {
    return (
      "Error: IMPL_PLAN approval requires a previously written implementation plan on disk " +
      "so the plan can be parsed into a DAG before entering IMPLEMENTATION."
    )
  }
  const effectiveAllowlist =
    state.mode === "INCREMENTAL" && state.fileAllowlist.length === 0
      ? allowlists.get()
      : state.fileAllowlist
  const implPlanApprovalError = validateSubmitFeedbackImplPlanApproval({
    planContent,
    mode: state.mode,
    effectiveAllowlist,
    cwd,
    parseFixInstruction: "Fix the plan format and re-submit request_review with corrected artifact_files.",
  })
  return implPlanApprovalError ? `Error: ${implPlanApprovalError}` : null
}

function validateIncrementalReviewAllowlist(
  state: WorkflowState,
  cwd: string,
  allowlists: IncrementalAllowlistResolver,
): string | null {
  if (state.mode !== "INCREMENTAL" || (state.phase !== "INTERFACES" && state.phase !== "TESTS")) return null
  const effectiveAllowlist = state.fileAllowlist.length === 0 ? allowlists.get() : state.fileAllowlist
  const reviewedOutsideAllowlist = findReviewedArtifactFilesOutsideAllowlist({
    reviewArtifactFiles: state.reviewArtifactFiles,
    artifactDiskPaths: state.artifactDiskPaths,
    allowlist: effectiveAllowlist,
    cwd,
  })
  if (reviewedOutsideAllowlist.length === 0) return null
  return (
    `Error: ${state.phase} approval failed allowlist validation: reviewed artifact files fall outside the approved INCREMENTAL allowlist: ` +
    `${reviewedOutsideAllowlist.join(", ")}. Update the planning allowlist or narrow the artifact scope before approval.`
  )
}

function seedPlanningAllowlistFromArtifact(
  state: WorkflowState,
  args: ParsedSubmitFeedbackArgs,
  cwd: string,
  allowlists: IncrementalAllowlistResolver,
): string | null {
  if (state.phase !== "PLANNING" || state.mode !== "INCREMENTAL" || args.approved_files) return null
  const planContent = readArtifactContent(state, "plan")
  if (planContent) {
    allowlists.setDerived(extractApprovedFileAllowlist(planContent, cwd))
  }
  if ((allowlists.getDerived()?.length ?? 0) > 0) return null
  return (
    "Error: INCREMENTAL planning approval requires an explicit file allowlist source. " +
    "Pass `approved_files`, or include an `Allowlist`/`Narrow allowlist` section in the approved plan artifact."
  )
}

async function applyApprovalTransition(
  state: WorkflowState,
  args: ParsedSubmitFeedbackArgs,
  resolvedHumanGates: string[],
  cwd: string,
  allowlists: IncrementalAllowlistResolver,
  toolCtx: ToolContext,
  ctx: BridgeContext,
): Promise<string> {
  const { store, sm } = ctx.engine!
  const approvalResult = computeSubmitFeedbackApproveTransition(state, sm)
  if (!approvalResult.success) return `Error: ${approvalResult.error}`
  const approval = approvalResult.transition

  const approveArtifactKey = approval.artifactKey
  const approveArtifactPath = approveArtifactKey && approveArtifactKey !== "implementation"
    ? state.artifactDiskPaths[approveArtifactKey] ?? null
    : null
  const approvedArtifactMarker = approveArtifactKey
    ? buildApprovedArtifactMarker(state, approveArtifactKey, approveArtifactPath)
    : null

  const preserveFinalImplementationReview =
    state.phase === "IMPLEMENTATION" &&
    state.phaseState === "USER_GATE" &&
    resolvedHumanGates.length > 0 &&
    approval.nextPhase === "DONE"

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = approval.nextPhase
    draft.phaseState = approval.nextPhaseState
    draft.approvalCount = approval.newApprovalCount
    draft.phaseApprovalCounts[state.phase] = approval.phaseCount
    draft.iterationCount = 0
    draft.retryCount = 0
    draft.userGateMessageReceived = false
    draft.reviewArtifactHash = null
    if (!preserveFinalImplementationReview) {
      draft.latestReviewResults = null
    }
    if (approveArtifactPath && approveArtifactKey) {
      draft.artifactDiskPaths[approveArtifactKey] = approveArtifactPath
    }
    if (approveArtifactKey && approvedArtifactMarker) {
      draft.approvedArtifacts[approveArtifactKey] = approvedArtifactMarker
    }
    if (approveArtifactKey && state.reviewArtifactFiles.length > 0) {
      draft.approvedArtifactFiles ??= {}
      draft.approvedArtifactFiles[approveArtifactKey] = Array.from(new Set(state.reviewArtifactFiles.map((path) =>
        path.startsWith("/") ? path : resolve(cwd, path),
      )))
    }
    if (state.phase === "DISCOVERY") {
      draft.conventions = null
    }
    if (state.phase === "IMPLEMENTATION") {
      draft.currentTaskId = null
      draft.taskCompletionInProgress = null
      draft.taskReviewCount = 0
    }
    if (state.phase === "IMPL_PLAN") {
      const planContent = readArtifactContent(state, "impl_plan")
      if (planContent) {
        const materialized = materializeImplPlanDag(planContent)
        if (materialized) {
          draft.implDag = materialized.nodes
          draft.currentTaskId = materialized.currentTaskId
          if (materialized.currentTaskId) {
            draft.implDag = applyDispatch(draft, materialized.currentTaskId)
            draft.phaseState = "DRAFT"
          }
        } else {
          draft.implDag = null
        }
      }
    }
    if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && args.approved_files) {
      draft.fileAllowlist = normalizeApprovalFilePaths(args.approved_files, cwd)
    } else if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && allowlists.getDerived()) {
      draft.fileAllowlist = allowlists.getDerived() ?? []
    } else if (
      state.mode === "INCREMENTAL" &&
      draft.fileAllowlist.length === 0 &&
      (state.phase === "INTERFACES" || state.phase === "TESTS" || state.phase === "IMPL_PLAN")
    ) {
      const effectiveAllowlist = allowlists.get()
      if (effectiveAllowlist.length > 0) {
        draft.fileAllowlist = effectiveAllowlist
      }
    }
    if (!preserveFinalImplementationReview) {
      draft.reviewArtifactFiles = []
    }
  })
  await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

  try {
    await createGitCheckpoint(
      { cwd: toolCtx.directory },
      {
        phase: state.phase,
        approvalCount: approval.phaseCount,
        featureName: state.featureName,
        ...(state.mode === "INCREMENTAL" ? { fileAllowlist: state.fileAllowlist } : {}),
        ...(state.reviewArtifactFiles.length > 0 ? { expectedFiles: state.reviewArtifactFiles } : {}),
      },
    )
  } catch (err) {
    ctx.engine?.log.warn("Git checkpoint failed", {
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  return approval.responseMessage
}

async function handleApproveFeedback(
  args: ParsedSubmitFeedbackArgs,
  state: WorkflowState,
  cwd: string,
  toolCtx: ToolContext,
  ctx: BridgeContext,
): Promise<string> {
  const resolvedHumanGates = args.resolved_human_gates ?? []
  const humanGateResult = await resolveHumanGateFeedback(state, resolvedHumanGates, toolCtx, ctx)
  if (humanGateResult) return humanGateResult

  const allowlists = createIncrementalAllowlistResolver(state, args.approved_files, cwd)
  const implPlanError = validateImplPlanApproval(state, cwd, allowlists)
  if (implPlanError) return implPlanError
  const reviewAllowlistError = validateIncrementalReviewAllowlist(state, cwd, allowlists)
  if (reviewAllowlistError) return reviewAllowlistError
  const planningAllowlistError = seedPlanningAllowlistFromArtifact(state, args, cwd, allowlists)
  if (planningAllowlistError) return planningAllowlistError

  return applyApprovalTransition(state, args, resolvedHumanGates, cwd, allowlists, toolCtx, ctx)
}

async function handleReviseFeedback(
  feedbackText: string,
  state: WorkflowState,
  toolCtx: ToolContext,
  ctx: BridgeContext,
): Promise<string> {
  if (ctx.capabilities.orchestrator !== false) {
    return subagentError("submit_feedback(revise)", "the orchestrator (SubagentDispatcher)")
  }
  const result = computeSubmitFeedbackReviseTransition(feedbackText, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  const t = result.transition
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.retryCount = 0
    draft.reviewArtifactHash = null
    draft.latestReviewResults = null
    draft.reviewArtifactFiles = []
    draft.pendingRevisionSteps = null
    draft.feedbackHistory.push(t.feedbackEntry)
  })
  return t.responseMessage
}

export const handleSubmitFeedback: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const cwd = toolCtx.directory || process.cwd()
  if (Object.prototype.hasOwnProperty.call(args, "artifact_content")) {
    return "Error: submit_feedback no longer accepts artifact_content; approve the artifact already submitted on disk via request_review artifact_files."
  }
  const parsedArgs = parseToolArgs(SubmitFeedbackToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const feedbackTextArg = parsedArgs.data.feedback_text ? stripWorkflowRoutingNotes(parsedArgs.data.feedback_text) : ""

  const gateError = validateSubmitFeedbackGate(state.phaseState)
  if (gateError) return `Error: ${gateError}`

  if (!state.userGateMessageReceived) {
    return (
      "Error: Waiting for user response. Present your artifact summary and " +
      "wait for the user to respond before calling submit_feedback. " +
      "The user must review and decide — you cannot self-approve."
    )
  }

  const feedbackType = parsedArgs.data.feedback_type
  const clarificationMessage = buildSubmitFeedbackClarificationMessage(feedbackType, state.phaseState, feedbackTextArg)
  if (clarificationMessage) return clarificationMessage
  if (feedbackType === "approve") {
    return handleApproveFeedback(parsedArgs.data, state, cwd, toolCtx, ctx)
  }

  if (feedbackType === "revise") {
    return handleReviseFeedback(feedbackTextArg, state, toolCtx, ctx)
  }

  return `Error: feedback_type must be "approve" or "revise", got "${feedbackType}".`
}
