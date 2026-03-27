/**
 * Integration test for the sub-workflow lifecycle.
 *
 * Tests the full round-trip: spawn → delegate → child completion → parent unblock.
 * Uses real store + mock backend (no SubagentDispatcher — that's adapter-level).
 *
 * Covers:
 * - spawn_sub_workflow validation → parent state mutation
 * - Child WorkflowState creation with parentWorkflow link
 * - Parent's DAG task transitions: pending → delegated → complete
 * - Parent's childWorkflows lifecycle: running → complete
 * - Child completion propagation via applyChildCompletion
 * - Scheduler correctly blocks on delegated, unblocks on complete
 * - Timeout detection and abort cascade
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createSessionStateStore } from "#core/session-state"
import { createFileSystemStateBackend } from "#core/state-backend-fs"
import { processSpawnSubWorkflow } from "#core/tools/spawn-sub-workflow"
import { processQueryChildWorkflow } from "#core/tools/query-workflow"
import { applyChildCompletion, findTimedOutChildren, applyDelegationTimeout } from "#core/tools/complete-sub-workflow"
import { createImplDAG } from "#core/dag"
import { nextSchedulerDecision } from "#core/scheduler"
import { SUB_WORKFLOW_TIMEOUT_MS } from "#core/constants"
import { SCHEMA_VERSION } from "#core/types"
import type { SessionStateStore, WorkflowState } from "#core/types"
import type { TaskNode } from "#core/dag"

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

let store: SessionStateStore
let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sub-wf-test-"))
  store = createSessionStateStore(createFileSystemStateBackend(tmpDir))
  await store.load()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("Sub-workflow lifecycle — spawn → delegate → complete → unblock", () => {
  it("full round trip: parent spawns child, child completes, parent unblocks", async () => {
    // 1. Create parent in IMPLEMENTATION with a DAG
    await store.create("parent-session")
    await store.update("parent-session", (d) => {
      d.featureName = "cloud-cost"
      d.mode = "GREENFIELD"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        makeTask({ id: "T1", status: "complete" }),
        makeTask({ id: "T2", status: "pending", dependencies: ["T1"] }),
        makeTask({ id: "T3", status: "pending", dependencies: ["T2"] }),
      ]
    })

    // 2. Validate spawn_sub_workflow for T2
    const parentState = store.get("parent-session")!
    const spawnResult = processSpawnSubWorkflow(
      { task_id: "T2", feature_name: "billing-engine" },
      parentState,
    )
    expect("error" in spawnResult).toBe(false)
    if ("error" in spawnResult) return
    expect(spawnResult.childFeatureName).toBe("cloud-cost/sub/billing-engine")

    // 3. Simulate what the adapter does: create child state, mark parent task delegated
    const childSessionId = "child-session-1"
    await store.create(childSessionId)
    await store.update(childSessionId, (d) => {
      d.featureName = "cloud-cost/sub/billing-engine"
      d.parentWorkflow = {
        sessionId: "parent-session",
        featureName: "cloud-cost",
        taskId: "T2",
      }
    })

    await store.update("parent-session", (d) => {
      const task = d.implDag?.find((t) => t.id === "T2")
      if (task) task.status = "delegated"
      d.childWorkflows.push({
        taskId: "T2",
        featureName: "cloud-cost/sub/billing-engine",
        sessionId: childSessionId,
        status: "running",
        delegatedAt: new Date().toISOString(),
      })
    })

    // 4. Verify scheduler blocks on delegated task
    const parentAfterSpawn = store.get("parent-session")!
    const dag1 = createImplDAG(Array.from(parentAfterSpawn.implDag!))
    const decision1 = nextSchedulerDecision(dag1)
    expect(decision1.action).toBe("blocked")
    expect(decision1.message).toContain("delegated")

    // 5. Verify child can be queried
    const childState = store.get(childSessionId)
    const queryResult = processQueryChildWorkflow(parentAfterSpawn, "T2", childState)
    expect(queryResult.error).toBeUndefined()
    expect(queryResult.childStatus).toBe("running")

    // 6. Simulate child reaching DONE — apply completion propagation
    await store.update("parent-session", (d) => {
      applyChildCompletion(d, "cloud-cost/sub/billing-engine", "T2")
    })

    // 7. Verify parent's DAG task is now complete
    const parentAfterComplete = store.get("parent-session")!
    expect(parentAfterComplete.implDag?.find((t) => t.id === "T2")?.status).toBe("complete")
    expect(parentAfterComplete.childWorkflows[0]?.status).toBe("complete")

    // 8. Verify T3 is now unblocked (T2 is complete)
    const dag2 = createImplDAG(Array.from(parentAfterComplete.implDag!))
    const decision2 = nextSchedulerDecision(dag2)
    expect(decision2.action).toBe("dispatch")
    if (decision2.action === "dispatch") {
      expect(decision2.task.id).toBe("T3")
    }
  })

  it("timeout aborts delegated task and cascades to dependents", async () => {
    await store.create("parent-session")
    const past = new Date(Date.now() - SUB_WORKFLOW_TIMEOUT_MS - 60000).toISOString()

    await store.update("parent-session", (d) => {
      d.featureName = "project"
      d.mode = "GREENFIELD"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        makeTask({ id: "T1", status: "complete" }),
        makeTask({ id: "T2", status: "delegated", dependencies: ["T1"] }),
        makeTask({ id: "T3", status: "pending", dependencies: ["T2"] }),
      ]
      d.childWorkflows.push({
        taskId: "T2",
        featureName: "project/sub/slow-task",
        sessionId: "child-1",
        status: "running",
        delegatedAt: past,
      })
    })

    // Detect timeout
    const state = store.get("parent-session")!
    const timedOut = findTimedOutChildren(state)
    expect(timedOut).toHaveLength(1)
    expect(timedOut[0]?.taskId).toBe("T2")

    // Apply timeout
    await store.update("parent-session", (d) => {
      for (const to of timedOut) {
        applyDelegationTimeout(d, to.taskId)
      }
    })

    // Verify cascade
    const afterTimeout = store.get("parent-session")!
    expect(afterTimeout.childWorkflows[0]?.status).toBe("failed")
    expect(afterTimeout.implDag?.find((t) => t.id === "T2")?.status).toBe("aborted")
    expect(afterTimeout.implDag?.find((t) => t.id === "T3")?.status).toBe("aborted")

    // Scheduler should now report complete (T1 complete, T2+T3 aborted)
    const dag = createImplDAG(Array.from(afterTimeout.implDag!))
    const decision = nextSchedulerDecision(dag)
    expect(decision.action).toBe("complete")
  })

  it("state persists to disk and survives reload", async () => {
    await store.create("parent-session")
    await store.update("parent-session", (d) => {
      d.featureName = "persist-test"
      d.mode = "GREENFIELD"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [makeTask({ id: "T1", status: "delegated" })]
      d.childWorkflows.push({
        taskId: "T1",
        featureName: "persist-test/sub/child",
        sessionId: "child-1",
        status: "running",
        delegatedAt: new Date().toISOString(),
      })
    })

    // Create child state in nested path
    await store.create("child-1")
    await store.update("child-1", (d) => {
      d.featureName = "persist-test/sub/child"
      d.parentWorkflow = { sessionId: "parent-session", featureName: "persist-test", taskId: "T1" }
    })

    // Reload from disk
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()

    // Both parent and child should survive
    const parent = store2.get("parent-session")
    expect(parent).not.toBeNull()
    expect(parent?.childWorkflows).toHaveLength(1)
    expect(parent?.implDag?.find((t) => t.id === "T1")?.status).toBe("delegated")

    const child = store2.get("child-1")
    expect(child).not.toBeNull()
    expect(child?.featureName).toBe("persist-test/sub/child")
    expect(child?.parentWorkflow?.featureName).toBe("persist-test")

    // Cross-query works after reload
    expect(store2.findByFeatureName("persist-test")).not.toBeNull()
    expect(store2.findByFeatureName("persist-test/sub/child")).not.toBeNull()
  })
})
