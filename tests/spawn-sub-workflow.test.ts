/**
 * Tests for spawn-sub-workflow.ts — core validation logic.
 *
 * Covers:
 * - Phase validation (only IMPLEMENTATION)
 * - DAG presence check
 * - Task lookup and status validation
 * - Feature name validation
 * - Depth limit (MAX_SUB_WORKFLOWS)
 * - Feature name collision detection
 * - Success case
 */
import { describe, expect, it } from "bun:test"
import { processSpawnSubWorkflow } from "#core/tools/spawn-sub-workflow"
import { SCHEMA_VERSION } from "#core/types"
import type { WorkflowState } from "#core/types"
import type { TaskNode } from "#core/dag"
import { MAX_SUB_WORKFLOWS } from "#core/constants"

function makeTask(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    description: `Task ${overrides.id}`,
    dependencies: [],
    expectedTests: [],
    estimatedComplexity: "medium",
    status: "pending",
    ...overrides,
  }
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "parent-session",
    mode: "GREENFIELD",
    phase: "IMPLEMENTATION",
    phaseState: "DRAFT",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: [],
    lastCheckpointTag: null,
    approvalCount: 3,
    orchestratorSessionId: null,
    intentBaseline: null,
    modeDetectionNote: null,
    discoveryReport: null,
    implDag: [
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "pending", dependencies: ["T1"] }),
      makeTask({ id: "T3", status: "pending", dependencies: ["T1"] }),
    ],
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    currentTaskId: null,
    feedbackHistory: [],
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
    artifactDiskPaths: {},
    featureName: "parent-feature",
    revisionBaseline: null,
    activeAgent: "artisan",
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Phase validation
// ---------------------------------------------------------------------------

describe("spawn_sub_workflow — phase validation", () => {
  it("rejects when not in IMPLEMENTATION phase", () => {
    const state = makeState({ phase: "PLANNING", phaseState: "DRAFT" })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "child" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("IMPLEMENTATION")
    }
  })

  it("rejects when implDag is null", () => {
    const state = makeState({ implDag: null })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "child" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("no implementation DAG")
    }
  })

  it("rejects when implDag is empty", () => {
    const state = makeState({ implDag: [] })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "child" },
      state,
    )
    expect("error" in result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task validation
// ---------------------------------------------------------------------------

describe("spawn_sub_workflow — task validation", () => {
  it("rejects unknown task ID", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T99", feature_name: "child" },
      makeState(),
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("T99")
      expect(result.error).toContain("not found")
    }
  })

  it("rejects already delegated task", () => {
    const state = makeState({
      implDag: [makeTask({ id: "T1", status: "delegated" })],
    })
    const result = processSpawnSubWorkflow(
      { task_id: "T1", feature_name: "child" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("already delegated")
    }
  })

  it("rejects complete task", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T1", feature_name: "child" }, // T1 is complete in default fixture
      makeState(),
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("already complete")
    }
  })

  it("rejects aborted task", () => {
    const state = makeState({
      implDag: [makeTask({ id: "T1", status: "aborted" })],
    })
    const result = processSpawnSubWorkflow(
      { task_id: "T1", feature_name: "child" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("aborted")
    }
  })

  it("rejects human-gated task", () => {
    const state = makeState({
      implDag: [makeTask({ id: "T1", status: "human-gated", category: "human-gate", humanGate: { whatIsNeeded: "x", why: "y", verificationSteps: "z", resolved: false } })],
    })
    const result = processSpawnSubWorkflow(
      { task_id: "T1", feature_name: "child" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("human-gated")
    }
  })

  it("accepts pending task", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "child-feat" },
      makeState(),
    )
    expect("error" in result).toBe(false)
  })

  it("rejects in-flight task (agent is already working on it)", () => {
    const state = makeState({
      implDag: [
        makeTask({ id: "T1", status: "complete" }),
        makeTask({ id: "T2", status: "in-flight", dependencies: ["T1"] }),
      ],
    })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "child-feat" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("in-flight")
    }
  })
})

// ---------------------------------------------------------------------------
// Feature name validation
// ---------------------------------------------------------------------------

describe("spawn_sub_workflow — feature name validation", () => {
  it("rejects empty feature name", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "" },
      makeState(),
    )
    expect("error" in result).toBe(true)
  })

  it("rejects feature name with path traversal", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "../escape" },
      makeState(),
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("..")
    }
  })

  it("rejects feature name with slashes", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "sub/dir" },
      makeState(),
    )
    expect("error" in result).toBe(true)
  })

  it("rejects feature name starting with special char", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "-bad-name" },
      makeState(),
    )
    expect("error" in result).toBe(true)
  })

  it("rejects reserved name 'sub'", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "sub" },
      makeState(),
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("reserved")
    }
  })

  it("accepts kebab-case feature name", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "billing-engine" },
      makeState(),
    )
    expect("error" in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Depth limit
// ---------------------------------------------------------------------------

describe("spawn_sub_workflow — depth and sibling limits", () => {
  it("rejects when nesting depth exceeds MAX_SUB_WORKFLOW_DEPTH", () => {
    // Parent is already at depth 3: a/sub/b/sub/c/sub/d (3 /sub/ segments)
    const state = makeState({
      featureName: "a/sub/b/sub/c/sub/d",
    })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "too-deep" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("nesting depth")
    }
  })

  it("rejects when at max active sub-workflows (sibling limit)", () => {
    const children = Array.from({ length: MAX_SUB_WORKFLOWS }, (_, i) => ({
      taskId: `existing-${i}`,
      featureName: `child-${i}`,
      sessionId: `session-${i}`,
      status: "running" as const,
      delegatedAt: "2026-01-01T00:00:00.000Z",
    }))
    const state = makeState({ childWorkflows: children })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "new-child" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain(`Maximum ${MAX_SUB_WORKFLOWS}`)
    }
  })

  it("allows spawn when completed children don't count against limit", () => {
    const children = Array.from({ length: MAX_SUB_WORKFLOWS }, (_, i) => ({
      taskId: `done-${i}`,
      featureName: `child-${i}`,
      sessionId: `session-${i}`,
      status: "complete" as const,
      delegatedAt: "2026-01-01T00:00:00.000Z",
    }))
    const state = makeState({ childWorkflows: children })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "new-child" },
      state,
    )
    expect("error" in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Feature name collision
// ---------------------------------------------------------------------------

describe("spawn_sub_workflow — feature name collision", () => {
  it("rejects feature name matching parent", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "parent-feature" }, // same as parent's featureName
      makeState(),
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("same as the parent")
    }
  })

  it("rejects duplicate feature name among siblings", () => {
    const state = makeState({
      childWorkflows: [
        // Nested featureName as stored by the adapter
        { taskId: "T1", featureName: "parent-feature/sub/billing", sessionId: null, status: "pending", delegatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    })
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "billing" },
      state,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("already exists")
    }
  })
})

// ---------------------------------------------------------------------------
// Success case
// ---------------------------------------------------------------------------

describe("spawn_sub_workflow — success", () => {
  it("returns task and childFeatureName on valid spawn", () => {
    const result = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "billing-engine" },
      makeState(),
    )
    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(result.task.id).toBe("T2")
      expect(result.childFeatureName).toBe("parent-feature/sub/billing-engine")
      expect(result.responseMessage).toContain("T2")
      expect(result.responseMessage).toContain("billing-engine")
      expect(result.responseMessage).toContain("delegated")
    }
  })
})
