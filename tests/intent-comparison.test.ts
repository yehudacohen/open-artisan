/**
 * Tests for intent-comparison.ts — LLM-based intent matching.
 *
 * Covers:
 * - compareIntentsWithLLM: FULL, PARTIAL, DIFFERENT, ERROR classifications
 * - Session lifecycle: create/prompt/delete
 * - Error handling: create failure, no session API, empty response
 * - parentModel propagation (string + object forms)
 */
import { describe, expect, it, mock } from "bun:test"
import { compareIntentsWithLLM } from "#core/intent-comparison"
import type { IntentComparisonInput } from "#core/intent-comparison"
import type { SubagentDispatcher } from "#core/subagent-dispatcher"

// ---------------------------------------------------------------------------
// Mock dispatcher factory
// ---------------------------------------------------------------------------

function makeDispatcher(overrides?: {
  promptText?: string
  createThrows?: boolean
  promptThrows?: boolean
}): SubagentDispatcher & { _createMock: ReturnType<typeof mock> } {
  const defaultText = overrides?.promptText ?? "FULL: Prior workflow covers everything"
  const createMock = overrides?.createThrows
    ? mock(async () => { throw new Error("create failed") })
    : mock(async () => ({
        id: "mock-intent-session",
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

function makeInput(overrides?: Partial<IntentComparisonInput>): IntentComparisonInput {
  return {
    currentIntent: "Build a REST API for user management",
    priorIntent: "Build a REST API for user management",
    dispatcher: makeDispatcher(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Classification results
// ---------------------------------------------------------------------------

describe("compareIntentsWithLLM — classifications", () => {
  it("returns FULL when LLM says FULL", async () => {
    const dispatcher = makeDispatcher({ promptText: "FULL: Prior workflow covers everything" })
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(result.classification).toBe("FULL")
    expect(result.explanation).toContain("covers everything")
  })

  it("returns PARTIAL when LLM says PARTIAL", async () => {
    const dispatcher = makeDispatcher({ promptText: "PARTIAL: Prior workflow only covers auth, not billing" })
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(result.classification).toBe("PARTIAL")
  })

  it("returns DIFFERENT when LLM says DIFFERENT", async () => {
    const dispatcher = makeDispatcher({ promptText: "DIFFERENT: One is about billing, the other about profiles" })
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(result.classification).toBe("DIFFERENT")
  })

  it("returns ERROR for unrecognized response format", async () => {
    const dispatcher = makeDispatcher({ promptText: "I'm not sure what to say here" })
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(result.classification).toBe("ERROR")
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("compareIntentsWithLLM — session lifecycle", () => {
  it("creates session with agent=workflow-reviewer", async () => {
    const dispatcher = makeDispatcher()
    await compareIntentsWithLLM(makeInput({ dispatcher }))
    const createCall = dispatcher._createMock.mock.calls[0]
    expect((createCall as any)?.[0]?.agent).toBe("workflow-reviewer")
  })

  it("deletes session after completion", async () => {
    const dispatcher = makeDispatcher()
    await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(dispatcher._createMock).toHaveBeenCalledTimes(1)
  })

  it("passes object parentModel to session create", async () => {
    const dispatcher = makeDispatcher()
    await compareIntentsWithLLM(makeInput({
      dispatcher,
      parentModel: { modelID: "claude-3", providerID: "anthropic" },
    }))
    const createCall = dispatcher._createMock.mock.calls[0]
    expect((createCall as any)?.[0]?.model).toEqual({ modelID: "claude-3", providerID: "anthropic" })
  })

  it("passes string parentModel through to createSession", async () => {
    const dispatcher = makeDispatcher()
    await compareIntentsWithLLM(makeInput({ dispatcher, parentModel: "gpt-4" }))
    const createCall = dispatcher._createMock.mock.calls[0]
    // String model is passed through as-is — the adapter (not the core) normalizes to { modelID }
    expect((createCall as any)?.[0]?.model).toBe("gpt-4")
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("compareIntentsWithLLM — error handling", () => {
  it("returns ERROR when session create throws", async () => {
    const dispatcher = makeDispatcher({ createThrows: true })
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(result.classification).toBe("ERROR")
  })

  it("returns ERROR when prompt throws", async () => {
    const dispatcher = makeDispatcher({ promptThrows: true })
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(result.classification).toBe("ERROR")
  })

  it("returns ERROR when prompt throws (includes timeout errors)", async () => {
    // withTimeout rejects with a timeout error — verify it's caught and classified
    const dispatcher: SubagentDispatcher = {
      createSession: mock(async () => ({
        id: "timeout-session",
        prompt: mock(async () => { throw new Error("intent-comparison timed out after 60000ms") }),
        destroy: mock(async () => {}),
      })),
    }
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(result.classification).toBe("ERROR")
    expect(result.rawResponse).toContain("timed out")
  })

  it("calls destroy even when prompt throws", async () => {
    const destroyMock = mock(async () => {})
    const dispatcher: SubagentDispatcher = {
      createSession: mock(async () => ({
        id: "error-session",
        prompt: mock(async () => { throw new Error("prompt failed") }),
        destroy: destroyMock,
      })),
    }
    await compareIntentsWithLLM(makeInput({ dispatcher }))
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })

  it("returns ERROR when response is empty", async () => {
    const dispatcher = makeDispatcher({ promptText: "" })
    const result = await compareIntentsWithLLM(makeInput({ dispatcher }))
    // Empty text → "ERROR: Empty response" → classified as ERROR
    expect(result.classification).toBe("ERROR")
  })
})
