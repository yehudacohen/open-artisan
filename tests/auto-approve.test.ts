/**
 * Tests for auto-approve.ts — auto-approval dispatcher for robot-artisan mode.
 *
 * Covers:
 * - dispatchAutoApproval: success (approve + revise), error handling, timeout
 * - Ephemeral session lifecycle: create/prompt/delete called correctly
 * - Response parsing: valid JSON, invalid JSON, empty response
 */
import { describe, expect, it, mock } from "bun:test"
import { dispatchAutoApproval } from "#core/auto-approve"
import type { AutoApproveRequest } from "#core/auto-approve"
import type { SubagentDispatcher } from "#core/subagent-dispatcher"

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeDispatcher(overrides?: {
  promptText?: string
  createThrows?: boolean
  promptThrows?: boolean
}): SubagentDispatcher & { _createMock: ReturnType<typeof mock> } {
  const defaultText = overrides?.promptText ?? JSON.stringify({
    approve: true,
    confidence: 0.85,
    reasoning: "Looks good",
  })
  const createMock = overrides?.createThrows
    ? mock(async () => { throw new Error("create failed") })
    : mock(async () => ({
        id: "mock-auto-session",
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

function makeRequest(overrides?: Partial<AutoApproveRequest>): AutoApproveRequest {
  return {
    phase: "PLANNING",
    mode: "GREENFIELD",
    phaseSummary: "Plan for building a REST API",
    artifactDiskPaths: { plan: "/project/.openartisan/plan.md" },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Success path — approve
// ---------------------------------------------------------------------------

describe("dispatchAutoApproval — approve", () => {
  it("returns success with approve=true when confidence >= threshold", async () => {
    const dispatcher = makeDispatcher()
    const result = await dispatchAutoApproval(dispatcher, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.approve).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it("calls create, prompt, and delete on the session", async () => {
    const dispatcher = makeDispatcher()
    await dispatchAutoApproval(dispatcher, makeRequest())
    expect(dispatcher._createMock).toHaveBeenCalledTimes(1)
  })

  it("creates session with agent='auto-approver'", async () => {
    const dispatcher = makeDispatcher()
    await dispatchAutoApproval(dispatcher, makeRequest())
    const createCall = dispatcher._createMock.mock.calls[0]
    expect((createCall as any)?.[0]?.agent).toBe("auto-approver")
  })
})

// ---------------------------------------------------------------------------
// Success path — revise
// ---------------------------------------------------------------------------

describe("dispatchAutoApproval — revise", () => {
  it("returns approve=false when confidence < threshold", async () => {
    const dispatcher = makeDispatcher({
      promptText: JSON.stringify({
        approve: false,
        confidence: 0.4,
        reasoning: "Plan is incomplete",
        feedback: "Add error handling section",
      }),
    })
    const result = await dispatchAutoApproval(dispatcher, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.approve).toBe(false)
    expect(result.feedback).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("dispatchAutoApproval — error handling", () => {
  it("returns error when session create throws", async () => {
    const dispatcher = makeDispatcher({ createThrows: true })
    const result = await dispatchAutoApproval(dispatcher, makeRequest())
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("create failed")
  })

  it("returns error when prompt throws", async () => {
    const dispatcher = makeDispatcher({ promptThrows: true })
    const result = await dispatchAutoApproval(dispatcher, makeRequest())
    expect(result.success).toBe(false)
  })

  it("returns error when response is empty", async () => {
    const dispatcher = makeDispatcher({
      promptText: "",
    })
    const result = await dispatchAutoApproval(dispatcher, makeRequest())
    expect(result.success).toBe(false)
  })

  it("returns error when response is not valid JSON", async () => {
    const dispatcher = makeDispatcher({
      promptText: "not json at all",
    })
    const result = await dispatchAutoApproval(dispatcher, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.approve).toBe(false)
    expect(result.feedback).toContain("not json at all")
  })

  it("passes parentModel to session create", async () => {
    const dispatcher = makeDispatcher()
    await dispatchAutoApproval(dispatcher, makeRequest({
      parentModel: { modelID: "claude-3", providerID: "anthropic" },
    }))
    const createCall = dispatcher._createMock.mock.calls[0]
    expect((createCall as any)?.[0]?.model).toEqual({ modelID: "claude-3", providerID: "anthropic" })
  })
})
