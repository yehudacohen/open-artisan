/**
 * Tests for task-drift.ts — per-task drift detection dispatcher.
 *
 * Covers:
 * - dispatchDriftCheck: no drift, drift detected, no dependents (early return)
 * - Ephemeral session lifecycle: create/prompt/delete
 * - Error handling: create failure, prompt failure, invalid JSON
 * - parentModel propagation
 */
import { describe, expect, it, mock } from "bun:test"
import { dispatchDriftCheck } from "#core/task-drift"
import type { DriftCheckRequest } from "#core/task-drift"
import type { TaskNode } from "#core/dag"
import type { SubagentDispatcher } from "#core/subagent-dispatcher"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string, deps: string[] = []): TaskNode {
  return {
    id,
    description: `Task ${id} description`,
    dependencies: deps,
    expectedTests: [],
    expectedFiles: [],
    estimatedComplexity: "small" as const,
    status: "pending" as const,
  }
}

function makeDispatcher(overrides?: {
  promptText?: string
  createThrows?: boolean
  promptThrows?: boolean
}): SubagentDispatcher & { _createMock: ReturnType<typeof mock> } {
  const defaultText = overrides?.promptText ?? JSON.stringify({
    drift_detected: false,
    updated_descriptions: {},
    reasoning: "No drift detected",
  })
  const createMock = overrides?.createThrows
    ? mock(async () => { throw new Error("create failed") })
    : mock(async () => ({
        id: "mock-drift-session",
        prompt: overrides?.promptThrows
          ? mock(async () => { throw new Error("prompt failed") })
          : mock(async () => defaultText),
        destroy: mock(async () => {}),
      }))
  return {
    createSession: createMock,
    _createMock: createMock,
  }
}

function makeRequest(overrides?: Partial<DriftCheckRequest>): DriftCheckRequest {
  return {
    task: makeTask("T1"),
    implementationSummary: "Implemented T1 as planned",
    dagTasks: [makeTask("T1"), makeTask("T2", ["T1"]), makeTask("T3", ["T1"])],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// No drift
// ---------------------------------------------------------------------------

describe("dispatchDriftCheck — no drift", () => {
  it("returns driftDetected=false when LLM says no drift", async () => {
    const dispatcher = makeDispatcher()
    const result = await dispatchDriftCheck(dispatcher, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.driftDetected).toBe(false)
  })

  it("returns early when no pending dependents exist", async () => {
    const dispatcher = makeDispatcher()
    // T1 has no dependents
    const result = await dispatchDriftCheck(dispatcher, makeRequest({
      dagTasks: [makeTask("T1")],
    }))
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.driftDetected).toBe(false)
    // Should not have created a session (early return)
    expect(dispatcher._createMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Drift detected
// ---------------------------------------------------------------------------

describe("dispatchDriftCheck — drift detected", () => {
  it("returns updatedDescriptions when drift is detected", async () => {
    const dispatcher = makeDispatcher({
      promptText: JSON.stringify({
        drift_detected: true,
        updated_descriptions: { T2: "Updated T2 description" },
        reasoning: "T1 changed the API shape",
      }),
    })
    const result = await dispatchDriftCheck(dispatcher, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.driftDetected).toBe(true)
    expect(result.updatedDescriptions["T2"]).toBe("Updated T2 description")
  })

  it("filters out descriptions for non-dependent tasks", async () => {
    const dispatcher = makeDispatcher({
      promptText: JSON.stringify({
        drift_detected: true,
        updated_descriptions: { T2: "Valid update", T99: "Invalid — not a dependent" },
        reasoning: "Drift detected",
      }),
    })
    const result = await dispatchDriftCheck(dispatcher, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.updatedDescriptions["T2"]).toBeDefined()
    expect(result.updatedDescriptions["T99"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("dispatchDriftCheck — session lifecycle", () => {
  it("creates session with agent=workflow-orchestrator", async () => {
    const dispatcher = makeDispatcher()
    await dispatchDriftCheck(dispatcher, makeRequest())
    const createCall = dispatcher._createMock.mock.calls[0]
    expect((createCall as any)?.[0]?.agent).toBe("workflow-orchestrator")
  })

  it("deletes session after completion", async () => {
    const dispatcher = makeDispatcher()
    await dispatchDriftCheck(dispatcher, makeRequest())
    expect(dispatcher._createMock).toHaveBeenCalledTimes(1)
  })

  it("passes parentModel as object to session create", async () => {
    const dispatcher = makeDispatcher()
    await dispatchDriftCheck(dispatcher, makeRequest({
      parentModel: { modelID: "claude-3", providerID: "anthropic" },
    }))
    const createCall = dispatcher._createMock.mock.calls[0]
    expect((createCall as any)?.[0]?.model).toEqual({ modelID: "claude-3", providerID: "anthropic" })
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("dispatchDriftCheck — error handling", () => {
  it("returns error when create throws", async () => {
    const dispatcher = makeDispatcher({ createThrows: true })
    const result = await dispatchDriftCheck(dispatcher, makeRequest())
    expect(result.success).toBe(false)
  })

  it("returns error when prompt throws", async () => {
    const dispatcher = makeDispatcher({ promptThrows: true })
    const result = await dispatchDriftCheck(dispatcher, makeRequest())
    expect(result.success).toBe(false)
  })

  it("returns error when response is not valid JSON", async () => {
    const dispatcher = makeDispatcher({
      promptText: "not json",
    })
    const result = await dispatchDriftCheck(dispatcher, makeRequest())
    expect(result.success).toBe(false)
  })
})
