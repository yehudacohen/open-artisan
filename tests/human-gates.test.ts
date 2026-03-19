/**
 * Tests for human gates — the full pipeline from DAG types through scheduler,
 * parser, task-review stub detection, and state validation.
 *
 * Covers:
 * - dag.ts: TaskCategory, HumanGateInfo, human-gated status, getReadyHumanGates,
 *           hasUnresolvedHumanGates, isComplete with human-gated tasks
 * - scheduler.ts: SchedulerAwaitingHuman, auto-transition of human-gate tasks,
 *                 resolveHumanGate, abort cascade with human-gated tasks
 * - impl-plan-parser.ts: Category field parsing
 * - task-review.ts: stub detection check #5, category-aware exceptions
 * - types.ts: schema v12 validation of human-gated status, category, humanGate
 * - mark-task-complete.ts: human-gated task rejection
 */
import { describe, expect, it } from "bun:test"
import { createImplDAG } from "#plugin/dag"
import type { TaskNode, TaskCategory, HumanGateInfo } from "#plugin/dag"
import {
  nextSchedulerDecision,
  markTaskComplete,
  markTaskAborted,
  resolveHumanGate,
} from "#plugin/scheduler"
import { parseImplPlan } from "#plugin/impl-plan-parser"
import { buildTaskReviewPrompt } from "#plugin/task-review"
import { validateWorkflowState, SCHEMA_VERSION } from "#plugin/types"
import type { WorkflowState } from "#plugin/types"
import { processMarkTaskComplete } from "#plugin/tools/mark-task-complete"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    sessionId: "test-session",
    mode: "GREENFIELD",
    phase: "IMPLEMENTATION",
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
    currentTaskId: null,
    feedbackHistory: [],
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
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
    ...overrides,
  }
}

// ===========================================================================
// dag.ts — TaskCategory and HumanGateInfo
// ===========================================================================

describe("DAG — TaskCategory", () => {
  it("accepts all valid categories on TaskNode", () => {
    const categories: TaskCategory[] = ["scaffold", "human-gate", "integration", "standalone"]
    for (const cat of categories) {
      const dag = createImplDAG([makeTask({ id: "T1", category: cat })])
      expect(dag.validate().valid).toBe(true)
    }
  })

  it("tasks without category default to no category (undefined)", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    expect(dag.tasks[0]!.category).toBeUndefined()
  })
})

describe("DAG — getReady() excludes human-gate tasks", () => {
  it("does not include human-gate category tasks in ready list", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", category: "standalone" }),
      makeTask({ id: "T2", category: "human-gate" }),
    ])
    const ready = dag.getReady()
    expect(ready).toHaveLength(1)
    expect(ready[0]!.id).toBe("T1")
  })

  it("includes scaffold and integration tasks in ready list", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", category: "scaffold" }),
      makeTask({ id: "T2", category: "integration" }),
    ])
    const ready = dag.getReady()
    expect(ready).toHaveLength(2)
  })

  it("includes tasks without category (undefined) in ready list", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const ready = dag.getReady()
    expect(ready).toHaveLength(1)
  })
})

describe("DAG — getReadyHumanGates()", () => {
  it("returns human-gate tasks whose deps are all complete", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete", category: "scaffold" }),
      makeTask({ id: "T2", category: "human-gate", dependencies: ["T1"] }),
    ])
    const gates = dag.getReadyHumanGates()
    expect(gates).toHaveLength(1)
    expect(gates[0]!.id).toBe("T2")
  })

  it("does not return human-gate tasks with incomplete deps", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", category: "scaffold" }),
      makeTask({ id: "T2", category: "human-gate", dependencies: ["T1"] }),
    ])
    const gates = dag.getReadyHumanGates()
    expect(gates).toHaveLength(0)
  })

  it("does not return non-human-gate tasks", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", category: "standalone" }),
    ])
    const gates = dag.getReadyHumanGates()
    expect(gates).toHaveLength(0)
  })

  it("does not return already human-gated tasks", () => {
    const dag = createImplDAG([
      makeTask({
        id: "T1",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "test", why: "test", verificationSteps: "test", resolved: false },
      }),
    ])
    const gates = dag.getReadyHumanGates()
    expect(gates).toHaveLength(0)
  })
})

describe("DAG — isComplete() with human-gated tasks", () => {
  it("returns false if a task is human-gated and not resolved", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({
        id: "T2",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "creds", why: "need them", verificationSteps: "check", resolved: false },
      }),
    ])
    expect(dag.isComplete()).toBe(false)
  })

  it("returns true if all tasks are complete or aborted (no human-gated)", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "aborted" }),
    ])
    expect(dag.isComplete()).toBe(true)
  })
})

describe("DAG — hasUnresolvedHumanGates()", () => {
  it("returns true when human-gated task has resolved=false", () => {
    const dag = createImplDAG([
      makeTask({
        id: "T1",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "creds", why: "need", verificationSteps: "check", resolved: false },
      }),
    ])
    expect(dag.hasUnresolvedHumanGates()).toBe(true)
  })

  it("returns false when no human-gated tasks exist", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
    ])
    expect(dag.hasUnresolvedHumanGates()).toBe(false)
  })

  it("returns false when human-gated task has resolved=true", () => {
    const dag = createImplDAG([
      makeTask({
        id: "T1",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "creds", why: "need", verificationSteps: "check", resolved: true },
      }),
    ])
    // resolved=true but status is still human-gated — hasUnresolvedHumanGates checks both
    expect(dag.hasUnresolvedHumanGates()).toBe(false)
  })
})

// ===========================================================================
// scheduler.ts — SchedulerAwaitingHuman
// ===========================================================================

describe("Scheduler — human gate auto-transition", () => {
  it("auto-transitions ready human-gate tasks to human-gated status", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete", category: "scaffold" }),
      makeTask({ id: "T2", category: "human-gate", dependencies: ["T1"] }),
      makeTask({ id: "T3", category: "integration", dependencies: ["T2"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    // T2 should have been auto-transitioned to human-gated
    const t2 = Array.from(dag.tasks).find((t) => t.id === "T2")
    expect(t2!.status).toBe("human-gated")
    expect(t2!.humanGate).toBeDefined()
    expect(t2!.humanGate!.resolved).toBe(false)
  })

  it("returns awaiting-human when all remaining work is behind human gates", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete", category: "scaffold" }),
      makeTask({ id: "T2", category: "human-gate", dependencies: ["T1"] }),
      makeTask({ id: "T3", category: "integration", dependencies: ["T2"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("awaiting-human")
    if (decision.action !== "awaiting-human") throw new Error("Expected awaiting-human")
    expect(decision.humanGatedTasks).toHaveLength(1)
    expect(decision.humanGatedTasks[0]!.id).toBe("T2")
  })

  it("returns dispatch for standalone tasks alongside human-gated tasks", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete", category: "scaffold" }),
      makeTask({ id: "T2", category: "human-gate", dependencies: ["T1"] }),
      makeTask({ id: "T3", category: "standalone" }), // No deps on human gate
    ])
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("dispatch")
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.task.id).toBe("T3")
  })

  it("includes humanGated count in progress", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({
        id: "T2",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "creds", why: "need", verificationSteps: "check", resolved: false },
      }),
      makeTask({ id: "T3", dependencies: ["T2"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "awaiting-human") throw new Error("Expected awaiting-human")
    expect(decision.progress.humanGated).toBe(1)
    expect(decision.progress.complete).toBe(1)
    expect(decision.progress.pending).toBe(1)
  })
})

describe("Scheduler — resolveHumanGate()", () => {
  it("resolves a human-gated task to complete status", () => {
    const dag = createImplDAG([
      makeTask({
        id: "T1",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "creds", why: "need", verificationSteps: "check", resolved: false },
      }),
    ])
    const result = resolveHumanGate(dag, "T1")
    expect(result).not.toBeNull()
    expect(result!.status).toBe("complete")
    expect(result!.humanGate!.resolved).toBe(true)
    expect(result!.humanGate!.resolvedAt).toBeDefined()
  })

  it("returns null for non-human-gated task", () => {
    const dag = createImplDAG([makeTask({ id: "T1", status: "pending" })])
    const result = resolveHumanGate(dag, "T1")
    expect(result).toBeNull()
  })

  it("returns null for unknown task ID", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const result = resolveHumanGate(dag, "T999")
    expect(result).toBeNull()
  })

  it("unblocks downstream tasks after resolution", () => {
    const dag = createImplDAG([
      makeTask({
        id: "T1",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "creds", why: "need", verificationSteps: "check", resolved: false },
      }),
      makeTask({ id: "T2", category: "integration", dependencies: ["T1"] }),
    ])
    resolveHumanGate(dag, "T1")
    const ready = dag.getReady()
    expect(ready).toHaveLength(1)
    expect(ready[0]!.id).toBe("T2")
  })
})

describe("Scheduler — markTaskAborted with human-gated tasks", () => {
  it("cascades abort to human-gated downstream tasks", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight" }),
      makeTask({
        id: "T2",
        status: "human-gated",
        category: "human-gate",
        dependencies: ["T1"],
        humanGate: { whatIsNeeded: "creds", why: "need", verificationSteps: "check", resolved: false },
      }),
    ])
    const aborted = markTaskAborted(dag, "T1")
    expect(aborted).toHaveLength(2)
    expect(aborted.find((t) => t.id === "T2")!.status).toBe("aborted")
  })
})

// ===========================================================================
// impl-plan-parser.ts — Category field parsing
// ===========================================================================

describe("parseImplPlan — Category field", () => {
  it("parses Category: scaffold", () => {
    const plan = `
## Task T1: Build scaffold
**Dependencies:** none
**Category:** scaffold
**Expected tests:** tests/t1.test.ts
**Complexity:** small

Create the scaffold structure.
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected success")
    const task = Array.from(result.dag.tasks).find((t) => t.id === "T1")
    expect(task!.category).toBe("scaffold")
  })

  it("parses Category: human-gate", () => {
    const plan = `
## Task T1: Configure AWS
**Dependencies:** none
**Category:** human-gate
**Complexity:** small

User needs to set up AWS credentials.
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected success")
    const task = Array.from(result.dag.tasks).find((t) => t.id === "T1")
    expect(task!.category).toBe("human-gate")
  })

  it("parses Category: integration", () => {
    const plan = `
## Task T1: Real S3 integration
**Dependencies:** none
**Category:** integration
**Complexity:** medium

Implement real S3 client.
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected success")
    expect(Array.from(result.dag.tasks)[0]!.category).toBe("integration")
  })

  it("parses Category: standalone", () => {
    const plan = `
## Task T1: Business logic
**Dependencies:** none
**Category:** standalone
**Complexity:** small
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected success")
    expect(Array.from(result.dag.tasks)[0]!.category).toBe("standalone")
  })

  it("defaults to undefined (no category) when Category field is absent", () => {
    const plan = `
## Task T1: Do stuff
**Dependencies:** none
**Complexity:** small
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected success")
    expect(Array.from(result.dag.tasks)[0]!.category).toBeUndefined()
  })

  it("handles mixed categories in a plan", () => {
    const plan = `
## Task T1: Create scaffold
**Dependencies:** none
**Category:** scaffold
**Complexity:** small

## Task T2: Configure credentials
**Dependencies:** T1
**Category:** human-gate
**Complexity:** small

## Task T3: Real implementation
**Dependencies:** T1, T2
**Category:** integration
**Complexity:** medium

## Task T4: Business logic
**Dependencies:** none
**Category:** standalone
**Complexity:** small
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected success")
    const tasks = Array.from(result.dag.tasks)
    expect(tasks.find((t) => t.id === "T1")!.category).toBe("scaffold")
    expect(tasks.find((t) => t.id === "T2")!.category).toBe("human-gate")
    expect(tasks.find((t) => t.id === "T3")!.category).toBe("integration")
    expect(tasks.find((t) => t.id === "T4")!.category).toBe("standalone")
  })
})

// ===========================================================================
// task-review.ts — stub detection in review prompt
// ===========================================================================

describe("buildTaskReviewPrompt — stub detection", () => {
  it("includes stub detection as check #5", () => {
    const prompt = buildTaskReviewPrompt({
      task: makeTask({ id: "T1", category: "standalone" }),
      implementationSummary: "Implemented T1",
      mode: "GREENFIELD",
      cwd: "/test",
      parentSessionId: "sess-1",
    })
    expect(prompt).toContain("Stub/placeholder detection")
    expect(prompt).toContain("hardcoded values")
    expect(prompt).toContain("not implemented")
    expect(prompt).toContain("Placeholder credentials")
  })

  it("marks stubs as NOT acceptable for standalone tasks", () => {
    const prompt = buildTaskReviewPrompt({
      task: makeTask({ id: "T1", category: "standalone" }),
      implementationSummary: "Implemented T1",
      mode: "GREENFIELD",
      cwd: "/test",
    })
    expect(prompt).toContain("stubs are NOT acceptable")
  })

  it("marks stubs as NOT acceptable for integration tasks", () => {
    const prompt = buildTaskReviewPrompt({
      task: makeTask({ id: "T1", category: "integration" }),
      implementationSummary: "Implemented T1",
      mode: "GREENFIELD",
      cwd: "/test",
    })
    expect(prompt).toContain("stubs are NOT acceptable")
  })

  it("marks stubs as acceptable for scaffold tasks", () => {
    const prompt = buildTaskReviewPrompt({
      task: makeTask({ id: "T1", category: "scaffold" }),
      implementationSummary: "Implemented T1",
      mode: "GREENFIELD",
      cwd: "/test",
    })
    expect(prompt).toContain("stubs ARE acceptable")
  })

  it("treats tasks without category as standalone (stubs NOT acceptable)", () => {
    const prompt = buildTaskReviewPrompt({
      task: makeTask({ id: "T1" }), // no category
      implementationSummary: "Implemented T1",
      mode: "GREENFIELD",
      cwd: "/test",
    })
    expect(prompt).toContain("stubs are NOT acceptable")
  })

  it("references ALL five checks in the response format instructions", () => {
    const prompt = buildTaskReviewPrompt({
      task: makeTask({ id: "T1" }),
      implementationSummary: "test",
      mode: "GREENFIELD",
      cwd: "/test",
    })
    expect(prompt).toContain("ALL five checks pass")
  })
})

// ===========================================================================
// types.ts — schema v12 validation
// ===========================================================================

describe("validateWorkflowState — schema v12 implDag validation", () => {
  it("accepts human-gated status in implDag", () => {
    const state = makeState({
      implDag: [
        {
          id: "T1",
          description: "test",
          dependencies: [],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "human-gated",
          category: "human-gate",
          humanGate: { whatIsNeeded: "creds", why: "need", verificationSteps: "check", resolved: false },
        },
      ],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })

  it("rejects human-gated status without humanGate metadata", () => {
    const state = makeState({
      implDag: [
        {
          id: "T1",
          description: "test",
          dependencies: [],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "human-gated",
          // Missing humanGate!
        },
      ],
    })
    const error = validateWorkflowState(state)
    expect(error).not.toBeNull()
    expect(error).toContain("human-gated")
    expect(error).toContain("humanGate metadata")
  })

  it("accepts valid category values", () => {
    for (const cat of ["scaffold", "human-gate", "integration", "standalone"]) {
      const state = makeState({
        implDag: [
          {
            id: "T1",
            description: "test",
            dependencies: [],
            expectedTests: [],
            estimatedComplexity: "small",
            status: "pending",
            category: cat as any,
          },
        ],
      })
      expect(validateWorkflowState(state)).toBeNull()
    }
  })

  it("rejects invalid category values", () => {
    const state = makeState({
      implDag: [
        {
          id: "T1",
          description: "test",
          dependencies: [],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "pending",
          category: "invalid-category" as any,
        },
      ],
    })
    const error = validateWorkflowState(state)
    expect(error).not.toBeNull()
    expect(error).toContain("invalid category")
  })

  it("validates humanGate fields when present", () => {
    const state = makeState({
      implDag: [
        {
          id: "T1",
          description: "test",
          dependencies: [],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "human-gated",
          category: "human-gate",
          humanGate: {
            whatIsNeeded: 123 as any, // Invalid — should be string
            why: "need",
            verificationSteps: "check",
            resolved: false,
          },
        },
      ],
    })
    const error = validateWorkflowState(state)
    expect(error).not.toBeNull()
    expect(error).toContain("whatIsNeeded")
  })

  it("accepts tasks without category (optional field)", () => {
    const state = makeState({
      implDag: [
        {
          id: "T1",
          description: "test",
          dependencies: [],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "pending",
          // No category — should be valid
        },
      ],
    })
    expect(validateWorkflowState(state)).toBeNull()
  })
})

// ===========================================================================
// mark-task-complete.ts — rejects human-gated tasks
// ===========================================================================

describe("processMarkTaskComplete — human-gated rejection", () => {
  it("rejects completion of a human-gated task", () => {
    const nodes: TaskNode[] = [
      makeTask({
        id: "T1",
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "AWS creds", why: "need S3", verificationSteps: "aws s3 ls", resolved: false },
      }),
    ]
    const result = processMarkTaskComplete(
      { task_id: "T1", implementation_summary: "done", tests_passing: true },
      nodes,
      "T1",
    )
    expect("error" in result).toBe(true)
    if (!("error" in result)) throw new Error("Expected error")
    expect(result.error).toContain("human-gated")
    expect(result.error).toContain("AWS creds")
  })
})

// ===========================================================================
// Full pipeline — scaffold → human-gate → integration
// ===========================================================================

describe("Full pipeline — scaffold → human-gate → integration", () => {
  it("schedules scaffold first, then awaits human, then dispatches integration after resolution", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", category: "scaffold" }),
      makeTask({ id: "T2", category: "human-gate", dependencies: ["T1"] }),
      makeTask({ id: "T3", category: "integration", dependencies: ["T1", "T2"] }),
    ])

    // Step 1: Dispatch scaffold
    let decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("dispatch")
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.task.id).toBe("T1")

    // Step 2: Complete scaffold
    markTaskComplete(dag, "T1")
    decision = nextSchedulerDecision(dag)

    // T2 should be auto-transitioned to human-gated, and T3 is blocked behind T2
    expect(decision.action).toBe("awaiting-human")
    if (decision.action !== "awaiting-human") throw new Error("Expected awaiting-human")
    expect(decision.humanGatedTasks).toHaveLength(1)
    expect(decision.humanGatedTasks[0]!.id).toBe("T2")

    // Verify T2 was auto-transitioned
    const t2 = Array.from(dag.tasks).find((t) => t.id === "T2")
    expect(t2!.status).toBe("human-gated")

    // Step 3: Resolve human gate
    resolveHumanGate(dag, "T2")
    decision = nextSchedulerDecision(dag)

    // T3 should now be dispatchable
    expect(decision.action).toBe("dispatch")
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.task.id).toBe("T3")

    // Step 4: Complete integration
    markTaskComplete(dag, "T3")
    decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("complete")
  })
})
