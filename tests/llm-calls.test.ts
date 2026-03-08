/**
 * Tests for orchestrator/llm-calls.ts — createAssessFn and createDivergeFn.
 * The OpenCode client is mocked so no real LLM calls are made.
 */
import { describe, expect, it, mock } from "bun:test"
import { createAssessFn, createDivergeFn } from "#plugin/orchestrator/llm-calls"
import type { OrchestratorAssessResult } from "#plugin/types"

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

/**
 * The llm-calls module now uses ephemeralPrompt() which calls:
 *   client.session.create({ body: { ... } }) → { id: "mock-session-id" }
 *   client.session.prompt({ path: { id }, body: { ... } }) → { parts: [...] }
 *   client.session.delete({ path: { id } })  [best-effort, errors ignored]
 */
function makeClient(responseText: string) {
  return {
    session: {
      create: mock(async () => ({ id: "mock-session-id" })),
      prompt: mock(async () => ({
        parts: [{ type: "text", text: responseText }],
      })),
      delete: mock(async () => undefined),
    },
  }
}

function makeClientThrows() {
  return {
    session: {
      create: mock(async () => ({ id: "mock-session-id" })),
      prompt: mock(async () => {
        throw new Error("Network error")
      }),
      delete: mock(async () => undefined),
    },
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
    const client = makeClient(response)
    const assess = createAssessFn(client)

    const result = await assess("The interface is missing error types", "interfaces")

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.rootCauseArtifact).toBe("interfaces")
    expect(result.affectedArtifacts).toContain("interfaces")
    expect(result.affectedArtifacts).toContain("tests")
    expect(result.reasoning).toContain("interface")
  })

  it("calls client.session.prompt once", async () => {
    const client = makeClient(JSON.stringify({
      affected_artifacts: ["plan"],
      root_cause_artifact: "plan",
      reasoning: "Plan issue",
    }))
    const assess = createAssessFn(client)
    await assess("The plan is missing a requirement", "plan")
    expect((client.session.prompt as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  it("uses ephemeral session: create() and delete() are called once per assess call", async () => {
    const client = makeClient(JSON.stringify({
      affected_artifacts: ["tests"],
      root_cause_artifact: "tests",
      reasoning: "Tests issue",
    }))
    const assess = createAssessFn(client)
    await assess("Tests are missing edge cases", "tests")
    expect((client.session.create as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
    expect((client.session.delete as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  it("passes session id from create() into prompt() path param", async () => {
    const client = makeClient(JSON.stringify({
      affected_artifacts: ["impl_plan"],
      root_cause_artifact: "impl_plan",
      reasoning: "impl plan issue",
    }))
    const assess = createAssessFn(client)
    await assess("Impl plan is wrong", "impl_plan")
    const promptCall = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    // First arg to prompt() must have path: { id: "mock-session-id" }
    expect((promptCall?.[0] as any)?.path?.id).toBe("mock-session-id")
  })

  it("filters out invalid artifact keys from affected_artifacts", async () => {
    const response = JSON.stringify({
      affected_artifacts: ["interfaces", "INVALID_KEY", "tests"],
      root_cause_artifact: "interfaces",
      reasoning: "Interface issue",
    })
    const assess = createAssessFn(makeClient(response))
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
    const assess = createAssessFn(makeClient(response))
    const result = await assess("Some feedback", "interfaces")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.fallbackArtifact).toBe("interfaces")
  })

  it("returns error result when client throws", async () => {
    const assess = createAssessFn(makeClientThrows())
    const result = await assess("Some feedback", "tests")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.fallbackArtifact).toBe("tests")
    expect(result.error).toContain("Network error")
  })

  it("returns error result when LLM returns invalid JSON", async () => {
    const assess = createAssessFn(makeClient("not valid json {{"))
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
    const diverge = createDivergeFn(makeClient(response))
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
    const diverge = createDivergeFn(makeClient(response))
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
    const client = makeClient(JSON.stringify({
      classification: "tactical",
      reasoning: "Small change",
    }))
    const diverge = createDivergeFn(client)
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["tests"],
      rootCauseArtifact: "tests",
      reasoning: "test",
    }
    await diverge(assessResult, {})
    expect((client.session.create as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
    expect((client.session.delete as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  it("auto-classifies as strategic when 3+ artifacts affected (cascade_depth), regardless of LLM response", async () => {
    // LLM says tactical, but we have 3 affected artifacts → must be strategic
    const response = JSON.stringify({
      classification: "tactical",
      reasoning: "Seems small",
    })
    const diverge = createDivergeFn(makeClient(response))
    const assessResult: OrchestratorAssessResult = {
      success: true,
      affectedArtifacts: ["interfaces", "tests", "impl_plan"], // 3 artifacts
      rootCauseArtifact: "interfaces",
      reasoning: "Cascade",
    }
    const result = await diverge(assessResult, {})
    expect(result.success).toBe(true)
    if (!result.success) return
    // Must be strategic due to cascade_depth override
    expect(result.classification).toBe("strategic")
  })
})

// ---------------------------------------------------------------------------
// createDivergeFn — error handling
// ---------------------------------------------------------------------------

describe("createDivergeFn — error handling", () => {
  it("returns fallback to tactical when assess failed", async () => {
    const diverge = createDivergeFn(makeClient("{}"))
    const failedAssess: OrchestratorAssessResult = {
      success: false,
      error: "LLM timed out",
      fallbackArtifact: "interfaces",
    }
    const result = await diverge(failedAssess, {})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.classification).toBe("tactical")
  })

  it("returns error result when client throws", async () => {
    const diverge = createDivergeFn(makeClientThrows())
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
