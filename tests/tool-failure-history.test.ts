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
