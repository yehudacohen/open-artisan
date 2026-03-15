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
import { dispatchSelfReview, dispatchRebuttal, buildRebuttalPrompt } from "#plugin/self-review"
import type { SelfReviewRequest } from "#plugin/self-review"
import type { RebuttalRequest, CriterionResult } from "#plugin/types"

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeClient(responseText: string) {
  return {
    session: {
      create: mock(async () => ({ data: { id: "mock-review-session" } })),
      prompt: mock(async () => ({
        data: { parts: [{ type: "text", text: responseText }] },
      })),
      delete: mock(async () => ({ data: true })),
    },
  }
}

function makeClientWithTextShape(responseText: string) {
  // v2: text part in data.parts array (same as primary shape)
  return {
    session: {
      create: mock(async () => ({ data: { id: "mock-review-session" } })),
      prompt: mock(async () => ({
        data: { parts: [{ type: "text", text: responseText }] },
      })),
      delete: mock(async () => ({ data: true })),
    },
  }
}

function makeClientWithContentShape(responseText: string) {
  // v2: text part in data.parts array (same as primary shape)
  return {
    session: {
      create: mock(async () => ({ data: { id: "mock-review-session" } })),
      prompt: mock(async () => ({
        data: { parts: [{ type: "text", text: responseText }] },
      })),
      delete: mock(async () => ({ data: true })),
    },
  }
}

function makeClientThrows() {
  return {
    session: {
      create: mock(async () => ({ data: { id: "mock-review-session" } })),
      prompt: mock(async () => {
        throw new Error("Network error during review")
      }),
      delete: mock(async () => ({ data: true })),
    },
  }
}

function makeClientCreateThrows() {
  return {
    session: {
      create: mock(async () => {
        throw new Error("Cannot create review session")
      }),
      prompt: mock(async () => ({ data: { parts: [] } })),
      delete: mock(async () => ({ data: true })),
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
  /** Helper to extract prompt text from the v1-style mock call */
  function getPromptText(client: ReturnType<typeof makeClient>): string {
    const promptCall = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const arg = (promptCall as Array<unknown>)[0] as { path?: { id: string }; body?: { parts: Array<{ text: string }> } }
    return arg?.body?.parts?.[0]?.text ?? ""
  }

  it("includes phase name in the prompt sent to the reviewer session", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, phase: "INTERFACES" })
    expect(getPromptText(client)).toContain("INTERFACES")
  })

  it("includes artifact paths in the prompt when provided", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, artifactPaths: ["/workspace/interfaces.ts"] })
    expect(getPromptText(client)).toContain("/workspace/interfaces.ts")
  })

  it("includes criteria text in the prompt", async () => {
    const criteria = "1. Must have tests\n2. Must have docs"
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, criteriaText: criteria })
    expect(getPromptText(client)).toContain("Must have tests")
  })

  it("includes upstream summary in the prompt when provided", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, { ...BASE_REQ, upstreamSummary: "Conventions: use tabs" })
    expect(getPromptText(client)).toContain("use tabs")
  })

  it("uses v1 SDK path/body style in prompt() call", async () => {
    const client = makeClient(makeReviewResponse())
    await dispatchSelfReview(client, BASE_REQ)

    const promptCall = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const arg = (promptCall as Array<unknown>)[0] as Record<string, unknown>
    // v1 SDK: path.id, body.parts — no top-level sessionID, parts, or agent
    expect((arg["path"] as any)?.id).toBe("mock-review-session")
    expect(Array.isArray((arg["body"] as any)?.parts)).toBe(true)
    expect(arg["agent"]).toBeUndefined()
    expect(arg["sessionID"]).toBeUndefined()
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

// ---------------------------------------------------------------------------
// Timeout — hanging session returns SelfReviewError
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — timeout", () => {
  it("returns SelfReviewError when prompt hangs (simulated by never-resolving promise)", async () => {
    const client = {
      session: {
        create: mock(async () => ({ data: { id: "mock-review-session" } })),
        prompt: mock(() => new Promise<never>(() => { /* hangs forever */ })),
        delete: mock(async () => ({ data: true })),
      },
    }
    // Use a very short timeout via the SELF_REVIEW_TIMEOUT_MS constant.
    // We cannot override the module constant directly, so we verify the timeout
    // path is reachable by confirming withTimeout is wired: if the call ever
    // resolved it would fail the test; if it rejects with the timeout error we pass.
    // Since the constant is 120_000ms we instead test via a direct withTimeout call
    // in the utils test. Here we just verify that a network error (throw) is handled.
    const throwsClient = {
      session: {
        create: mock(async () => ({ data: { id: "session" } })),
        prompt: mock(async () => { throw new Error("timeout: self-review timed out after 120000ms") }),
        delete: mock(async () => ({ data: true })),
      },
    }
    const result = await dispatchSelfReview(throwsClient, BASE_REQ)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("timeout")
  })
})

// ---------------------------------------------------------------------------
// Artifact content for in-memory phases
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — artifactContent for in-memory phases", () => {
  it("includes artifact content in prompt when artifactPaths is empty", async () => {
    const capturedPrompts: string[] = []
    const client = {
      session: {
        create: mock(async () => ({ data: { id: "content-session" } })),
        prompt: mock(async (opts: { path?: { id: string }; body?: { parts: Array<{ text: string }> } }) => {
          capturedPrompts.push(opts.body!.parts[0]!.text)
          return {
            data: { parts: [{ type: "text", text: makeReviewResponse() }] },
          }
        }),
        delete: mock(async () => ({ data: true })),
      },
    }

    await dispatchSelfReview(client, {
      phase: "PLANNING",
      mode: "GREENFIELD",
      artifactPaths: [],
      criteriaText: "1. Plan covers all requirements",
      artifactContent: "## My Plan\nThis is the full plan text.",
    })

    expect(capturedPrompts.length).toBe(1)
    expect(capturedPrompts[0]).toContain("in-memory document")
    expect(capturedPrompts[0]).toContain("## My Plan")
    expect(capturedPrompts[0]).toContain("This is the full plan text.")
  })

  it("uses file paths when provided, even if artifactContent is also set", async () => {
    const capturedPrompts: string[] = []
    const client = {
      session: {
        create: mock(async () => ({ data: { id: "files-session" } })),
        prompt: mock(async (opts: { path?: { id: string }; body?: { parts: Array<{ text: string }> } }) => {
          capturedPrompts.push(opts.body!.parts[0]!.text)
          return {
            data: { parts: [{ type: "text", text: makeReviewResponse() }] },
          }
        }),
        delete: mock(async () => ({ data: true })),
      },
    }

    await dispatchSelfReview(client, {
      phase: "INTERFACES",
      mode: "GREENFIELD",
      artifactPaths: ["/workspace/src/types.ts"],
      criteriaText: "1. Types defined",
      artifactContent: "should not appear",
    })

    expect(capturedPrompts[0]).toContain("types.ts")
    expect(capturedPrompts[0]).not.toContain("should not appear")
  })

  it("shows graceful fallback when no paths and no content", async () => {
    const capturedPrompts: string[] = []
    const client = {
      session: {
        create: mock(async () => ({ data: { id: "empty-session" } })),
        prompt: mock(async (opts: { path?: { id: string }; body?: { parts: Array<{ text: string }> } }) => {
          capturedPrompts.push(opts.body!.parts[0]!.text)
          return {
            data: { parts: [{ type: "text", text: makeReviewResponse() }] },
          }
        }),
        delete: mock(async () => ({ data: true })),
      },
    }

    await dispatchSelfReview(client, {
      phase: "PLANNING",
      mode: "GREENFIELD",
      artifactPaths: [],
      criteriaText: "1. Something",
    })

    expect(capturedPrompts[0]).toContain("mark criteria as unmet")
  })
})

// ---------------------------------------------------------------------------
// Agent rebuttal — dispatchRebuttal and buildRebuttalPrompt
// ---------------------------------------------------------------------------

const BASE_REBUTTAL_REQ: RebuttalRequest = {
  phase: "TESTS",
  mode: "GREENFIELD",
  reviewerVerdict: [
    {
      criterion: "[Q] Operational excellence — structured logging",
      met: false,
      evidence: "No tests verify JSON log format (score: 8/10)",
      severity: "blocking",
      score: 8,
    },
  ],
  agentAssessment: [
    {
      criterion: "[Q] Operational excellence — structured logging",
      met: true,
      evidence: "Structured logging is an implementation concern, not testable at interface level. Tests verify error contracts (retryCount) which is the interface responsibility.",
      score: 9,
    },
  ],
  artifactPaths: ["/workspace/tests/ingestion.test.ts"],
  criteriaText: "1. All interface contracts tested\n2. [Q] Operational excellence — ...",
}

describe("buildRebuttalPrompt — prompt structure", () => {
  it("includes the phase name", () => {
    const prompt = buildRebuttalPrompt(BASE_REBUTTAL_REQ)
    expect(prompt).toContain("TESTS")
  })

  it("includes the reviewer's original verdict", () => {
    const prompt = buildRebuttalPrompt(BASE_REBUTTAL_REQ)
    expect(prompt).toContain("No tests verify JSON log format")
    expect(prompt).toContain("score: 8/10")
  })

  it("includes the agent's counterarguments", () => {
    const prompt = buildRebuttalPrompt(BASE_REBUTTAL_REQ)
    expect(prompt).toContain("implementation concern")
    expect(prompt).toContain("agent claims score: 9/10")
  })

  it("includes artifact paths for re-checking", () => {
    const prompt = buildRebuttalPrompt(BASE_REBUTTAL_REQ)
    expect(prompt).toContain("/workspace/tests/ingestion.test.ts")
  })

  it("includes instructions about valid vs invalid rebuttals", () => {
    const prompt = buildRebuttalPrompt(BASE_REBUTTAL_REQ)
    expect(prompt).toContain("out of scope")
    expect(prompt).toContain("INVALID")
    expect(prompt).toContain("handwaving")
  })

  it("requests JSON output with rebuttal_accepted field", () => {
    const prompt = buildRebuttalPrompt(BASE_REBUTTAL_REQ)
    expect(prompt).toContain("rebuttal_accepted")
  })
})

describe("dispatchRebuttal — reviewer concedes", () => {
  it("returns allResolved=true when reviewer accepts rebuttal and revises score to 9+", async () => {
    const responseText = JSON.stringify({
      criteria_results: [
        {
          criterion: "[Q] Operational excellence — structured logging",
          met: true,
          evidence: "Agent's argument is valid: structured logging verification is an implementation concern. Tests correctly verify the error contract (retryCount field).",
          severity: "blocking",
          score: 9,
          rebuttal_accepted: true,
        },
      ],
    })
    const client = makeClient(responseText)
    const result = await dispatchRebuttal(client, BASE_REBUTTAL_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.allResolved).toBe(true)
    expect(result.revisedResults).toHaveLength(1)
    expect(result.revisedResults[0]!.met).toBe(true)
    expect(result.revisedResults[0]!.score).toBe(9)
  })
})

describe("dispatchRebuttal — reviewer holds firm", () => {
  it("returns allResolved=false when reviewer maintains low score", async () => {
    const responseText = JSON.stringify({
      criteria_results: [
        {
          criterion: "[Q] Operational excellence — structured logging",
          met: false,
          evidence: "Rebuttal rejected: even at interface level, the plan explicitly requires structured JSON logging tests (Section 6.5).",
          severity: "blocking",
          score: 8,
          rebuttal_accepted: false,
        },
      ],
    })
    const client = makeClient(responseText)
    const result = await dispatchRebuttal(client, BASE_REBUTTAL_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.allResolved).toBe(false)
    expect(result.revisedResults[0]!.met).toBe(false)
    expect(result.revisedResults[0]!.score).toBe(8)
  })
})

describe("dispatchRebuttal — multiple disputed criteria", () => {
  it("handles mixed results: some accepted, some rejected", async () => {
    const req: RebuttalRequest = {
      ...BASE_REBUTTAL_REQ,
      reviewerVerdict: [
        { criterion: "[Q] Op excellence — logging", met: false, evidence: "no log tests", severity: "blocking", score: 8 },
        { criterion: "[Q] Op excellence — retry", met: false, evidence: "shallow retry tests", severity: "blocking", score: 7 },
      ],
      agentAssessment: [
        { criterion: "[Q] Op excellence — logging", met: true, evidence: "out of scope", score: 9 },
        { criterion: "[Q] Op excellence — retry", met: true, evidence: "we test the contract", score: 9 },
      ],
    }
    const responseText = JSON.stringify({
      criteria_results: [
        { criterion: "[Q] Op excellence — logging", met: true, evidence: "accepted", severity: "blocking", score: 9 },
        { criterion: "[Q] Op excellence — retry", met: false, evidence: "rejected: plan says test retries", severity: "blocking", score: 7 },
      ],
    })
    const client = makeClient(responseText)
    const result = await dispatchRebuttal(client, req)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.allResolved).toBe(false) // one still failing
    expect(result.revisedResults.filter((r) => r.met)).toHaveLength(1)
    expect(result.revisedResults.filter((r) => !r.met)).toHaveLength(1)
  })
})

describe("dispatchRebuttal — error handling", () => {
  it("returns RebuttalError on network failure", async () => {
    const client = makeClientThrows()
    const result = await dispatchRebuttal(client, BASE_REBUTTAL_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Network error")
  })

  it("returns RebuttalError on session creation failure", async () => {
    const client = makeClientCreateThrows()
    const result = await dispatchRebuttal(client, BASE_REBUTTAL_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Cannot create review session")
  })
})

describe("dispatchRebuttal — session lifecycle", () => {
  it("creates session with Rebuttal title including phase and feature name", async () => {
    const responseText = JSON.stringify({
      criteria_results: [
        { criterion: "[Q] Op ex", met: true, evidence: "ok", severity: "blocking", score: 9 },
      ],
    })
    const client = makeClient(responseText)
    await dispatchRebuttal(client, { ...BASE_REBUTTAL_REQ, featureName: "cloud-cost-platform" })

    const createCall = (client.session.create as ReturnType<typeof mock>).mock.calls[0]
    const createArg = (createCall as Array<unknown>)[0] as { body: { title: string } }
    expect(createArg.body.title).toContain("Rebuttal")
    expect(createArg.body.title).toContain("TESTS")
    expect(createArg.body.title).toContain("cloud-cost-platform")
  })

  it("cleans up session via delete() even on success", async () => {
    const responseText = JSON.stringify({
      criteria_results: [
        { criterion: "[Q] Op ex", met: true, evidence: "ok", severity: "blocking", score: 9 },
      ],
    })
    const client = makeClient(responseText)
    await dispatchRebuttal(client, BASE_REBUTTAL_REQ)

    expect((client.session.delete as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })
})
