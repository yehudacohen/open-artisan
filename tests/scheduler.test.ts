/**
 * Tests for scheduler.ts — sequential task scheduler.
 *
 * Covers:
 * - nextSchedulerDecision: dispatch, complete, blocked decisions
 * - Dispatch: picks the first ready task (least dependencies)
 * - Complete: all tasks done/aborted → complete decision
 * - Blocked: no ready tasks, no complete sentinel → blocked decision
 * - markTaskComplete / markTaskInFlight / markTaskAborted
 * - Progress counters in dispatch decision
 * - Task prompt includes task ID and description
 */
import { describe, expect, it } from "bun:test"
import { createImplDAG } from "#core/dag"
import {
  nextSchedulerDecision,
  markTaskComplete,
  markTaskInFlight,
  markTaskAborted,
} from "#core/scheduler"
import type { TaskNode } from "#core/dag"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    description: `Task ${overrides.id} description`,
    dependencies: [],
    expectedTests: [],
    estimatedComplexity: "medium",
    status: "pending",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// nextSchedulerDecision — dispatch
// ---------------------------------------------------------------------------

describe("nextSchedulerDecision — dispatch", () => {
  it("returns action=dispatch when there is a ready task", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("dispatch")
  })

  it("dispatches the single pending task", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.task.id).toBe("T1")
  })

  it("dispatches T2 after T1 is marked complete", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.task.id).toBe("T2")
  })

  it("prompt includes the task ID", () => {
    const dag = createImplDAG([makeTask({ id: "T42" })])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.prompt).toContain("T42")
  })

  it("prompt includes the task description", () => {
    const dag = createImplDAG([makeTask({ id: "T1", description: "Implement authentication" })])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.prompt).toContain("Implement authentication")
  })

  it("prompt includes expected test paths", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", expectedTests: ["tests/auth.test.ts"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.prompt).toContain("tests/auth.test.ts")
  })

  it("progress.total matches total task count", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2" }),
      makeTask({ id: "T3" }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.progress.total).toBe(3)
  })

  it("progress.complete is 0 when no tasks are done", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.progress.complete).toBe(0)
  })

  it("progress.complete reflects completed tasks", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "dispatch") throw new Error("Expected dispatch")
    expect(decision.progress.complete).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// nextSchedulerDecision — complete
// ---------------------------------------------------------------------------

describe("nextSchedulerDecision — complete", () => {
  it("returns action=complete when all tasks are complete", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "complete", dependencies: ["T1"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("complete")
  })

  it("returns action=complete when tasks are complete or aborted", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "aborted" }),
    ])
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("complete")
  })

  it("complete message mentions the task count", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "complete") throw new Error("Expected complete")
    expect(decision.message).toContain("1")
  })
})

// ---------------------------------------------------------------------------
// nextSchedulerDecision — blocked
// ---------------------------------------------------------------------------

describe("nextSchedulerDecision — blocked", () => {
  it("returns action=blocked when all pending tasks are waiting on incomplete deps", () => {
    // Simulate a state where T1 is in-flight but not yet complete, T2 waits on T1
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    // T1 is in-flight (not pending), T2 is pending but T1 is not complete
    // → no ready tasks, not complete → blocked
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("blocked")
  })

  it("blocked decision with in-flight tasks reports waiting, not DAG inconsistency", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "blocked") throw new Error("Expected blocked")
    // In-flight tasks cause a "waiting" blocked state, not a DAG inconsistency
    expect(decision.message).toContain("in-flight")
    expect(decision.blockedTasks).toHaveLength(0)
  })

  it("blocked decision with no in-flight tasks includes blockedTasks with unmet deps", () => {
    // DAG inconsistency: T1 is pending but T2 depends on T1, no tasks in-flight
    const dag = createImplDAG([
      makeTask({ id: "T1", dependencies: ["T_MISSING"] }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    const decision = nextSchedulerDecision(dag)
    if (decision.action !== "blocked") throw new Error("Expected blocked")
    expect(decision.blockedTasks.some((bt) => bt.id === "T1")).toBe(true)
    const t1Block = decision.blockedTasks.find((bt) => bt.id === "T1")!
    expect(t1Block.waitingFor).toContain("T_MISSING")
  })
})

// ---------------------------------------------------------------------------
// markTaskComplete / markTaskInFlight / markTaskAborted
// ---------------------------------------------------------------------------

describe("markTaskComplete", () => {
  it("sets status to complete for the given task ID", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    markTaskComplete(dag, "T1")
    const t = Array.from(dag.tasks).find((t) => t.id === "T1")!
    expect(t.status).toBe("complete")
  })

  it("returns the mutated task node", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const result = markTaskComplete(dag, "T1")
    expect(result).not.toBeNull()
    expect(result?.status).toBe("complete")
  })

  it("returns null for unknown task ID", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const result = markTaskComplete(dag, "T99")
    expect(result).toBeNull()
  })

  it("returns null for already-complete task (status validation)", () => {
    const dag = createImplDAG([makeTask({ id: "T1", status: "complete" })])
    expect(markTaskComplete(dag, "T1")).toBeNull()
  })

  it("returns null for aborted task (status validation)", () => {
    const dag = createImplDAG([makeTask({ id: "T1", status: "aborted" })])
    expect(markTaskComplete(dag, "T1")).toBeNull()
  })

  it("after marking T1 complete, T2 becomes ready", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    markTaskComplete(dag, "T1")
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("dispatch")
    if (decision.action === "dispatch") {
      expect(decision.task.id).toBe("T2")
    }
  })
})

describe("markTaskInFlight", () => {
  it("sets status to in-flight", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    markTaskInFlight(dag, "T1")
    const t = Array.from(dag.tasks).find((t) => t.id === "T1")!
    expect(t.status).toBe("in-flight")
  })

  it("returns null for unknown task ID", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    expect(markTaskInFlight(dag, "T99")).toBeNull()
  })

  it("returns null for already in-flight task (status validation)", () => {
    const dag = createImplDAG([makeTask({ id: "T1", status: "in-flight" })])
    expect(markTaskInFlight(dag, "T1")).toBeNull()
  })

  it("returns null for complete task (status validation)", () => {
    const dag = createImplDAG([makeTask({ id: "T1", status: "complete" })])
    expect(markTaskInFlight(dag, "T1")).toBeNull()
  })
})

describe("markTaskAborted", () => {
  it("sets status to aborted", () => {
    const dag = createImplDAG([makeTask({ id: "T1", status: "in-flight" })])
    markTaskAborted(dag, "T1")
    const t = Array.from(dag.tasks).find((t) => t.id === "T1")!
    expect(t.status).toBe("aborted")
  })

  it("clears worktreeBranch and worktreePath", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight", worktreeBranch: "task/T1", worktreePath: ".worktrees/T1" }),
    ])
    markTaskAborted(dag, "T1")
    const t = Array.from(dag.tasks).find((t) => t.id === "T1")!
    expect(t.worktreeBranch).toBeUndefined()
    expect(t.worktreePath).toBeUndefined()
  })

  it("returns empty array for unknown task ID", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    expect(markTaskAborted(dag, "T99")).toEqual([])
  })

  it("cascades abort to downstream dependents", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight" }),
      makeTask({ id: "T2", dependencies: ["T1"], status: "pending" }),
      makeTask({ id: "T3", dependencies: ["T2"], status: "pending" }),
    ])
    const aborted = markTaskAborted(dag, "T1")
    expect(aborted.length).toBe(3)
    expect(Array.from(dag.tasks).every((t) => t.status === "aborted")).toBe(true)
  })

  it("does not cascade to already-complete tasks", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight" }),
      makeTask({ id: "T2", dependencies: ["T1"], status: "complete" }),
      makeTask({ id: "T3", dependencies: ["T1"], status: "pending" }),
    ])
    const aborted = markTaskAborted(dag, "T1")
    expect(aborted.length).toBe(2) // T1 + T3, not T2
    expect(Array.from(dag.tasks).find((t) => t.id === "T2")!.status).toBe("complete")
  })
})
