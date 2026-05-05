/**
 * Tests for orchestrator/llm-calls.ts — createAssessFn and createDivergeFn.
 * The OpenCode client is mocked so no real LLM calls are made.
 */
import { describe, expect, it, mock } from "bun:test"
import { createAssessFn, createDivergeFn } from "#core/orchestrator/llm-calls"
import type { OrchestratorAssessResult } from "#core/orchestrator-types"
import type { SubagentDispatcher } from "#core/subagent-dispatcher"

// ---------------------------------------------------------------------------
// Mock dispatcher factory
// ---------------------------------------------------------------------------

function makeDispatcher(responseText: string): SubagentDispatcher & { _createMock: ReturnType<typeof mock>; _promptMock: ReturnType<typeof mock>; _destroyMock: ReturnType<typeof mock> } {
  const promptMock = mock(async () => responseText)
  const destroyMock = mock(async () => {})
  const createMock = mock(async () => ({
    id: "mock-session-id",
    prompt: promptMock,
    destroy: destroyMock,
  }))
  return {
    createSession: createMock,
    _createMock: createMock,
    _promptMock: promptMock,
    _destroyMock: destroyMock,
  }
}

function makeDispatcherThrows(): SubagentDispatcher & { _destroyMock: ReturnType<typeof mock> } {
  const destroyMock = mock(async () => {})
  return {
    createSession: mock(async () => ({
      id: "mock-session-id",
      prompt: mock(async () => { throw new Error("Network error") }),
      destroy: destroyMock,
    })),
    _destroyMock: destroyMock,
  }
}

// ---------------------------------------------------------------------------
// createAssessFn — happy path
// ---------------------------------------------------------------------------

describe("createAssessFn — happy path", () => {
  it("returns success with parsed root cause and affected artifacts", async () => {
    const response = JSON.stringify({
      affected_artifacts: ["interfaces", "tests", "impl_plan"],
      root_cause_artifact: "interfaces",
      reasoning: "The feedback targets the interface definitions",
    })
    const dispatcher = makeDispatcher(response)
    const assess = createAssessFn(dispatcher)

    const result = await assess("The interface is missing error types", "interfaces")

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.rootCauseArtifact).toBe("interfaces")
    expect(result.affectedArtifacts).toContain("interfaces")
    expect(result.affectedArtifacts).toContain("tests")
    expect(result.reasoning).toContain("interface")
  })

  it("calls session.prompt once", async () => {
    const dispatcher = makeDispatcher(JSON.stringify({
      affected_artifacts: ["plan"],
      root_cause_artifact: "plan",
      reasoning: "Plan issue",
    }))
    const assess = createAssessFn(dispatcher)
    await assess("The plan is missing a requirement", "plan")
    expect(dispatcher._promptMock.mock.calls).toHaveLength(1)
  })

  it("uses ephemeral session: create() and delete() are called once per assess call", async () => {
    const dispatcher = makeDispatcher(JSON.stringify({
      affected_artifacts: ["tests"],
      root_cause_artifact: "tests",
      reasoning: "Tests issue",
    }))
    const assess = createAssessFn(dispatcher)
    await assess("Tests are missing edge cases", "tests")
    expect(dispatcher._createMock.mock.calls).toHaveLength(1)
    expect(dispatcher._destroyMock.mock.calls).toHaveLength(1)
  })

  it("passes session id from create() into prompt() path.id param (v1 SDK style)", async () => {
    const dispatcher = makeDispatcher(JSON.stringify({
      affected_artifacts: ["impl_plan"],
      root_cause_artifact: "impl_plan",
      reasoning: "impl plan issue",
    }))
    const assess = createAssessFn(dispatcher)
    await assess("Impl plan is wrong", "impl_plan")
    // prompt() now receives a plain string (not SDK envelope)
    const promptText = dispatcher._promptMock.mock.calls[0]?.[0] as string
    expect(typeof promptText).toBe("string")
    expect(promptText.length).toBeGreaterThan(0)
  })

  it("inlines system prompt into the prompt text", async () => {
    const dispatcher = makeDispatcher(JSON.stringify({
      affected_artifacts: ["plan"],
      root_cause_artifact: "plan",
      reasoning: "plan issue",
    }))
    const assess = createAssessFn(dispatcher)
    await assess("Plan is wrong", "plan")
    const promptText = dispatcher._promptMock.mock.calls[0]?.[0] as string
    // System prompt should be inlined into the prompt text
    expect(promptText).toContain("workflow orchestrator")
    // User feedback should also be in the prompt
    expect(promptText).toContain("Plan is wrong")
  })

  it("filters out invalid artifact keys from affected_artifacts", async () => {
    const response = JSON.stringify({
      affected_artifacts: ["interfaces", "INVALID_KEY", "tests"],
      root_cause_artifact: "interfaces",
      reasoning: "Interface issue",
    })
    const assess = createAssessFn(makeDispatcher(response))
    const result = await assess("Interface is wrong", "interfaces")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.affectedArtifacts).not.toContain("INVALID_KEY")
    expect(result.affectedArtifacts).toContain("interfaces")
  })
})

// ---------------------------------------------------------------------------
// createAssessFn — error handling
// ---------------------------------------------------------------------------

describe("createAssessFn — error handling", () => {
  it("returns error result when LLM returns invalid root_cause_artifact", async () => {
    const response = JSON.stringify({
      affected_artifacts: ["interfaces"],
      root_cause_artifact: "NOT_A_VALID_KEY",
      reasoning: "Some issue",
    })
    const assess = createAssessFn(makeDispatcher(response))
    const result = await assess("Some feedback", "interfaces")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.fallbackArtifact).toBe("interfaces")
  })

  it("returns error result when client throws", async () => {
    const assess = createAssessFn(makeDispatcherThrows())
    const result = await assess("Some feedback", "tests")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.fallbackArtifact).toBe("tests")
    expect(result.error).toContain("Network error")
  })

  it("returns error result when LLM returns invalid JSON", async () => {
    const assess = createAssessFn(makeDispatcher("not valid json {{"))
    const result = await assess("Some feedback", "plan")
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createDivergeFn — happy path
// ---------------------------------------------------------------------------

describe("createDivergeFn — happy path", () => {
  it("returns tactical classification from LLM", async () => {
    const response = JSON.stringify({
      classification: "tactical",
      reasoning: "Small targeted change",
    })
    const diverge = createDivergeFn(makeDispatcher(response))
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["tests"],
      rootCauseArtifact: "tests",
      reasoning: "Test missing",
    }
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.classification).toBe("tactical")
  })

  it("returns strategic classification from LLM", async () => {
    const response = JSON.stringify({
      classification: "strategic",
      trigger_criterion: "scope_expansion",
      reasoning: "Adds new microservice not in plan",
    })
    const diverge = createDivergeFn(makeDispatcher(response))
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["plan", "interfaces"],
      rootCauseArtifact: "plan",
      reasoning: "Plan changed",
    }
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.classification).toBe("strategic")
  })

  it("uses ephemeral session: create() and delete() are called once per diverge call", async () => {
    const dispatcher = makeDispatcher(JSON.stringify({
      classification: "tactical",
      reasoning: "Small change",
    }))
    const diverge = createDivergeFn(dispatcher)
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["tests"],
      rootCauseArtifact: "tests",
      reasoning: "test",
    }
    await diverge(assessResult, {})
    expect(dispatcher._createMock.mock.calls).toHaveLength(1)
    expect(dispatcher._destroyMock.mock.calls).toHaveLength(1)
  })

  it("auto-classifies as strategic when 3+ APPROVED artifacts affected (cascade_depth)", async () => {
    // LLM says tactical, but we have 3 materially affected (approved) artifacts → must be strategic
    const response = JSON.stringify({
      classification: "tactical",
      reasoning: "Seems small",
    })
    const diverge = createDivergeFn(makeDispatcher(response))
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["interfaces", "tests", "impl_plan"], // 3 artifacts
      rootCauseArtifact: "interfaces",
      reasoning: "Cascade",
    }
    // All 3 artifacts are approved → cascade_depth triggers
    const result = await diverge(assessResult, {
      interfaces: "/path/to/interfaces.ts",
      tests: "/path/to/tests.ts",
      impl_plan: "/path/to/impl_plan.md",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.classification).toBe("strategic")
  })

  it("does NOT trigger cascade_depth when affected artifacts are unwritten (not approved)", async () => {
    // LLM reports 4 affected artifacts, but only 1 (interfaces) is approved.
    // Unwritten downstream artifacts shouldn't count toward cascade depth.
    const response = JSON.stringify({
      classification: "tactical",
      reasoning: "Just interface fixes",
    })
    const diverge = createDivergeFn(makeDispatcher(response))
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["interfaces", "tests", "impl_plan", "implementation"], // 4 artifacts
      rootCauseArtifact: "interfaces",
      reasoning: "Interface changes cascade",
    }
    // Only interfaces is approved — tests/impl_plan/implementation don't exist yet
    const result = await diverge(assessResult, {
      interfaces: "/path/to/interfaces.ts",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    // Should be tactical — only 1 materially affected artifact
    expect(result.classification).toBe("tactical")
  })
})

// ---------------------------------------------------------------------------
// createDivergeFn — error handling
// ---------------------------------------------------------------------------

describe("createDivergeFn — error handling", () => {
  it("returns error when assess failed", async () => {
    const diverge = createDivergeFn(makeDispatcher("{}"))
    const failedAssess: OrchestratorAssessResult = {
      success: false,
      error: "LLM timed out",
      fallbackArtifact: "interfaces",
    }
    const result = await diverge(failedAssess, {})
    expect(result.success).toBe(false)
  })

  it("returns error result when client throws", async () => {
    const diverge = createDivergeFn(makeDispatcherThrows())
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["tests"],
      rootCauseArtifact: "tests",
      reasoning: "Test issue",
    }
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.fallback).toBe("tactical")
  })
})
