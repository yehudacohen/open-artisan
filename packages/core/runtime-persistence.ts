/**
 * runtime-persistence.ts — Best-effort DB persistence for live runtime facts.
 */

import { createHash } from "node:crypto"

import type { WorkflowState } from "./workflow-state-types"
import type { Phase, PhaseState } from "./workflow-primitives"
import type { CriterionResult } from "./review-types"
import type { TaskReviewSuccess } from "./task-review"
import type { OpenArtisanServices } from "./open-artisan-services"
import type { DbAgentLease, DbReviewObservation, DbWorktreeObservation, ReviewRecommendation } from "./open-artisan-repository"
import type { WorktreeFileClaim } from "./worktree-observation"
import { DB_TASK_LEASE_TTL_MS } from "./constants"

function nowIso(): string {
  return new Date().toISOString()
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

export function workflowDbId(state: Pick<WorkflowState, "featureName" | "sessionId">): string {
  return `workflow:${state.featureName ?? state.sessionId}`
}

export function taskDbId(state: Pick<WorkflowState, "featureName" | "sessionId">, taskId: string): string {
  return `${workflowDbId(state)}:${taskId}`
}

export function taskLeaseId(state: Pick<WorkflowState, "featureName" | "sessionId">, taskId: string, sessionId: string): string {
  return stableId(workflowDbId(state), "lease", taskId, sessionId)
}

function recommendation(passed: boolean, issueCount: number): ReviewRecommendation {
  if (!passed) return "fail"
  return issueCount > 0 ? "pass_with_suggestions" : "pass"
}

function issueObservation(reviewId: string, issue: string, index: number): DbReviewObservation {
  return {
    id: stableId(reviewId, "issue", String(index), issue),
    reviewId,
    kind: issue.startsWith("PATCH:") ? "patch_suggestion" : "blocking_issue",
    severity: issue.startsWith("PATCH:") ? "warning" : "blocking",
    message: issue,
  }
}

export async function persistWorktreeObservations(
  services: OpenArtisanServices | null | undefined,
  observations: DbWorktreeObservation[],
): Promise<void> {
  if (!services) return
  for (const observation of observations) {
    await services.worktreeObservations.recordObservation(observation)
  }
}

export async function loadWorkflowFileClaims(
  services: OpenArtisanServices | null | undefined,
  workflowId: string,
): Promise<WorktreeFileClaim[]> {
  if (!services) return []
  const leases = await services.agentLeases.listLeases(workflowId)
  if (!leases.ok) return []
  const claims: WorktreeFileClaim[] = []
  for (const lease of leases.value) {
    const result = await services.agentLeases.listFileClaims(lease.id)
    if (!result.ok) continue
    for (const claim of result.value) {
      claims.push({ path: claim.path, agentLeaseId: lease.id })
    }
  }
  return claims
}

export async function persistTaskDispatchClaims(
  services: OpenArtisanServices | null | undefined,
  state: WorkflowState,
  taskId: string,
  sessionId: string,
  agentKind: DbAgentLease["agentKind"] = "other",
): Promise<string | null> {
  if (!services) return null
  const task = state.implDag?.find((candidate) => candidate.id === taskId)
  if (!task) return null
  const workflowId = workflowDbId(state)
  const leaseId = taskLeaseId(state, taskId, sessionId)
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + DB_TASK_LEASE_TTL_MS).toISOString()
  const lease = await services.agentLeases.recordLease({
    id: leaseId,
    workflowId,
    agentKind,
    sessionId,
    taskId: taskDbId(state, taskId),
    heartbeatAt: createdAt,
    expiresAt,
    createdAt,
  })
  if (!lease.ok) return null
  for (const path of task.expectedFiles) {
    await services.agentLeases.recordFileClaim({
      id: stableId(leaseId, "claim", path),
      agentLeaseId: leaseId,
      path,
      mode: "write",
      createdAt,
    })
  }
  return leaseId
}

export async function persistTaskReviewResult(
  services: OpenArtisanServices | null | undefined,
  state: WorkflowState,
  taskId: string,
  result: TaskReviewSuccess,
  rawOutput?: string,
): Promise<void> {
  if (!services) return
  const createdAt = nowIso()
  const workflowId = workflowDbId(state)
  const reviewId = stableId(workflowId, taskId, "task-review", createdAt)
  const observations = result.issues.map((issue, index) => issueObservation(reviewId, issue, index))
  if (result.scores) {
    observations.push({
      id: stableId(reviewId, "score", "code_quality"),
      reviewId,
      kind: "quality_score",
      severity: result.scores.code_quality >= 8 ? "info" : "blocking",
      message: `Code quality: ${result.scores.code_quality}/10`,
      metadata: { score: result.scores.code_quality, dimension: "code_quality" },
    })
    observations.push({
      id: stableId(reviewId, "score", "error_handling"),
      reviewId,
      kind: "quality_score",
      severity: result.scores.error_handling >= 8 ? "info" : "blocking",
      message: `Error handling: ${result.scores.error_handling}/10`,
      metadata: { score: result.scores.error_handling, dimension: "error_handling" },
    })
  }

  await services.reviews.recordTaskReview({
    id: reviewId,
    workflowId,
    taskId: taskDbId(state, taskId),
    recommendation: recommendation(result.passed, result.issues.length),
    passed: result.passed,
    ...(rawOutput ? { rawOutput } : {}),
    createdAt,
  }, observations)

  for (const patch of result.patchSuggestions ?? []) {
    await services.patchSuggestions.recordSuggestion({
      id: stableId(reviewId, "patch", patch.targetPath, patch.summary),
      workflowId,
      taskId: taskDbId(state, taskId),
      targetPath: patch.targetPath,
      summary: patch.summary,
      suggestedPatch: patch.suggestedPatch,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    })
  }
}

export async function persistPhaseReviewResult(
  services: OpenArtisanServices | null | undefined,
  state: WorkflowState,
  criteria: CriterionResult[],
  rawOutput: string,
): Promise<void> {
  if (!services) return
  const createdAt = nowIso()
  const workflowId = workflowDbId(state)
  const reviewId = stableId(workflowId, state.phase, "phase-review", createdAt)
  const blockingFailures = criteria.filter((criterion) => criterion.severity !== "suggestion" && !criterion.met)
  const observations: DbReviewObservation[] = criteria.map((criterion, index) => ({
    id: stableId(reviewId, "criterion", String(index), criterion.criterion),
    reviewId,
    kind: criterion.criterion.includes("[Q]") ? "quality_score" : criterion.met ? "ownership_observation" : "blocking_issue",
    severity: criterion.met ? "info" : criterion.severity === "suggestion" ? "warning" : "blocking",
    message: `${criterion.criterion}: ${criterion.evidence}`,
    metadata: { met: criterion.met, severity: criterion.severity, score: criterion.score },
  }))
  await services.reviews.recordPhaseReview({
    id: reviewId,
    workflowId,
    phase: state.phase,
    recommendation: blockingFailures.length > 0 ? "fail" : "pass",
    passed: blockingFailures.length === 0,
    rawOutput,
    createdAt,
  }, observations)
}

export async function persistFastForwardRecord(
  services: OpenArtisanServices | null | undefined,
  state: WorkflowState,
  fromPhase: Phase,
  fromPhaseState: PhaseState,
  toPhase: Phase,
  toPhaseState: PhaseState,
  reason: string,
  patchSuggestionIds: string[] = [],
): Promise<void> {
  if (!services) return
  const createdAt = nowIso()
  await services.fastForward.recordFastForward({
    id: stableId(workflowDbId(state), "fast-forward", fromPhase, fromPhaseState, toPhase, toPhaseState, createdAt),
    workflowId: workflowDbId(state),
    fromPhase,
    fromPhaseState,
    toPhase,
    toPhaseState,
    reason,
    patchSuggestionIds,
    createdAt,
  })
}
