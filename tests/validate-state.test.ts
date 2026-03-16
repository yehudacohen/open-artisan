/**
 * Tests for validateWorkflowState — the state invariant checker (G4).
 * Also tests resolveSessionId — the session ID resolver (G19).
 */
import { describe, expect, it } from "bun:test"
import { validateWorkflowState, SCHEMA_VERSION } from "#plugin/types"
import type { WorkflowState } from "#plugin/types"
import { resolveSessionId } from "#plugin/utils"

function makeValidState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "GREENFIELD",
    phase: "PLANNING",
    phaseState: "DRAFT",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: [],
    lastCheckpointTag: null,
    approvalCount: 0,
    orchestratorSessionId: null,
    intentBaseline: null,
    modeDetectionNote: null,
    discoveryReport: null,
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// validateWorkflowState
// ---------------------------------------------------------------------------

describe("validateWorkflowState — valid states", () => {
  it("returns null for a fully valid GREENFIELD state", () => {
    expect(validateWorkflowState(makeValidState())).toBeNull()
  })

  it("returns null for DISCOVERY/SCAN in REFACTOR mode", () => {
    expect(
      validateWorkflowState(
        makeValidState({ mode: "REFACTOR", phase: "DISCOVERY", phaseState: "SCAN" }),
      ),
    ).toBeNull()
  })

  it("returns null for IMPLEMENTATION/DRAFT in INCREMENTAL mode with absolute paths", () => {
    expect(
      validateWorkflowState(
        makeValidState({
          mode: "INCREMENTAL",
          phase: "IMPLEMENTATION",
          phaseState: "DRAFT",
          fileAllowlist: ["/project/src/foo.ts"],
        }),
      ),
    ).toBeNull()
  })

  it("returns null for DONE/DRAFT", () => {
    expect(validateWorkflowState(makeValidState({ phase: "DONE", phaseState: "DRAFT" }))).toBeNull()
  })
})

describe("validateWorkflowState — schema version", () => {
  it("rejects wrong schemaVersion", () => {
    const state = makeValidState({ schemaVersion: 999 as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("schemaVersion")
  })
})

describe("validateWorkflowState — sessionId", () => {
  it("rejects empty sessionId", () => {
    const state = makeValidState({ sessionId: "" })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("sessionId")
  })
})

describe("validateWorkflowState — phase/phaseState combinations", () => {
  it("rejects SCAN phaseState in PLANNING phase", () => {
    const state = makeValidState({ phase: "PLANNING", phaseState: "SCAN" as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("SCAN")
    expect(err).toContain("PLANNING")
  })

  it("rejects ANALYZE phaseState in INTERFACES phase", () => {
    const state = makeValidState({ phase: "INTERFACES", phaseState: "ANALYZE" as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
  })

  it("accepts CONVENTIONS phaseState in DISCOVERY phase", () => {
    const state = makeValidState({ phase: "DISCOVERY", phaseState: "CONVENTIONS" })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects CONVENTIONS phaseState in PLANNING phase", () => {
    const state = makeValidState({ phase: "PLANNING", phaseState: "CONVENTIONS" as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
  })

  it("accepts DISCOVERY/REVIEW as a valid state (N4 gap)", () => {
    const state = makeValidState({ mode: "REFACTOR", phase: "DISCOVERY", phaseState: "REVIEW" })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("accepts DISCOVERY/REVISE as a valid state (N4 gap)", () => {
    const state = makeValidState({ mode: "REFACTOR", phase: "DISCOVERY", phaseState: "REVISE" })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("accepts DISCOVERY/USER_GATE as a valid state (N4 gap)", () => {
    const state = makeValidState({ mode: "INCREMENTAL", phase: "DISCOVERY", phaseState: "USER_GATE" })
    expect(validateWorkflowState(state)).toBeNull()
  })
})

describe("validateWorkflowState — numeric counters", () => {
  it("rejects negative iterationCount", () => {
    const err = validateWorkflowState(makeValidState({ iterationCount: -1 }))
    expect(err).not.toBeNull()
    expect(err).toContain("iterationCount")
  })

  it("rejects negative retryCount", () => {
    const err = validateWorkflowState(makeValidState({ retryCount: -3 }))
    expect(err).not.toBeNull()
    expect(err).toContain("retryCount")
  })

  it("rejects negative approvalCount", () => {
    const err = validateWorkflowState(makeValidState({ approvalCount: -1 }))
    expect(err).not.toBeNull()
    expect(err).toContain("approvalCount")
  })

  it("accepts zero for all counters", () => {
    const state = makeValidState({ iterationCount: 0, retryCount: 0, approvalCount: 0 })
    expect(validateWorkflowState(state)).toBeNull()
  })
})

describe("validateWorkflowState — fileAllowlist in INCREMENTAL mode", () => {
  it("rejects relative paths in INCREMENTAL mode", () => {
    const state = makeValidState({
      mode: "INCREMENTAL",
      fileAllowlist: ["src/foo.ts"], // missing leading /
    })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("absolute path")
  })

  it("accepts absolute paths in INCREMENTAL mode", () => {
    const state = makeValidState({
      mode: "INCREMENTAL",
      fileAllowlist: ["/abs/path/foo.ts"],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("does NOT validate paths in GREENFIELD mode (allowlist is N/A)", () => {
    // In GREENFIELD, fileAllowlist is empty and relative paths are irrelevant
    const state = makeValidState({
      mode: "GREENFIELD",
      fileAllowlist: ["relative/path.ts"], // would fail in INCREMENTAL, but not GREENFIELD
    })
    expect(validateWorkflowState(state)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateWorkflowState — escapePending / pendingRevisionSteps (schema v2)
// ---------------------------------------------------------------------------

describe("validateWorkflowState — escapePending and pendingRevisionSteps", () => {
  it("accepts escapePending=false with pendingRevisionSteps=null", () => {
    const state = makeValidState({ escapePending: false, pendingRevisionSteps: null })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("accepts escapePending=true with non-null pendingRevisionSteps and ESCAPE_HATCH phaseState", () => {
    const state = makeValidState({
      escapePending: true,
      phaseState: "ESCAPE_HATCH",
      pendingRevisionSteps: [
        { artifact: "interfaces", phase: "INTERFACES", phaseState: "REVISE", instructions: "fix it" },
      ],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects escapePending as non-boolean", () => {
    const state = makeValidState({ escapePending: "yes" as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("escapePending")
  })

  it("rejects pendingRevisionSteps as a non-null non-array", () => {
    const state = makeValidState({ pendingRevisionSteps: "invalid" as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("pendingRevisionSteps")
  })

  it("rejects escapePending=true with pendingRevisionSteps=null", () => {
    const state = makeValidState({ escapePending: true, pendingRevisionSteps: null })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("escapePending")
  })

  it("rejects escapePending=true with pendingRevisionSteps=[] (empty)", () => {
    const state = makeValidState({ escapePending: true, pendingRevisionSteps: [] })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("escapePending")
  })
})

// ---------------------------------------------------------------------------
// resolveSessionId (G19)
// ---------------------------------------------------------------------------

describe("resolveSessionId — field resolution", () => {
  it("resolves context.sessionId", () => {
    expect(resolveSessionId({ sessionId: "abc-123" })).toBe("abc-123")
  })

  it("resolves context.session.id", () => {
    expect(resolveSessionId({ session: { id: "session-from-object" } })).toBe("session-from-object")
  })

  it("resolves context.session_id (snake_case fallback)", () => {
    expect(resolveSessionId({ session_id: "snake-case-id" } as any)).toBe("snake-case-id")
  })

  it("resolves context.sessionID (camelCase fallback)", () => {
    expect(resolveSessionId({ sessionID: "camel-case-id" } as any)).toBe("camel-case-id")
  })

  it("resolves context.id as last resort", () => {
    expect(resolveSessionId({ id: "bare-id" } as any)).toBe("bare-id")
  })

  it("returns null when no session ID field found", () => {
    expect(resolveSessionId({ directory: "/some/dir" })).toBeNull()
  })

  it("prefers context.sessionId over context.session.id", () => {
    expect(
      resolveSessionId({ sessionId: "preferred", session: { id: "fallback" } }),
    ).toBe("preferred")
  })

  it("returns null for empty context object", () => {
    expect(resolveSessionId({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// New field validations (v6 schema: currentTaskId, feedbackHistory, implDag, conventions)
// ---------------------------------------------------------------------------

describe("validateWorkflowState — v6 fields", () => {
  it("accepts valid currentTaskId (string)", () => {
    const state = makeValidState({ currentTaskId: "T1" })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("accepts valid currentTaskId (null)", () => {
    const state = makeValidState({ currentTaskId: null })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects currentTaskId as a non-null non-string", () => {
    const state = makeValidState({ currentTaskId: 42 as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("currentTaskId")
  })

  it("accepts valid feedbackHistory (empty array)", () => {
    const state = makeValidState({ feedbackHistory: [] })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("accepts valid feedbackHistory (non-empty array)", () => {
    const state = makeValidState({
      feedbackHistory: [
        { phase: "PLANNING" as const, feedback: "change the scope", timestamp: 1234 },
      ],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects feedbackHistory as a non-array", () => {
    const state = makeValidState({ feedbackHistory: "invalid" as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("feedbackHistory")
  })

  it("accepts valid conventions (string)", () => {
    const state = makeValidState({ conventions: "Use camelCase" })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects conventions as a non-null non-string", () => {
    const state = makeValidState({ conventions: 42 as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("conventions")
  })

  it("accepts valid implDag", () => {
    const state = makeValidState({
      implDag: [
        { id: "T1", description: "Build it", dependencies: [], expectedTests: [], estimatedComplexity: "small" as const, status: "pending" as const },
      ],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects implDag as a non-null non-array", () => {
    const state = makeValidState({ implDag: "wrong" as any })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("implDag")
  })

  it("rejects implDag task missing id", () => {
    const state = makeValidState({
      implDag: [{ description: "no id", dependencies: [], status: "pending" } as any],
    })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("id")
  })

  it("rejects implDag task missing dependencies array", () => {
    const state = makeValidState({
      implDag: [{ id: "T1", description: "bad", dependencies: "not-array", status: "pending" } as any],
    })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("dependencies")
  })

  it("rejects implDag task with invalid status", () => {
    const state = makeValidState({
      implDag: [{ id: "T1", description: "bad", dependencies: [], status: "invalid" } as any],
    })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("invalid status")
  })

  it("accepts implDag tasks with all valid statuses", () => {
    const state = makeValidState({
      implDag: [
        { id: "T1", description: "a", dependencies: [], expectedTests: [], estimatedComplexity: "small" as const, status: "pending" as const },
        { id: "T2", description: "b", dependencies: ["T1"], expectedTests: [], estimatedComplexity: "medium" as const, status: "in-flight" as const },
        { id: "T3", description: "c", dependencies: [], expectedTests: [], estimatedComplexity: "large" as const, status: "complete" as const },
        { id: "T4", description: "d", dependencies: [], expectedTests: [], estimatedComplexity: "small" as const, status: "aborted" as const },
      ],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// feedbackHistory structural validation
// ---------------------------------------------------------------------------

describe("validateWorkflowState — feedbackHistory structural validation", () => {
  it("accepts valid feedbackHistory entries", () => {
    const result = validateWorkflowState(
      makeValidState({
        feedbackHistory: [{ phase: "PLANNING", feedback: "looks good", timestamp: 123456 }],
      }),
    )
    expect(result).toBeNull()
  })

  it("rejects feedbackHistory entry with missing phase", () => {
    const err = validateWorkflowState(
      makeValidState({
        feedbackHistory: [{ feedback: "test", timestamp: 123 } as any],
      }),
    )
    expect(err).not.toBeNull()
    expect(err).toContain("feedbackHistory[0].phase")
  })

  it("rejects feedbackHistory entry with missing feedback", () => {
    const err = validateWorkflowState(
      makeValidState({
        feedbackHistory: [{ phase: "PLANNING", timestamp: 123 } as any],
      }),
    )
    expect(err).not.toBeNull()
    expect(err).toContain("feedbackHistory[0].feedback")
  })

  it("rejects feedbackHistory entry with negative timestamp", () => {
    const err = validateWorkflowState(
      makeValidState({
        feedbackHistory: [{ phase: "PLANNING", feedback: "test", timestamp: -1 }],
      }),
    )
    expect(err).not.toBeNull()
    expect(err).toContain("feedbackHistory[0].timestamp")
  })

  it("accepts empty feedbackHistory", () => {
    const result = validateWorkflowState(makeValidState({ feedbackHistory: [] }))
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// phaseApprovalCounts validation
// ---------------------------------------------------------------------------

describe("validateWorkflowState — phaseApprovalCounts validation", () => {
  it("accepts empty phaseApprovalCounts", () => {
    const result = validateWorkflowState(makeValidState({ phaseApprovalCounts: {} }))
    expect(result).toBeNull()
  })

  it("accepts valid phaseApprovalCounts", () => {
    const result = validateWorkflowState(
      makeValidState({ phaseApprovalCounts: { PLANNING: 2, INTERFACES: 1 } }),
    )
    expect(result).toBeNull()
  })

  it("rejects negative phaseApprovalCounts value", () => {
    const err = validateWorkflowState(
      makeValidState({ phaseApprovalCounts: { PLANNING: -1 } }),
    )
    expect(err).not.toBeNull()
    expect(err).toContain("phaseApprovalCounts")
  })
})

// ---------------------------------------------------------------------------
// userGateMessageReceived validation (v8)
// ---------------------------------------------------------------------------

describe("validateWorkflowState — userGateMessageReceived validation", () => {
  it("accepts userGateMessageReceived=false", () => {
    const result = validateWorkflowState(makeValidState({ userGateMessageReceived: false }))
    expect(result).toBeNull()
  })

  it("accepts userGateMessageReceived=true", () => {
    const result = validateWorkflowState(makeValidState({ userGateMessageReceived: true }))
    expect(result).toBeNull()
  })

  it("rejects non-boolean userGateMessageReceived", () => {
    const state = makeValidState()
    ;(state as any).userGateMessageReceived = "yes"
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("userGateMessageReceived")
    expect(err).toContain("boolean")
  })

  it("rejects undefined userGateMessageReceived", () => {
    const state = makeValidState()
    ;(state as any).userGateMessageReceived = undefined
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("userGateMessageReceived")
  })
})

// ---------------------------------------------------------------------------
// ESCAPE_HATCH cross-field invariant (M2)
// ---------------------------------------------------------------------------

describe("validateWorkflowState — ESCAPE_HATCH invariant", () => {
  it("accepts escapePending=true with phaseState=ESCAPE_HATCH (valid)", () => {
    const state = makeValidState({
      escapePending: true,
      phaseState: "ESCAPE_HATCH",
      pendingRevisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "revise plan" },
      ],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects escapePending=true with phaseState=USER_GATE (cross-field invariant violated)", () => {
    const state = makeValidState({
      escapePending: true,
      phaseState: "USER_GATE",
      pendingRevisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "revise plan" },
      ],
    })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("escapePending")
    expect(err).toContain("ESCAPE_HATCH")
  })

  it("rejects escapePending=true with phaseState=DRAFT (cross-field invariant violated)", () => {
    const state = makeValidState({
      escapePending: true,
      phaseState: "DRAFT",
      pendingRevisionSteps: [
        { artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "revise plan" },
      ],
    })
    const err = validateWorkflowState(state)
    expect(err).not.toBeNull()
    expect(err).toContain("escapePending")
    expect(err).toContain("ESCAPE_HATCH")
  })
})
