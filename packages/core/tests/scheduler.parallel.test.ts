import { describe, expect, it } from "bun:test"

import { createImplDAG, type TaskNode } from "#core/dag"
import {
  applyDispatch,
  applyDispatchBatch,
  applyFallback,
  nextSchedulerDecision,
  nextSchedulerDecisionForInput,
  readDecisionInput,
} from "#core/scheduler"

function makeTask(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    description: id,
    dependencies: [],
    expectedTests: [],
    expectedFiles: [`src/${id}.ts`],
    estimatedComplexity: "small",
    status: "pending",
    ...overrides,
  }
}

describe("parallel scheduler contract", () => {
  it("wraps sequential dispatch in a result envelope with slot accounting", () => {
    const dag = createImplDAG([makeTask("T1")])
    const result = nextSchedulerDecisionForInput({ dag, maxParallelTasks: 1 })

    expect(result.decision.action).toBe("dispatch")
    expect(result.slots.maxParallelTasks).toBe(1)
    expect(result.slots.activeTasks).toBe(0)
    expect(result.slots.availableSlots).toBe(1)
    expect(result.slots.readyTasks).toBe(1)
    expect(result.slots.dispatchableNow).toBe(1)
  })

  it("treats absent isolation as not parallel-safe and falls back to sequential dispatch", () => {
    const dag = createImplDAG([makeTask("T1"), makeTask("T2")])
    const result = nextSchedulerDecisionForInput({ dag, maxParallelTasks: 2 })
    expect(result.decision.action).toBe("dispatch")
    expect(result.slots.readyTasks).toBe(2)
    expect(result.slots.dispatchableNow).toBe(1)
  })

  it("deterministically dispatches one task when multiple parallel-safe tasks are ready", () => {
    const dag = createImplDAG([
      makeTask("T1", { isolation: { mode: "isolated-worktree", ownershipKey: "T1", writablePaths: ["src/t1.ts"], safeForParallelDispatch: true } }),
      makeTask("T2", { isolation: { mode: "isolated-worktree", ownershipKey: "T2", writablePaths: ["src/t2.ts"], safeForParallelDispatch: true } }),
    ])
    const result = nextSchedulerDecisionForInput({ dag, maxParallelTasks: 2 })

    expect(result.decision.action).toBe("dispatch")
    if (result.decision.action !== "dispatch") return
    expect(result.decision.task.id).toBe("T1")
    expect(result.decision.prompt).toContain("sequential lane")
    expect(result.slots.readyTasks).toBe(2)
    expect(result.slots.dispatchableNow).toBe(2)
  })

  it("fails closed when parallel-ready tasks overlap writable paths", () => {
    const dag = createImplDAG([
      makeTask("T1", { isolation: { mode: "isolated-worktree", ownershipKey: "one", writablePaths: ["src/shared.ts"], safeForParallelDispatch: true } }),
      makeTask("T2", { isolation: { mode: "isolated-worktree", ownershipKey: "two", writablePaths: ["src/shared.ts"], safeForParallelDispatch: true } }),
    ])
    const result = nextSchedulerDecisionForInput({ dag, maxParallelTasks: 2 })

    expect(result.decision.action).toBe("blocked")
    if (result.decision.action !== "blocked") return
    expect(result.decision.reason).toBe("isolation-missing")
    expect(result.decision.retryable).toBeTrue()
  })

  it("derives scheduler input from workflow state", () => {
    const dag = createImplDAG([makeTask("T1")])
    const input = readDecisionInput({
      implDag: Array.from(dag.tasks).map((task) => ({ ...task })),
      concurrency: { maxParallelTasks: 3 },
    })
    expect(input.maxParallelTasks).toBe(3)
    expect(input.dag.tasks.length).toBe(1)
  })

  it("applies dispatch helpers without mutating unrelated tasks", () => {
    const state = { implDag: [makeTask("T1"), makeTask("T2")] }

    const dispatched = applyDispatch(state, "T1")
    expect(dispatched?.find((task) => task.id === "T1")?.status).toBe("in-flight")
    expect(dispatched?.find((task) => task.id === "T2")?.status).toBe("pending")

    const batch = applyDispatchBatch(state, ["T1", "T2"])
    expect(batch?.every((task) => task.status === "in-flight")).toBeTrue()

    const fallback = applyFallback(state, "sequential")
    expect(fallback).not.toBe(state.implDag)
    expect(fallback?.map((task) => task.status)).toEqual(["pending", "pending"])
  })

  it("includes the task review rubric in implementation prompts", () => {
    const dag = createImplDAG([makeTask("T1")])
    const decision = nextSchedulerDecision(dag)

    expect(decision.action).toBe("dispatch")
    if (decision.action !== "dispatch") return
    expect(decision.prompt).toContain("Task review rubric")
    expect(decision.prompt).toContain("isolated reviewer will check")
    expect(decision.prompt).toContain("real runtime behavior")
    expect(decision.prompt).toContain("code quality and error handling scores")
    expect(decision.prompt).toContain("Final implementation phase rubric")
    expect(decision.prompt).toContain("approved interfaces, plan, tests, implementation plan, and conventions")
    expect(decision.prompt).toContain("autonomous/runtime claims are verified")
  })

  it("surfaces awaiting-human when only unresolved human-gated work remains", () => {
    const dag = createImplDAG([
      makeTask("T1", {
        status: "human-gated",
        category: "human-gate",
        humanGate: { whatIsNeeded: "Manual migration", why: "Irreversible step", verificationSteps: "Confirm manually", resolved: false },
      }),
    ])
    const result = nextSchedulerDecisionForInput({ dag, maxParallelTasks: 1 })
    expect(result.decision.action).toBe("awaiting-human")
  })

  it("does not silently dispatch delegated work as ordinary in-flight authoring", () => {
    const dag = createImplDAG([
      makeTask("T1", {
        status: "delegated",
        expectedFiles: ["src/delegated.ts"],
      }),
    ])
    const result = nextSchedulerDecisionForInput({ dag, maxParallelTasks: 1 })
    expect(result.decision.action).not.toBe("dispatch")
  })
})
