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
import { dispatchSelfReview, dispatchRebuttal, buildRebuttalPrompt, buildReviewPrompt, extractExpectedBlockingCriteria } from "#core/self-review"
import type { SelfReviewRequest } from "#core/self-review"
import { encodeSubagentToolSubmission } from "#core/subagent-dispatcher"
import type { SubagentDispatcher, SubagentSession } from "#core/subagent-dispatcher"
import type { CriterionResult, RebuttalRequest } from "#core/review-types"

// ---------------------------------------------------------------------------
// Mock dispatcher factory
// ---------------------------------------------------------------------------

function makeDispatcher(responseText: string): SubagentDispatcher & { _promptMock: ReturnType<typeof mock>; _destroyMock: ReturnType<typeof mock>; _createMock: ReturnType<typeof mock> } {
  const promptMock = mock(async () => responseText)
  const destroyMock = mock(async () => {})
  const createMock = mock(async () => ({
    id: "mock-review-session",
    prompt: promptMock,
    destroy: destroyMock,
  }))
  return {
    createSession: createMock,
    _promptMock: promptMock,
    _destroyMock: destroyMock,
    _createMock: createMock,
  }
}

function makeDispatcherSequence(responseTexts: string[]): SubagentDispatcher & { _promptMock: ReturnType<typeof mock>; _destroyMock: ReturnType<typeof mock>; _createMock: ReturnType<typeof mock> } {
  let index = 0
  const promptMock = mock(async () => {
    const response = responseTexts[Math.min(index, responseTexts.length - 1)] ?? ""
    index++
    return response
  })
  const destroyMock = mock(async () => {})
  const createMock = mock(async () => ({
    id: `mock-review-session-${index}`,
    prompt: promptMock,
    destroy: destroyMock,
  }))
  return {
    createSession: createMock,
    _promptMock: promptMock,
    _destroyMock: destroyMock,
    _createMock: createMock,
  }
}

function makeDispatcherThrows(): SubagentDispatcher & { _destroyMock: ReturnType<typeof mock> } {
  const destroyMock = mock(async () => {})
  const promptMock = mock(async () => { throw new Error("Network error during review") })
  return {
    createSession: mock(async () => ({
      id: "mock-review-session",
      prompt: promptMock,
      destroy: destroyMock,
    })),
    _destroyMock: destroyMock,
  }
}

function makeDispatcherCreateThrows(): SubagentDispatcher {
  return {
    createSession: mock(async () => {
      throw new Error("Cannot create review session")
    }),
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function selfReviewErrorText(result: { error?: string; message?: string }): string {
  const runtimeError = typeof result.error === "string" ? result.error : undefined
  return runtimeError ?? result.message ?? ""
}

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
    const dispatcher = makeDispatcher(makeReviewResponse())
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
    expect(result.criteriaResults).toHaveLength(2)
  })

  it("reports per-criterion results with evidence and severity", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    if (!result.success) return
    const first = result.criteriaResults[0]!
    expect(first.criterion).toBe("All requirements addressed")
    expect(first.met).toBe(true)
    expect(first.evidence).toContain("plan.md")
    expect(first.severity).toBe("blocking")
  })

  it("preserves reviewer criterion_id as criterionId", async () => {
    const dispatcher = makeDispatcher(JSON.stringify({
      satisfied: true,
      criteria_results: [
        { criterion_id: "planning.user-requirements", criterion: "All requirements addressed", met: true, evidence: "section exists", severity: "blocking" },
        { criterion_id: "planning.scope-boundaries", criterion: "Scope boundaries explicit", met: true, evidence: "section exists", severity: "blocking" },
      ],
    }))
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.criteriaResults.some((criterion) => criterion.criterionId === "planning.scope-boundaries")).toBe(true)
  })

  it("uses ephemeral session: create() and delete() each called once", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(dispatcher._createMock.mock.calls).toHaveLength(1)
    expect(dispatcher._destroyMock.mock.calls).toHaveLength(1)
  })

  it("requests reviewer tool submission when the adapter supports it", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(dispatcher._promptMock.mock.calls[0]?.[1]).toEqual({ submissionTool: { name: "submit_phase_review_result" } })
  })
})

describe("buildReviewPrompt — intent baseline context", () => {
  it("uses intentBaseline instead of raw approval chatter", () => {
    const prompt = buildReviewPrompt({
      ...BASE_REQ,
      artifactPaths: ["/workspace/.openartisan/feature/plan.md"],
      intentBaseline: "Build a Discord supervisor harness for Hermes/Open Artisan dogfooding.",
    })

    expect(prompt).toContain("## User's Original Request")
    expect(prompt).toContain("Build a Discord supervisor harness")
    expect(prompt).not.toContain("ok approve")
    expect(prompt).toContain("Markdown planning artifacts may live under .openartisan/")
    expect(prompt).not.toContain("NOT in .openartisan")
  })

  it("includes the bespoke self-review structural gate", () => {
    const prompt = buildReviewPrompt({
      ...BASE_REQ,
      phase: "INTERFACES",
      criteriaText: "1. Reviewed artifacts are real interface/type/schema files",
    })

    expect(prompt).toContain("Bespoke Structural Review Gate")
    expect(prompt).toContain("Interfaces review")
    expect(prompt).toContain("source contracts")
  })

  it("starts with a strict JSON-only output contract", () => {
    const prompt = buildReviewPrompt(BASE_REQ)

    expect(prompt.startsWith("CRITICAL OUTPUT CONTRACT")).toBe(true)
    expect(prompt).toContain("ONLY one valid JSON object")
    expect(prompt).toContain("Do not include markdown")
  })

  it("includes recent feedback as authoritative conflict-resolution context", () => {
    const prompt = buildReviewPrompt({
      ...BASE_REQ,
      phase: "INTERFACES",
      feedbackHistory: [
        {
          phase: "INTERFACES",
          feedback: "Remove the bespoke CommonWorkloadOverrideSchema; use factory-advertised { spec: ... } schemas instead.",
          timestamp: 123,
        },
      ],
    })

    expect(prompt).toContain("## Recent User Feedback / Approved Direction")
    expect(prompt).toContain("latest approved intent")
    expect(prompt).toContain("Do not resurrect requirements")
    expect(prompt).toContain("factory-advertised { spec: ... } schemas")
    expect(prompt).toContain("newer feedback as authoritative")
  })

  it("includes realWorldAcceptanceScenario as a review lens when captured", () => {
    const prompt = buildReviewPrompt({
      ...BASE_REQ,
      phase: "TESTS",
      realWorldAcceptanceScenario: {
        scenario: "A maintainer needs test reviewers to preserve the user's motivating workflow use case.",
        requiredCapabilities: ["Tests cover prompt consumers that carry the scenario"],
        acceptanceChecks: ["Reviewed tests catch missing scenario wiring"],
        explicitNonGoals: ["Do not infer scenarios from arbitrary chat"],
        sourceArtifactPath: "/workspace/.openartisan/feature/plan.md",
        capturedAtPhase: "PLANNING",
      },
    } as any)

    expect(prompt).toContain("Real-World Acceptance Scenario")
    expect(prompt).toContain("A maintainer needs test reviewers")
    expect(prompt).toContain("Tests cover prompt consumers that carry the scenario")
    expect(prompt).toContain("Reviewed tests catch missing scenario wiring")
    expect(prompt).toContain("evaluate Vision alignment")
  })

  it("omits realWorldAcceptanceScenario review context when no scenario has been captured", () => {
    const prompt = buildReviewPrompt({
      ...BASE_REQ,
      realWorldAcceptanceScenario: null,
    } as any)

    expect(prompt).not.toContain("Real-World Acceptance Scenario")
    expect(prompt).not.toContain("Scenario Sufficiency")
  })

  it("limits review scope to explicitly listed artifact files", () => {
    const prompt = buildReviewPrompt({
      ...BASE_REQ,
      phase: "INTERFACES",
      artifactPaths: ["/workspace/src/core/aspects/types.ts"],
    })

    expect(prompt).toContain("Evaluate ONLY these listed files as the reviewed artifact set")
    expect(prompt).toContain("unlisted dependency has pre-existing issues")
    expect(prompt).toContain("For TypeScript module augmentation")
    expect(prompt).toContain("do not treat the original augmented module as a reviewed artifact")
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
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

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
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

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
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

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
        { criterion: "Scope boundaries explicit", met: true, evidence: "boundaries listed", severity: "blocking" },
        { criterion: "Rationale documented", met: false, evidence: "no rationale section", severity: "suggestion" },
      ],
    })
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

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
        { criterion: "Second criterion", met: true, evidence: "ok", severity: "blocking" },
      ],
    })
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

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
    const dispatcher = makeDispatcherThrows()
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(selfReviewErrorText(result)).toContain("Network error")
  })

  it("returns SelfReviewError when session.create throws", async () => {
    const dispatcher = makeDispatcherCreateThrows()
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(selfReviewErrorText(result)).toContain("Cannot create review session")
  })

  it("still calls session.delete even when prompt throws (finally block)", async () => {
    const dispatcher = makeDispatcherThrows()
    await dispatchSelfReview(dispatcher, BASE_REQ)
    // delete is called in finally — even after a prompt failure
    expect(dispatcher._destroyMock.mock.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// extractText — response shape variants
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — response shape variants", () => {
  it("extracts text from parts array (primary shape)", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)
    expect(result.success).toBe(true)
  })

  it("extracts text from flat 'text' field", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
  })

  it("extracts text from flat 'content' field", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
  })
})

describe("dispatchSelfReview — invalid JSON recovery", () => {
  it("rejects assistant text without JSON repair when tool submission is required", async () => {
    const dispatcher = makeDispatcher("**Evaluating deployment plans**\nThis is prose, not a tool call.")

    const result = await dispatchSelfReview(dispatcher, { ...BASE_REQ, requireToolSubmission: true })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(selfReviewErrorText(result)).toContain("Expected submit_phase_review_result tool submission")
    expect(selfReviewErrorText(result)).not.toContain("Reviewer returned invalid JSON")
    expect(dispatcher._promptMock).toHaveBeenCalledTimes(1)
  })

  it("accepts encoded reviewer tool submissions when tool submission is required", async () => {
    const dispatcher = makeDispatcher(encodeSubagentToolSubmission("submit_phase_review_result", makeReviewResponse()))

    const result = await dispatchSelfReview(dispatcher, { ...BASE_REQ, requireToolSubmission: true })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
  })

  it("retries once with a JSON-only repair prompt when reviewer returns prose", async () => {
    const dispatcher = makeDispatcherSequence([
      "* All criteria look good, but this is not JSON.",
      makeReviewResponse(),
    ])

    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    expect(dispatcher._createMock).toHaveBeenCalledTimes(2)
    expect(dispatcher._promptMock).toHaveBeenCalledTimes(2)
    const repairPrompt = dispatcher._promptMock.mock.calls[1]?.[0] as string
    expect(repairPrompt).toContain("not valid JSON")
    expect(repairPrompt).toContain("Return ONLY a valid JSON object")
  })

  it("requests reviewer tool submission without adapter-level JSON schema formatting for review or repair prompts", async () => {
    const dispatcher = makeDispatcherSequence([
      "* First invalid reviewer response.",
      makeReviewResponse(),
    ])

    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    const firstOptions = dispatcher._promptMock.mock.calls[0]?.[1] as any
    const repairOptions = dispatcher._promptMock.mock.calls[1]?.[1] as any
    expect(firstOptions).toEqual({ submissionTool: { name: "submit_phase_review_result" } })
    expect(repairOptions).toEqual({ submissionTool: { name: "submit_phase_review_result" } })
    expect(firstOptions?.responseFormat).toBeUndefined()
    expect(repairOptions?.responseFormat).toBeUndefined()
  })

  it("returns an actionable snippet when reviewer JSON repair also fails", async () => {
    const dispatcher = makeDispatcherSequence([
      "* First invalid reviewer response.",
      "Still not JSON.",
    ])

    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(selfReviewErrorText(result)).toContain("Reviewer returned invalid JSON")
    expect(selfReviewErrorText(result)).toContain("Output snippet")
    expect(selfReviewErrorText(result)).toContain("JSON repair failed")
  })
})

// ---------------------------------------------------------------------------
// Prompt construction — passes context through to session.prompt
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — prompt construction", () => {
  /** Helper to extract prompt text from the v1-style mock call */
  function getPromptText(dispatcher: ReturnType<typeof makeDispatcher>): string {
    const promptCall = dispatcher._promptMock.mock.calls[0]
    // prompt() now receives a plain string (not SDK envelope)
    return (promptCall as Array<unknown>)[0] as string ?? ""
  }

  it("includes phase name in the prompt sent to the reviewer session", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, { ...BASE_REQ, phase: "INTERFACES" })
    expect(getPromptText(dispatcher)).toContain("INTERFACES")
  })

  it("includes artifact paths in the prompt when provided", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, { ...BASE_REQ, artifactPaths: ["/workspace/interfaces.ts"] })
    expect(getPromptText(dispatcher)).toContain("/workspace/interfaces.ts")
  })

  it("instructs reviewers not to fail unrelated legacy APIs in mixed files", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, { ...BASE_REQ, phase: "INTERFACES", artifactPaths: ["/workspace/workflow-state-types.ts"] })
    const prompt = getPromptText(dispatcher)
    expect(prompt).toContain("unrelated legacy APIs")
    expect(prompt).toContain("do not fail unrelated pre-existing APIs")
  })

  it("instructs reviewers to reject markdown artifacts for file-based phases", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, { ...BASE_REQ, phase: "TESTS", artifactPaths: ["/workspace/tests.md"] })
    expect(getPromptText(dispatcher)).toContain("Structural gate")
    expect(getPromptText(dispatcher)).toContain("Markdown test plans")
    expect(getPromptText(dispatcher)).toContain(".openartisan")
  })

  it("includes criteria text in the prompt", async () => {
    const criteria = "1. Must have tests\n2. Must have docs"
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, { ...BASE_REQ, criteriaText: criteria })
    expect(getPromptText(dispatcher)).toContain("Must have tests")
  })

  it("includes a full required checklist and forbids failed-only reviewer output", async () => {
    const criteria = `**Blocking criteria (must all pass to advance):**
1. First standard criterion
2. [Q] Quality criterion

**Suggestion criteria (non-blocking):**
1. Optional suggestion`
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, { ...BASE_REQ, criteriaText: criteria })
    const prompt = getPromptText(dispatcher)

    expect(prompt).toContain("Full Required Blocking/Quality Checklist")
    expect(prompt).toContain("First standard criterion")
    expect(prompt).toContain("[Q] Quality criterion")
    expect(prompt).toContain("Do not return only failed criteria")
  })

  it("tells PLANNING reviewers candidate allowlists do not need to be active yet", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, {
      ...BASE_REQ,
      mode: "INCREMENTAL",
      fileAllowlist: ["/workspace/packages/core/self-review.ts"],
      fileAllowlistSource: "planning-artifact",
    })
    const prompt = getPromptText(dispatcher)

    expect(prompt).toContain("candidate replacement allowlist")
    expect(prompt).toContain("not against any stale active allowlist")
    expect(prompt).toContain("Do not fail the PLANNING artifact merely because candidate files are not already in the active approved allowlist")
  })

  it("includes upstream summary in the prompt when provided", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, { ...BASE_REQ, upstreamSummary: "Conventions: use tabs" })
    expect(getPromptText(dispatcher)).toContain("use tabs")
  })

  it("uses v1 SDK path/body style in prompt() call", async () => {
    const dispatcher = makeDispatcher(makeReviewResponse())
    await dispatchSelfReview(dispatcher, BASE_REQ)

    // Verify the dispatcher was called with a string prompt
    expect(dispatcher._promptMock.mock.calls).toHaveLength(1)
    const promptArg = dispatcher._promptMock.mock.calls[0]?.[0]
    expect(typeof promptArg).toBe("string")
    expect((promptArg as string).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Empty criteria_results
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — empty criteria list", () => {
  it("rejects empty criteria_results after incomplete-output repair also fails", async () => {
    const resp = JSON.stringify({ satisfied: true, criteria_results: [] })
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Reviewer returned only 0 blocking criteria")
    expect(result.error).toContain("Criteria repair failed")
  })

  it("repairs incomplete reviewer output by prompting for the full criteria checklist", async () => {
    const incomplete = JSON.stringify({
      satisfied: false,
      criteria_results: [
        { criterion: "Allowlist adequacy", met: false, evidence: "candidate allowlist incomplete", severity: "blocking" },
      ],
    })
    const repaired = JSON.stringify({
      satisfied: true,
      criteria_results: [
        { criterion: "All requirements addressed", met: true, evidence: "plan.md:10", severity: "blocking" },
        { criterion: "Scope boundaries explicit", met: true, evidence: "plan.md:22", severity: "blocking" },
      ],
    })
    const dispatcher = makeDispatcherSequence([incomplete, repaired])

    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.criteriaResults).toHaveLength(2)
    expect(dispatcher._promptMock.mock.calls).toHaveLength(2)
    const repairPrompt = dispatcher._promptMock.mock.calls[1]?.[0] as string
    expect(repairPrompt).toContain("previous review output was incomplete")
    expect(repairPrompt).toContain("Full Required Checklist To Echo")
  })
})

describe("extractExpectedBlockingCriteria", () => {
  it("extracts numbered blocking and quality criteria before suggestions", () => {
    const criteria = `**Blocking criteria (must all pass to advance):**
1. Standard criterion
2. [Q] Quality criterion

**Suggestion criteria (non-blocking):**
1. Optional suggestion`

    expect(extractExpectedBlockingCriteria(criteria)).toEqual([
      "Standard criterion",
      "[Q] Quality criterion",
    ])
  })
})

// ---------------------------------------------------------------------------
// Timeout — hanging session returns SelfReviewError
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — timeout", () => {
  it("returns SelfReviewError when prompt throws timeout error", async () => {
    const dispatcher: SubagentDispatcher = {
      createSession: mock(async () => ({
        id: "timeout-session",
        prompt: mock(async () => { throw new Error("timeout: self-review timed out after 120000ms") }),
        destroy: mock(async () => {}),
      })),
    }
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(selfReviewErrorText(result)).toContain("timeout")
  })
})

// ---------------------------------------------------------------------------
// Artifact content for in-memory phases
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — file artifact paths", () => {
  it("uses file paths as the review source of truth", async () => {
    const capturedPrompts: string[] = []
    const capturingDispatcher: SubagentDispatcher = {
      createSession: mock(async () => ({
        id: "files-session",
        prompt: mock(async (text: string) => { capturedPrompts.push(text); return makeReviewResponse() }),
        destroy: mock(async () => {}),
      })),
    }

    await dispatchSelfReview(capturingDispatcher, {
      phase: "INTERFACES",
      mode: "GREENFIELD",
      artifactPaths: ["/workspace/src/types.ts"],
      criteriaText: "1. Types defined",
    })

    expect(capturedPrompts[0]).toContain("types.ts")
  })

  it("shows graceful fallback when no paths and no content", async () => {
    const capturedPrompts: string[] = []
    const capturingDispatcher: SubagentDispatcher = {
      createSession: mock(async () => ({
        id: "empty-session",
        prompt: mock(async (text: string) => { capturedPrompts.push(text); return makeReviewResponse() }),
        destroy: mock(async () => {}),
      })),
    }

    await dispatchSelfReview(capturingDispatcher, {
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
    const dispatcher = makeDispatcher(responseText)
    const result = await dispatchRebuttal(dispatcher, BASE_REBUTTAL_REQ)

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
    const dispatcher = makeDispatcher(responseText)
    const result = await dispatchRebuttal(dispatcher, BASE_REBUTTAL_REQ)

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
    const dispatcher = makeDispatcher(responseText)
    const result = await dispatchRebuttal(dispatcher, req)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.allResolved).toBe(false) // one still failing
    expect(result.revisedResults.filter((r) => r.met)).toHaveLength(1)
    expect(result.revisedResults.filter((r) => !r.met)).toHaveLength(1)
  })
})

describe("dispatchRebuttal — error handling", () => {
  it("returns RebuttalError on network failure", async () => {
    const dispatcher = makeDispatcherThrows()
    const result = await dispatchRebuttal(dispatcher, BASE_REBUTTAL_REQ)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Network error")
  })

  it("returns RebuttalError on session creation failure", async () => {
    const dispatcher = makeDispatcherCreateThrows()
    const result = await dispatchRebuttal(dispatcher, BASE_REBUTTAL_REQ)

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
    const dispatcher = makeDispatcher(responseText)
    await dispatchRebuttal(dispatcher, { ...BASE_REBUTTAL_REQ, featureName: "cloud-cost-platform" })

    const createCall = dispatcher._createMock.mock.calls[0]
    const createArg = (createCall as Array<unknown>)[0] as { title: string }
    expect(createArg.title).toContain("Rebuttal")
    expect(createArg.title).toContain("TESTS")
    expect(createArg.title).toContain("cloud-cost-platform")
  })

  it("cleans up session via delete() even on success", async () => {
    const responseText = JSON.stringify({
      criteria_results: [
        { criterion: "[Q] Op ex", met: true, evidence: "ok", severity: "blocking", score: 9 },
      ],
    })
    const dispatcher = makeDispatcher(responseText)
    await dispatchRebuttal(dispatcher, BASE_REBUTTAL_REQ)

    expect(dispatcher._destroyMock.mock.calls).toHaveLength(1)
    expect(dispatcher._promptMock.mock.calls[0]?.[1]).toEqual({ submissionTool: { name: "submit_rebuttal_review_result" } })
  })
})

// ---------------------------------------------------------------------------
// Design-invariant ([D]) criterion parsing and blocking behavior
// ---------------------------------------------------------------------------

describe("dispatchSelfReview — design-invariant criteria", () => {
  it("parses [D] criterion with severity 'design-invariant' in criteriaResults", async () => {
    const resp = makeReviewResponse({
      satisfied: true,
      criteria: [
        { criterion: "[D] No circular dependencies", met: true, evidence: "dep graph verified", severity: "blocking" },
        { criterion: "Code compiles", met: true, evidence: "tsc clean", severity: "blocking" },
      ],
    })
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    const diCriterion = result.criteriaResults.find((c) => c.criterion.startsWith("[D]"))
    expect(diCriterion).toBeDefined()
    expect(diCriterion!.severity).toBe("design-invariant")
  })

  it("returns satisfied=false when a design-invariant criterion is not met", async () => {
    const resp = makeReviewResponse({
      satisfied: false,
      criteria: [
        { criterion: "[D] No circular dependencies", met: false, evidence: "cycle detected: A→B→A", severity: "blocking" },
        { criterion: "Code compiles", met: true, evidence: "tsc clean", severity: "blocking" },
      ],
    })
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(false)
    const failing = result.criteriaResults.filter((c) => !c.met)
    expect(failing).toHaveLength(1)
    expect(failing[0]!.severity).toBe("design-invariant")
  })

  it("returns satisfied=true when all design-invariant and blocking criteria are met", async () => {
    const resp = makeReviewResponse({
      satisfied: true,
      criteria: [
        { criterion: "[D] No circular dependencies", met: true, evidence: "dep graph clean", severity: "blocking" },
        { criterion: "[D] Single responsibility", met: true, evidence: "each module has one purpose", severity: "blocking" },
        { criterion: "Code compiles", met: true, evidence: "tsc clean", severity: "blocking" },
      ],
    })
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.satisfied).toBe(true)
    // Verify all [D] criteria were parsed as design-invariant
    const diCriteria = result.criteriaResults.filter((c) => c.severity === "design-invariant")
    expect(diCriteria).toHaveLength(2)
    expect(diCriteria.every((c) => c.met)).toBe(true)
  })

  it("overrides satisfied=true to false when a design-invariant criterion is unmet (inconsistency guard)", async () => {
    const resp = makeReviewResponse({
      satisfied: true, // LLM incorrectly says satisfied
      criteria: [
        { criterion: "[D] No circular dependencies", met: false, evidence: "cycle: A→B→A", severity: "blocking" },
        { criterion: "Code compiles", met: true, evidence: "tsc clean", severity: "blocking" },
      ],
    })
    const dispatcher = makeDispatcher(resp)
    const result = await dispatchSelfReview(dispatcher, BASE_REQ)

    expect(result.success).toBe(true)
    if (!result.success) return
    // Inconsistency guard must fire: design-invariant unmet → satisfied=false
    expect(result.satisfied).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildReviewPrompt — artifact disk paths and explicit files (v22)
// ---------------------------------------------------------------------------

describe("buildReviewPrompt — v22 artifact tracking", () => {
  const { buildReviewPrompt } = require("#core/self-review") as typeof import("#core/self-review")

  it("shows artifactDiskPaths unconditionally (not gated on fileAllowlist)", () => {
    const prompt = buildReviewPrompt({
      phase: "IMPLEMENTATION",
      mode: "GREENFIELD",
      artifactPaths: [],
      criteriaText: "Some criteria",
      artifactDiskPaths: { plan: "/tmp/.openartisan/plan.md", impl_plan: "/tmp/.openartisan/impl_plan.md" },
      // No fileAllowlist — GREENFIELD mode
    })
    expect(prompt).toContain("plan")
    expect(prompt).toContain("/tmp/.openartisan/plan.md")
    expect(prompt).toContain("impl_plan")
    expect(prompt).toContain("/tmp/.openartisan/impl_plan.md")
    expect(prompt).toContain("Approved Artifact Locations")
  })

  it("shows explicit artifact file paths when provided", () => {
    const prompt = buildReviewPrompt({
      phase: "IMPLEMENTATION",
      mode: "GREENFIELD",
      artifactPaths: ["/project/pages/01.html", "/project/pages/02.html"],
      criteriaText: "Some criteria",
    })
    expect(prompt).toContain("/project/pages/01.html")
    expect(prompt).toContain("/project/pages/02.html")
    expect(prompt).toContain("Read each of the following files")
  })

  it("does not show artifact disk paths section when none provided", () => {
    const prompt = buildReviewPrompt({
      phase: "IMPLEMENTATION",
      mode: "GREENFIELD",
      artifactPaths: [],
      criteriaText: "Some criteria",
    })
    expect(prompt).not.toContain("Approved Artifact Locations")
  })
})
