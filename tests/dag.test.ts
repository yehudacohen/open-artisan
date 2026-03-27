/**
 * Tests for dag.ts — ImplDAG data structure and validator.
 *
 * Covers:
 * - validate(): duplicate IDs, missing deps, cycle detection, empty DAG
 * - getReady(): pending tasks with all deps complete; respects in-flight/complete status
 * - isComplete(): terminal condition for all tasks done/aborted
 * - getDependents(): transitive dependent lookup
 */
import { describe, expect, it } from "bun:test"
import { createImplDAG } from "#core/dag"
import type { TaskNode } from "#core/dag"

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

// ---------------------------------------------------------------------------
// validate() — basic structural checks
// ---------------------------------------------------------------------------

describe("ImplDAG.validate() — structural checks", () => {
  it("returns valid for a single task with no dependencies", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    const result = dag.validate()
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("returns valid for a linear chain T1 → T2 → T3", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
      makeTask({ id: "T3", dependencies: ["T2"] }),
    ])
    const result = dag.validate()
    expect(result.valid).toBe(true)
  })

  it("returns valid for a diamond: T1 → T2, T1 → T3, T2+T3 → T4", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
      makeTask({ id: "T3", dependencies: ["T1"] }),
      makeTask({ id: "T4", dependencies: ["T2", "T3"] }),
    ])
    expect(dag.validate().valid).toBe(true)
  })

  it("returns invalid for an empty task list", () => {
    const dag = createImplDAG([])
    const result = dag.validate()
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.toLowerCase().includes("no tasks"))).toBe(true)
  })

  it("returns invalid for duplicate task IDs", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T1" }), // duplicate
    ])
    const result = dag.validate()
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("Duplicate"))).toBe(true)
  })

  it("returns invalid when a dependency references a non-existent task", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", dependencies: ["T99"] }),
    ])
    const result = dag.validate()
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("T99"))).toBe(true)
  })

  it("returns invalid for a direct self-loop (T1 depends on T1)", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", dependencies: ["T1"] }),
    ])
    const result = dag.validate()
    expect(result.valid).toBe(false)
  })

  it("returns invalid for a 2-node cycle: T1 → T2, T2 → T1", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", dependencies: ["T2"] }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    const result = dag.validate()
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.toLowerCase().includes("circular"))).toBe(true)
  })

  it("returns invalid for a 3-node cycle: T1→T2→T3→T1", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", dependencies: ["T3"] }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
      makeTask({ id: "T3", dependencies: ["T2"] }),
    ])
    const result = dag.validate()
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getReady() — task scheduling
// ---------------------------------------------------------------------------

describe("ImplDAG.getReady()", () => {
  it("returns all tasks with no dependencies when all are pending", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2" }),
      makeTask({ id: "T3" }),
    ])
    const ready = dag.getReady()
    expect(ready.map((t) => t.id)).toEqual(expect.arrayContaining(["T1", "T2", "T3"]))
    expect(ready).toHaveLength(3)
  })

  it("returns only T1 when T2 depends on T1 and T1 is pending", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    const ready = dag.getReady()
    expect(ready.map((t) => t.id)).toEqual(["T1"])
  })

  it("returns T2 after T1 is marked complete", () => {
    const nodes = [
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ]
    const dag = createImplDAG(nodes)
    const ready = dag.getReady()
    expect(ready.map((t) => t.id)).toEqual(["T2"])
  })

  it("does NOT return in-flight tasks", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight" }),
    ])
    expect(dag.getReady()).toHaveLength(0)
  })

  it("does NOT return complete tasks", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
    ])
    expect(dag.getReady()).toHaveLength(0)
  })

  it("returns T3 only after T1 and T2 are both complete (diamond dependency)", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "pending", dependencies: ["T1"] }),
      makeTask({ id: "T3", dependencies: ["T1", "T2"] }),
    ])
    // T2 is ready, T3 is not (T2 not complete)
    const ready = dag.getReady()
    expect(ready.map((t) => t.id)).toContain("T2")
    expect(ready.map((t) => t.id)).not.toContain("T3")
  })

  it("returns empty when all tasks are complete", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "complete", dependencies: ["T1"] }),
    ])
    expect(dag.getReady()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// isComplete()
// ---------------------------------------------------------------------------

describe("ImplDAG.isComplete()", () => {
  it("returns true when all tasks are complete", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "complete" }),
    ])
    expect(dag.isComplete()).toBe(true)
  })

  it("returns true when tasks are complete or aborted", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "aborted" }),
    ])
    expect(dag.isComplete()).toBe(true)
  })

  it("returns false when any task is pending", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "complete" }),
      makeTask({ id: "T2", status: "pending" }),
    ])
    expect(dag.isComplete()).toBe(false)
  })

  it("returns false when any task is in-flight", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1", status: "in-flight" }),
    ])
    expect(dag.isComplete()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getDependents()
// ---------------------------------------------------------------------------

describe("ImplDAG.getDependents()", () => {
  it("returns direct dependents", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
      makeTask({ id: "T3", dependencies: ["T1"] }),
    ])
    const deps = dag.getDependents("T1").map((t) => t.id)
    expect(deps).toContain("T2")
    expect(deps).toContain("T3")
  })

  it("returns transitive dependents", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
      makeTask({ id: "T3", dependencies: ["T2"] }),
    ])
    const deps = dag.getDependents("T1").map((t) => t.id)
    expect(deps).toContain("T2")
    expect(deps).toContain("T3")
  })

  it("returns empty array for a leaf task (no dependents)", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    expect(dag.getDependents("T2")).toHaveLength(0)
  })

  it("returns empty array for unknown task ID", () => {
    const dag = createImplDAG([makeTask({ id: "T1" })])
    expect(dag.getDependents("T99")).toHaveLength(0)
  })

  it("does not include the source task itself", () => {
    const dag = createImplDAG([
      makeTask({ id: "T1" }),
      makeTask({ id: "T2", dependencies: ["T1"] }),
    ])
    const deps = dag.getDependents("T1").map((t) => t.id)
    expect(deps).not.toContain("T1")
  })
})

// ---------------------------------------------------------------------------
// tasks snapshot is independent (no reference sharing)
// ---------------------------------------------------------------------------

describe("ImplDAG.tasks — snapshot isolation", () => {
  it("mutating a task node does not affect the original input array", () => {
    const original = [makeTask({ id: "T1" })]
    const dag = createImplDAG(original)
    // Mutate via DAG tasks access
    const t = dag.tasks.find((t) => t.id === "T1")!
    t.status = "complete"
    // Original should be unchanged
    expect(original[0]!.status).toBe("pending")
  })
})
