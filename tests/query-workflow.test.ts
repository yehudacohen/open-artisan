/**
 * Tests for query-workflow.ts — read-only cross-workflow inspection.
 */
import { describe, expect, it } from "bun:test"
import { processQueryParentWorkflow, processQueryChildWorkflow } from "#core/tools/query-workflow"
import { SCHEMA_VERSION, type WorkflowState } from "#core/workflow-state-types"

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
    modeDetectionNote: null,
    discoveryReport: null,
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    currentTaskId: null,
    feedbackHistory: [],
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
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
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// query_parent_workflow
// ---------------------------------------------------------------------------

describe("query_parent_workflow", () => {
  it("rejects when session has no parentWorkflow", () => {
    const child = makeState({ parentWorkflow: null })
    const result = processQueryParentWorkflow(child, null)
    expect(result.error).toContain("not a sub-workflow")
  })

  it("returns error when parent state not found", () => {
    const child = makeState({
      parentWorkflow: { sessionId: "p1", featureName: "parent-feat", taskId: "T1" },
    })
    const result = processQueryParentWorkflow(child, null)
    expect(result.error).toContain("not found")
  })

  it("handles parent with null conventions and intentBaseline", () => {
    const child = makeState({
      parentWorkflow: { sessionId: "p1", featureName: "parent-feat", taskId: "T1" },
    })
    const parent = makeState({
      featureName: "parent-feat",
      phase: "PLANNING",
      phaseState: "DRAFT",
      mode: "GREENFIELD",
      conventions: null,
      intentBaseline: null,
    })
    const result = processQueryParentWorkflow(child, parent)
    expect(result.error).toBeUndefined()
    expect(result.conventions).toBeNull()
    expect(result.intentBaseline).toBeNull()
  })

  it("returns parent phase, mode, conventions, artifacts", () => {
    const child = makeState({
      parentWorkflow: { sessionId: "p1", featureName: "parent-feat", taskId: "T1" },
    })
    const parent = makeState({
      featureName: "parent-feat",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      mode: "REFACTOR",
      conventions: "Use camelCase",
      approvedArtifacts: { plan: "abc123" },
      artifactDiskPaths: { plan: "/proj/.openartisan/parent-feat/plan.md" },
      intentBaseline: "Build a billing system",
    })
    const result = processQueryParentWorkflow(child, parent)
    expect(result.error).toBeUndefined()
    expect(result.phase).toBe("IMPLEMENTATION")
    expect(result.mode).toBe("REFACTOR")
    expect(result.conventions).toBe("Use camelCase")
    expect(result.approvedArtifacts).toEqual({ plan: "abc123" })
    expect(result.artifactDiskPaths).toEqual({ plan: "/proj/.openartisan/parent-feat/plan.md" })
    expect(result.intentBaseline).toBe("Build a billing system")
  })
})

// ---------------------------------------------------------------------------
// query_child_workflow
// ---------------------------------------------------------------------------

describe("query_child_workflow", () => {
  it("rejects when task_id not in childWorkflows", () => {
    const parent = makeState({ childWorkflows: [] })
    const result = processQueryChildWorkflow(parent, "T99", null)
    expect(result.error).toContain("No child workflow")
    expect(result.error).toContain("T99")
  })

  it("returns basic info when child state not loaded", () => {
    const parent = makeState({
      childWorkflows: [
        { taskId: "T3", featureName: "parent/sub/billing", sessionId: null, status: "pending", delegatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    })
    const result = processQueryChildWorkflow(parent, "T3", null)
    expect(result.error).toBeUndefined()
    expect(result.taskId).toBe("T3")
    expect(result.childFeatureName).toBe("parent/sub/billing")
    expect(result.childStatus).toBe("pending")
    expect(result.phase).toBeUndefined() // no child state loaded
  })

  it("returns full info when child state is loaded", () => {
    const parent = makeState({
      childWorkflows: [
        { taskId: "T3", featureName: "parent/sub/billing", sessionId: "child-1", status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    })
    const child = makeState({
      featureName: "parent/sub/billing",
      phase: "TESTS",
      phaseState: "DRAFT",
      mode: "GREENFIELD",
      currentTaskId: "T2",
      implDag: [
        { id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "d", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium", status: "in-flight" },
        { id: "T3", description: "d", dependencies: ["T2"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ],
    })
    const result = processQueryChildWorkflow(parent, "T3", child)
    expect(result.error).toBeUndefined()
    expect(result.phase).toBe("TESTS")
    expect(result.phaseState).toBe("DRAFT")
    expect(result.mode).toBe("GREENFIELD")
    expect(result.currentTaskId).toBe("T2")
    expect(result.implDagProgress).toEqual({ total: 3, complete: 1, delegated: 0 })
  })

  it("lists valid delegated tasks in error message", () => {
    const parent = makeState({
      childWorkflows: [
        { taskId: "T1", featureName: "a", sessionId: null, status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" },
        { taskId: "T2", featureName: "b", sessionId: null, status: "complete", delegatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    })
    const result = processQueryChildWorkflow(parent, "T99", null)
    expect(result.error).toContain("T1")
    expect(result.error).toContain("T2")
  })
})
