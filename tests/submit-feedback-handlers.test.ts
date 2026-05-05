/**
 * Tests for tools/submit-feedback-handlers.ts — extracted routing handlers.
 *
 * Covers:
 * handleEscapeHatch:
 *   - abort path (option D)
 *   - new direction path (option C, "new direction: ...")
 *   - alternative direction path (option B, substantive text)
 *   - plain accept path (option A, "accept"/"proceed")
 *   - alternative direction triggers escape_represent when rebuilt plan is strategic
 *
 * handleCascade:
 *   - returns "revise" with next step from pendingRevisionSteps
 *   - final step: remainingMsg says "Final revision step"
 *   - intermediate step: cascade continues message
 *
 * handleNormalRevise:
 *   - tactical: returns "revise" directly
 *   - strategic: returns "escape_represent"
 *   - orchestrator throws: falls back to direct revise
 */
import { describe, expect, it, mock } from "bun:test"
import {
  handleEscapeHatch,
  handleCascade,
  handleNormalRevise,
} from "#core/tools/submit-feedback-handlers"
import type { WorkflowState } from "#core/types"
import type { RevisionStep } from "#core/orchestrator-types"
import { SCHEMA_VERSION } from "#core/types"
import { createStateMachine } from "#core/state-machine"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sm = createStateMachine()

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "GREENFIELD",
    phase: "PLANNING",
    phaseState: "USER_GATE",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: [],
    lastCheckpointTag: "workflow/discovery-v1",
    approvalCount: 1,
    orchestratorSessionId: null,
    intentBaseline: "Build an auth service",
    modeDetectionNote: null,
    discoveryReport: null,
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: true,
    pendingRevisionSteps: null,
    currentTaskId: null,
    feedbackHistory: [],
    userGateMessageReceived: false,
    artifactDiskPaths: {},
    featureName: null,
    revisionBaseline: null,
    activeAgent: null,
    taskCompletionInProgress: null,
    taskReviewCount: 0,
    pendingFeedback: null,
    userMessages: [],
    cachedPriorState: null,
    priorWorkflowChecked: false,
    sessionModel: null,
    reviewArtifactHash: null,
    latestReviewResults: null,
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
    ...overrides,
  }
}

function makeRevisionStep(artifact: string): RevisionStep {
  return {
    artifact: artifact as import("#core/types").ArtifactKey,
    phase: "PLANNING",
    phaseState: "REVISE",
    instructions: `Revise the ${artifact} artifact.`,
  }
}

function makeOrchestrator(overrides?: {
  revisionSteps?: RevisionStep[]
  classification?: "tactical" | "strategic"
  throws?: boolean
}) {
  return {
    route: mock(async () => {
      if (overrides?.throws) throw new Error("Orchestrator failure")
      return {
        revisionSteps: overrides?.revisionSteps ?? [makeRevisionStep("plan")],
        classification: overrides?.classification ?? "tactical",
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// handleEscapeHatch — abort (option D)
// ---------------------------------------------------------------------------

describe("handleEscapeHatch — abort", () => {
  it("returns action=abort for 'abort' text", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const result = await handleEscapeHatch("abort", state, sm, makeOrchestrator())
    expect(result.action).toBe("abort")
  })

  it("returns action=abort for 'cancel' text", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const result = await handleEscapeHatch("cancel", state, sm, makeOrchestrator())
    expect(result.action).toBe("abort")
  })

  it("abort message includes the checkpoint tag", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const result = await handleEscapeHatch("abort", state, sm, makeOrchestrator())
    if (result.action !== "abort") return
    expect(result.message).toContain("workflow/discovery-v1")
  })
})

// ---------------------------------------------------------------------------
// handleEscapeHatch — new direction (option C)
// ---------------------------------------------------------------------------

describe("handleEscapeHatch — new direction", () => {
  it("returns action=revise for 'new direction: ...' prefix", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const result = await handleEscapeHatch("new direction: use OAuth instead", state, sm, makeOrchestrator())
    expect(result.action).toBe("revise")
  })

  it("sets newIntentBaseline for new direction", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const result = await handleEscapeHatch("new direction: use OAuth instead", state, sm, makeOrchestrator())
    if (result.action !== "revise") return
    expect(result.newIntentBaseline).toContain("use OAuth instead")
  })

  it("clearEscapePending=true for new direction", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const result = await handleEscapeHatch("new direction: use OAuth", state, sm, makeOrchestrator())
    if (result.action !== "revise") return
    expect(result.clearEscapePending).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleEscapeHatch — plain accept (option A)
// ---------------------------------------------------------------------------

describe("handleEscapeHatch — plain accept", () => {
  it("returns action=revise for 'accept'", async () => {
    const steps = [makeRevisionStep("plan")]
    const state = makeState({ pendingRevisionSteps: steps })
    const result = await handleEscapeHatch("accept", state, sm, makeOrchestrator())
    expect(result.action).toBe("revise")
  })

  it("returns action=revise for 'proceed'", async () => {
    const steps = [makeRevisionStep("plan")]
    const state = makeState({ pendingRevisionSteps: steps })
    const result = await handleEscapeHatch("proceed", state, sm, makeOrchestrator())
    expect(result.action).toBe("revise")
  })

  it("sets targetPhase from first pending step", async () => {
    const step: RevisionStep = { artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "Fix it" }
    const state = makeState({ pendingRevisionSteps: [step] })
    const result = await handleEscapeHatch("accept", state, sm, makeOrchestrator())
    if (result.action !== "revise") return
    expect(result.targetPhase).toBe("PLANNING")
  })

  it("clearEscapePending=true on accept", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const result = await handleEscapeHatch("accept", state, sm, makeOrchestrator())
    if (result.action !== "revise") return
    expect(result.clearEscapePending).toBe(true)
  })

  it("returns error when no pending steps on accept", async () => {
    const state = makeState({ pendingRevisionSteps: [] })
    const result = await handleEscapeHatch("accept", state, sm, makeOrchestrator())
    expect(result.action).toBe("error")
  })
})

// ---------------------------------------------------------------------------
// handleEscapeHatch — alternative direction (option B)
// ---------------------------------------------------------------------------

describe("handleEscapeHatch — alternative direction", () => {
  it("returns action=revise when rebuilt plan is tactical", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const orch = makeOrchestrator({ classification: "tactical" })
    const result = await handleEscapeHatch(
      "Let's use JWT tokens instead of session cookies",
      state, sm, orch,
    )
    expect(result.action).toBe("revise")
  })

  it("returns action=escape_represent when rebuilt plan is strategic", async () => {
    const state = makeState({ pendingRevisionSteps: [makeRevisionStep("plan")] })
    const orch = makeOrchestrator({ classification: "strategic" })
    const result = await handleEscapeHatch(
      "Let's completely rearchitect using microservices",
      state, sm, orch,
    )
    expect(result.action).toBe("escape_represent")
  })
})

// ---------------------------------------------------------------------------
// handleCascade
// ---------------------------------------------------------------------------

describe("handleCascade — single remaining step", () => {
  it("returns action=revise", () => {
    const step = makeRevisionStep("interfaces")
    const state = makeState({ pendingRevisionSteps: [step], escapePending: false })
    const result = handleCascade(state, sm)
    expect(result.action).toBe("revise")
  })

  it("targetPhase matches the step's phase", () => {
    const step: RevisionStep = { artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "Fix types" }
    const state = makeState({ pendingRevisionSteps: [step], phase: "PLANNING", escapePending: false })
    const result = handleCascade(state, sm)
    if (result.action !== "revise") return
    expect(result.targetPhase).toBe("INTERFACES")
  })

  it("pendingRevisionSteps is empty after consuming last step", () => {
    const step = makeRevisionStep("plan")
    const state = makeState({ pendingRevisionSteps: [step], escapePending: false })
    const result = handleCascade(state, sm)
    if (result.action !== "revise") return
    expect(result.pendingRevisionSteps).toHaveLength(0)
  })

  it("final step message says 'Final revision step'", () => {
    const step = makeRevisionStep("plan")
    const state = makeState({ pendingRevisionSteps: [step], escapePending: false })
    const result = handleCascade(state, sm)
    if (result.action !== "revise") return
    expect(result.message).toContain("Final revision step")
  })
})

describe("handleCascade — multiple remaining steps", () => {
  it("intermediate step message mentions cascade continues", () => {
    const steps = [makeRevisionStep("plan"), makeRevisionStep("interfaces")]
    const state = makeState({ pendingRevisionSteps: steps, escapePending: false })
    const result = handleCascade(state, sm)
    if (result.action !== "revise") return
    expect(result.message.toLowerCase()).toContain("cascade")
  })

  it("pendingRevisionSteps has one fewer element after step consumed", () => {
    const steps = [makeRevisionStep("plan"), makeRevisionStep("interfaces"), makeRevisionStep("tests")]
    const state = makeState({ pendingRevisionSteps: steps, escapePending: false })
    const result = handleCascade(state, sm)
    if (result.action !== "revise") return
    expect(result.pendingRevisionSteps).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// handleNormalRevise
// ---------------------------------------------------------------------------

describe("handleNormalRevise — tactical plan", () => {
  it("returns action=revise", async () => {
    const state = makeState({ escapePending: false })
    const result = await handleNormalRevise("fix error handling", "fallback", state, sm, makeOrchestrator({ classification: "tactical" }))
    expect(result.action).toBe("revise")
  })

  it("message contains 'Orchestrator routing'", async () => {
    const state = makeState({ escapePending: false })
    const result = await handleNormalRevise("fix error handling", "fallback", state, sm, makeOrchestrator({ classification: "tactical" }))
    if (result.action !== "revise") return
    expect(result.message).toContain("Orchestrator routing")
  })
})

describe("handleNormalRevise — strategic plan", () => {
  it("returns action=escape_represent", async () => {
    const state = makeState({ escapePending: false })
    const result = await handleNormalRevise(
      "redesign the whole system",
      "fallback",
      state,
      sm,
      makeOrchestrator({ classification: "strategic" }),
    )
    expect(result.action).toBe("escape_represent")
  })
})

describe("handleNormalRevise — orchestrator throws", () => {
  it("returns action=revise as fallback", async () => {
    const state = makeState({ escapePending: false })
    const result = await handleNormalRevise(
      "fix it",
      "fallback msg",
      state,
      sm,
      makeOrchestrator({ throws: true }),
    )
    expect(result.action).toBe("revise")
  })

  it("fallback message contains 'Orchestrator unavailable'", async () => {
    const state = makeState({ escapePending: false })
    const result = await handleNormalRevise(
      "fix it",
      "fallback msg",
      state,
      sm,
      makeOrchestrator({ throws: true }),
    )
    if (result.action !== "revise") return
    expect(result.message).toContain("Orchestrator unavailable")
  })
})
