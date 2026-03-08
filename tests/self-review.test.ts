/**
 * Tests for self-review.ts — Layer 3 isolated subagent reviewer dispatcher.
 *
 * The OpenCode client is fully mocked. No real LLM calls are made.
 * Tests verify:
 * - Happy path: reviewer returns all criteria met → satisfied = true
 * - Blocking criterion fails → satisfied = false regardless of LLM's top-level satisfied field
 * - LLM inconsistency guard: LLM says satisfied=true but a blocking criterion has met=false
 * - Network error → SelfReviewError with error string
 * - Session cleanup: session.delete() is always called (even on prompt failure)
 * - extractText handles multiple response shapes (parts array, text field, content field)
 * - Severity defaults: unknown severity treated as "blocking"
 */
import { describe, expect, it, mock } from "bun:test"
import { dispatchSelfReview } from "#plugin/self-review"
import type { SelfReviewRequest } from "#plugin/self-review"

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeClient(responseText: string) {
  return {
    session: {
      create: mock(async () => ({ id: "mock-review-session" })),
      prompt: mock(async () => ({
        parts: [{ type: "text", text: responseText }],
      })),
      delete: mock(async () => undefined),
    },
  }
}

function makeClientWithTextShape(responseText: string) {
  return {
    session: {
      create: mock(async () => ({ id: "mock-review-session" })),
      prompt: mock(async () => ({ text: responseText })),
      delete: mock(async () => undefined),
    },
  }
}

function makeClientWithContentShape(responseText: string) {
  return {
    session: {
      create: mock(async () => ({ id: "mock-review-session" })),
      prompt: mock(async () => ({ content: responseText })),
      delete: mock(async () => undefined),
    },
  }
}

function makeClientThrows() {
  return {
    session: {
      create: mock(async () => ({ id: "mock-review-session" })),
      prompt: mock(async () => {
        throw new Error("Network error during review")
      }),
      delete: mock(async () => undefined),
    },
  }
}

function makeClientCreateThrows() {
  return {
    session: {
      create: mock(async () => {
        throw new Error("Cannot create review session")
      }),
      prompt: mock(async () => ({ parts: [] })),
      delete: mock(async () => undefined),
    },
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_REQ: SelfReviewRequest = {
  phase: "PLANNING",
  mode: "GREENFIELD",
  artifactPaths: ["/workspace/plan.md"],
  criteriaText: "1. All requirements addressed\n2. Scope boundaries explicit",
}

function makeReviewResponse(overrides?: {
  satisfied?: boolean
  criteria?: Array<{ criterion: string; met: boolean; evidence: string; severity?: string }>
}): string {
  const criteria = overrides?.criteria ?? [
    { criterion: "All requirements addressed", met: true, evidence: "plan.md:10 — all 5 requirements listed", severity: "blocking" },
    { criterion: "Scope boundaries explicit", met: true, evidence: "plan.md:22 — in-scope and out-of-scope sections present", severity: "blocking" },
  ]
  return JSON.stringify({
    satisfied: overrides?.satisfied ?? true,
    criteria_results: criteria,
  })
}

// ---------------------------------------------------------------------------
// Happy path — all criteria met
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — all criteria met", () => {
  it("returns success=true with satisfied=true when all blocking criteria pass", async () => {
    const client = makeClient(makeReviewResponse())
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
    expect(result.criteriaResults).toHaveLength(2)
  })

  it("reports per-criterion results with evidence and severity", async () => {
    const client = makeClient(makeReviewResponse())
    const result = await dispatchSelfReview(client, BASE_REQ)

    if (!result.success) return
    const first = result.criteriaResults[0]!
    expect(first.criterion).toBe("All requirements addressed")
    expect(first.met).toBe(true)
    expect(first.evidence).toContain("plan.md")
    expect(first.severity).toBe("blocking")
  })

  it("uses ephemeral session: create() and delete() each called once", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, BASE_REQ)

    expect((client.session.create as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
    expect((client.session.delete as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Blocking criterion fails
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — blocking criterion fails", () => {
  it("returns satisfied=false when any blocking criterion is not met", async () => {
    const resp = makeReviewResponse({
      satisfied: false,
      criteria: [
        { criterion: "All requirements addressed", met: false, evidence: "req #3 (error handling) is absent", severity: "blocking" },
        { criterion: "Scope boundaries explicit", met: true, evidence: "plan.md:22 present", severity: "blocking" },
      ],
    })
    const client = makeClient(resp)
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(false)
    const failing = result.criteriaResults.filter((c) => !c.met)
    expect(failing).toHaveLength(1)
    expect(failing[0]!.criterion).toBe("All requirements addressed")
  })
})

// ---------------------------------------------------------------------------
// LLM inconsistency guard: LLM says satisfied=true but blocking criterion unmet
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — LLM inconsistency guard", () => {
  it("recomputes satisfied=false from criteria even if LLM top-level field says true", async () => {
    const resp = makeReviewResponse({
      satisfied: true, // LLM is wrong
      criteria: [
        { criterion: "All requirements addressed", met: false, evidence: "req #3 missing", severity: "blocking" },
        { criterion: "Scope explicit", met: true, evidence: "present", severity: "blocking" },
      ],
    })
    const client = makeClient(resp)
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    // Guard must have fired: satisfied must be false despite LLM saying true
    expect(result.satisfied).toBe(false)
  })

  it("recomputes satisfied=true if all blocking criteria pass (even if LLM says false)", async () => {
    const resp = makeReviewResponse({
      satisfied: false, // LLM is wrong the other way
      criteria: [
        { criterion: "All requirements addressed", met: true, evidence: "all present", severity: "blocking" },
        { criterion: "Scope explicit", met: true, evidence: "section exists", severity: "blocking" },
      ],
    })
    const client = makeClient(resp)
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Suggestion criteria: non-blocking — do not affect satisfied
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — suggestion criteria are non-blocking", () => {
  it("satisfied=true even when a suggestion criterion is not met", async () => {
    const resp = makeReviewResponse({
      satisfied: true,
      criteria: [
        { criterion: "All requirements addressed", met: true, evidence: "all present", severity: "blocking" },
        { criterion: "Rationale documented", met: false, evidence: "no rationale section", severity: "suggestion" },
      ],
    })
    const client = makeClient(resp)
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
    // Suggestion criterion is still reported in results
    const suggestion = result.criteriaResults.find((c) => c.severity === "suggestion")
    expect(suggestion).toBeDefined()
    expect(suggestion?.met).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unknown severity defaults to "blocking"
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — unknown severity defaults to blocking", () => {
  it("treats missing severity as blocking", async () => {
    const resp = JSON.stringify({
      satisfied: true,
      criteria_results: [
        { criterion: "A criterion", met: false, evidence: "no evidence", severity: "unknown-value" },
      ],
    })
    const client = makeClient(resp)
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    // Unknown severity → treated as "blocking" → unmet blocking → satisfied=false
    expect(result.satisfied).toBe(false)
    expect(result.criteriaResults[0]!.severity).toBe("blocking")
  })
})

// ---------------------------------------------------------------------------
// Error handling — network failure
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — network failure", () => {
  it("returns SelfReviewError when prompt throws", async () => {
    const client = makeClientThrows()
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Network error")
  })

  it("returns SelfReviewError when session.create throws", async () => {
    const client = makeClientCreateThrows()
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Cannot create review session")
  })

  it("still calls session.delete even when prompt throws (finally block)", async () => {
    const client = makeClientThrows()
    await dispatchSelfReview(client, BASE_REQ)
    // delete is called in finally — even after a prompt failure
    expect((client.session.delete as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// extractText — response shape variants
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — response shape variants", () => {
  it("extracts text from parts array (primary shape)", async () => {
    const client = makeClient(makeReviewResponse())
    const result = await dispatchSelfReview(client, BASE_REQ)
    expect(result.success).toBe(true)
  })

  it("extracts text from flat 'text' field", async () => {
    const client = makeClientWithTextShape(makeReviewResponse())
    const result = await dispatchSelfReview(client, BASE_REQ)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
  })

  it("extracts text from flat 'content' field", async () => {
    const client = makeClientWithContentShape(makeReviewResponse())
    const result = await dispatchSelfReview(client, BASE_REQ)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Prompt construction — passes context through to session.prompt
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — prompt construction", () => {
  it("includes phase name in the prompt sent to the reviewer session", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, phase: "INTERFACES" })

    const promptCall = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const body = (promptCall as Array<unknown>)[0] as { body: { parts: Array<{ text: string }> } }
    const text = body.body.parts[0]?.text ?? ""
    expect(text).toContain("INTERFACES")
  })

  it("includes artifact paths in the prompt when provided", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, artifactPaths: ["/workspace/interfaces.ts"] })

    const promptCall = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const body = (promptCall as Array<unknown>)[0] as { body: { parts: Array<{ text: string }> } }
    const text = body.body.parts[0]?.text ?? ""
    expect(text).toContain("/workspace/interfaces.ts")
  })

  it("includes criteria text in the prompt", async () => {
    const criteria = "1. Must have tests\n2. Must have docs"
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, criteriaText: criteria })

    const promptCall = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const body = (promptCall as Array<unknown>)[0] as { body: { parts: Array<{ text: string }> } }
    const text = body.body.parts[0]?.text ?? ""
    expect(text).toContain("Must have tests")
  })

  it("includes upstream summary in the prompt when provided", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, upstreamSummary: "Conventions: use tabs" })

    const promptCall = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const body = (promptCall as Array<unknown>)[0] as { body: { parts: Array<{ text: string }> } }
    const text = body.body.parts[0]?.text ?? ""
    expect(text).toContain("use tabs")
  })

  it("creates session with agent: 'workflow-reviewer'", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, BASE_REQ)

    const createCall = (client.session.create as ReturnType<typeof mock>).mock.calls[0]
    const arg = (createCall as Array<unknown>)[0] as { body: { agent: string } }
    expect(arg.body.agent).toBe("workflow-reviewer")
  })
})

// ---------------------------------------------------------------------------
// Empty criteria_results
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — empty criteria list", () => {
  it("returns satisfied=true when criteria_results is empty (nothing to fail)", async () => {
    const resp = JSON.stringify({ satisfied: true, criteria_results: [] })
    const client = makeClient(resp)
    const result = await dispatchSelfReview(client, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
    expect(result.criteriaResults).toHaveLength(0)
  })
})
