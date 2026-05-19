import { describe, expect, it } from "bun:test"

import { buildIncidentSummary, recordToolFailure, sanitizeFailureMessage } from "#core/tool-failure-history"
import { makeWorkflowState } from "./helpers/workflow-state"

describe("tool failure history", () => {
  it("fingerprints duplicate reviewer infrastructure failures and summarizes them", () => {
    const state = makeWorkflowState({
      phase: "IMPLEMENTATION",
      phaseState: "TASK_REVISE",
      currentTaskId: "T7",
    })

    const first = recordToolFailure(state, {
      category: "reviewer-infrastructure",
      toolName: "mark_task_complete",
      taskId: "T7",
      message: "Cannot extract text from reviewer result ids=msg_abc original={ token: 123 }",
      now: 1,
    })
    const second = recordToolFailure(state, {
      category: "reviewer-infrastructure",
      toolName: "mark_task_complete",
      taskId: "T7",
      message: "Cannot extract text from reviewer result ids=msg_def original={ token: 456 }",
      now: 2,
    })

    expect(first.fingerprint).toBe(second.fingerprint)
    expect(second.count).toBe(2)
    expect(buildIncidentSummary(state)).toContain("Repeated tool failures: 1")
  })

  it("surfaces repeated mark_satisfied failures as review-gate runtime defects", () => {
    const state = makeWorkflowState({ phase: "DISCOVERY", phaseState: "REVIEW" })
    const message = "Only 1 blocking criteria submitted, but this phase requires 14."

    recordToolFailure(state, { category: "tooling", toolName: "mark_satisfied", message, now: 1 })
    recordToolFailure(state, { category: "tooling", toolName: "mark_satisfied", message, now: 2 })

    const summary = buildIncidentSummary(state)
    expect(summary).toContain("Runtime State Explainer")
    expect(summary).toContain("Repeated tool failures: 1")
    expect(summary).toContain("Repeated mark_satisfied failures are review-gate/runtime defects")
    expect(summary).toContain("Last failure: mark_satisfied x2")
  })

  it("includes review attempts and open rubric items in incident summaries", () => {
    const state = makeWorkflowState({
      reviewAttempts: [{
        id: "attempt1",
        kind: "task",
        subject: "T2",
        status: "timed-out",
        rubricItems: [{ criterion: "Run the tests", status: "unknown" }],
        error: "task-review timed out after 180000ms",
        startedAt: 1,
        completedAt: 2,
      }],
    })

    const summary = buildIncidentSummary(state)

    expect(summary).toContain("Review Attempts")
    expect(summary).toContain("task/T2 timed-out")
    expect(summary).toContain("Run the tests:unknown")
  })

  it("redacts volatile IDs, hashes, timestamps, and payload objects from incident summaries", () => {
    const state = makeWorkflowState({
      phase: "IMPLEMENTATION",
      phaseState: "TASK_REVISE",
      currentTaskId: "T7",
    })
    const message = "Failure at 2026-05-01T00:00:00.000Z ids=msg_secret original={ token: 123 } history={ session: sess_secret } hash=abcdef1234567890abcdef"

    recordToolFailure(state, {
      category: "reviewer-infrastructure",
      toolName: "mark_task_complete",
      taskId: "T7",
      message,
      now: 1,
    })

    const sanitized = sanitizeFailureMessage(message)
    const summary = buildIncidentSummary(state)
    expect(sanitized).toContain("<timestamp>")
    expect(summary).not.toContain("msg_secret")
    expect(summary).not.toContain("sess_secret")
    expect(summary).not.toContain("abcdef1234567890abcdef")
    expect(summary).not.toContain("token: 123")
    expect(summary).not.toContain("2026-05-01T00:00:00.000Z")
  })
})
