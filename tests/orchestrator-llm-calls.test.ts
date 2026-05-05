/**
 * Tests for orchestrator/llm-calls.ts — LLM-backed assess and diverge functions.
 *
 * Covers:
 * - createAssessFn: success path, error handling, session lifecycle
 * - createDivergeFn: tactical/strategic/backtrack classification, cascade_depth hard rule
 * - parentModel propagation
 * - ephemeralPrompt: session create/prompt/delete lifecycle
 */
import { describe, expect, it, mock } from "bun:test"
import { createAssessFn, createDivergeFn } from "#core/orchestrator/llm-calls"
import type { OrchestratorAssessResult } from "#core/orchestrator-types"
import type { SubagentDispatcher } from "#core/subagent-dispatcher"

// ---------------------------------------------------------------------------
// Mock dispatcher factory
// ---------------------------------------------------------------------------

function makeDispatcher(overrides?: {
  promptText?: string
  createThrows?: boolean
  promptThrows?: boolean
}): SubagentDispatcher & { _createMock: ReturnType<typeof mock>; _destroyMock: ReturnType<typeof mock> } {
  const defaultText = overrides?.promptText ?? JSON.stringify({
    affected_artifacts: ["plan"],
    root_cause_artifact: "plan",
    reasoning: "The feedback targets the plan",
  })
  const destroyMock = mock(async () => {})
  const createMock = overrides?.createThrows
    ? mock(async () => { throw new Error("create failed") })
    : mock(async () => ({
        id: "mock-orch-session",
        prompt: overrides?.promptThrows
          ? mock(async () => { throw new Error("prompt failed") })
          : mock(async () => defaultText),
        destroy: destroyMock,
      }))
  return {
    createSession: createMock,
    _createMock: createMock,
    _destroyMock: destroyMock,
  }
}

// ---------------------------------------------------------------------------
// createAssessFn
// ---------------------------------------------------------------------------

describe("createAssessFn — success path", () => {
  it("returns assess result with rootCauseArtifact and affectedArtifacts", async () => {
    const dispatcher = makeDispatcher()
    const assess = createAssessFn(dispatcher)
    const result = await assess("Fix the plan", "plan")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.rootCauseArtifact).toBe("plan")
    expect(result.affectedArtifacts).toContain("plan")
  })

  it("creates ephemeral session with agent=workflow-orchestrator", async () => {
    const dispatcher = makeDispatcher()
    const assess = createAssessFn(dispatcher)
    await assess("Fix the plan", "plan")
    const createCall = dispatcher._createMock.mock.calls[0]
    expect((createCall as any)?.[0]?.agent).toBe("workflow-orchestrator")
  })

  it("deletes session after completion", async () => {
    const dispatcher = makeDispatcher()
    const assess = createAssessFn(dispatcher)
    await assess("Fix the plan", "plan")
    expect(dispatcher._destroyMock).toHaveBeenCalledTimes(1)
  })

  it("passes parentModel from getter to session create", async () => {
    const dispatcher = makeDispatcher()
    const assess = createAssessFn(
      dispatcher,
      () => "parent-session-123",
      () => ({ modelID: "claude-3", providerID: "anthropic" }),
    )
    await assess("Fix the plan", "plan")
    const createCall = dispatcher._createMock.mock.calls[0]
    const opts = (createCall as any)?.[0]
    expect(opts?.model).toEqual({ modelID: "claude-3", providerID: "anthropic" })
    expect(opts?.parentId).toBe("parent-session-123")
  })
})

describe("createAssessFn — error handling", () => {
  it("returns error when session create throws", async () => {
    const dispatcher = makeDispatcher({ createThrows: true })
    const assess = createAssessFn(dispatcher)
    const result = await assess("Fix the plan", "plan")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.fallbackArtifact).toBe("plan")
  })

  it("returns error when prompt throws", async () => {
    const dispatcher = makeDispatcher({ promptThrows: true })
    const assess = createAssessFn(dispatcher)
    const result = await assess("Fix the plan", "plan")
    expect(result.success).toBe(false)
  })

  it("returns error when response is not valid JSON", async () => {
    const dispatcher = makeDispatcher({ promptText: "not json at all" })
    const assess = createAssessFn(dispatcher)
    const result = await assess("Fix the plan", "plan")
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createDivergeFn
// ---------------------------------------------------------------------------

describe("createDivergeFn — classification", () => {
  it("returns tactical classification", async () => {
    const dispatcher = makeDispatcher({
      promptText: JSON.stringify({
        classification: "tactical",
        trigger_criterion: null,
        reasoning: "Small change",
      }),
    })
    const diverge = createDivergeFn(dispatcher)
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["plan"],
      rootCauseArtifact: "plan",
      reasoning: "test",
    }
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.classification).toBe("tactical")
  })

  it("returns backtrack classification", async () => {
    const dispatcher = makeDispatcher({
      promptText: JSON.stringify({
        classification: "backtrack",
        trigger_criterion: "upstream_root_cause",
        reasoning: "Need to revise upstream plan",
      }),
    })
    const diverge = createDivergeFn(dispatcher)
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["plan"],
      rootCauseArtifact: "plan",
      reasoning: "test",
    }
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.classification).toBe("backtrack")
  })

  it("forces strategic when 3+ materially affected artifacts", async () => {
    const dispatcher = makeDispatcher({
      promptText: JSON.stringify({
        classification: "tactical",
        trigger_criterion: null,
        reasoning: "Small change",
      }),
    })
    const diverge = createDivergeFn(dispatcher)
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["plan", "interfaces", "tests"],
      rootCauseArtifact: "plan",
      reasoning: "test",
    }
    // All 3 artifacts are "materially affected" (approved or root cause)
    const result = await diverge(assessResult, { plan: "hash1", interfaces: "hash2", tests: "hash3" })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.classification).toBe("strategic")
  })

  it("returns error when assess failed", async () => {
    const dispatcher = makeDispatcher()
    const diverge = createDivergeFn(dispatcher)
    const assessResult: OrchestratorAssessResult = {
      success: false,
      error: "assess failed",
      fallbackArtifact: "plan",
    }
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(false)
  })
})

describe("createDivergeFn — error handling", () => {
  it("returns error when session create throws", async () => {
    const dispatcher = makeDispatcher({ createThrows: true })
    const diverge = createDivergeFn(dispatcher)
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["plan"],
      rootCauseArtifact: "plan",
      reasoning: "test",
    }
    // Should not throw — returns error result
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(false)
  })
})
