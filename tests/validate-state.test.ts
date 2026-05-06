/**
 * Tests for validateWorkflowState — the state invariant checker (G4).
 * Also tests resolveSessionId — the session ID resolver (G19).
 */
import { describe, expect, it } from "bun:test"
import { SCHEMA_VERSION, validateWorkflowState, type WorkflowState } from "#core/workflow-state-types"
import { resolveSessionId } from "#core/utils"

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
    const state = makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" }],
      currentTaskId: "T1",
    })
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
        { id: "T1", description: "Build it", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small" as const, status: "pending" as const },
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
        { id: "T1", description: "a", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small" as const, status: "pending" as const },
        { id: "T2", description: "b", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium" as const, status: "in-flight" as const },
        { id: "T3", description: "c", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "large" as const, status: "complete" as const },
        { id: "T4", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small" as const, status: "aborted" as const },
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

// ---------------------------------------------------------------------------
// featureName security validation (path traversal prevention)
// ---------------------------------------------------------------------------

describe("validateWorkflowState — featureName path traversal prevention", () => {
  it("rejects featureName containing '..'", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "../../../etc" }))
    expect(err).not.toBeNull()
    expect(err).toContain("..")
    expect(err).toContain("path traversal")
  })

  it("accepts nested featureName for sub-workflows (parent/sub/child)", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "parent-feat/sub/billing-engine" }))
    expect(err).toBeNull()
  })

  it("rejects featureName containing '\\'", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "foo\\bar" }))
    expect(err).not.toBeNull()
    expect(err).toContain("backslash")
  })

  it("rejects featureName with invalid segment", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "parent/.bad/child" }))
    expect(err).not.toBeNull()
    expect(err).toContain("segment")
  })

  it("rejects featureName with leading slash", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "/parent/sub/child" }))
    expect(err).not.toBeNull()
    expect(err).toContain("start or end")
  })

  it("rejects featureName with consecutive slashes", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "parent//child" }))
    expect(err).not.toBeNull()
    expect(err).toContain("consecutive")
  })

  it("rejects featureName starting with a dot", () => {
    const err = validateWorkflowState(makeValidState({ featureName: ".hidden" }))
    expect(err).not.toBeNull()
    expect(err).toContain("alphanumeric")
  })

  it("rejects featureName starting with a hyphen", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "-bad-name" }))
    expect(err).not.toBeNull()
    expect(err).toContain("alphanumeric")
  })

  it("rejects featureName with special characters", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "feat$name" }))
    expect(err).not.toBeNull()
    expect(err).toContain("alphanumeric")
  })

  it("rejects featureName with spaces", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "feat name" }))
    expect(err).not.toBeNull()
    expect(err).toContain("alphanumeric")
  })

  it("accepts valid featureName (alphanumeric with hyphens)", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "my-feature-123" }))
    expect(err).toBeNull()
  })

  it("accepts valid featureName (alphanumeric with underscores)", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "my_feature_v2" }))
    expect(err).toBeNull()
  })

  it("accepts valid featureName (alphanumeric with dots)", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "feature.v1.2" }))
    expect(err).toBeNull()
  })

  it("accepts single character featureName", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "x" }))
    expect(err).toBeNull()
  })

  it("accepts null featureName", () => {
    const err = validateWorkflowState(makeValidState({ featureName: null }))
    expect(err).toBeNull()
  })

  it("accepts nested featureName for sub-workflows", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "parent/sub/child" }))
    expect(err).toBeNull()
  })

  it("rejects top-level featureName 'sub' (reserved)", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "sub" }))
    expect(err).not.toBeNull()
    expect(err).toContain("reserved")
  })

  it("allows 'sub' as interior segment in nested featureName", () => {
    const err = validateWorkflowState(makeValidState({ featureName: "parent/sub/child" }))
    expect(err).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateWorkflowState — v21 sub-workflow cross-field invariants
// ---------------------------------------------------------------------------

describe("validateWorkflowState — v21 sub-workflow invariants", () => {
  it("rejects running childWorkflow when DAG task is not delegated", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" }],
      childWorkflows: [{ taskId: "T1", featureName: "child", sessionId: "s1", status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" }],
    }))
    expect(err).not.toBeNull()
    expect(err).toContain("delegated")
  })

  it("accepts running childWorkflow when DAG task IS delegated", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "delegated" }],
      childWorkflows: [{ taskId: "T1", featureName: "child", sessionId: "s1", status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" }],
    }))
    expect(err).toBeNull()
  })

  it("accepts complete childWorkflow regardless of DAG task status", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" }],
      childWorkflows: [{ taskId: "T1", featureName: "child", sessionId: "s1", status: "complete", delegatedAt: "2026-01-01T00:00:00.000Z" }],
    }))
    expect(err).toBeNull()
  })

  it("skips cross-field check when implDag is null", () => {
    const err = validateWorkflowState(makeValidState({
      implDag: null,
      childWorkflows: [{ taskId: "T1", featureName: "child", sessionId: "s1", status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" }],
    }))
    expect(err).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// v22: reviewArtifactFiles validation
// ---------------------------------------------------------------------------

describe("validateWorkflowState — v22 reviewArtifactFiles", () => {
  it("accepts valid string array", () => {
    const err = validateWorkflowState(makeValidState({
      reviewArtifactFiles: ["src/foo.ts", "pages/01.html"],
    }))
    expect(err).toBeNull()
  })

  it("accepts empty array", () => {
    const err = validateWorkflowState(makeValidState({
      reviewArtifactFiles: [],
    }))
    expect(err).toBeNull()
  })

  it("rejects non-array reviewArtifactFiles", () => {
    const err = validateWorkflowState(makeValidState({
      reviewArtifactFiles: "not-an-array" as any,
    }))
    expect(err).toContain("reviewArtifactFiles must be an array")
  })

  it("rejects array with non-string elements", () => {
    const err = validateWorkflowState(makeValidState({
      reviewArtifactFiles: ["valid.ts", 42 as any],
    }))
    expect(err).toContain("reviewArtifactFiles[1] must be a string")
  })
})

// ---------------------------------------------------------------------------
// v22: implDag expectedFiles validation
// ---------------------------------------------------------------------------

describe("validateWorkflowState — v22 implDag expectedFiles", () => {
  it("accepts tasks with valid expectedFiles array", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{
        id: "T1", description: "d", dependencies: [], expectedTests: [],
        expectedFiles: ["src/foo.ts", "src/bar.ts"],
        estimatedComplexity: "small", status: "pending",
      }],
    }))
    expect(err).toBeNull()
  })

  it("accepts tasks without expectedFiles (backward compat)", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{
        id: "T1", description: "d", dependencies: [], expectedTests: [],
        estimatedComplexity: "small", status: "pending",
        // No expectedFiles — should be valid (optional)
      } as any],
    }))
    expect(err).toBeNull()
  })

  it("rejects non-array expectedFiles", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{
        id: "T1", description: "d", dependencies: [], expectedTests: [],
        expectedFiles: "not-an-array" as any,
        estimatedComplexity: "small", status: "pending",
      }],
    }))
    expect(err).toContain('expectedFiles must be an array')
  })

  it("rejects expectedFiles with non-string elements", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{
        id: "T1", description: "d", dependencies: [], expectedTests: [],
        expectedFiles: ["valid.ts", 123 as any],
        estimatedComplexity: "small", status: "pending",
      }],
    }))
    expect(err).toContain('expectedFiles[1] must be a string')
  })
})

describe("validateWorkflowState — implementation pointer invariants", () => {
  it("rejects currentTaskId outside IMPLEMENTATION", () => {
    const err = validateWorkflowState(makeValidState({ phase: "PLANNING", currentTaskId: "T1" }))
    expect(err).toContain("currentTaskId must be null outside IMPLEMENTATION")
  })

  it("rejects taskCompletionInProgress that does not match currentTaskId", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" }],
      currentTaskId: "T2",
      taskCompletionInProgress: "T1",
      taskReviewCount: 1,
    }))
    expect(err).toContain("must match currentTaskId")
  })

  it("rejects DONE with unresolved DAG work", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "DONE",
      implDag: [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" }],
    }))
    expect(err).toContain("DONE cannot contain unresolved implDag work")
  })

  it("rejects currentTaskId pointing at a completed task when no review is pending", () => {
    const err = validateWorkflowState(makeValidState({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" }],
      currentTaskId: "T1",
      taskReviewCount: 1,
    }))
    expect(err).toContain("cannot point to a terminal task")
  })
})
