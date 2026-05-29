import { JSONRPCErrorException } from "json-rpc-2.0"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import type { OpenArtisanServices } from "../../core/open-artisan-services"
import type { WorkflowEvent } from "../../core/workflow-primitives"
import type { TaskReviewSuccess } from "../../core/task-review"
import { buildAdjacentTasksForTask, buildTaskReviewAcceptancePlan, parseTaskReviewResult } from "../../core/task-review"
import { parseReviewResult } from "../../core/self-review"
import { computeMarkSatisfiedTransition } from "../../core/tools/transitions"
import { applyDispatch, nextSchedulerDecisionForInput, readDecisionInput } from "../../core/scheduler"
import { buildInvalidPhaseReviewJsonReason } from "../../core/phase-review"
import { extractJsonFromText } from "../../core/utils"
import { getAcceptanceCriteria } from "../../core/hooks/system-transform"
import { countExpectedBlockingCriteria, countSubmittedBlockingCriteria } from "../../core/tools/mark-satisfied"
import { parseToolArgs } from "../../core/tool-args"
import { SubmitPhaseReviewToolSchema, SubmitReviewRubricItemToolSchema, SubmitTaskReviewToolSchema } from "../../core/schemas"
import { buildPhaseReviewOutputFromSubmission, buildTaskReviewOutputFromSubmission } from "../../core/review-submission-normalizers"
import { persistPhaseReviewResult, persistTaskDispatchClaims, persistTaskReviewResult } from "../../core/runtime-persistence"
import type { DbAgentLease } from "../../core/open-artisan-repository"
import type { ToolHandler } from "./tool-handler-types"
import { artifactFilesHash, buildImplPlanExecutableContractFailureCriterion } from "./review-feedback-tool-handlers"
import { consumeReviewSubmissionToken, getReviewSubmissionTokenRecord } from "./review-submission-tokens"
import { recordToolFailure } from "../../core/tool-failure-history"
import { buildTaskReviewRubricItems, completeReviewAttempt, createReviewAttempt, recordReviewRubricItemProgress, rubricItemsFromPhaseCriteria, rubricItemsFromTaskReviewResult, upsertReviewAttempt } from "../../core/tools/review-attempts"
import { appendWorkflowProgressEvent, buildWorkflowProgressEvent } from "../../core/workflow-progress"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

async function emitReviewerSubmissionProgress(ctx: BridgeContext, state: WorkflowState, input: {
  sessionId: string
  kind: "task" | "phase"
  subject: string
  toolName: string
  message: string
}): Promise<void> {
  const stateDir = ctx.stateDir ?? ctx.runtimeBackendInfo.stateDir
  if (!stateDir) return
  try {
    await appendWorkflowProgressEvent(stateDir, buildWorkflowProgressEvent({
      sessionId: input.sessionId,
      kind: input.kind === "task" ? "task-review.tool" : "phase-review.tool",
      status: "in-progress",
      message: input.message,
      spanId: `${input.kind}:${input.subject}:tool`,
      ...(input.kind === "task" ? { taskId: input.subject } : {}),
      metadata: { toolName: input.toolName },
    }, state))
  } catch (error) {
    ctx.pinoLogger?.debug({ err: error }, "Reviewer submission progress emit failed")
  }
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

function buildTaskReviewResolvedMessage(
  taskId: string,
  implDag: import("../../core/dag").TaskNode[] | null,
  concurrency: { maxParallelTasks: number },
): string {
  const { fallbackDecision } = buildRuntimeSchedulerDecision({ implDag, concurrency })

  if (fallbackDecision.action === "dispatch") {
    return `**Next task ready:**\n${fallbackDecision.prompt}`
  }

  if (fallbackDecision.action === "complete") {
    return `**All DAG tasks complete.** ${fallbackDecision.message}`
  }

  return `**${formatSchedulerDecisionMessage(fallbackDecision)}**`
}

function buildLatestTaskReviewResults(taskId: string, review: TaskReviewSuccess): WorkflowState["latestReviewResults"] {
  const results: NonNullable<WorkflowState["latestReviewResults"]> = [{
    criterion: `Task ${taskId} isolated review verdict`,
    met: review.passed,
    evidence: review.reasoning || (review.passed ? "Reviewer accepted the completed task." : "Reviewer rejected the completed task."),
  }]

  review.issues.forEach((issue, index) => {
    results.push({
      criterion: `Task ${taskId} review issue ${index + 1}`,
      met: false,
      evidence: issue,
    })
  })

  if (review.scores) {
    results.push({
      criterion: `Task ${taskId} code quality score`,
      met: review.scores.code_quality >= 8,
      evidence: `Code quality score ${review.scores.code_quality}/10`,
      score: `${review.scores.code_quality}/10`,
    })
    results.push({
      criterion: `Task ${taskId} error handling score`,
      met: review.scores.error_handling >= 8,
      evidence: `Error handling score ${review.scores.error_handling}/10`,
      score: `${review.scores.error_handling}/10`,
    })
  }

  return results
}

function isTaskReviewRuntimeFailure(review: TaskReviewSuccess): boolean {
  return review.issues.some((issue) =>
    issue.startsWith("Review dispatch failed:") || issue.includes("ISOLATED_REVIEW_FAILED:"),
  )
}

function normalizedScore(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const score = typeof value === "number" ? value : Number(value.trim())
  return Number.isFinite(score) ? score : undefined
}

function currentReviewAttempt(draft: WorkflowState, kind: "task" | "phase", subject: string) {
  return draft.reviewAttempts.find((candidate) => candidate.kind === kind && candidate.subject === subject && candidate.status === "started")
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

export function taskReviewArtifactHash(state: WorkflowState, taskId: string, directory: string): string | null {
  const task = state.implDag?.find((candidate) => candidate.id === taskId)
  if (!task) return null
  const files = [...(task.expectedFiles ?? []), ...(task.expectedTests ?? [])]
  return artifactFilesHash(files, directory)
}

export const handleSubmitReviewRubricItem: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const parsedArgs = parseToolArgs(SubmitReviewRubricItemToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const token = parsedArgs.data.review_token
  if (!token) return "Error: review_token is required for bridge reviewer rubric progress submissions."
  const tokenRecord = getReviewSubmissionTokenRecord(ctx, token)
  if (!tokenRecord) return "Error: Invalid or expired isolated reviewer token. Request a fresh review context and retry."
  if (tokenRecord.sessionId !== toolCtx.sessionId) return "Error: Isolated reviewer token does not match the pending review. Request a fresh review context and retry."
  if (tokenRecord.kind !== "task" && tokenRecord.kind !== "phase") return "Error: submit_review_rubric_item only supports task and phase reviews."
  const reviewKind: "task" | "phase" = tokenRecord.kind
  const state = requireState(ctx, toolCtx.sessionId)
  const score = normalizedScore(parsedArgs.data.score)
  await store.update(toolCtx.sessionId, (draft) => {
    const rubricItems = reviewKind === "task"
      ? buildTaskReviewRubricItems(buildAdjacentTasksForTask(draft.implDag, tokenRecord.subject).length > 0)
      : [{ criterion: parsedArgs.data.criterion, status: "pending" as const }]
    recordReviewRubricItemProgress(draft, {
      kind: reviewKind,
      subject: tokenRecord.subject,
      rubricItems,
      artifactHash: tokenRecord.artifactHash ?? state.reviewArtifactHash,
      rubricItem: {
        criterion: parsedArgs.data.criterion,
        status: parsedArgs.data.status,
        ...(parsedArgs.data.evidence ? { evidence: parsedArgs.data.evidence } : {}),
        ...(score !== undefined ? { score } : {}),
      },
    })
  })
  await emitReviewerSubmissionProgress(ctx, state, {
    sessionId: toolCtx.sessionId,
    kind: reviewKind,
    subject: tokenRecord.subject,
    toolName: "submit_review_rubric_item",
    message: `submit_review_rubric_item called for ${parsedArgs.data.criterion}`,
  })
  return "Review rubric item recorded."
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

function buildIncompletePhaseReviewReason(state: WorkflowState, submittedBlockingCount: number, reviewOutput: string): string | null {
  if (submittedBlockingCount === 0) return null
  const criteriaText = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, state.artifactDiskPaths?.design ?? null)
  const expectedBlockingCount = countExpectedBlockingCriteria(criteriaText)
  if (expectedBlockingCount <= 0 || submittedBlockingCount >= expectedBlockingCount) return null
  const excerpt = reviewOutput.length > 500 ? `${reviewOutput.slice(0, 500)}...` : reviewOutput
  return `Reviewer returned only ${submittedBlockingCount} blocking criteria, but ${state.phase} requires ${expectedBlockingCount}. The isolated reviewer output was incomplete; raw output: ${excerpt}`
}

export const handleSubmitTaskReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  const recoveredTaskId = state.taskCompletionInProgress ?? (state.phase === "IMPLEMENTATION" && state.phaseState === "TASK_REVIEW" ? state.currentTaskId : null)
  if (!recoveredTaskId) {
    return "Error: No task review is pending. Call mark_task_complete first."
  }

  const parsedArgs = parseToolArgs(SubmitTaskReviewToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const taskId = recoveredTaskId
  const tokenResult = consumeReviewSubmissionToken(ctx, parsedArgs.data.review_token, toolCtx.sessionId, "task", taskId, false)
  if (tokenResult.error) return `Error: ${tokenResult.error}`
  const currentTaskHash = taskReviewArtifactHash(state, taskId, toolCtx.directory)
  if (tokenResult.artifactHash && (!currentTaskHash || tokenResult.artifactHash !== currentTaskHash)) {
    return (
      "Error: The task files changed after isolated task review context was issued. " +
      "Request a fresh task review context and retry."
    )
  }
  await emitReviewerSubmissionProgress(ctx, state, {
    sessionId: toolCtx.sessionId,
    kind: "task",
    subject: taskId,
    toolName: "submit_task_review",
    message: `submit_task_review called for ${taskId}`,
  })
  const baseTaskRubricItems = buildTaskReviewRubricItems(buildAdjacentTasksForTask(state.implDag, taskId).length > 0)
  const normalizedSubmission = buildTaskReviewOutputFromSubmission(parsedArgs.data)
  if (!normalizedSubmission.success) {
    let duplicateCount = 1
    await store.update(toolCtx.sessionId, (draft) => {
      const failure = recordToolFailure(draft, {
        category: "reviewer-infrastructure",
        toolName: "submit_task_review",
        taskId,
        message: normalizedSubmission.error,
      })
      duplicateCount = failure.count
      draft.latestReviewResults = [{
        criterion: `Task ${taskId} reviewer infrastructure failed`,
        met: false,
        evidence: normalizedSubmission.error,
      }]
      const attempt = currentReviewAttempt(draft, "task", taskId) ?? createReviewAttempt({ kind: "task", subject: taskId, rubricItems: baseTaskRubricItems })
      upsertReviewAttempt(draft, completeReviewAttempt({
        attempt,
        status: "error",
        rubricItems: rubricItemsFromTaskReviewResult({ success: false, error: normalizedSubmission.error }, baseTaskRubricItems),
        error: normalizedSubmission.error,
      }))
    })
    return (
      `Task "${taskId}" is blocked by reviewer infrastructure, not by a code-review verdict.\n\n` +
      `**Classification:** reviewer-failed\n` +
      `**Attempt consumed:** no\n` +
      `**Reviewer/tool error:** ${normalizedSubmission.error}\n` +
      (duplicateCount > 1 ? `\n**Known tooling defect:** same reviewer submission failure seen ${duplicateCount} times. Safe to retry this reviewer submission after fixing/restarting the reviewer path.\n` : "")
    )
  }
  const reviewOutput = normalizedSubmission.reviewOutput

  const review = parseTaskReviewResult(reviewOutput)

  if (!review.success) {
    let duplicateCount = 1
    await store.update(toolCtx.sessionId, (draft) => {
      const failure = recordToolFailure(draft, {
        category: "reviewer-infrastructure",
        toolName: "submit_task_review",
        taskId,
        message: review.error,
      })
      duplicateCount = failure.count
      draft.latestReviewResults = [{
        criterion: `Task ${taskId} reviewer infrastructure failed`,
        met: false,
        evidence: review.error,
      }]
      const attempt = currentReviewAttempt(draft, "task", taskId) ?? createReviewAttempt({ kind: "task", subject: taskId, rubricItems: baseTaskRubricItems })
      upsertReviewAttempt(draft, completeReviewAttempt({
        attempt,
        status: "error",
        rubricItems: rubricItemsFromTaskReviewResult({ success: false, error: review.error }, baseTaskRubricItems),
        error: review.error,
      }))
    })
    return (
      `Task "${taskId}" is blocked by reviewer infrastructure, not by a code-review verdict.\n\n` +
      `**Classification:** reviewer-failed\n` +
      `**Attempt consumed:** no\n` +
      `**Reviewer/tool error:** ${review.error}\n` +
      (duplicateCount > 1 ? `\n**Known tooling defect:** same reviewer parse failure seen ${duplicateCount} times. Safe to retry this reviewer submission after fixing/restarting the reviewer path.\n` : "")
    )
  }
  ctx.reviewSubmissionTokens?.delete(parsedArgs.data.review_token)
  await persistTaskReviewResult(ctx.openArtisanServices, state, taskId, review, reviewOutput)
  const latestTaskReviewResults = buildLatestTaskReviewResults(taskId, review)
  const reviewRuntimeFailure = isTaskReviewRuntimeFailure(review)

  const nextReviewAttempt = state.taskReviewCount + 1
  if (review.passed) {
    const acceptancePlan = buildTaskReviewAcceptancePlan({ implDag: state.implDag, concurrency: state.concurrency, taskId })
    const nextMessage = buildTaskReviewResolvedMessage(taskId, state.implDag, state.concurrency)
    const nextState = nextImplementationAuthoringState(state, acceptancePlan, ctx)
    await store.update(toolCtx.sessionId, (draft) => {
      applyTaskReviewAcceptance(draft, acceptancePlan, nextState)
      draft.latestReviewResults = latestTaskReviewResults
      const attempt = currentReviewAttempt(draft, "task", taskId) ?? createReviewAttempt({ kind: "task", subject: taskId, rubricItems: baseTaskRubricItems })
      upsertReviewAttempt(draft, completeReviewAttempt({
        attempt,
        status: "passed",
        rubricItems: rubricItemsFromTaskReviewResult(review, baseTaskRubricItems),
      }))
    })
    await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)
    return `Task "${taskId}" review passed.\n\n${nextMessage}`
  }

  const failedState = transitionOrThrow(state, "task_review_fail", ctx)
  let runtimeFailureDuplicateCount = 1
  await store.update(toolCtx.sessionId, (draft) => {
    const task = draft.implDag?.find((t) => t.id === taskId)
    if (task) task.status = "in-flight"
    draft.phase = failedState.phase
    draft.phaseState = failedState.phaseState
    draft.currentTaskId = taskId
    draft.taskCompletionInProgress = null
    draft.taskReviewCount = reviewRuntimeFailure
      ? Math.max(draft.taskReviewCount ?? 0, 0)
      : nextReviewAttempt
    draft.latestReviewResults = latestTaskReviewResults
    const attempt = currentReviewAttempt(draft, "task", taskId) ?? createReviewAttempt({ kind: "task", subject: taskId, rubricItems: baseTaskRubricItems })
    upsertReviewAttempt(draft, completeReviewAttempt({
      attempt,
      status: reviewRuntimeFailure ? "error" : "failed",
      rubricItems: rubricItemsFromTaskReviewResult(review, baseTaskRubricItems),
      ...(reviewRuntimeFailure ? { error: `${review.issues.join("; ")} ${review.reasoning}`.trim() } : {}),
    }))
    if (reviewRuntimeFailure) {
      const failure = recordToolFailure(draft, {
        category: "reviewer-infrastructure",
        toolName: "submit_task_review",
        taskId,
        message: `${review.issues.join("; ")} ${review.reasoning}`.trim(),
      })
      runtimeFailureDuplicateCount = failure.count
    }
  })

  const issuesList = review.issues.map((i) => `  - ${i}`).join("\n")
  if (reviewRuntimeFailure) {
    return (
      `Task "${taskId}" isolated review runtime FAILED. ${review.issues.length} issue(s) found:\n${issuesList}\n\n` +
      `${review.reasoning ? `Reviewer runtime reasoning: ${review.reasoning}\n\n` : ""}` +
      "Attempt consumed: no. " +
      (runtimeFailureDuplicateCount > 1 ? `Known tooling defect: same reviewer runtime failure seen ${runtimeFailureDuplicateCount} times; safe to retry after fixing/restarting the reviewer path. ` : "") +
      "Do not change implementation code for this runtime failure. Fix the reviewer/runtime path and call mark_task_complete again."
    )
  }
  return (
    `Task "${taskId}" review FAILED. ${review.issues.length} issue(s) found:\n${issuesList}\n\n` +
    `${review.reasoning ? `Reviewer reasoning: ${review.reasoning}\n\n` : ""}` +
    `Fix the issues and call mark_task_complete again. ` +
    `(Review iteration ${nextReviewAttempt})`
  )
}

export const handleSubmitPhaseReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phaseState !== "REVIEW") {
    return `Error: submit_phase_review can only be called in REVIEW state (current: ${state.phase}/${state.phaseState}).`
  }

  const parsedArgs = parseToolArgs(SubmitPhaseReviewToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const tokenResult = consumeReviewSubmissionToken(ctx, parsedArgs.data.review_token, toolCtx.sessionId, "phase", state.phase, false)
  if (tokenResult.error) return `Error: ${tokenResult.error}`
  const currentPhaseHash = artifactFilesHash(state.reviewArtifactFiles, toolCtx.directory)
  if (tokenResult.artifactHash && (!currentPhaseHash || tokenResult.artifactHash !== currentPhaseHash)) {
    return (
      "Error: The phase artifact files changed after isolated review context was issued. " +
      "Request a fresh phase review context and retry."
    )
  }
  await emitReviewerSubmissionProgress(ctx, state, {
    sessionId: toolCtx.sessionId,
    kind: "phase",
    subject: state.phase,
    toolName: "submit_phase_review",
    message: `submit_phase_review called for ${state.phase}`,
  })
  const normalizedSubmission = buildPhaseReviewOutputFromSubmission(parsedArgs.data)
  if (!normalizedSubmission.success) return `Error: ${normalizedSubmission.error}`
  const reviewOutput = normalizedSubmission.reviewOutput
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
      const incompleteReason = buildIncompletePhaseReviewReason(state, countSubmittedBlockingCriteria(rawCriteria), reviewOutput)
      if (incompleteReason) {
        let duplicateCount = 1
        await store.update(toolCtx.sessionId, (draft) => {
          const failure = recordToolFailure(draft, {
            category: "reviewer-infrastructure",
            toolName: "submit_phase_review",
            message: incompleteReason,
          })
          duplicateCount = failure.count
          draft.latestReviewResults = [{
            criterion: "Isolated reviewer infrastructure failed",
            met: false,
            evidence: incompleteReason,
          }]
        })
        const duplicateNote = duplicateCount > 1
          ? ` Same reviewer/tool failure has been seen ${duplicateCount} times; treat it as a tooling defect, not an artifact verdict.`
          : ""
        return `Error: Isolated phase reviewer failed: ${incompleteReason}.${duplicateNote} Workflow state remains at ${state.phase}/${state.phaseState}; fix the reviewer/runtime issue and request a fresh phase review context before retrying.`
      }
    }
  } catch (err) {
    rawCriteria = buildReviewerFailureCriteria(state, buildInvalidPhaseReviewJsonReason(reviewOutput, err))
  }
  const implPlanContractFailure = buildImplPlanExecutableContractFailureCriterion(state, toolCtx.directory)
  if (implPlanContractFailure) rawCriteria.push(implPlanContractFailure)

  const result = computeMarkSatisfiedTransition(rawCriteria, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  ctx.reviewSubmissionTokens?.delete(parsedArgs.data.review_token)
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
    const attempt = currentReviewAttempt(draft, "phase", state.phase) ?? createReviewAttempt({ kind: "phase", subject: state.phase, rubricItems: rubricItemsFromPhaseCriteria(rawCriteria) })
    upsertReviewAttempt(draft, completeReviewAttempt({
      attempt,
      status: t.event === "self_review_pass" ? "passed" : "failed",
      rubricItems: rubricItemsFromPhaseCriteria(rawCriteria),
    }))
  })

  return `Isolated phase review submitted. ${t.responseMessage}`
}
