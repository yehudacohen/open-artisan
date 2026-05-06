/**
 * Tests for complete-sub-workflow.ts — completion propagation and timeout detection.
 */
import { describe, expect, it } from "bun:test"
import {
  applyChildCompletion,
  findTimedOutChildren,
  applyDelegationTimeout,
  syncChildWorkflowsWithDag,
} from "#core/tools/complete-sub-workflow"
import { SUB_WORKFLOW_TIMEOUT_MS } from "#core/constants"
import type { WorkflowState } from "#core/workflow-state-types"
import type { TaskNode } from "#core/dag"
import { makeWorkflowState } from "./helpers/workflow-state"

function makeTask(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    description: `Task ${overrides.id}`,
    dependencies: [],
    expectedTests: [],
    expectedFiles: [],
    estimatedComplexity: "medium",
    status: "pending",
    ...overrides,
  }
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return makeWorkflowState({
    sessionId: "parent-session",
    phase: "IMPLEMENTATION",
    approvalCount: 3,
    implDag: [
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "delegated", dependencies: ["T1"] }),
      makeTask({ id: "T3", status: "pending", dependencies: ["T2"] }),
    ],
    featureName: "parent-feature",
    activeAgent: "artisan",
    childWorkflows: [
      {
        taskId: "T2",
        featureName: "parent-feature/sub/billing",
        sessionId: "child-1",
        status: "running",
        delegatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// applyChildCompletion
// ---------------------------------------------------------------------------

describe("applyChildCompletion", () => {
  it("marks childWorkflows entry as complete and DAG task as complete", () => {
    const state = makeState()
    const msg = applyChildCompletion(state, "parent-feature/sub/billing", "T2")
    expect(msg).toContain("completed task")
    expect(state.childWorkflows[0]?.status).toBe("complete")
    expect(state.implDag?.find((t) => t.id === "T2")?.status).toBe("complete")
  })

  it("returns null when childWorkflows entry not found", () => {
    const state = makeState()
    const msg = applyChildCompletion(state, "nonexistent", "T2")
    expect(msg).toBeNull()
  })

  it("handles DAG task not in delegated status", () => {
    const state = makeState({
      implDag: [makeTask({ id: "T2", status: "aborted" })],
    })
    const msg = applyChildCompletion(state, "parent-feature/sub/billing", "T2")
    expect(msg).toContain("was not in")
    expect(state.childWorkflows[0]?.status).toBe("complete") // entry still updated
  })

  it("handles null implDag", () => {
    const state = makeState({ implDag: null })
    const msg = applyChildCompletion(state, "parent-feature/sub/billing", "T2")
    expect(msg).toContain("was not in")
  })
})

// ---------------------------------------------------------------------------
// findTimedOutChildren
// ---------------------------------------------------------------------------

describe("findTimedOutChildren", () => {
  it("returns empty when no children are running", () => {
    const state = makeState({
      childWorkflows: [
        { taskId: "T2", featureName: "x", sessionId: "s1", status: "complete", delegatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    })
    const result = findTimedOutChildren(state)
    expect(result).toEqual([])
  })

  it("returns empty when running children are within timeout", () => {
    const now = Date.now()
    const state = makeState({
      childWorkflows: [
        { taskId: "T2", featureName: "x", sessionId: "s1", status: "running", delegatedAt: new Date(now - 1000).toISOString() },
      ],
    })
    const result = findTimedOutChildren(state, now)
    expect(result).toEqual([])
  })

  it("returns timed-out running children", () => {
    const now = Date.now()
    const state = makeState({
      childWorkflows: [
        {
          taskId: "T2",
          featureName: "x",
          sessionId: "s1",
          status: "running",
          delegatedAt: new Date(now - SUB_WORKFLOW_TIMEOUT_MS - 1000).toISOString(),
        },
      ],
    })
    const result = findTimedOutChildren(state, now)
    expect(result).toHaveLength(1)
    expect(result[0]?.taskId).toBe("T2")
    expect(result[0]?.elapsedMs).toBeGreaterThan(SUB_WORKFLOW_TIMEOUT_MS)
  })

  it("only returns running children, not pending or complete", () => {
    const now = Date.now()
    const old = new Date(now - SUB_WORKFLOW_TIMEOUT_MS - 1000).toISOString()
    const state = makeState({
      childWorkflows: [
        { taskId: "T1", featureName: "a", sessionId: null, status: "pending", delegatedAt: old },
        { taskId: "T2", featureName: "b", sessionId: "s1", status: "running", delegatedAt: old },
        { taskId: "T3", featureName: "c", sessionId: "s2", status: "complete", delegatedAt: old },
      ],
    })
    const result = findTimedOutChildren(state, now)
    expect(result).toHaveLength(1)
    expect(result[0]?.taskId).toBe("T2")
  })
})

// ---------------------------------------------------------------------------
// applyDelegationTimeout
// ---------------------------------------------------------------------------

describe("applyDelegationTimeout", () => {
  it("marks childWorkflows entry as failed and aborts DAG task", () => {
    const state = makeState()
    const aborted = applyDelegationTimeout(state, "T2")
    expect(state.childWorkflows[0]?.status).toBe("failed")
    expect(state.implDag?.find((t) => t.id === "T2")?.status).toBe("aborted")
    expect(aborted).toContain("T2")
  })

  it("cascades abort to downstream dependents", () => {
    const state = makeState()
    const aborted = applyDelegationTimeout(state, "T2")
    // T3 depends on T2 — should be cascade-aborted
    expect(state.implDag?.find((t) => t.id === "T3")?.status).toBe("aborted")
    expect(aborted).toContain("T3")
  })

  it("does not abort already-complete tasks in cascade", () => {
    const state = makeState()
    const aborted = applyDelegationTimeout(state, "T2")
    // T1 was complete — should remain complete
    expect(state.implDag?.find((t) => t.id === "T1")?.status).toBe("complete")
    expect(aborted).not.toContain("T1")
  })
})

// ---------------------------------------------------------------------------
// syncChildWorkflowsWithDag
// ---------------------------------------------------------------------------

describe("syncChildWorkflowsWithDag", () => {
  it("marks running children as failed when DAG is null", () => {
    const state = makeState({ implDag: null })
    const failed = syncChildWorkflowsWithDag(state)
    expect(failed).toEqual(["parent-feature/sub/billing"])
    expect(state.childWorkflows[0]?.status).toBe("failed")
  })

  it("marks running children as failed when their DAG task is aborted", () => {
    const state = makeState({
      implDag: [
        makeTask({ id: "T1", status: "complete" }),
        makeTask({ id: "T2", status: "aborted" }), // was delegated, now aborted
        makeTask({ id: "T3", status: "pending" }),
      ],
    })
    const failed = syncChildWorkflowsWithDag(state)
    expect(failed).toEqual(["parent-feature/sub/billing"])
    expect(state.childWorkflows[0]?.status).toBe("failed")
  })

  it("does not touch children whose DAG task is still delegated", () => {
    const state = makeState() // T2 is "delegated" in default fixture
    const failed = syncChildWorkflowsWithDag(state)
    expect(failed).toEqual([])
    expect(state.childWorkflows[0]?.status).toBe("running")
  })

  it("does not touch already-complete children", () => {
    const state = makeState({
      childWorkflows: [
        { taskId: "T2", featureName: "x", sessionId: "s1", status: "complete", delegatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      implDag: null, // DAG cleared
    })
    const failed = syncChildWorkflowsWithDag(state)
    expect(failed).toEqual([])
    expect(state.childWorkflows[0]?.status).toBe("complete")
  })

  it("handles multiple children with mixed statuses", () => {
    const state = makeState({
      childWorkflows: [
        { taskId: "T2", featureName: "a", sessionId: "s1", status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" },
        { taskId: "T3", featureName: "b", sessionId: "s2", status: "complete", delegatedAt: "2026-01-01T00:00:00.000Z" },
        { taskId: "T4", featureName: "c", sessionId: null, status: "pending", delegatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      implDag: null,
    })
    const failed = syncChildWorkflowsWithDag(state)
    expect(failed).toEqual(["a", "c"]) // running + pending, not complete
    expect(state.childWorkflows[0]?.status).toBe("failed")
    expect(state.childWorkflows[1]?.status).toBe("complete") // unchanged
    expect(state.childWorkflows[2]?.status).toBe("failed")
  })
})
