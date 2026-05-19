import { createHash } from "node:crypto"

import type { TaskReviewResult } from "../task-review"
import type { ReviewAttempt, ReviewAttemptStatus, ReviewRubricItem, WorkflowState } from "../workflow-state-types"

const MAX_REVIEW_ATTEMPTS = 50

const BASE_TASK_RUBRIC_ITEMS = [
  "Run the tests",
  "Verify interface alignment",
  "Check for regressions",
  "Check conventions alignment",
  "Reject placeholder tests",
  "Stub/placeholder detection",
  "Reject helper-only or drifting policy integrations",
  "Structural wiring gate",
  "Scenario sufficiency gate",
]

export function buildTaskReviewRubricItems(hasAdjacentTasks: boolean): ReviewRubricItem[] {
  const items = BASE_TASK_RUBRIC_ITEMS.map((criterion) => ({ criterion, status: "pending" as const }))
  if (hasAdjacentTasks) items.push({ criterion: "Integration seam check", status: "pending" })
  items.push({ criterion: "[Q] Code quality", status: "pending" })
  items.push({ criterion: "[Q] Error handling", status: "pending" })
  return items
}

export function reviewAttemptId(input: { kind: ReviewAttempt["kind"]; subject: string; startedAt: number }): string {
  return createHash("sha256")
    .update(`${input.kind}\0${input.subject}\0${input.startedAt}`)
    .digest("hex")
    .slice(0, 16)
}

export function createReviewAttempt(input: {
  kind: ReviewAttempt["kind"]
  subject: string
  rubricItems: ReviewRubricItem[]
  artifactHash?: string | null
  startedAt?: number
}): ReviewAttempt {
  const startedAt = input.startedAt ?? Date.now()
  return {
    id: reviewAttemptId({ kind: input.kind, subject: input.subject, startedAt }),
    kind: input.kind,
    subject: input.subject,
    status: "started",
    rubricItems: input.rubricItems.map((item) => ({ ...item })),
    ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
    startedAt,
  }
}

export function upsertReviewAttempt(state: Pick<WorkflowState, "reviewAttempts">, attempt: ReviewAttempt): void {
  const existing = state.reviewAttempts.findIndex((candidate) => candidate.id === attempt.id)
  if (existing >= 0) {
    state.reviewAttempts[existing] = attempt
  } else {
    state.reviewAttempts = [attempt, ...state.reviewAttempts].slice(0, MAX_REVIEW_ATTEMPTS)
  }
}

function mergeReviewRubricItems(existingItems: ReviewRubricItem[], incomingItems: ReviewRubricItem[]): ReviewRubricItem[] {
  const merged = existingItems.map((item) => ({ ...item }))
  for (const incoming of incomingItems) {
    const index = merged.findIndex((item) => item.criterion === incoming.criterion)
    if (index === -1) {
      merged.push({ ...incoming })
      continue
    }
    const existing = merged[index]!
    if (incoming.status === "unknown" && (existing.status === "passed" || existing.status === "failed")) {
      merged[index] = {
        ...incoming,
        status: existing.status,
        ...(existing.evidence !== undefined ? { evidence: existing.evidence } : {}),
        ...(existing.score !== undefined ? { score: existing.score } : {}),
      }
      continue
    }
    merged[index] = { ...existing, ...incoming }
  }
  return merged
}

export function recordReviewRubricItemProgress(inputState: Pick<WorkflowState, "reviewAttempts">, input: {
  kind: ReviewAttempt["kind"]
  subject: string
  rubricItem: ReviewRubricItem
  rubricItems?: ReviewRubricItem[]
  attemptId?: string | null
  artifactHash?: string | null
  startedAt?: number
}): ReviewAttempt {
  const attempt = inputState.reviewAttempts.find((candidate) =>
    (input.attemptId ? candidate.id === input.attemptId : candidate.kind === input.kind && candidate.subject === input.subject && candidate.status === "started"),
  ) ?? createReviewAttempt({
    kind: input.kind,
    subject: input.subject,
    rubricItems: input.rubricItems ?? [input.rubricItem],
    ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
  })
  const updated = {
    ...attempt,
    rubricItems: mergeReviewRubricItems(attempt.rubricItems, [input.rubricItem]),
  }
  upsertReviewAttempt(inputState, updated)
  return updated
}

export function completeReviewAttempt(input: {
  attempt: ReviewAttempt
  status: ReviewAttemptStatus
  rubricItems?: ReviewRubricItem[]
  error?: string | null
  completedAt?: number
}): ReviewAttempt {
  return {
    ...input.attempt,
    status: input.status,
    rubricItems: mergeReviewRubricItems(input.attempt.rubricItems, input.rubricItems ?? input.attempt.rubricItems),
    ...(input.error ? { error: input.error } : {}),
    completedAt: input.completedAt ?? Date.now(),
  }
}

export function rubricItemsFromTaskReviewResult(
  result: TaskReviewResult,
  baseItems: ReviewRubricItem[],
): ReviewRubricItem[] {
  if (!result.success) {
    return baseItems.map((item) => ({ ...item, status: "unknown", evidence: result.error }))
  }
  if (result.passed) {
    return baseItems.map((item) => {
      if (item.criterion === "[Q] Code quality") {
        return { ...item, status: "passed", ...(result.scores ? { score: result.scores.code_quality } : {}) }
      }
      if (item.criterion === "[Q] Error handling") {
        return { ...item, status: "passed", ...(result.scores ? { score: result.scores.error_handling } : {}) }
      }
      return { ...item, status: "passed" }
    })
  }

  const issueText = result.issues.join("; ") || result.reasoning
  return baseItems.map((item) => {
    if (item.criterion === "[Q] Code quality" && result.scores) {
      const passed = result.scores.code_quality >= 8
      return { ...item, status: passed ? "passed" : "failed", score: result.scores.code_quality, ...(!passed ? { evidence: issueText } : {}) }
    }
    if (item.criterion === "[Q] Error handling" && result.scores) {
      const passed = result.scores.error_handling >= 8
      return { ...item, status: passed ? "passed" : "failed", score: result.scores.error_handling, ...(!passed ? { evidence: issueText } : {}) }
    }
    return { ...item, status: "unknown", evidence: issueText }
  })
}

export function summarizePriorReviewAttempts(attempts: readonly ReviewAttempt[], subject: string): string | null {
  const relevant = attempts.filter((attempt) => attempt.subject === subject).slice(0, 3)
  if (relevant.length === 0) return null
  const lines = ["## Prior Review Attempts", "", "Use this runtime-backed history to avoid repeating completed reviewer work. Focus retries on failed, timed-out, pending, or unknown rubric items."]
  for (const attempt of relevant) {
    const openItems = attempt.rubricItems.filter((item) => item.status !== "passed")
    lines.push("")
    lines.push(`- Attempt ${attempt.id}: ${attempt.status}${attempt.error ? ` — ${attempt.error}` : ""}`)
    if (openItems.length > 0) {
      lines.push(`  Remaining/unknown rubric items: ${openItems.map((item) => item.criterion).join(", ")}`)
    } else {
      lines.push("  All rubric items were marked passed.")
    }
  }
  return lines.join("\n")
}

export function rubricItemsFromPhaseCriteria(criteria: Array<{ criterion: string; met: boolean; evidence: string; score?: string | number }>): ReviewRubricItem[] {
  return criteria.map((criterion) => ({
    criterion: criterion.criterion,
    status: criterion.met ? "passed" : "failed",
    evidence: criterion.evidence,
    ...(criterion.score !== undefined ? { score: typeof criterion.score === "number" ? criterion.score : Number(criterion.score) } : {}),
  }))
}
