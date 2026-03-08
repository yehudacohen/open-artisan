/**
 * Tests for the compaction hook — context block building.
 * Covers G13: ANALYZE sub-state now correctly mentions mark_analyze_complete.
 */
import { describe, expect, it } from "bun:test"
import { buildCompactionContext } from "#plugin/hooks/compaction"
import type { WorkflowState } from "#plugin/types"
import { SCHEMA_VERSION } from "#plugin/types"

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe("buildCompactionContext — structure", () => {
  it("returns a non-empty string", () => {
    const ctx = buildCompactionContext(makeState())
    expect(typeof ctx).toBe("string")
    expect(ctx.length).toBeGreaterThan(0)
  })

  it("includes phase and phaseState", () => {
    const ctx = buildCompactionContext(makeState({ phase: "INTERFACES", phaseState: "REVIEW" }))
    expect(ctx).toContain("INTERFACES")
    expect(ctx).toContain("REVIEW")
  })

  it("includes mode", () => {
    const ctx = buildCompactionContext(makeState({ mode: "INCREMENTAL" }))
    expect(ctx).toContain("INCREMENTAL")
  })

  it("includes last checkpoint tag when present", () => {
    const ctx = buildCompactionContext(makeState({ lastCheckpointTag: "workflow/tests-v2" }))
    expect(ctx).toContain("workflow/tests-v2")
  })
})

// ---------------------------------------------------------------------------
// Next-action guidance per sub-state
// ---------------------------------------------------------------------------

describe("buildCompactionContext — SCAN next action", () => {
  it("mentions mark_scan_complete", () => {
    const ctx = buildCompactionContext(
      makeState({ phase: "DISCOVERY", phaseState: "SCAN", mode: "REFACTOR" }),
    )
    expect(ctx).toContain("mark_scan_complete")
  })
})

describe("buildCompactionContext — ANALYZE next action (G13)", () => {
  it("mentions mark_analyze_complete (G13 fix)", () => {
    const ctx = buildCompactionContext(
      makeState({ phase: "DISCOVERY", phaseState: "ANALYZE", mode: "REFACTOR" }),
    )
    expect(ctx).toContain("mark_analyze_complete")
  })
})

describe("buildCompactionContext — DRAFT next action", () => {
  it("mentions request_review", () => {
    const ctx = buildCompactionContext(makeState({ phaseState: "DRAFT" }))
    expect(ctx).toContain("request_review")
  })
})

describe("buildCompactionContext — REVIEW next action", () => {
  it("mentions mark_satisfied", () => {
    const ctx = buildCompactionContext(makeState({ phaseState: "REVIEW" }))
    expect(ctx).toContain("mark_satisfied")
  })
})

describe("buildCompactionContext — USER_GATE next action", () => {
  it("tells agent to wait for user response", () => {
    const ctx = buildCompactionContext(makeState({ phaseState: "USER_GATE" }))
    expect(ctx.toLowerCase()).toContain("wait")
  })
})

describe("buildCompactionContext — REVISE next action", () => {
  it("mentions request_review", () => {
    const ctx = buildCompactionContext(makeState({ phaseState: "REVISE" }))
    expect(ctx).toContain("request_review")
  })
})

describe("buildCompactionContext — DONE phase", () => {
  it("says workflow is complete", () => {
    const ctx = buildCompactionContext(makeState({ phase: "DONE", phaseState: "DRAFT" }))
    expect(ctx.toLowerCase()).toContain("complete")
  })
})

// ---------------------------------------------------------------------------
// Optional data sections
// ---------------------------------------------------------------------------

describe("buildCompactionContext — approved artifacts section", () => {
  it("includes approved artifacts when present", () => {
    const ctx = buildCompactionContext(
      makeState({ approvedArtifacts: { plan: "abc123def456ab12" } }),
    )
    expect(ctx).toContain("plan")
    expect(ctx).toContain("abc123def456ab12")
  })

  it("omits section when no approved artifacts", () => {
    const ctx = buildCompactionContext(makeState({ approvedArtifacts: {} }))
    expect(ctx).not.toContain("Approved Artifacts")
  })
})

describe("buildCompactionContext — conventions section", () => {
  it("includes conventions when present (non-GREENFIELD)", () => {
    const ctx = buildCompactionContext(
      makeState({
        mode: "REFACTOR",
        conventions: "## My Conventions\nUse snake_case.",
      }),
    )
    expect(ctx).toContain("My Conventions")
  })

  it("omits conventions section when null", () => {
    const ctx = buildCompactionContext(makeState({ conventions: null }))
    expect(ctx).not.toContain("Conventions Document")
  })
})

describe("buildCompactionContext — file allowlist section", () => {
  it("includes allowlist in INCREMENTAL mode", () => {
    const ctx = buildCompactionContext(
      makeState({
        mode: "INCREMENTAL",
        fileAllowlist: ["/project/src/foo.ts"],
      }),
    )
    expect(ctx).toContain("/project/src/foo.ts")
  })

  it("omits allowlist when empty", () => {
    const ctx = buildCompactionContext(
      makeState({ mode: "INCREMENTAL", fileAllowlist: [] }),
    )
    expect(ctx).not.toContain("File Allowlist")
  })
})

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

describe("buildCompactionContext — pure function", () => {
  it("does not mutate state", () => {
    const state = makeState({ iterationCount: 7 })
    buildCompactionContext(state)
    expect(state.iterationCount).toBe(7)
  })
})
