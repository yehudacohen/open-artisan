/**
 * tool-execute.ts — Bridge tool execution dispatcher.
 *
 * Routes tool.execute JSON-RPC calls to per-tool handlers. Each handler
 * implements a simplified version of the adapter's orchestration:
 * state lookup → validation → transition → store update → response.
 *
 * Bridge handlers run in adapter-managed mode: adapters request review context,
 * spawn external reviewers themselves, then submit structured reviewer output.
 * Platform-local capabilities such as OpenCode TUI notifications remain in the
 * OpenCode adapter, while bridge-visible state transitions use shared core logic.
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler, BridgeContext } from "../server"
import type { ToolExecuteParams } from "../protocol"
import { SESSION_NOT_FOUND, INVALID_PARAMS } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import type { ArtifactKey, WorkflowEvent } from "../../core/workflow-primitives"
import type { OpenArtisanServices } from "../../core/open-artisan-services"
import type { ToolContext, ToolHandler } from "./tool-handler-types"
import { handleRoadmapDeriveExecutionSlice, handleRoadmapQuery, handleRoadmapRead } from "./roadmap-tool-handlers"
import { createDriftToolHandlers } from "./drift-tool-handlers"
import { handleApplyPatchSuggestion, handleResolvePatchSuggestion, handleRoutePatchSuggestions } from "./patch-suggestion-tool-handlers"
import { handleQueryChildWorkflow, handleQueryParentWorkflow } from "./query-workflow-tool-handlers"
import { handleAnalyzeTaskBoundaryChange, handleApplyTaskBoundaryChange } from "./task-boundary-tool-handlers"
import { handleCheckPriorWorkflow, handleResetTask, handleResolveHumanGate, handleSpawnSubWorkflow } from "./implementation-control-tool-handlers"
import { createAutoApproveToolHandlers } from "./auto-approve-tool-handlers"
import { artifactFilesHash, handleMarkSatisfied, handleRequestReview } from "./review-feedback-tool-handlers"
import { handleSubmitFeedback } from "./feedback-tool-handlers"

import { createHash, randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { parseSelectModeArgs } from "../../core/tools/select-mode"
import { processMarkTaskComplete, validateMarkTaskCompletePhase } from "../../core/tools/mark-task-complete"
import { buildAdjacentTasksForTask, buildTaskReviewAcceptancePlan, buildTaskReviewPrompt, parseTaskReviewResult } from "../../core/task-review"
import { buildReviewPrompt, parseReviewResult } from "../../core/self-review"
import { MAX_TASK_REVIEW_ITERATIONS, REVIEW_SUBMISSION_TOKEN_BYTES, REVIEW_SUBMISSION_TOKEN_TTL_MS } from "../../core/constants"
import {
  computeMarkScanCompleteTransition,
  computeMarkSatisfiedTransition,
  computeMarkAnalyzeCompleteTransition,
  computeProposeBacktrackTransition,
} from "../../core/tools/transitions"
import { PHASE_TO_ARTIFACT } from "../../core/artifacts"
import { applyDispatch, nextSchedulerDecisionForInput, readDecisionInput } from "../../core/scheduler"
import { buildInvalidPhaseReviewJsonReason, normalizePhaseReviewOutput } from "../../core/phase-review"
import { buildWorkflowSwitchMessage, parkCurrentWorkflowSession } from "../../core/session-switch"
import type { DbAgentLease } from "../../core/open-artisan-repository"
import { getAcceptanceCriteria } from "../../core/hooks/system-transform"
import { resolveArtifactPaths } from "../../core/tools/artifact-paths"
import { extractJsonFromText } from "../../core/utils"
import { countExpectedBlockingCriteria } from "../../core/tools/mark-satisfied"
import {
  MarkAnalyzeCompleteToolSchema,
  MarkScanCompleteToolSchema,
  MarkTaskCompleteToolSchema,
  ProposeBacktrackToolSchema,
  SubmitPhaseReviewToolSchema,
  SubmitTaskReviewToolSchema,
} from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import {
  loadWorkflowFileClaims,
  persistPhaseReviewResult,
  persistTaskDispatchClaims,
  persistTaskReviewResult,
  persistWorktreeObservations,
  workflowDbId,
} from "../../core/runtime-persistence"
import { collectWorktreeObservations } from "../../core/worktree-observation"
import type { DriftToolCallPlan } from "../../core/drift"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function buildRuntimeSchedulerDecision(state: {
  implDag: import("../../core/dag").TaskNode[] | null
  concurrency: { maxParallelTasks: number }
}) {
  const input = readDecisionInput({ implDag: state.implDag, concurrency: state.concurrency })
  const evaluation = nextSchedulerDecisionForInput(input)
  return { evaluation, fallbackDecision: evaluation.decision }
}

function formatSchedulerDecisionMessage(decision: ReturnType<typeof buildRuntimeSchedulerDecision>["fallbackDecision"]): string {
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

function buildTaskReviewPendingMessage(taskId: string, implementationSummary: string): string {
  return `Task "${taskId}" marked complete.\nSummary: ${implementationSummary}`
}

function buildTaskReviewResolvedMessage(
  taskId: string,
  implDag: import("../../core/dag").TaskNode[] | null,
  concurrency: { maxParallelTasks: number },
): string {
  const { evaluation, fallbackDecision } = buildRuntimeSchedulerDecision({ implDag, concurrency })

  if (fallbackDecision.action === "dispatch") {
    return (
      `**Next task ready:**\n${fallbackDecision.prompt}`
    )
  }

  if (fallbackDecision.action === "complete") {
    return `**All DAG tasks complete.** ${fallbackDecision.message}`
  }

  return `**${formatSchedulerDecisionMessage(fallbackDecision)}**`
}

function transitionOrThrow(
  state: WorkflowState,
  event: WorkflowEvent,
  ctx: BridgeContext,
): { phase: WorkflowState["phase"]; phaseState: WorkflowState["phaseState"] } {
  const outcome = ctx.engine!.sm.transition(state.phase, state.phaseState, event, state.mode)
  if (!outcome.ok) throw new Error(outcome.message)
  return { phase: outcome.nextPhase, phaseState: outcome.nextPhaseState }
}

function nextImplementationAuthoringState(
  state: WorkflowState,
  plan: ReturnType<typeof buildTaskReviewAcceptancePlan>,
  ctx: BridgeContext,
): { phase: WorkflowState["phase"]; phaseState: WorkflowState["phaseState"] } {
  const afterReview = transitionOrThrow(state, "task_review_pass", ctx)
  if (plan.schedulerDecision.action === "dispatch" || plan.schedulerDecision.action === "complete") {
    const schedulingState = { ...state, phase: afterReview.phase, phaseState: afterReview.phaseState }
    return transitionOrThrow(schedulingState, "scheduling_complete", ctx)
  }
  return {
    phase: afterReview.phase,
    phaseState: plan.nextPhaseState ?? afterReview.phaseState,
  }
}

function applyTaskReviewAcceptance(
  draft: WorkflowState,
  plan: ReturnType<typeof buildTaskReviewAcceptancePlan>,
  nextState: { phase: WorkflowState["phase"]; phaseState: WorkflowState["phaseState"] },
): void {
  const existing = new Set(draft.reviewArtifactFiles)
  for (const f of plan.completedTaskFiles) {
    if (!existing.has(f)) draft.reviewArtifactFiles.push(f)
  }
  draft.phase = nextState.phase
  draft.phaseState = nextState.phaseState
  draft.currentTaskId = plan.nextTaskId
  if (plan.nextTaskId) {
    draft.implDag = applyDispatch(draft, plan.nextTaskId)
  }
  if (plan.resetUserGateMessage) {
    draft.userGateMessageReceived = false
  }
  draft.taskCompletionInProgress = null
  draft.taskReviewCount = 0
}

function cleanupExpiredReviewTokens(ctx: BridgeContext): void {
  const tokens = ctx.reviewSubmissionTokens
  if (!tokens) return
  const now = Date.now()
  for (const [token, record] of tokens.entries()) {
    if (record.expiresAt <= now) tokens.delete(token)
  }
}

function issueReviewSubmissionToken(
  ctx: BridgeContext,
  sessionId: string,
  kind: "task" | "phase",
  subject: string,
  artifactHash?: string | null,
): string {
  cleanupExpiredReviewTokens(ctx)
  const token = randomBytes(REVIEW_SUBMISSION_TOKEN_BYTES).toString("hex")
  const tokens = ctx.reviewSubmissionTokens ?? new Map()
  tokens.set(token, {
    sessionId,
    kind,
    subject,
    expiresAt: Date.now() + REVIEW_SUBMISSION_TOKEN_TTL_MS,
    ...(artifactHash ? { artifactHash } : {}),
  })
  ctx.reviewSubmissionTokens = tokens
  return token
}

function consumeReviewSubmissionToken(
  ctx: BridgeContext,
  token: string,
  sessionId: string,
  kind: "task" | "phase",
  subject: string,
): { error: string | null; artifactHash: string | null } {
  cleanupExpiredReviewTokens(ctx)
  const record = ctx.reviewSubmissionTokens?.get(token)
  if (!record) return { error: "Invalid or expired isolated reviewer token. Request a fresh review context and retry.", artifactHash: null }
  if (record.sessionId !== sessionId || record.kind !== kind || record.subject !== subject) {
    return { error: "Isolated reviewer token does not match the pending review. Request a fresh review context and retry.", artifactHash: null }
  }
  ctx.reviewSubmissionTokens?.delete(token)
  return { error: null, artifactHash: record.artifactHash ?? null }
}

function taskReviewArtifactHash(state: WorkflowState, taskId: string, directory: string): string | null {
  const task = state.implDag?.find((candidate) => candidate.id === taskId)
  if (!task) return null
  const files = [...(task.expectedFiles ?? []), ...(task.expectedTests ?? [])]
  return artifactFilesHash(files, directory)
}

function appendReviewerTokenInstruction(prompt: string, token: string): string {
  return `${prompt}\n\n---\n\nOPEN_ARTISAN_REVIEW_TOKEN: ${token}\nAdapters must include this one-time token as \`review_token\` when submitting the isolated reviewer result.`
}

/**
 * Builds the isolated review prompt for a given task, including adjacent
 * task context for integration seam checking.
 *
 * Shared by handleMarkTaskComplete (inline prompt) and
 * handleTaskGetReviewContext (bridge method).
 *
 * Returns null if the task is not found in the DAG.
 */
async function buildReviewContextForTask(
  state: WorkflowState,
  taskId: string,
  directory: string,
  services: OpenArtisanServices | null | undefined,
  implementationSummary?: string,
): Promise<string | null> {
  const task = state.implDag?.find((t) => t.id === taskId)
  if (!task) return null

  const adjacentTasks = buildAdjacentTasksForTask(state.implDag, taskId)

  const workflowId = workflowDbId(state)
  const currentAgentLeaseId = await persistTaskDispatchClaims(services, state, taskId, state.sessionId, agentKindFromSession(state.activeAgent))
  const worktreeObservations = await collectWorktreeObservations({
    cwd: directory,
    workflowId,
    taskOwnedFiles: task.expectedFiles,
    artifactFiles: state.reviewArtifactFiles,
    ...(currentAgentLeaseId ? { currentAgentLeaseId } : {}),
    fileClaims: await loadWorkflowFileClaims(services, workflowId),
  })
  await persistWorktreeObservations(services, worktreeObservations)

  return buildTaskReviewPrompt({
    task,
    implementationSummary: implementationSummary ?? "(see task files)",
    mode: state.mode,
    cwd: directory,
    featureName: state.featureName,
    conventions: state.conventions,
    artifactDiskPaths: state.artifactDiskPaths as Record<string, string>,
    ...(adjacentTasks.length > 0 ? { adjacentTasks } : {}),
    ...(worktreeObservations.length > 0 ? { worktreeObservations } : {}),
  })
}

function buildPhaseReviewContext(
  state: WorkflowState,
  directory: string,
): string | null {
  if (state.phaseState !== "REVIEW") return null
  const criteriaText = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, state.artifactDiskPaths?.design ?? null)
  if (!criteriaText) return null

  const explicitReviewFiles = state.reviewArtifactFiles.map((p) =>
    p.startsWith("/") ? p : resolve(directory, p)
  )
  const artifactPaths = explicitReviewFiles.length > 0
    ? explicitReviewFiles
    : resolveArtifactPaths(
        state.phase,
        state.mode,
        directory,
        state.fileAllowlist,
        state.artifactDiskPaths,
      )

  const conventionsPath = state.artifactDiskPaths["conventions"]
  const upstreamSummary = conventionsPath
    ? `Conventions document is at \`${conventionsPath}\`. Read it before evaluating.`
    : (state.conventions ?? undefined)

  return buildReviewPrompt({
    phase: state.phase,
    mode: state.mode,
    artifactPaths,
    criteriaText,
    ...(upstreamSummary ? { upstreamSummary } : {}),
    featureName: state.featureName,
    ...(state.intentBaseline ? { intentBaseline: state.intentBaseline } : {}),
    ...(state.fileAllowlist.length > 0 ? { fileAllowlist: state.fileAllowlist } : {}),
    ...(Object.keys(state.approvedArtifacts).length > 0 ? { approvedArtifacts: state.approvedArtifacts } : {}),
    ...(Object.keys(state.artifactDiskPaths).length > 0 ? { artifactDiskPaths: state.artifactDiskPaths } : {}),
    ...(Object.keys(state.approvedArtifactFiles ?? {}).length > 0 ? { approvedArtifactFiles: state.approvedArtifactFiles ?? {} } : {}),
  })
}

function buildReviewerFailureCriteria(state: WorkflowState, reason: string) {
  const criteriaText = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, state.artifactDiskPaths?.design ?? null)
  const expectedCount = Math.max(countExpectedBlockingCriteria(criteriaText), 1)
  return Array.from({ length: expectedCount }, (_, i) => ({
    criterion: `Isolated reviewer failed to evaluate criterion ${i + 1}`,
    met: false,
    evidence: `Isolated phase review failed: ${reason}. The artifact must be revised or review infrastructure fixed before approval.`,
    severity: "blocking" as const,
  }))
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

// ---- select_mode ----

const handleSelectMode: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const parsed = parseSelectModeArgs(args)
  if ("error" in parsed) return `Error: ${parsed.error}`

  let state = requireState(ctx, toolCtx.sessionId)

  const requestedFeatureName = parsed.featureName ?? ""
  const switchingFeatures = state.phase !== "MODE_SELECT" && state.featureName !== null && requestedFeatureName !== "" && state.featureName !== requestedFeatureName

  if (state.phase !== "MODE_SELECT" && !switchingFeatures) {
    return `Error: select_mode can only be called during MODE_SELECT (current: ${state.phase}).`
  }

  if (switchingFeatures) {
    await parkCurrentWorkflowSession(store, state)
    await store.create(toolCtx.sessionId)
    state = requireState(ctx, toolCtx.sessionId)
  }

  // Sub-workflow sessions preserve their existing featureName
  const isSubWorkflow = state.parentWorkflow !== null
  let featureName: string
  if (isSubWorkflow && state.featureName) {
    featureName = state.featureName
  } else {
    featureName = requestedFeatureName
    if (!featureName) {
      return "Error: feature_name is required."
    }
    // Validate format (same rules as validateWorkflowState)
    if (/\.\./.test(featureName)) return "Error: feature_name must not contain '..'."
    if (/[/\\]/.test(featureName)) return "Error: feature_name must not contain path separators."
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(featureName)) {
      return "Error: feature_name must start with alphanumeric and contain only alphanumeric, dots, hyphens, and underscores."
    }
    if (featureName === "sub") return 'Error: "sub" is reserved.'
  }

  // Check for existing persisted state for this feature name.
  // If prior state exists beyond MODE_SELECT, resume it under the current sessionId.
  const priorState = await store.findPersistedByFeatureName(featureName)
  if (priorState && priorState.phase !== "MODE_SELECT" && priorState.sessionId !== toolCtx.sessionId) {
    // Migrate the prior state to the current session
    await store.migrateSession(priorState.sessionId, toolCtx.sessionId)
    if (switchingFeatures) {
      return buildWorkflowSwitchMessage({
        fromFeatureName: state.featureName,
        toFeatureName: featureName,
        toPhase: priorState.phase,
        toPhaseState: priorState.phaseState,
        resumed: true,
        preservedMode: priorState.mode !== parsed.mode ? priorState.mode : null,
      })
    }
    return (
      `Resumed prior workflow for "${featureName}" at ${priorState.phase}/${priorState.phaseState}` +
      (priorState.mode !== parsed.mode ? ` (keeping original mode ${priorState.mode}).` : ".")
    )
  }

  const outcome = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", parsed.mode)
  if (!outcome.ok) return `Error: ${outcome.message}`

  await store.update(toolCtx.sessionId, (draft) => {
    draft.mode = parsed.mode
    draft.featureName = featureName
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.iterationCount = 0
    draft.retryCount = 0
  })

  // policyVersion bumped automatically by setPostUpdateHook on store.update
  if (switchingFeatures) {
    return buildWorkflowSwitchMessage({
      fromFeatureName: state.featureName,
      toFeatureName: featureName,
      toPhase: outcome.nextPhase,
      toPhaseState: outcome.nextPhaseState,
      resumed: false,
    })
  }
  return `Mode set to ${parsed.mode}. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}.`
}

// ---- mark_scan_complete ----

const handleMarkScanComplete: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  const parsedArgs = parseToolArgs(MarkScanCompleteToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = computeMarkScanCompleteTransition(parsedArgs.data, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  const t = result.transition

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.iterationCount = 0
    draft.retryCount = 0
  })

  // policyVersion bumped automatically by setPostUpdateHook on store.update
  return t.responseMessage
}

// ---- mark_analyze_complete ----

const handleMarkAnalyzeComplete: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.capabilities.discoveryFleet !== false) {
    return subagentError("mark_analyze_complete", "the discovery fleet (SubagentDispatcher)")
  }
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(MarkAnalyzeCompleteToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = computeMarkAnalyzeCompleteTransition(parsedArgs.data, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  const { nextPhase, nextPhaseState, analysisSummary, responseMessage } = result.transition
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    draft.phase = nextPhase
    draft.phaseState = nextPhaseState
    draft.discoveryReport = analysisSummary
  })
  return responseMessage
}

// ---- mark_task_complete ----

const handleMarkTaskComplete: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  // Re-entry guard: prevent concurrent task completions
  if (state.taskCompletionInProgress) {
    return `Error: Task "${state.taskCompletionInProgress}" is already awaiting review. Call submit_task_review first.`
  }

  const phaseError = validateMarkTaskCompletePhase(state)
  if (phaseError) return `Error: ${phaseError}`

  const parsedArgs = parseToolArgs(MarkTaskCompleteToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = processMarkTaskComplete(parsedArgs.data, state.implDag, state.currentTaskId)
  if ("error" in result) return `Error: ${result.error}`

  // Persist DAG changes and set review gate
  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = result.updatedNodes
    draft.currentTaskId = parsedArgs.data.task_id
    draft.taskCompletionInProgress = parsedArgs.data.task_id
    draft.taskReviewCount = (draft.taskReviewCount ?? 0) + 1
    draft.phaseState = "TASK_REVIEW"
  })

  // Build the isolated review prompt for the adapter to dispatch.
  // Use the freshly-updated state (with completed task) for context.
  const updatedState = requireState(ctx, toolCtx.sessionId)
  const taskId = parsedArgs.data.task_id
  const implSummary = parsedArgs.data.implementation_summary
  const reviewPrompt = await buildReviewContextForTask(updatedState, taskId, toolCtx.directory, ctx.openArtisanServices, implSummary)
  if (!reviewPrompt) {
    // Should not happen — task was just completed. Clear guard and return.
    await store.update(toolCtx.sessionId, (draft) => {
      draft.taskCompletionInProgress = null
      draft.taskReviewCount = 0
    })
    return result.responseMessage
  }
  return (
    buildTaskReviewPendingMessage(taskId, implSummary) +
    "\n\n**Per-task review required.** The adapter hook must request isolated review context and submit the reviewer result. " +
    "Do not call `submit_task_review` from the authoring conversation."
  )
}

// ---- submit_task_review ----

const handleSubmitTaskReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (!state.taskCompletionInProgress) {
    return "Error: No task review is pending. Call mark_task_complete first."
  }

  const parsedArgs = parseToolArgs(SubmitTaskReviewToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const reviewOutput = parsedArgs.data.review_output.trim()

  const taskId = state.taskCompletionInProgress
  const review = parseTaskReviewResult(reviewOutput)

  // Parse failure — don't accept, ask agent to retry
  if (!review.success) {
    return `Error: Failed to parse review output: ${review.error}. Re-run the isolated reviewer and submit again.`
  }
  const tokenResult = consumeReviewSubmissionToken(ctx, parsedArgs.data.review_token, toolCtx.sessionId, "task", taskId)
  if (tokenResult.error) return `Error: ${tokenResult.error}`
  const currentTaskHash = taskReviewArtifactHash(state, taskId, toolCtx.directory)
  if (tokenResult.artifactHash && (!currentTaskHash || tokenResult.artifactHash !== currentTaskHash)) {
    return (
      "Error: The task files changed after isolated task review context was issued. " +
      "Request a fresh task review context and retry."
    )
  }
  await persistTaskReviewResult(ctx.openArtisanServices, state, taskId, review, reviewOutput)

  // Check iteration cap — force accept after MAX_TASK_REVIEW_ITERATIONS
  const hitCap = state.taskReviewCount >= MAX_TASK_REVIEW_ITERATIONS
  if (hitCap && !review.passed) {
    const acceptancePlan = buildTaskReviewAcceptancePlan({ implDag: state.implDag, concurrency: state.concurrency, taskId })
    const nextMessage = buildTaskReviewResolvedMessage(taskId, state.implDag, state.concurrency)
    const nextState = nextImplementationAuthoringState(state, acceptancePlan, ctx)
    await store.update(toolCtx.sessionId, (draft) => {
      applyTaskReviewAcceptance(draft, acceptancePlan, nextState)
    })
    await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)
    return (
      `Task "${taskId}" force-accepted after ${MAX_TASK_REVIEW_ITERATIONS} review iterations. ` +
      `Issues will be caught in the full implementation review.\n\n${nextMessage}`
    )
  }

  if (review.passed) {
    const acceptancePlan = buildTaskReviewAcceptancePlan({ implDag: state.implDag, concurrency: state.concurrency, taskId })
    const nextMessage = buildTaskReviewResolvedMessage(taskId, state.implDag, state.concurrency)
    const nextState = nextImplementationAuthoringState(state, acceptancePlan, ctx)
    await store.update(toolCtx.sessionId, (draft) => {
      applyTaskReviewAcceptance(draft, acceptancePlan, nextState)
    })
    await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)
    return `Task "${taskId}" review passed.\n\n${nextMessage}`
  }

  // Review failed — revert task status and return issues
  const failedState = transitionOrThrow(state, "task_review_fail", ctx)
  await store.update(toolCtx.sessionId, (draft) => {
    const task = draft.implDag?.find((t) => t.id === taskId)
    if (task) task.status = "pending"
    draft.phase = failedState.phase
    draft.phaseState = failedState.phaseState
    draft.currentTaskId = taskId
    draft.taskCompletionInProgress = null
    draft.taskReviewCount = Math.max(draft.taskReviewCount ?? 0, 1)
  })

  const issuesList = review.issues.map((i) => `  - ${i}`).join("\n")
  return (
    `Task "${taskId}" review FAILED. ${review.issues.length} issue(s) found:\n${issuesList}\n\n` +
    `${review.reasoning ? `Reviewer reasoning: ${review.reasoning}\n\n` : ""}` +
    `Fix the issues and call mark_task_complete again. ` +
    `(Review iteration ${state.taskReviewCount + 1}/${MAX_TASK_REVIEW_ITERATIONS})`
  )
}

// ---- submit_phase_review ----

const handleSubmitPhaseReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phaseState !== "REVIEW") {
    return `Error: submit_phase_review can only be called in REVIEW state (current: ${state.phase}/${state.phaseState}).`
  }

  const parsedArgs = parseToolArgs(SubmitPhaseReviewToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const normalizedPhaseReviewInput = {
    ...(parsedArgs.data.review_stdout !== undefined ? { stdout: parsedArgs.data.review_stdout } : {}),
    ...(parsedArgs.data.review_stderr !== undefined ? { stderr: parsedArgs.data.review_stderr } : {}),
    ...(parsedArgs.data.review_exit_code !== undefined ? { exitCode: parsedArgs.data.review_exit_code } : {}),
    ...(parsedArgs.data.review_error !== undefined ? { error: parsedArgs.data.review_error } : {}),
  }
  const reviewOutput = parsedArgs.data.review_output?.trim() || normalizePhaseReviewOutput(normalizedPhaseReviewInput).trim()
  if (!reviewOutput) {
    return "Error: review_output is required. Pass the raw output from the isolated phase reviewer."
  }
  const currentArtifactHash = artifactFilesHash(state.reviewArtifactFiles, toolCtx.directory)
  if (state.reviewArtifactHash && (!currentArtifactHash || state.reviewArtifactHash !== currentArtifactHash)) {
    return (
      "Error: The artifact changed after it was submitted for review. " +
      "Call `request_review` again so the reviewer evaluates the current artifact instead of stale content."
    )
  }
  let rawCriteria: Array<{
    criterion: string; met: boolean; evidence: string;
    severity?: "blocking" | "suggestion" | "design-invariant"; score?: string | number
  }>
  if (reviewOutput.startsWith("ISOLATED_PHASE_REVIEW_FAILED:")) {
    rawCriteria = buildReviewerFailureCriteria(state, reviewOutput)
  } else try {
    const parsed = parseReviewResult(extractJsonFromText(reviewOutput))
    if (!parsed.success) {
      rawCriteria = buildReviewerFailureCriteria(state, parsed.error)
    } else {
      rawCriteria = parsed.criteriaResults.map((criterion) => ({
        criterion: criterion.criterion,
        met: criterion.met,
        evidence: criterion.evidence,
        ...(criterion.severity ? { severity: criterion.severity } : {}),
        ...(typeof criterion.score === "number" ? { score: criterion.score } : {}),
      }))
    }
  } catch (err) {
    rawCriteria = buildReviewerFailureCriteria(state, buildInvalidPhaseReviewJsonReason(reviewOutput, err))
  }

  const result = computeMarkSatisfiedTransition(rawCriteria, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  const tokenResult = consumeReviewSubmissionToken(ctx, parsedArgs.data.review_token, toolCtx.sessionId, "phase", state.phase)
  if (tokenResult.error) return `Error: ${tokenResult.error}`
  await persistPhaseReviewResult(ctx.openArtisanServices, state, rawCriteria.map((criterion) => ({
    criterion: criterion.criterion,
    met: criterion.met,
    evidence: criterion.evidence,
    severity: criterion.severity === "suggestion" || criterion.severity === "design-invariant" ? criterion.severity : "blocking",
    ...(typeof criterion.score === "number" ? { score: criterion.score } : {}),
  })), reviewOutput)
  const t = result.transition
  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.iterationCount = t.nextIterationCount
    draft.retryCount = 0
    draft.latestReviewResults = t.latestReviewResults
    if (t.clearReviewArtifactHash) draft.reviewArtifactHash = null
    if (t.resetUserGateMessage) draft.userGateMessageReceived = false
    if (t.clearRevisionBaseline) draft.revisionBaseline = null
  })

  return `Isolated phase review submitted. ${t.responseMessage}`
}

// ---- propose_backtrack ----

const handleProposeBacktrack: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.capabilities.orchestrator !== false) {
    return subagentError("propose_backtrack", "the orchestrator (SubagentDispatcher)")
  }
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(ProposeBacktrackToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = computeProposeBacktrackTransition(parsedArgs.data, state)
  if (!result.success) return `Error: ${result.error}`
  const t = result.transition
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.targetPhase
    draft.phaseState = "REDRAFT"
    draft.iterationCount = 0
    draft.retryCount = 0
    draft.userGateMessageReceived = false
    draft.reviewArtifactFiles = []
    draft.revisionBaseline = null
    draft.pendingRevisionSteps = null
    draft.backtrackContext = {
      sourcePhase: state.phase,
      targetPhase: t.targetPhase,
      reason: parsedArgs.data.reason,
    }
    for (const key of t.clearedArtifactKeys) {
      delete draft.approvedArtifacts[key]
    }
    if (t.clearImplDag) {
      draft.implDag = null
      draft.currentTaskId = null
      draft.taskReviewCount = 0
      draft.taskCompletionInProgress = null
    }
    draft.feedbackHistory.push(t.feedbackEntry)
  })
  return t.responseMessage
}

async function executeDriftToolCall(toolCall: DriftToolCallPlan, toolCtx: ToolContext, ctx: BridgeContext): Promise<string> {
  switch (toolCall.toolName) {
    case "reset_task": return handleResetTask(toolCall.args, toolCtx, ctx)
    case "apply_patch_suggestion": return handleApplyPatchSuggestion(toolCall.args, toolCtx, ctx)
    case "apply_task_boundary_change": return handleApplyTaskBoundaryChange(toolCall.args, toolCtx, ctx)
    case "resolve_human_gate": return handleResolveHumanGate(toolCall.args, toolCtx, ctx)
    case "propose_backtrack": return handleProposeBacktrack(toolCall.args, toolCtx, ctx)
    case "request_review": return handleRequestReview(toolCall.args, toolCtx, ctx)
    case "submit_feedback": return handleSubmitFeedback(toolCall.args, toolCtx, ctx)
  }
}

const { handleReportDrift, handlePlanDriftRepair, handleApplyDriftRepair } = createDriftToolHandlers(executeDriftToolCall)

const { handleSubmitAutoApprove, handleAutoApproveContext } = createAutoApproveToolHandlers(buildApprovedArtifactMarker)

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  select_mode: handleSelectMode,
  mark_scan_complete: handleMarkScanComplete,
  mark_analyze_complete: handleMarkAnalyzeComplete,
  mark_satisfied: handleMarkSatisfied,
  request_review: handleRequestReview,
  submit_feedback: handleSubmitFeedback,
  mark_task_complete: handleMarkTaskComplete,
  submit_task_review: handleSubmitTaskReview,
  submit_phase_review: handleSubmitPhaseReview,
  submit_auto_approve: handleSubmitAutoApprove,
  reset_task: handleResetTask,
  check_prior_workflow: handleCheckPriorWorkflow,
  resolve_human_gate: handleResolveHumanGate,
  propose_backtrack: handleProposeBacktrack,
  spawn_sub_workflow: handleSpawnSubWorkflow,
  analyze_task_boundary_change: handleAnalyzeTaskBoundaryChange,
  apply_task_boundary_change: handleApplyTaskBoundaryChange,
  route_patch_suggestions: handleRoutePatchSuggestions,
  resolve_patch_suggestion: handleResolvePatchSuggestion,
  apply_patch_suggestion: handleApplyPatchSuggestion,
  report_drift: handleReportDrift,
  plan_drift_repair: handlePlanDriftRepair,
  apply_drift_repair: handleApplyDriftRepair,
  query_parent_workflow: handleQueryParentWorkflow,
  query_child_workflow: handleQueryChildWorkflow,
  roadmap_read: handleRoadmapRead,
  roadmap_query: handleRoadmapQuery,
  roadmap_derive_execution_slice: handleRoadmapDeriveExecutionSlice,
}

const REVIEW_SUBMISSION_TOOLS = new Set(["submit_task_review", "submit_phase_review"])

// ---------------------------------------------------------------------------
// task.getReviewContext — returns review prompt for pending task review
// ---------------------------------------------------------------------------

export const handleTaskGetReviewContext: MethodHandler = async (params, ctx) => {
  const p = params as { sessionId?: string }
  if (!p.sessionId) {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  const state = ctx.engine!.store.get(p.sessionId)
  if (!state || !state.taskCompletionInProgress) return null

  const prompt = await buildReviewContextForTask(state, state.taskCompletionInProgress, ctx.projectDir ?? process.cwd(), ctx.openArtisanServices)
  if (!prompt) return null
  const token = issueReviewSubmissionToken(ctx, p.sessionId, "task", state.taskCompletionInProgress, taskReviewArtifactHash(state, state.taskCompletionInProgress, ctx.projectDir ?? process.cwd()))
  return appendReviewerTokenInstruction(prompt, token)
}

// ---------------------------------------------------------------------------
// task.getPhaseReviewContext — returns review prompt for phase-level review
// ---------------------------------------------------------------------------

export const handlePhaseGetReviewContext: MethodHandler = async (params, ctx) => {
  const p = params as { sessionId?: string }
  if (!p.sessionId) {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  const state = ctx.engine!.store.get(p.sessionId)
  if (!state || state.phaseState !== "REVIEW") return null

  const prompt = buildPhaseReviewContext(state, ctx.projectDir ?? process.cwd())
  if (!prompt) return null
  const token = issueReviewSubmissionToken(ctx, p.sessionId, "phase", state.phase)
  return appendReviewerTokenInstruction(prompt, token)
}

// ---------------------------------------------------------------------------
// task.getAutoApproveContext — returns auto-approve prompt for USER_GATE
// ---------------------------------------------------------------------------

export { handleAutoApproveContext }

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handleToolExecute: MethodHandler = async (params, ctx) => {
  const p = params as Partial<ToolExecuteParams>
  if (!p.name || typeof p.name !== "string") {
    throw new JSONRPCErrorException("name is required", INVALID_PARAMS)
  }
  if (!p.context?.sessionId) {
    throw new JSONRPCErrorException("context.sessionId is required", INVALID_PARAMS)
  }

  const handler = TOOL_HANDLERS[p.name]
  if (!handler) {
    return `Error: Unknown tool "${p.name}". Available: ${Object.keys(TOOL_HANDLERS).join(", ")}`
  }

  if (REVIEW_SUBMISSION_TOOLS.has(p.name) && p.context.invocation !== "isolated-reviewer") {
    return `Error: ${p.name} is reserved for isolated reviewer submissions.`
  }

  const toolCtx: ToolContext = {
    sessionId: p.context.sessionId,
    directory: ctx.projectDir ?? p.context.directory ?? process.cwd(),
    ...(p.context.agent ? { agent: p.context.agent } : {}),
    ...(p.context.invocation ? { invocation: p.context.invocation } : {}),
  }

  return handler(p.args ?? {}, toolCtx, ctx)
}
