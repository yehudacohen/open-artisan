import { describe, expect, it } from "bun:test"

import {
  buildTaskReviewRubricItems,
  completeReviewAttempt,
  createReviewAttempt,
  recordReviewRubricItemProgress,
  rubricItemsFromTaskReviewResult,
  summarizePriorReviewAttempts,
  upsertReviewAttempt,
} from "#core/tools/review-attempts"
import { makeWorkflowState } from "./helpers/workflow-state"

describe("review attempts", () => {
  it("records task reviewer timeout attempts with rubric items", () => {
    const state = makeWorkflowState()
    const rubricItems = buildTaskReviewRubricItems(true)
    const attempt = createReviewAttempt({ kind: "task", subject: "T2", rubricItems, startedAt: 1 })
    const completed = completeReviewAttempt({
      attempt,
      status: "timed-out",
      rubricItems: rubricItemsFromTaskReviewResult({ success: false, error: "task-review timed out after 180000ms" }, rubricItems),
      error: "task-review timed out after 180000ms",
      completedAt: 2,
    })

    upsertReviewAttempt(state, completed)

    expect(state.reviewAttempts).toHaveLength(1)
    expect(state.reviewAttempts[0]?.status).toBe("timed-out")
    expect(state.reviewAttempts[0]?.rubricItems.length).toBeGreaterThan(9)
    expect(state.reviewAttempts[0]?.rubricItems.every((item) => item.status === "unknown")).toBe(true)
  })

  it("summarizes prior attempts so retries can focus on unpassed rubric items", () => {
    const rubricItems = buildTaskReviewRubricItems(false)
    const attempt = completeReviewAttempt({
      attempt: createReviewAttempt({ kind: "task", subject: "T2", rubricItems, startedAt: 1 }),
      status: "failed",
      rubricItems: rubricItems.map((item, index) => ({ ...item, status: index === 0 ? "passed" : "unknown" })),
      completedAt: 2,
    })

    const summary = summarizePriorReviewAttempts([attempt], "T2")

    expect(summary).toContain("Prior Review Attempts")
    expect(summary).toContain("Remaining/unknown rubric items")
    expect(summary).not.toContain("Run the tests, Verify")
  })

  it("preserves incrementally passed rubric items when a reviewer times out", () => {
    const state = makeWorkflowState()
    const rubricItems = buildTaskReviewRubricItems(false)
    const attempt = createReviewAttempt({ kind: "task", subject: "T2", rubricItems, startedAt: 1 })
    upsertReviewAttempt(state, attempt)

    recordReviewRubricItemProgress(state, {
      kind: "task",
      subject: "T2",
      attemptId: attempt.id,
      rubricItems,
      rubricItem: {
        criterion: "Run the tests",
        status: "passed",
        evidence: "bun run verify:release passed",
      },
    })

    const persisted = state.reviewAttempts[0] ?? attempt
    const completed = completeReviewAttempt({
      attempt: persisted,
      status: "timed-out",
      rubricItems: rubricItemsFromTaskReviewResult({ success: false, error: "task-review timed out after 180000ms" }, rubricItems),
      error: "task-review timed out after 180000ms",
      completedAt: 2,
    })

    expect(completed.rubricItems.find((item) => item.criterion === "Run the tests")?.status).toBe("passed")
    expect(completed.rubricItems.find((item) => item.criterion === "Verify interface alignment")?.status).toBe("unknown")
  })
})
