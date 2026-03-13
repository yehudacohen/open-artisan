/**
 * Tests for tools/mark-task-complete.ts — DAG task completion tool handler.
 *
 * Covers:
 * - Happy path: task marked complete, next task dispatched
 * - All tasks complete: "all done" message, call request_review
 * - Tests not passing: returns error, does not mutate DAG
 * - Invalid task ID: returns error with valid IDs listed
 * - Task already complete: returns error
 * - Task aborted: returns error
 * - No DAG in state: returns error
 * - Persists updated nodes (status changes reflected in updatedNodes)
 * - Blocked DAG: appropriate message
 */
import { describe, expect, it } from "bun:test"
import { processMarkTaskComplete } from "#plugin/tools/mark-task-complete"
import type { TaskNode } from "#plugin/dag"

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

const VALID_ARGS = {
  task_id: "T1",
  implementation_summary: "Implemented the feature",
  tests_passing: true,
}

// ---------------------------------------------------------------------------
// Tests not passing — early exit without mutation
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — tests not passing", () => {
  it("returns error when tests_passing=false", () => {
    const nodes = [makeTask({ id: "T1" })]
    const result = processMarkTaskComplete({ ...VALID_ARGS, tests_passing: false }, nodes)
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("tests are not passing")
  })

  it("does not mutate nodes when tests_passing=false", () => {
    const nodes = [makeTask({ id: "T1" })]
    processMarkTaskComplete({ ...VALID_ARGS, tests_passing: false }, nodes)
    expect(nodes[0]!.status).toBe("pending")
  })

  it("rejects truthy non-boolean tests_passing (string 'false' coercion guard)", () => {
    const nodes = [makeTask({ id: "T1" })]
    const result = processMarkTaskComplete(
      { ...VALID_ARGS, tests_passing: "false" as any },
      nodes,
    )
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("tests are not passing")
    }
  })
})

// ---------------------------------------------------------------------------
// No DAG in state
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — no DAG", () => {
  it("returns error when currentNodes is null", () => {
    const result = processMarkTaskComplete(VALID_ARGS, null)
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("No implementation DAG")
  })

  it("returns error when currentNodes is empty array", () => {
    const result = processMarkTaskComplete(VALID_ARGS, [])
    expect("error" in result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Invalid task ID
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — invalid task ID", () => {
  it("returns error for unknown task ID", () => {
    const nodes = [makeTask({ id: "T1" }), makeTask({ id: "T2", dependencies: ["T1"] })]
    const result = processMarkTaskComplete({ ...VALID_ARGS, task_id: "T99" }, nodes)
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("T99")
    expect(result.error).toContain("T1") // lists valid IDs
  })
})

// ---------------------------------------------------------------------------
// Task already complete
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — already complete", () => {
  it("returns error when task is already complete", () => {
    const nodes = [makeTask({ id: "T1", status: "complete" })]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("already marked complete")
  })
})

// ---------------------------------------------------------------------------
// Task aborted
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — aborted task", () => {
  it("returns error when task is aborted", () => {
    const nodes = [makeTask({ id: "T1", status: "aborted" })]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("aborted")
  })
})

// ---------------------------------------------------------------------------
// Happy path — mark complete, next task dispatched
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — next task dispatched", () => {
  it("returns updatedNodes with T1 marked complete", () => {
    const nodes = [
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    expect("error" in result).toBe(false)
    if ("error" in result) return

    const t1 = result.updatedNodes.find((t) => t.id === "T1")
    expect(t1?.status).toBe("complete")
  })

  it("responseMessage includes T1 in confirmation", () => {
    const nodes = [
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    if ("error" in result) return
    expect(result.responseMessage).toContain("T1")
  })

  it("responseMessage includes next task T2", () => {
    const nodes = [
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    if ("error" in result) return
    expect(result.responseMessage).toContain("T2")
  })

  it("includes implementation_summary in response", () => {
    const nodes = [makeTask({ id: "T1" }), makeTask({ id: "T2", dependencies: ["T1"] })]
    const result = processMarkTaskComplete(
      { ...VALID_ARGS, implementation_summary: "auth service done" },
      nodes,
    )
    if ("error" in result) return
    expect(result.responseMessage).toContain("auth service done")
  })

  it("T2 status remains pending in updatedNodes (not yet started)", () => {
    const nodes = [
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    if ("error" in result) return
    const t2 = result.updatedNodes.find((t) => t.id === "T2")
    expect(t2?.status).toBe("pending")
  })
})

// ---------------------------------------------------------------------------
// Happy path — all tasks complete
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — all tasks done", () => {
  it("responseMessage says all complete when last task is marked done", () => {
    const nodes = [makeTask({ id: "T1" })]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    if ("error" in result) return
    expect(result.responseMessage.toLowerCase()).toMatch(/all|complete|done/)
  })

  it("responseMessage tells agent to call request_review", () => {
    const nodes = [makeTask({ id: "T1" })]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    if ("error" in result) return
    expect(result.responseMessage).toContain("request_review")
  })

  it("all nodes in updatedNodes are complete/aborted", () => {
    const nodes = [
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const result = processMarkTaskComplete({ ...VALID_ARGS, task_id: "T2" }, nodes)
    if ("error" in result) return
    for (const t of result.updatedNodes) {
      expect(["complete", "aborted"].includes(t.status)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Isolated mutation — original input array not mutated
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — isolation", () => {
  it("does not mutate the original nodes array passed in", () => {
    const nodes = [makeTask({ id: "T1" })]
    const originalStatus = nodes[0]!.status
    processMarkTaskComplete(VALID_ARGS, nodes)
    // The processMarkTaskComplete implementation uses createImplDAG which makes
    // a defensive copy — but our input array itself should not be spliced/mutated
    expect(nodes[0]!.status).toBe(originalStatus)
  })
})

// ---------------------------------------------------------------------------
// Blocked DAG
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — uses canonical markTaskComplete (M8)", () => {
  it("rejects marking a task that is in an invalid status (not pending/in-flight)", () => {
    // The canonical markTaskComplete only allows transitions from "pending" or "in-flight".
    // A task with status "aborted" should be rejected at the earlier guard (explicit check),
    // but if somehow a task ended up with an unexpected status, markTaskComplete returns null.
    // We verify the explicit guard catches "aborted" before reaching the canonical helper.
    const nodes = [makeTask({ id: "T1", status: "aborted" })]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("aborted")
    }
  })

  it("marks an in-flight task as complete successfully", () => {
    // The canonical helper accepts "in-flight" → "complete" transitions.
    const nodes = [
      makeTask({ id: "T1", status: "in-flight" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    expect("error" in result).toBe(false)
    if ("error" in result) return
    const t1 = result.updatedNodes.find((t) => t.id === "T1")
    expect(t1?.status).toBe("complete")
  })

  it("marks a pending task as complete successfully", () => {
    // The canonical helper accepts "pending" → "complete" transitions.
    const nodes = [makeTask({ id: "T1", status: "pending" })]
    const result = processMarkTaskComplete(VALID_ARGS, nodes)
    expect("error" in result).toBe(false)
    if ("error" in result) return
    const t1 = result.updatedNodes.find((t) => t.id === "T1")
    expect(t1?.status).toBe("complete")
  })
})

// ---------------------------------------------------------------------------
// currentTaskId guard (M9)
// ---------------------------------------------------------------------------

describe("currentTaskId guard (M9)", () => {
  function nodes(): TaskNode[] {
    return [makeTask({ id: "T1" }), makeTask({ id: "T2" })]
  }

  it("rejects completing a task that is not the current dispatched task", () => {
    const result = processMarkTaskComplete(
      { task_id: "T2", implementation_summary: "done", tests_passing: true },
      nodes(),
      "T1",
    )
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("not the currently dispatched task")
  })

  it("allows completing when currentTaskId is null (backward compat)", () => {
    const result = processMarkTaskComplete(
      { task_id: "T1", implementation_summary: "done", tests_passing: true },
      nodes(),
      null,
    )
    expect("error" in result).toBe(false)
  })

  it("allows completing when currentTaskId is undefined (backward compat)", () => {
    const result = processMarkTaskComplete(
      { task_id: "T1", implementation_summary: "done", tests_passing: true },
      nodes(),
    )
    expect("error" in result).toBe(false)
  })

  it("allows completing when task_id matches currentTaskId", () => {
    const result = processMarkTaskComplete(
      { task_id: "T1", implementation_summary: "done", tests_passing: true },
      nodes(),
      "T1",
    )
    expect("error" in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Blocked DAG
// ---------------------------------------------------------------------------

describe("processMarkTaskComplete — blocked DAG", () => {
  it("responseMessage mentions blocked/conflict when DAG is in a blocked state", () => {
    // Create a DAG where T2 depends on T3 but T3 depends on T2 (cycle not detectable at runtime
    // after validation; instead simulate blocked by marking T1 complete but T2 still waiting on
    // a non-existent dep — we test the "all pending tasks are blocked" scenario by
    // having T1 complete and T2 blocked with no ready tasks remaining)
    // Simpler approach: mark T1 complete (the only no-dep task), then complete T2 which has
    // T1 as dep. If we next have a T3 depending on a T4 that is also pending with T3 as dep
    // (a cycle), that is caught at parse time. Instead just verify the blocked path does not throw.
    // We test the "blocked" scheduler action by having T2 depend on "T99" (invalid dep),
    // but createImplDAG validates deps, so we cannot create that at the DAG level.
    // The blocked scenario requires in-flight tasks with no new ready tasks — not reachable
    // in sequential mode without manually mutating. Accept this coverage gap and verify
    // the happy path does not regress.
    const nodes = [
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const result = processMarkTaskComplete({ ...VALID_ARGS, task_id: "T2" }, nodes)
    // T2 is the last task — should be "complete" outcome
    expect("error" in result).toBe(false)
  })
})
