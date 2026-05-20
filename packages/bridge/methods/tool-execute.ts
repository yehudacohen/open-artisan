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
import { createRoadmapContextAttachmentService, type OpenArtisanServices } from "../../core/open-artisan-services"
import type { WorkflowRoadmapContext } from "../../core/roadmap-types"
import type { ToolContext, ToolHandler } from "./tool-handler-types"
import {
  handleRoadmapDelete,
  handleRoadmapDeleteEdge,
  handleRoadmapDeleteItem,
  handleRoadmapDeriveExecutionSlice,
  handleRoadmapQuery,
  handleRoadmapRead,
  handleRoadmapReplace,
  handleRoadmapUpdateItemStatus,
  handleRoadmapUpsertEdge,
  handleRoadmapUpsertItem,
} from "./roadmap-tool-handlers"
import { createDriftToolHandlers } from "./drift-tool-handlers"
import { handleApplyPatchSuggestion, handleResolvePatchSuggestion, handleRoutePatchSuggestions } from "./patch-suggestion-tool-handlers"
import { handleProposeDirectApplication } from "./direct-application-tool-handlers"
import { handleQueryChildWorkflow, handleQueryParentWorkflow } from "./query-workflow-tool-handlers"
import { handleAnalyzeTaskBoundaryChange, handleApplyTaskBoundaryChange } from "./task-boundary-tool-handlers"
import { handleCheckPriorWorkflow, handleResetTask, handleResolveHumanGate } from "./implementation-control-tool-handlers"
import { createAutoApproveToolHandlers } from "./auto-approve-tool-handlers"
import { handleSubmitPhaseReview, handleSubmitReviewRubricItem, handleSubmitTaskReview, taskReviewArtifactHash } from "./review-submission-tool-handlers"
import { issueReviewSubmissionToken } from "./review-submission-tokens"
import { artifactFilesHash, handleMarkSatisfied, handleRequestReview } from "./review-feedback-tool-handlers"
import { handleSubmitFeedback } from "./feedback-tool-handlers"
import { recordAllowlistExpansionRequest } from "../../core/tools/allowlist-expansion"
import { approveCurrentTaskScopeExpansion } from "../../core/tools/current-task-scope"
import { repairCurrentTaskBoundaryFromImplPlan } from "../../core/tools/impl-plan-boundary-repair"
import { buildIncidentSummary } from "../../core/tool-failure-history"

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { parseSelectModeArgs } from "../../core/tools/select-mode"
import { processMarkTaskComplete, validateMarkTaskCompletePhase } from "../../core/tools/mark-task-complete"
import { buildAdjacentTasksForTask, buildTaskReviewPrompt } from "../../core/task-review"
import { buildReviewPrompt } from "../../core/self-review"
import {
  computeMarkScanCompleteTransition,
  computeMarkAnalyzeCompleteTransition,
  computeProposeBacktrackTransition,
} from "../../core/tools/transitions"
import { PHASE_TO_ARTIFACT } from "../../core/artifacts"
import { buildWorkflowSwitchMessage, parkCurrentWorkflowSession } from "../../core/session-switch"
import type { DbAgentLease } from "../../core/open-artisan-repository"
import { getAcceptanceCriteria } from "../../core/hooks/system-transform"
import { resolveArtifactPaths } from "../../core/tools/artifact-paths"
import { deriveReviewFileAllowlist } from "../../core/tools/plan-allowlist"
import {
  MarkAnalyzeCompleteToolSchema,
  MarkScanCompleteToolSchema,
  MarkTaskCompleteToolSchema,
  ApproveCurrentTaskScopeExpansionToolSchema,
  ProposeBacktrackToolSchema,
  RequestAllowlistExpansionToolSchema,
  RepairCurrentTaskBoundaryFromImplPlanToolSchema,
  SummarizeWorkflowIncidentToolSchema,
  StructuralTransitionToolSchema,
} from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import {
  loadWorkflowFileClaims,
  persistTaskDispatchClaims,
  persistWorktreeObservations,
  workflowDbId,
} from "../../core/runtime-persistence"
import { collectWorktreeObservations } from "../../core/worktree-observation"
import type { DriftToolCallPlan } from "../../core/drift"
import { buildTaskReviewRubricItems, createReviewAttempt, upsertReviewAttempt } from "../../core/tools/review-attempts"

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

const handleRequestAllowlistExpansion: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parsed = parseToolArgs(RequestAllowlistExpansionToolSchema, args)
  if (!parsed.success) return `Error: ${parsed.error}`
  let message = ""
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    const result = recordAllowlistExpansionRequest(draft, parsed.data, toolCtx.directory)
    message = result.success ? result.message : `Error: ${result.error}`
  })
  return message || `Error: Failed to record allowlist expansion for ${state.phase}.`
}

const handleApproveCurrentTaskScopeExpansion: ToolHandler = async (args, toolCtx, ctx) => {
  requireState(ctx, toolCtx.sessionId)
  const parsed = parseToolArgs(ApproveCurrentTaskScopeExpansionToolSchema, args)
  if (!parsed.success) return `Error: ${parsed.error}`
  let message = ""
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    const result = approveCurrentTaskScopeExpansion(draft, parsed.data, toolCtx.directory)
    message = result.success ? result.message : `Error: ${result.error}`
  })
  return message
}

const handleRepairCurrentTaskBoundaryFromImplPlan: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parsed = parseToolArgs(RepairCurrentTaskBoundaryFromImplPlanToolSchema, args)
  if (!parsed.success) return `Error: ${parsed.error}`
  const implPlanPath = state.artifactDiskPaths.impl_plan
  if (!implPlanPath) return "Error: No approved IMPL_PLAN artifact path is recorded."
  let planContent = ""
  try {
    planContent = readFileSync(implPlanPath, "utf-8")
  } catch (error) {
    return `Error: Could not read approved IMPL_PLAN artifact at ${implPlanPath}: ${error instanceof Error ? error.message : String(error)}`
  }
  let message = ""
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    const repairArgs = parsed.data.task_id ? { task_id: parsed.data.task_id, reason: parsed.data.reason } : { reason: parsed.data.reason }
    const result = repairCurrentTaskBoundaryFromImplPlan(draft, planContent, toolCtx.directory, repairArgs)
    message = result.success ? result.message : `Error: ${result.error}`
  })
  return message
}

const handleSummarizeWorkflowIncident: ToolHandler = async (args, toolCtx, ctx) => {
  const parsed = parseToolArgs(SummarizeWorkflowIncidentToolSchema, args)
  if (!parsed.success) return `Error: ${parsed.error}`
  return buildIncidentSummary(requireState(ctx, toolCtx.sessionId))
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

function buildTaskReviewPendingMessage(taskId: string, implementationSummary: string): string {
  return `Task "${taskId}" marked complete.\nSummary: ${implementationSummary}`
}

function appendReviewerTokenInstruction(prompt: string, token: string): string {
  return `${prompt}\n\n---\n\nOPEN_ARTISAN_REVIEW_TOKEN: ${token}\nAdapters must include this one-time token as \`review_token\` when submitting incremental \`submit_review_rubric_item\` progress and the final isolated reviewer result.`
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
  const reviewAllowlist = deriveReviewFileAllowlist({
    phase: state.phase,
    mode: state.mode,
    artifactPaths,
    fallbackAllowlist: state.fileAllowlist,
    cwd: directory,
    pendingAllowlistExpansions: state.pendingAllowlistExpansions,
  })

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
    ...(reviewAllowlist.allowlist.length > 0 ? { fileAllowlist: reviewAllowlist.allowlist, fileAllowlistSource: reviewAllowlist.source } : {}),
    ...(Object.keys(state.approvedArtifacts).length > 0 ? { approvedArtifacts: state.approvedArtifacts } : {}),
    ...(Object.keys(state.artifactDiskPaths).length > 0 ? { artifactDiskPaths: state.artifactDiskPaths } : {}),
    ...(Object.keys(state.approvedArtifactFiles ?? {}).length > 0 ? { approvedArtifactFiles: state.approvedArtifactFiles ?? {} } : {}),
  })
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

// ---- select_mode ----

async function buildBridgeRoadmapContextForSelectMode(
  ctx: BridgeContext,
  input: { roadmapItemIds: string[]; executionSliceId: string | null; featureName: string },
): Promise<{ ok: true; context: WorkflowRoadmapContext | null } | { ok: false; error: string }> {
  if (input.roadmapItemIds.length === 0 && !input.executionSliceId) {
    return { ok: true, context: null }
  }
  if (!ctx.roadmapService) {
    return { ok: false, error: "Roadmap service was not initialized at lifecycle.init" }
  }

  const service = createRoadmapContextAttachmentService({
    roadmapSliceService: ctx.roadmapService,
    executionSlices: ctx.openArtisanServices?.executionSlices ?? null,
    workflow: ctx.openArtisanServices?.workflow ?? null,
  })
  const context = await service.deriveContext({
    roadmapItemIds: input.roadmapItemIds,
    featureName: input.featureName,
    ...(input.executionSliceId ? { executionSliceId: input.executionSliceId } : {}),
  })
  return context.ok ? { ok: true, context: context.value } : { ok: false, error: context.error.message }
}

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

  const roadmapContextResult = await buildBridgeRoadmapContextForSelectMode(ctx, {
    roadmapItemIds: parsed.roadmapItemIds,
    executionSliceId: parsed.executionSliceId,
    featureName,
  })
  if (!roadmapContextResult.ok) return `Error: ${roadmapContextResult.error}`
  const roadmapContext = roadmapContextResult.context

  await store.update(toolCtx.sessionId, (draft) => {
    draft.mode = parsed.mode
    draft.featureName = featureName
    draft.roadmapContext = roadmapContext
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.iterationCount = 0
    draft.retryCount = 0
  })

  if (ctx.roadmapService) {
    const link = await createRoadmapContextAttachmentService({
      roadmapSliceService: ctx.roadmapService,
      executionSlices: ctx.openArtisanServices?.executionSlices ?? null,
      workflow: ctx.openArtisanServices?.workflow ?? null,
    }).linkWorkflow({ featureName, roadmapContext })
    if (!link.ok) return `Error: ${link.error.message}`
  }

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
    draft.latestReviewResults = null
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

function createStructuralTransitionHandler(event: WorkflowEvent): ToolHandler {
  return async (args, toolCtx, ctx) => {
    const parsedArgs = parseToolArgs(StructuralTransitionToolSchema, args)
    if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
    const state = requireState(ctx, toolCtx.sessionId)
    const outcome = ctx.engine!.sm.transition(state.phase, state.phaseState, event, state.mode)
    if (!outcome.ok) return `Error: ${outcome.message}`
    await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
      draft.phase = outcome.nextPhase
      draft.phaseState = outcome.nextPhaseState
      draft.retryCount = 0
      draft.iterationCount = 0
      draft.userGateMessageReceived = false
    })
    return `Structural transition complete: ${state.phase}/${state.phaseState} + ${event} → ${outcome.nextPhase}/${outcome.nextPhaseState}.`
  }
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
    case "repair_current_task_boundary_from_impl_plan": return handleRepairCurrentTaskBoundaryFromImplPlan(toolCall.args, toolCtx, ctx)
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
  scheduling_complete: createStructuralTransitionHandler("scheduling_complete"),
  phase_skipped: createStructuralTransitionHandler("phase_skipped"),
  mark_task_complete: handleMarkTaskComplete,
  submit_task_review: handleSubmitTaskReview,
  submit_phase_review: handleSubmitPhaseReview,
  submit_review_rubric_item: handleSubmitReviewRubricItem,
  submit_auto_approve: handleSubmitAutoApprove,
  reset_task: handleResetTask,
  check_prior_workflow: handleCheckPriorWorkflow,
  resolve_human_gate: handleResolveHumanGate,
  propose_backtrack: handleProposeBacktrack,
  analyze_task_boundary_change: handleAnalyzeTaskBoundaryChange,
  apply_task_boundary_change: handleApplyTaskBoundaryChange,
  approve_current_task_scope_expansion: handleApproveCurrentTaskScopeExpansion,
  repair_current_task_boundary_from_impl_plan: handleRepairCurrentTaskBoundaryFromImplPlan,
  route_patch_suggestions: handleRoutePatchSuggestions,
  resolve_patch_suggestion: handleResolvePatchSuggestion,
  apply_patch_suggestion: handleApplyPatchSuggestion,
  propose_direct_application: handleProposeDirectApplication,
  request_allowlist_expansion: handleRequestAllowlistExpansion,
  summarize_workflow_incident: handleSummarizeWorkflowIncident,
  report_drift: handleReportDrift,
  plan_drift_repair: handlePlanDriftRepair,
  apply_drift_repair: handleApplyDriftRepair,
  query_parent_workflow: handleQueryParentWorkflow,
  query_child_workflow: handleQueryChildWorkflow,
  roadmap_read: handleRoadmapRead,
  roadmap_query: handleRoadmapQuery,
  roadmap_derive_execution_slice: handleRoadmapDeriveExecutionSlice,
  roadmap_upsert_item: handleRoadmapUpsertItem,
  roadmap_update_item_status: handleRoadmapUpdateItemStatus,
  roadmap_delete_item: handleRoadmapDeleteItem,
  roadmap_upsert_edge: handleRoadmapUpsertEdge,
  roadmap_delete_edge: handleRoadmapDeleteEdge,
  roadmap_replace: handleRoadmapReplace,
  roadmap_delete: handleRoadmapDelete,
}

const REVIEW_SUBMISSION_TOOLS = new Set(["submit_task_review", "submit_phase_review", "submit_review_rubric_item"])

// ---------------------------------------------------------------------------
// task.getReviewContext — returns review prompt for pending task review
// ---------------------------------------------------------------------------

export const handleTaskGetReviewContext: MethodHandler = async (params, ctx) => {
  const p = params as { sessionId?: string }
  if (!p.sessionId) {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  let state = ctx.engine!.store.get(p.sessionId)
  if (!state) return null
  const taskId = state.taskCompletionInProgress ?? (state.phase === "IMPLEMENTATION" && state.phaseState === "TASK_REVIEW" ? state.currentTaskId : null)
  if (!taskId) return null
  if (!state.taskCompletionInProgress) {
    await ctx.engine!.store.update(p.sessionId, (draft) => {
      draft.taskCompletionInProgress = taskId
    })
    state = ctx.engine!.store.get(p.sessionId)
    if (!state) return null
  }

  const prompt = await buildReviewContextForTask(state, taskId, ctx.projectDir ?? process.cwd(), ctx.openArtisanServices)
  if (!prompt) return null
  const artifactHash = taskReviewArtifactHash(state, taskId, ctx.projectDir ?? process.cwd())
  await ctx.engine!.store.update(p.sessionId, (draft) => {
    const existing = draft.reviewAttempts.find((attempt) => attempt.kind === "task" && attempt.subject === taskId && attempt.status === "started")
    if (!existing) {
      upsertReviewAttempt(draft, createReviewAttempt({
        kind: "task",
        subject: taskId,
        rubricItems: buildTaskReviewRubricItems(buildAdjacentTasksForTask(draft.implDag, taskId).length > 0),
        ...(artifactHash ? { artifactHash } : {}),
      }))
    }
  })
  const token = issueReviewSubmissionToken(ctx, p.sessionId, "task", taskId, artifactHash)
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

  const directory = ctx.projectDir ?? process.cwd()
  const artifactHash = artifactFilesHash(state.reviewArtifactFiles, directory)
  if (!artifactHash) return null
  const prompt = buildPhaseReviewContext(state, directory)
  if (!prompt) return null
  await ctx.engine!.store.update(p.sessionId, (draft) => {
    const existing = draft.reviewAttempts.find((attempt) => attempt.kind === "phase" && attempt.subject === state.phase && attempt.status === "started")
    if (!existing) {
      upsertReviewAttempt(draft, createReviewAttempt({ kind: "phase", subject: state.phase, rubricItems: [], artifactHash }))
    }
  })
  const token = issueReviewSubmissionToken(ctx, p.sessionId, "phase", state.phase, artifactHash)
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

  if (p.name === "mark_satisfied" && ctx.capabilities.selfReview !== "agent-only") {
    return "Error: mark_satisfied is disabled for bridge isolated-review workflows. Use request_review and let the adapter-dispatched isolated reviewer submit submit_phase_review."
  }

  if (p.name === "submit_auto_approve" && p.context.invocation !== "auto-approver") {
    return "Error: submit_auto_approve is reserved for adapter-dispatched auto-approver submissions."
  }

  const toolCtx: ToolContext = {
    sessionId: p.context.sessionId,
    directory: ctx.projectDir ?? p.context.directory ?? process.cwd(),
    ...(p.context.agent ? { agent: p.context.agent } : {}),
    ...(p.context.invocation ? { invocation: p.context.invocation } : {}),
  }

  return handler(p.args ?? {}, toolCtx, ctx)
}
