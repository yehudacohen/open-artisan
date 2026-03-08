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
    escapePending: false,
    pendingRevisionSteps: null,
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

  it("accepts escapePending=true with non-null pendingRevisionSteps", () => {
    const state = makeValidState({
      escapePending: true,
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
