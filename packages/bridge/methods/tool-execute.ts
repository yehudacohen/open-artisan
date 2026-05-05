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
import type { AnalyzeTaskBoundaryChangeArgs, ApplyTaskBoundaryChangeArgs, ArtifactKey, WorkflowState } from "../../core/types"
import type { OpenArtisanServices } from "../../core/open-artisan-services"

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { parseSelectModeArgs } from "../../core/tools/select-mode"
import { processMarkTaskComplete, validateMarkTaskCompletePhase } from "../../core/tools/mark-task-complete"
import { buildAdjacentTasksForTask, buildTaskReviewAcceptancePlan, buildTaskReviewPrompt, parseTaskReviewResult } from "../../core/task-review"
import { buildReviewPrompt, parseReviewResult } from "../../core/self-review"
import { MAX_TASK_REVIEW_ITERATIONS } from "../../core/constants"
import { processQueryParentWorkflow, processQueryChildWorkflow } from "../../core/tools/query-workflow"
import {
  computeMarkScanCompleteTransition,
  computeMarkSatisfiedTransition,
  computeMarkAnalyzeCompleteTransition,
  computeRequestReviewTransition,
  computeSubmitFeedbackApproveTransition,
  computeSubmitFeedbackReviseTransition,
  computeProposeBacktrackTransition,
} from "../../core/tools/transitions"
import { buildAutoApprovePrompt, parseAutoApproveResult } from "../../core/auto-approve"
import { createGitCheckpoint } from "../../core/hooks/git-checkpoint"
import type { AutoApproveResult } from "../../core/auto-approve"
import { extractApprovedFileAllowlist } from "../../core/tools/plan-allowlist"
import { writeArtifact } from "../../core/artifact-store"
import { PHASE_TO_ARTIFACT } from "../../core/artifacts"
import { createImplDAG } from "../../core/dag"
import { nextSchedulerDecision, nextSchedulerDecisionForInput, readDecisionInput } from "../../core/scheduler"
import { validateFileBasedReviewArtifacts } from "../../core/tools/file-artifact-validation"
import { buildInvalidPhaseReviewJsonReason, normalizePhaseReviewOutput } from "../../core/phase-review"
import {
  buildAutoApproveRequest,
  buildRobotArtisanAutoApproveFailureFeedback,
  computeAutoApproveTransition,
  isRobotArtisanSession,
} from "../../core/autonomous-user-gate"
import { activateHumanGateTasks, resolveAwaitingHumanState } from "../../core/human-gate-policy"
import { buildWorkflowSwitchMessage, parkCurrentWorkflowSession } from "../../core/session-switch"
import type { RoadmapQuery } from "../../core/roadmap-types"
import type { DbAgentLease } from "../../core/open-artisan-repository"
import { getAcceptanceCriteria } from "../../core/hooks/system-transform"
import { resolveArtifactPaths } from "../../core/tools/artifact-paths"
import { extractJsonFromText } from "../../core/utils"
import { countExpectedBlockingCriteria } from "../../core/tools/mark-satisfied"
import { analyzeTaskBoundaryChange, applyTaskBoundaryChange } from "../../core/tools/transitions"
import { buildSubmitFeedbackClarificationMessage, findReviewedArtifactFilesOutsideAllowlist, findUnresolvedHumanGates, materializeImplPlanDag, normalizeApprovalFilePaths, resolveSubmitFeedbackHumanGates, stripWorkflowRoutingNotes, validateSubmitFeedbackGate, validateSubmitFeedbackImplPlanApproval } from "../../core/tools/submit-feedback"
import { collectWorktreeObservations } from "../../core/worktree-observation"
import {
  AnalyzeTaskBoundaryChangeSchema,
  ApplyDriftRepairToolSchema,
  ApplyPatchSuggestionSchema,
  ApplyTaskBoundaryChangeSchema,
  CheckPriorWorkflowToolSchema,
  MarkAnalyzeCompleteToolSchema,
  MarkScanCompleteToolSchema,
  MarkSatisfiedToolSchema,
  MarkTaskCompleteToolSchema,
  PlanDriftRepairToolSchema,
  ProposeBacktrackToolSchema,
  QueryChildWorkflowToolSchema,
  RoadmapDeriveExecutionSliceToolSchema,
  RoadmapQueryToolSchema,
  ResetTaskToolSchema,
  RequestReviewToolSchema,
  ReportDriftToolSchema,
  ResolveHumanGateToolSchema,
  ResolvePatchSuggestionSchema,
  SubmitAutoApproveToolSchema,
  SubmitFeedbackToolSchema,
  SubmitPhaseReviewToolSchema,
  SubmitTaskReviewToolSchema,
  type z,
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
import { routePatchSuggestions } from "../../core/patch-suggestion-routing"
import { applyPatchSuggestionToWorktree } from "../../core/patch-suggestion-application"
import { buildDriftRepairPlan, buildRepairToolCall, buildWorkflowDriftReport, type DriftRepairPlan, type DriftReport, type DriftToolCallPlan } from "../../core/drift"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolContext {
  sessionId: string
  directory: string
  agent?: string
}

function createRoadmapServices(ctx: BridgeContext):
  | { ok: true; roadmapBackend: NonNullable<BridgeContext["roadmapBackend"]>; roadmapService: NonNullable<BridgeContext["roadmapService"]> }
  | { ok: false; message: string } {
  if (ctx.roadmapBackend && ctx.roadmapService) {
    return { ok: true, roadmapBackend: ctx.roadmapBackend, roadmapService: ctx.roadmapService }
  }
  return { ok: false, message: "Roadmap backend was not initialized at lifecycle.init" }
}

function roadmapStorageFailure(message: string, retryable: boolean) {
  return JSON.stringify({
    ok: false,
    error: {
      code: "storage-failure",
      message,
      retryable,
    },
  })
}

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

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

const driftReports = new Map<string, DriftReport>()
const driftRepairPlans = new Map<string, DriftRepairPlan>()
const latestDriftReportBySession = new Map<string, string>()

function driftStoreKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`
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

function artifactFilesHash(files: string[], cwd: string): string | null {
  if (files.length === 0) return null
  try {
    const payload = files
      .map((file) => {
        const resolvedPath = file.startsWith("/") ? file : resolve(cwd, file)
        return `${resolvedPath}\n${readFileSync(resolvedPath, "utf-8")}`
      })
      .join("\n---\n")
    return artifactHash(payload)
  } catch {
    return null
  }
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

async function readCurrentArtifactHash(state: WorkflowState): Promise<string | null> {
  if (state.reviewArtifactFiles.length > 0) {
    return artifactFilesHash(state.reviewArtifactFiles, process.cwd())
  }
  const artifactKey = PHASE_TO_ARTIFACT[state.phase]
  if (!artifactKey) return null
  const artifactPath = state.artifactDiskPaths[artifactKey]
  if (!artifactPath) return null
  try {
    const content = await readFile(artifactPath, "utf-8")
    return artifactHash(content)
  } catch {
    return null
  }
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

type ToolHandler = (
  args: Record<string, unknown>,
  toolCtx: ToolContext,
  ctx: BridgeContext,
) => Promise<string>

function toAnalyzeTaskBoundaryChangeArgs(args: z.output<typeof AnalyzeTaskBoundaryChangeSchema>): AnalyzeTaskBoundaryChangeArgs {
  return args as AnalyzeTaskBoundaryChangeArgs
}

function toApplyTaskBoundaryChangeArgs(args: z.output<typeof ApplyTaskBoundaryChangeSchema>): ApplyTaskBoundaryChangeArgs {
  return args as ApplyTaskBoundaryChangeArgs
}

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

// ---- mark_satisfied ----

const handleMarkSatisfied: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.capabilities.selfReview !== "agent-only") {
    return subagentError("mark_satisfied", "the self-review subagent (SubagentDispatcher)")
  }
  const state = requireState(ctx, toolCtx.sessionId)
  const currentArtifactHash = await readCurrentArtifactHash(state)
  if (state.reviewArtifactHash && currentArtifactHash && state.reviewArtifactHash !== currentArtifactHash) {
    return (
      "Error: The artifact changed after it was submitted for review. " +
      "Call `request_review` again so the reviewer evaluates the current artifact instead of stale content."
    )
  }
  const parsedArgs = parseToolArgs(MarkSatisfiedToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const criteria = parsedArgs.data.criteria_met.map((item) => ({
    criterion: item.criterion,
    met: item.met,
    evidence: item.evidence,
    ...(item.severity !== undefined ? { severity: item.severity } : {}),
    ...(item.score !== undefined ? { score: item.score } : {}),
  }))
  const result = computeMarkSatisfiedTransition(criteria, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  const t = result.transition
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.iterationCount = t.nextIterationCount
    draft.retryCount = 0
    draft.latestReviewResults = t.latestReviewResults
    if (t.clearReviewArtifactHash) draft.reviewArtifactHash = null
    if (t.resetUserGateMessage) draft.userGateMessageReceived = false
    if (t.clearRevisionBaseline) draft.revisionBaseline = null
  })
  return t.responseMessage
}

// ---- request_review ----

const handleRequestReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  const validReviewStates = new Set(["DRAFT", "CONVENTIONS", "REVISE", "REVIEW"])
  if (!validReviewStates.has(state.phaseState)) {
    return `Error: request_review can only be called in DRAFT, CONVENTIONS, REVISE, or REVIEW state (current: ${state.phase}/${state.phaseState}).`
  }
  if (Object.prototype.hasOwnProperty.call(args, "artifact_content")) {
    return "Error: request_review no longer accepts artifact_content; write the artifact to disk and pass artifact_files instead."
  }
  const parsedArgs = parseToolArgs(RequestReviewToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`

  if (state.phaseState === "REVIEW") {
    let artifactFiles = parsedArgs.data.artifact_files.map((file) =>
      file.startsWith("/") ? file : resolve(toolCtx.directory, file),
    )
    const artifactKey = PHASE_TO_ARTIFACT[state.phase]
    const artifactMarkdown = parsedArgs.data.artifact_markdown
    if (artifactMarkdown?.trim()) {
      if (!artifactKey || !["DISCOVERY", "PLANNING", "IMPL_PLAN"].includes(state.phase)) {
        return "Error: artifact_markdown is only supported for DISCOVERY, PLANNING, and IMPL_PLAN markdown artifacts."
      }
      artifactFiles = [await writeArtifact(toolCtx.directory, artifactKey, artifactMarkdown, state.featureName)]
    }
    if (artifactFiles.length === 0) {
      return "Error: request_review at REVIEW state requires artifact_files so the review source of truth can be updated."
    }

    const artifactValidationError = validateFileBasedReviewArtifacts({
      phase: state.phase,
      artifactFiles,
      cwd: toolCtx.directory,
      featureName: state.featureName,
    })
    if (artifactValidationError) return `Error: ${artifactValidationError}`

    const artifactDiskPath = artifactKey && artifactKey !== "implementation" ? artifactFiles[0] ?? null : null
    const reviewHash = artifactFilesHash(artifactFiles, toolCtx.directory)

    await store.update(toolCtx.sessionId, (draft) => {
      draft.retryCount = 0
      draft.latestReviewResults = null
      if (reviewHash) draft.reviewArtifactHash = reviewHash
      if (artifactDiskPath && artifactKey) {
        draft.artifactDiskPaths[artifactKey] = artifactDiskPath
      }
      draft.reviewArtifactFiles = artifactFiles
    })

    const diskMsg = artifactDiskPath ? ` Artifact updated at ${artifactDiskPath}.` : ""
    const filesMsg = artifactFiles.length ? ` Registered ${artifactFiles.length} review file(s).` : ""
    return `Artifact re-submitted for ${state.phase} review.${diskMsg}${filesMsg}`
  }

  const transition = computeRequestReviewTransition(state, ctx.engine!.sm)
  if (!transition.success) return `Error: ${transition.error}`
  const t = transition.transition

  const artifactKey = PHASE_TO_ARTIFACT[state.phase]
  let artifactFiles = parsedArgs.data.artifact_files.map((file) =>
    file.startsWith("/") ? file : resolve(toolCtx.directory, file),
  )
  const artifactMarkdown = parsedArgs.data.artifact_markdown
  if (artifactMarkdown?.trim()) {
    if (!artifactKey || !["DISCOVERY", "PLANNING", "IMPL_PLAN"].includes(state.phase)) {
      return "Error: artifact_markdown is only supported for DISCOVERY, PLANNING, and IMPL_PLAN markdown artifacts."
    }
    artifactFiles = [await writeArtifact(toolCtx.directory, artifactKey, artifactMarkdown, state.featureName)]
  }
  const artifactValidationError = validateFileBasedReviewArtifacts({
    phase: state.phase,
    artifactFiles,
    cwd: toolCtx.directory,
    featureName: state.featureName,
  })
  if (artifactValidationError) return `Error: ${artifactValidationError}`
  const artifactDiskPath = artifactKey && artifactKey !== "implementation" ? artifactFiles[0] ?? null : null
  const reviewHash = artifactFilesHash(artifactFiles, toolCtx.directory)

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.retryCount = 0
    draft.latestReviewResults = null
    draft.reviewArtifactHash = null
    if (artifactDiskPath && artifactKey) {
      draft.artifactDiskPaths[artifactKey] = artifactDiskPath
    }
    if (reviewHash) {
      draft.reviewArtifactHash = reviewHash
    }
    draft.reviewArtifactFiles = artifactFiles
  })

  // policyVersion bumped automatically by setPostUpdateHook on store.update
  const diskMsg = artifactDiskPath ? ` Artifact written to ${artifactDiskPath}.` : ""
  return `Artifact submitted for review. Transitioning to ${t.nextPhase}/${t.nextPhaseState}.${diskMsg}`
}

// ---- submit_feedback ----

const handleSubmitFeedback: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)
  const cwd = toolCtx.directory || process.cwd()
  if (Object.prototype.hasOwnProperty.call(args, "artifact_content")) {
    return "Error: submit_feedback no longer accepts artifact_content; approve the artifact already submitted on disk via request_review artifact_files."
  }
  const parsedArgs = parseToolArgs(SubmitFeedbackToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const feedbackTextArg = parsedArgs.data.feedback_text ? stripWorkflowRoutingNotes(parsedArgs.data.feedback_text) : ""

  let derivedApprovedFiles: string[] | null = null
  const getEffectiveIncrementalAllowlist = (): string[] => {
    if (parsedArgs.data.approved_files) {
      return normalizeApprovalFilePaths(parsedArgs.data.approved_files, cwd)
    }
    if (derivedApprovedFiles) return derivedApprovedFiles
    let planContent: string | undefined
    if (state.artifactDiskPaths.plan) {
      try {
        planContent = readFileSync(state.artifactDiskPaths.plan, "utf-8")
      } catch {
        // non-fatal
      }
    }
    derivedApprovedFiles = planContent ? extractApprovedFileAllowlist(planContent, cwd) : []
    return derivedApprovedFiles
  }

  const gateError = validateSubmitFeedbackGate(state.phaseState)
  if (gateError) return `Error: ${gateError}`

  // Structural enforcement: agent cannot self-approve. The user must have
  // sent a message first (detected via message.process or session resume).
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
    const resolvedHumanGates = parsedArgs.data.resolved_human_gates ?? []
    if (state.phaseState === "HUMAN_GATE" && resolvedHumanGates.length === 0) {
      return "Cannot approve — HUMAN_GATE is a structural manual-action state, not a user approval surface. Resolve human-gated tasks via resolved_human_gates instead."
    }
    if (state.phaseState === "ESCAPE_HATCH") {
      return "Error: Cannot approve while an escape hatch is pending."
    }

    if (
      state.phase === "IMPLEMENTATION" &&
      state.implDag &&
      resolvedHumanGates.length === 0
    ) {
      const unresolvedGates = findUnresolvedHumanGates(state)
      if (unresolvedGates.length > 0) {
        const gateList = unresolvedGates
          .map((t) => `  - **${t.id}:** ${t.humanGate?.whatIsNeeded ?? t.description}`)
          .join("\n")
        return (
          `Cannot approve — ${unresolvedGates.length} unresolved human gate(s):\n\n` +
          `${gateList}\n\n` +
          "Please complete the required actions above, then call `submit_feedback` with `resolved_human_gates`."
        )
      }
    }

    if (state.phase === "IMPLEMENTATION" && state.implDag && resolvedHumanGates.length > 0) {
      const resolutionResult = resolveSubmitFeedbackHumanGates(state, resolvedHumanGates)
      if (!resolutionResult.success) return resolutionResult.error
      const { resolvedIds, updatedNodes, remainingGates, nextDecision } = resolutionResult.resolution
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
          draft.phaseState = "SCHEDULING"
          draft.currentTaskId = nextDecision.task.id
          draft.iterationCount = 0
          draft.retryCount = 0
          draft.userGateMessageReceived = false
        })
        await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)
        return (
          `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
          "Returning to IMPLEMENTATION/SCHEDULING — downstream tasks are now unblocked."
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
          draft.phaseState = "SCHEDULING"
          draft.currentTaskId = null
          draft.iterationCount = 0
          draft.retryCount = 0
          draft.userGateMessageReceived = false
        })
        return (
          `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
          "All DAG tasks are now complete. Returning to IMPLEMENTATION/SCHEDULING so the runtime can request final implementation review."
        )
      }

      await store.update(toolCtx.sessionId, (draft) => {
        draft.implDag = updatedNodes
      })
    }

    if (state.phase === "IMPL_PLAN") {
      let planContent: string | undefined
      if (!planContent) {
        const diskPath = state.artifactDiskPaths["impl_plan" as keyof typeof state.artifactDiskPaths] as string | undefined
        if (diskPath) {
          try {
            planContent = readFileSync(diskPath, "utf-8")
          } catch {
            // handled below with a clear error
          }
        }
      }
      if (!planContent) {
        return (
          "Error: IMPL_PLAN approval requires a previously written implementation plan on disk " +
          "so the plan can be parsed into a DAG before entering IMPLEMENTATION."
        )
      }
      const effectiveAllowlist =
        state.mode === "INCREMENTAL" && state.fileAllowlist.length === 0
          ? getEffectiveIncrementalAllowlist()
          : state.fileAllowlist
      const implPlanApprovalError = validateSubmitFeedbackImplPlanApproval({
        planContent,
        mode: state.mode,
        effectiveAllowlist,
        cwd,
        parseFixInstruction: "Fix the plan format and re-submit request_review with corrected artifact_files.",
      })
      if (implPlanApprovalError) return `Error: ${implPlanApprovalError}`
    }

    if (
      state.mode === "INCREMENTAL" &&
      (state.phase === "INTERFACES" || state.phase === "TESTS")
    ) {
      const effectiveAllowlist =
        state.fileAllowlist.length === 0 ? getEffectiveIncrementalAllowlist() : state.fileAllowlist
      const reviewedOutsideAllowlist = findReviewedArtifactFilesOutsideAllowlist({
        reviewArtifactFiles: state.reviewArtifactFiles,
        artifactDiskPaths: state.artifactDiskPaths,
        allowlist: effectiveAllowlist,
        cwd,
      })
      if (reviewedOutsideAllowlist.length > 0) {
        return (
          `Error: ${state.phase} approval failed allowlist validation: reviewed artifact files fall outside the approved INCREMENTAL allowlist: ` +
          `${reviewedOutsideAllowlist.join(", ")}. Update the planning allowlist or narrow the artifact scope before approval.`
        )
      }
    }

    if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && !parsedArgs.data.approved_files) {
      let planContent: string | undefined
      if (!planContent && state.artifactDiskPaths.plan) {
        try {
          planContent = readFileSync(state.artifactDiskPaths.plan, "utf-8")
        } catch {
          // non-fatal
        }
      }
      if (planContent) {
        derivedApprovedFiles = extractApprovedFileAllowlist(planContent, cwd)
      }
    }

    if (
      state.phase === "PLANNING" &&
      state.mode === "INCREMENTAL" &&
      !parsedArgs.data.approved_files &&
      (!derivedApprovedFiles || derivedApprovedFiles.length === 0)
    ) {
      return (
        "Error: INCREMENTAL planning approval requires an explicit file allowlist source. " +
        "Pass `approved_files`, or include an `Allowlist`/`Narrow allowlist` section in the approved plan artifact."
      )
    }

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
        let planContent: string | undefined
        if (!planContent) {
          const diskPath = state.artifactDiskPaths["impl_plan" as keyof typeof state.artifactDiskPaths] as string | undefined
          if (diskPath) {
            try {
              planContent = readFileSync(diskPath, "utf-8")
            } catch { /* non-fatal — DAG just won't be parsed */ }
          }
        }
        if (planContent) {
          const materialized = materializeImplPlanDag(planContent)
          if (materialized) {
            draft.implDag = materialized.nodes
            draft.currentTaskId = materialized.currentTaskId
          } else {
            draft.implDag = null
          }
        }
      }
      // Capture file allowlist at PLANNING approval in INCREMENTAL mode
      if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && parsedArgs.data.approved_files) {
        draft.fileAllowlist = normalizeApprovalFilePaths(parsedArgs.data.approved_files, cwd)
      } else if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && derivedApprovedFiles) {
        draft.fileAllowlist = derivedApprovedFiles
      } else if (
        state.mode === "INCREMENTAL" &&
        draft.fileAllowlist.length === 0 &&
        (state.phase === "INTERFACES" || state.phase === "TESTS" || state.phase === "IMPL_PLAN")
      ) {
        const effectiveAllowlist = getEffectiveIncrementalAllowlist()
        if (effectiveAllowlist.length > 0) {
          draft.fileAllowlist = effectiveAllowlist
        }
      }
      // Reset artifact file tracking for the new phase
      if (!preserveFinalImplementationReview) {
        draft.reviewArtifactFiles = []
      }
    })
    await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

    // policyVersion bumped automatically by setPostUpdateHook

    // Git checkpoint: tag the approval in version control (non-fatal)
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
      // Non-fatal — git checkpoint failure should not block the workflow
      ctx.engine?.log.warn("Git checkpoint failed", {
        detail: err instanceof Error ? err.message : String(err),
      })
    }

    return approval.responseMessage
  }

  if (feedbackType === "revise") {
    if (ctx.capabilities.orchestrator !== false) {
      return subagentError("submit_feedback(revise)", "the orchestrator (SubagentDispatcher)")
    }
    const result = computeSubmitFeedbackReviseTransition(feedbackTextArg, state, sm)
    if (!result.success) return `Error: ${result.error}`
    const t = result.transition
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
    return t.responseMessage
  }

  return `Error: feedback_type must be "approve" or "revise", got "${feedbackType}".`
}

// ---- mark_task_complete ----

const handleMarkTaskComplete: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  const phaseError = validateMarkTaskCompletePhase(state, { allowScheduling: true })
  if (phaseError) return `Error: ${phaseError}`

  // Re-entry guard: prevent concurrent task completions
  if (state.taskCompletionInProgress) {
    return `Error: Task "${state.taskCompletionInProgress}" is already awaiting review. Call submit_task_review first.`
  }

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
    "\n\n**Per-task review required.** Spawn an isolated reviewer (e.g. `claude --print`) with the prompt below. " +
    "The reviewer must have NO access to this conversation — only the prompt and project files. " +
    "Then call `submit_task_review` with the reviewer's output.\n\n" +
    "---\n\n" +
    reviewPrompt
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
  await persistTaskReviewResult(ctx.openArtisanServices, state, taskId, review, reviewOutput)

  // Check iteration cap — force accept after MAX_TASK_REVIEW_ITERATIONS
  const hitCap = state.taskReviewCount >= MAX_TASK_REVIEW_ITERATIONS
  if (hitCap && !review.passed) {
    const acceptancePlan = buildTaskReviewAcceptancePlan({ implDag: state.implDag, concurrency: state.concurrency, taskId })
    const nextMessage = buildTaskReviewResolvedMessage(taskId, state.implDag, state.concurrency)
    await store.update(toolCtx.sessionId, (draft) => {
      const existing = new Set(draft.reviewArtifactFiles)
      for (const f of acceptancePlan.completedTaskFiles) {
        if (!existing.has(f)) draft.reviewArtifactFiles.push(f)
      }
      draft.currentTaskId = acceptancePlan.nextTaskId
      if (acceptancePlan.nextPhaseState) draft.phaseState = acceptancePlan.nextPhaseState
      if (acceptancePlan.resetUserGateMessage) {
        draft.userGateMessageReceived = false
      }
      draft.taskCompletionInProgress = null
      draft.taskReviewCount = 0
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
    await store.update(toolCtx.sessionId, (draft) => {
      const existing = new Set(draft.reviewArtifactFiles)
      for (const f of acceptancePlan.completedTaskFiles) {
        if (!existing.has(f)) draft.reviewArtifactFiles.push(f)
      }
      draft.currentTaskId = acceptancePlan.nextTaskId
      if (acceptancePlan.nextPhaseState) draft.phaseState = acceptancePlan.nextPhaseState
      if (acceptancePlan.resetUserGateMessage) {
        draft.userGateMessageReceived = false
      }
      draft.taskCompletionInProgress = null
      draft.taskReviewCount = 0
    })
    await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)
    return `Task "${taskId}" review passed.\n\n${nextMessage}`
  }

  // Review failed — revert task status and return issues
  await store.update(toolCtx.sessionId, (draft) => {
    const task = draft.implDag?.find((t) => t.id === taskId)
    if (task) task.status = "pending"
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

// ---- check_prior_workflow ----

const handleCheckPriorWorkflow: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const parsedArgs = parseToolArgs(CheckPriorWorkflowToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const featureName = parsedArgs.data.feature_name.trim()

  const priorState = await store.findPersistedByFeatureName(featureName)
  if (!priorState) {
    await store.update(toolCtx.sessionId, (draft) => {
      draft.priorWorkflowChecked = true
    })
    return `No prior workflow found for feature "${featureName}". Proceed with select_mode.`
  }

  await store.update(toolCtx.sessionId, (draft) => {
    draft.priorWorkflowChecked = true
    draft.cachedPriorState = {
      intentBaseline: priorState.intentBaseline,
      phase: priorState.phase,
      artifactDiskPaths: priorState.artifactDiskPaths as Record<string, string>,
      approvedArtifacts: priorState.approvedArtifacts as Record<string, string>,
    }
  })

  return `Prior workflow found for "${featureName}" at phase ${priorState.phase}. Call select_mode to continue or start fresh.`
}

// ---- resolve_human_gate ----

const handleResolveHumanGate: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "IMPLEMENTATION") {
    return `Error: resolve_human_gate can only be called during IMPLEMENTATION.`
  }

  const parsedArgs = parseToolArgs(ResolveHumanGateToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const taskId = parsedArgs.data.task_id

  if (!state.implDag) return "Error: No implementation DAG found."

  const task = state.implDag.find((t) => t.id === taskId)
  if (!task) return `Error: Task "${taskId}" not found in DAG.`

  if (task.status !== "pending" && task.status !== "human-gated") {
    return `Error: Task "${taskId}" must be pending or human-gated (current: ${task.status}).`
  }

  const activatedNodes = activateHumanGateTasks(state.implDag, taskId, {
    whatIsNeeded: parsedArgs.data.what_is_needed,
    why: parsedArgs.data.why || "Required for implementation.",
    verificationSteps: parsedArgs.data.verification_steps || "Verify the setup is complete.",
    resolved: false,
  })
  const resolution = resolveAwaitingHumanState(activatedNodes, isRobotArtisanSession(state))

  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = resolution.updatedNodes
    if (resolution.action === "robot-abort") {
      draft.currentTaskId = resolution.nextTask?.id ?? null
      return
    }
    if (resolution.action === "user-gate") {
      draft.phaseState = "HUMAN_GATE"
      draft.iterationCount = 0
      draft.retryCount = 0
      draft.userGateMessageReceived = false
      draft.currentTaskId = null
    }
  })
  await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

  if (resolution.action === "robot-abort") {
    return (
      `Human gate set for task "${taskId}".\n\n` +
      `**Robot-artisan mode:** Auto-aborted ${resolution.abortedIds.length} human-gated task(s) and dependents.\n` +
      `These tasks require human action that cannot be automated.\n\n` +
      (resolution.nextTask
        ? `**Next task ready:** ${resolution.nextTask.id} — ${resolution.nextTask.description}\nContinue with the next task.`
        : `Call \`request_review\` to submit the partial implementation for review.`)
    )
  }

  if (resolution.action === "user-gate") {
    const gateList = resolution.humanGatedTasks
      .map((gate) => `  - **${gate.id}:** ${gate.whatIsNeeded}`)
      .join("\n")
    return (
      `Human gate set for task "${taskId}".\n\n` +
      `**All remaining work is blocked behind human gates.** Auto-advancing to HUMAN_GATE for user resolution.\n\n` +
      `**Unresolved human gates:**\n${gateList}`
    )
  }

  const refreshedDecision = nextSchedulerDecision(createImplDAG(resolution.updatedNodes))
  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = resolution.updatedNodes
    draft.currentTaskId = refreshedDecision.action === "dispatch" ? refreshedDecision.task.id : null
    draft.phaseState = "SCHEDULING"
  })
  await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

  return `Human gate set for task "${taskId}". Returning to IMPLEMENTATION/SCHEDULING for remaining work.`
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

// ---- spawn_sub_workflow ----

const handleSpawnSubWorkflow: ToolHandler = async () => {
  return subagentError("spawn_sub_workflow", "adapter-managed child session creation")
}

const handleAnalyzeTaskBoundaryChange: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(AnalyzeTaskBoundaryChangeSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = analyzeTaskBoundaryChange(toAnalyzeTaskBoundaryChangeArgs(parsedArgs.data), state)
  if (!result.success) return `Error: ${result.error}`
  return JSON.stringify(result.analysis, null, 2)
}

const handleApplyTaskBoundaryChange: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(ApplyTaskBoundaryChangeSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = applyTaskBoundaryChange(toApplyTaskBoundaryChangeArgs(parsedArgs.data), state)
  if (!result.success) return `Error: ${result.error}`
  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = result.updatedNodes
  })
  return result.message
}

const handleRoutePatchSuggestions: ToolHandler = async (_args, toolCtx, ctx) => {
  if (!ctx.openArtisanServices) return "Error: DB-backed patch suggestion services are not enabled."
  const state = requireState(ctx, toolCtx.sessionId)
  const workflowId = workflowDbId(state)
  const suggestions = await ctx.openArtisanServices.patchSuggestions.listSuggestions(workflowId, "pending")
  if (!suggestions.ok) return `Error: ${suggestions.error.message}`
  return JSON.stringify({ ok: true, value: routePatchSuggestions(state, suggestions.value) }, null, 2)
}

const handleResolvePatchSuggestion: ToolHandler = async (args, toolCtx, ctx) => {
  if (!ctx.openArtisanServices) return "Error: DB-backed patch suggestion services are not enabled."
  const parsedArgs = parseToolArgs(ResolvePatchSuggestionSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const { patch_suggestion_id: suggestionId, resolution } = parsedArgs.data
  const message = parsedArgs.data.message ?? ""
  const now = new Date().toISOString()
  if (resolution === "applied" || resolution === "failed") {
    const applied = await ctx.openArtisanServices.patchSuggestions.applySuggestion({
      id: stableId(suggestionId, resolution, now),
      patchSuggestionId: suggestionId,
      appliedBy: parsedArgs.data.applied_by ?? "agent",
      result: resolution,
      ...(message ? { message } : {}),
      createdAt: now,
    })
    if (!applied.ok) return `Error: ${applied.error.message}`
    return JSON.stringify({ ok: true, value: applied.value }, null, 2)
  }
  const status = resolution === "escalated" ? "escalated" : resolution === "deferred" ? "deferred" : "rejected"
  const updated = await ctx.openArtisanServices.patchSuggestions.updateStatus(suggestionId, status, now)
  if (!updated.ok) return `Error: ${updated.error.message}`
  return JSON.stringify({ ok: true, value: updated.value }, null, 2)
}

const handleApplyPatchSuggestion: ToolHandler = async (args, toolCtx, ctx) => {
  if (!ctx.openArtisanServices) return "Error: DB-backed patch suggestion services are not enabled."
  const parsedArgs = parseToolArgs(ApplyPatchSuggestionSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const state = requireState(ctx, toolCtx.sessionId)
  const result = await applyPatchSuggestionToWorktree({
    services: ctx.openArtisanServices,
    state,
    cwd: toolCtx.directory,
    patchSuggestionId: parsedArgs.data.patch_suggestion_id,
    appliedBy: parsedArgs.data.applied_by ?? "agent",
    ...(parsedArgs.data.force === undefined ? {} : { force: parsedArgs.data.force }),
  })
  return JSON.stringify(result, null, 2)
}

const handleReportDrift: ToolHandler = async (args, toolCtx, ctx) => {
  const parsedArgs = parseToolArgs(ReportDriftToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const state = requireState(ctx, toolCtx.sessionId)
  const workflowId = workflowDbId(state)
  const worktreeObservations = parsedArgs.data.include_worktree === false
    ? []
    : await collectWorktreeObservations({
      cwd: toolCtx.directory,
      workflowId,
      taskOwnedFiles: state.currentTaskId ? state.implDag?.find((task) => task.id === state.currentTaskId)?.expectedFiles ?? [] : [],
      artifactFiles: Object.values(state.artifactDiskPaths).filter((item): item is string => typeof item === "string"),
      fileClaims: [],
    })
  const pendingPatchSuggestions = ctx.openArtisanServices && parsedArgs.data.include_db !== false
    ? await ctx.openArtisanServices.patchSuggestions.listSuggestions(workflowId, "pending")
    : null
  if (pendingPatchSuggestions && !pendingPatchSuggestions.ok) return `Error: ${pendingPatchSuggestions.error.message}`
  const report = buildWorkflowDriftReport({
    workflowId,
    state,
    ...(parsedArgs.data.scope === undefined ? {} : { scope: parsedArgs.data.scope }),
    ...(parsedArgs.data.drifted_artifact_keys === undefined ? {} : { artifactKeys: parsedArgs.data.drifted_artifact_keys }),
    ...(parsedArgs.data.task_ids === undefined ? {} : { taskIds: parsedArgs.data.task_ids }),
    ...(parsedArgs.data.changed_files === undefined ? {} : { changedFiles: parsedArgs.data.changed_files }),
    worktreeObservations,
    routedPatchSuggestions: pendingPatchSuggestions?.ok ? routePatchSuggestions(state, pendingPatchSuggestions.value) : [],
  })
  driftReports.set(driftStoreKey(toolCtx.sessionId, report.id), report)
  latestDriftReportBySession.set(toolCtx.sessionId, report.id)
  return JSON.stringify({ ok: true, value: report }, null, 2)
}

const handlePlanDriftRepair: ToolHandler = async (args, toolCtx) => {
  const parsedArgs = parseToolArgs(PlanDriftRepairToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const reportId = parsedArgs.data.drift_report_id ?? latestDriftReportBySession.get(toolCtx.sessionId)
  if (!reportId) return "Error: No drift report available. Call report_drift first or pass drift_report_id."
  const report = driftReports.get(driftStoreKey(toolCtx.sessionId, reportId))
  if (!report) return `Error: Drift report "${reportId}" was not found for this session.`
  const createdAt = new Date().toISOString()
  const plan = buildDriftRepairPlan({
    id: stableId("drift-repair-plan", report.id, parsedArgs.data.strategy ?? "minimal", createdAt),
    driftReport: report,
    strategy: parsedArgs.data.strategy ?? "minimal",
    createdAt,
  })
  driftRepairPlans.set(driftStoreKey(toolCtx.sessionId, plan.id), plan)
  return JSON.stringify({ ok: true, value: { ...plan, toolCalls: plan.actions.map((action) => ({ actionId: action.id, toolCall: buildRepairToolCall(action) })) } }, null, 2)
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

const handleApplyDriftRepair: ToolHandler = async (args, toolCtx, ctx) => {
  const parsedArgs = parseToolArgs(ApplyDriftRepairToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const plan = driftRepairPlans.get(driftStoreKey(toolCtx.sessionId, parsedArgs.data.repair_plan_id))
  if (!plan) return `Error: Drift repair plan "${parsedArgs.data.repair_plan_id}" was not found for this session.`
  const approved = new Set(parsedArgs.data.approved_actions ?? [])
  const results: Array<{ actionId: string; skipped?: string; toolName?: string; result?: string }> = []
  for (const action of plan.actions) {
    const shouldApply = (parsedArgs.data.apply_safe_actions && action.safety === "safe-auto") || approved.has(action.id)
    if (!shouldApply) {
      results.push({ actionId: action.id, skipped: `Action safety is ${action.safety}.` })
      continue
    }
    const toolCall = buildRepairToolCall(action)
    if (!toolCall) {
      results.push({ actionId: action.id, skipped: "No schema-valid executable tool call is available for this action." })
      continue
    }
    const result = await executeDriftToolCall(toolCall, toolCtx, ctx)
    results.push({ actionId: action.id, toolName: toolCall.toolName, result })
  }
  return JSON.stringify({ ok: true, value: { repairPlanId: plan.id, results } }, null, 2)
}

// ---- query_parent_workflow ----

const handleQueryParentWorkflow: ToolHandler = async (_args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parentState = state.parentWorkflow
    ? ctx.engine!.store.findByFeatureName(state.parentWorkflow.featureName)
    : null
  const result = processQueryParentWorkflow(state, parentState)
  if (result.error) return `Error: ${result.error}`
  return JSON.stringify(result, null, 2)
}

// ---- query_child_workflow ----

const handleQueryChildWorkflow: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(QueryChildWorkflowToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const taskId = parsedArgs.data.task_id
  const childEntry = state.childWorkflows.find((c) => c.taskId === taskId)
  const childState = childEntry
    ? ctx.engine!.store.findByFeatureName(childEntry.featureName)
    : null
  const result = processQueryChildWorkflow(state, taskId, childState)
  if (result.error) return `Error: ${result.error}`
  return JSON.stringify(result, null, 2)
}

// ---- submit_auto_approve (must be before dispatch table) ----

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
    // Auto-approve: transition to next phase
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

  // Below confidence threshold — route to REVISE with feedback
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

// ---- reset_task ----

const handleResetTask: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "IMPLEMENTATION") {
    return `Error: reset_task can only be called during IMPLEMENTATION (current: ${state.phase}).`
  }
  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE" && state.phaseState !== "SCHEDULING") {
    return `Error: reset_task can only be called in DRAFT, REVISE, or SCHEDULING state (current: ${state.phaseState}).`
  }
  if (state.taskCompletionInProgress) {
    return `Error: Task "${state.taskCompletionInProgress}" is awaiting review. Call submit_task_review first.`
  }

  const parsedArgs = parseToolArgs(ResetTaskToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const taskIds = parsedArgs.data.task_ids
  const taskId = parsedArgs.data.task_id
  const ids = taskIds ?? (taskId ? [taskId] : [])

  if (ids.length === 0) {
    return "Error: task_id (string) or task_ids (array) is required."
  }
  if (!state.implDag) {
    return "Error: No implementation DAG found."
  }

  // Validate all task IDs exist
  for (const id of ids) {
    if (!state.implDag.find((t) => t.id === id)) {
      return `Error: Task "${id}" not found in DAG.`
    }
  }

  // Check no downstream dependencies are in-flight or complete
  // (resetting a task that others depend on could break the DAG)
  const resetSet = new Set(ids)
  for (const node of state.implDag) {
    if (resetSet.has(node.id)) continue
    if (node.status === "complete" || node.status === "in-flight") {
      const dependsOnReset = node.dependencies.some((d) => resetSet.has(d))
      if (dependsOnReset) {
        return (
          `Error: Task "${node.id}" (${node.status}) depends on "${node.dependencies.find((d) => resetSet.has(d))}". ` +
          `Reset dependent tasks too, or reset them in dependency order.`
        )
      }
    }
  }

  await store.update(toolCtx.sessionId, (draft) => {
    for (const id of ids) {
      const task = draft.implDag?.find((t) => t.id === id)
      if (task) {
        task.status = "pending"
      }
    }
    // Set currentTaskId to the first reset task (earliest in DAG order)
    const dagOrder = draft.implDag?.map((t) => t.id) ?? []
    const firstReset = dagOrder.find((id) => ids.includes(id))
    if (firstReset) {
      draft.currentTaskId = firstReset
    }
    draft.taskReviewCount = 0
    draft.taskCompletionInProgress = null
  })
  await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

  const taskList = ids.join(", ")
  return `Reset ${ids.length} task(s) to pending: ${taskList}. Current task: ${ids[0]}.`
}

// ---- roadmap_read ----

const handleRoadmapRead: ToolHandler = async (_args, _toolCtx, ctx) => {
  if (!ctx.stateDir) {
    return roadmapStorageFailure("Bridge stateDir is required for roadmap tools", false)
  }
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const { roadmapBackend } = services
  return JSON.stringify(await roadmapBackend.readRoadmap())
}

// ---- roadmap_query ----

const handleRoadmapQuery: ToolHandler = async (args, _toolCtx, ctx) => {
  if (!ctx.stateDir) {
    return roadmapStorageFailure("Bridge stateDir is required for roadmap tools", false)
  }
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const { roadmapService } = services
  const parsedArgs = parseToolArgs(RoadmapQueryToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const query = (parsedArgs.data.query ?? {}) as RoadmapQuery
  return JSON.stringify(await roadmapService.queryRoadmap(query))
}

// ---- roadmap_derive_execution_slice ----

const handleRoadmapDeriveExecutionSlice: ToolHandler = async (args, _toolCtx, ctx) => {
  if (!ctx.stateDir) {
    return roadmapStorageFailure("Bridge stateDir is required for roadmap tools", false)
  }
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const { roadmapService } = services
  const parsedArgs = parseToolArgs(RoadmapDeriveExecutionSliceToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const roadmapItemIds = parsedArgs.data.roadmap_item_ids ?? parsedArgs.data.roadmapItemIds ?? []
  const featureName = parsedArgs.data.feature_name ?? parsedArgs.data.featureName
  const input = featureName === undefined ? { roadmapItemIds } : { roadmapItemIds, featureName }

  return JSON.stringify(await roadmapService.deriveExecutionSlice(input))
}

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

  return buildReviewContextForTask(state, state.taskCompletionInProgress, ctx.projectDir ?? process.cwd(), ctx.openArtisanServices)
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

  return buildPhaseReviewContext(state, ctx.projectDir ?? process.cwd())
}

// ---------------------------------------------------------------------------
// task.getAutoApproveContext — returns auto-approve prompt for USER_GATE
// ---------------------------------------------------------------------------

export const handleAutoApproveContext: MethodHandler = async (params, ctx) => {
  const p = params as { sessionId?: string }
  if (!p.sessionId) {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  const state = ctx.engine!.store.get(p.sessionId)
  if (!state || state.phaseState !== "USER_GATE" || state.activeAgent !== "robot-artisan") return null

  return `**Gate:** USER_GATE\n` + buildAutoApprovePrompt(buildAutoApproveRequest(state, p.sessionId))
}

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

  const toolCtx: ToolContext = {
    sessionId: p.context.sessionId,
    directory: ctx.projectDir ?? p.context.directory ?? process.cwd(),
    ...(p.context.agent ? { agent: p.context.agent } : {}),
  }

  return handler(p.args ?? {}, toolCtx, ctx)
}
