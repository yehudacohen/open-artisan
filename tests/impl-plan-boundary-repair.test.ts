import { describe, expect, it } from "bun:test"

import { repairCurrentTaskBoundaryFromImplPlan } from "#core/tools/impl-plan-boundary-repair"
import { makeWorkflowState } from "./helpers/workflow-state"

const PLAN = `
## Task T8: Mirror generated examples
**Dependencies:** none
**Files:** src/runtime.ts, examples/admin/users.ts
**Expected tests:** tests/runtime.test.ts
**Complexity:** medium

Boundary repair will add \`examples/migrations/001_init.sql\` when this task starts.
`

describe("repairCurrentTaskBoundaryFromImplPlan", () => {
  it("syncs missing current-task files from approved IMPL_PLAN and updates INCREMENTAL allowlist", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "TASK_REVISE",
      currentTaskId: "T8",
      fileAllowlist: ["/repo/src/runtime.ts"],
      pendingAllowlistExpansions: [{
        files: ["/repo/examples/admin/users.ts"],
        reason: "User approved planned generated examples.",
        sourceArtifact: "impl_plan",
        requestedAtPhase: "IMPLEMENTATION",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T8",
        description: "Mirror generated examples",
        dependencies: [],
        expectedFiles: ["/repo/src/runtime.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = repairCurrentTaskBoundaryFromImplPlan(state, PLAN, "/repo", {
      reason: "Approved implementation plan already names these active task files.",
    })

    expect(result.success).toBe(true)
    expect(state.implDag?.[0]?.expectedFiles).toEqual([
      "/repo/src/runtime.ts",
      "/repo/examples/admin/users.ts",
      "/repo/examples/migrations/001_init.sql",
    ])
    expect(state.implDag?.[0]?.expectedTests).toEqual(["/repo/tests/runtime.test.ts"])
    expect(state.fileAllowlist).toContain("/repo/examples/admin/users.ts")
    expect(state.fileAllowlist).toContain("/repo/examples/migrations/001_init.sql")
    expect(state.pendingAllowlistExpansions).toEqual([])
    expect(state.phaseState).toBe("DRAFT")
  })

  it("rejects automatic repair when approved IMPL_PLAN additions overlap another task", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "TASK_REVISE",
      currentTaskId: "T8",
      fileAllowlist: ["/repo/src/runtime.ts", "/repo/examples/admin/users.ts", "/repo/examples/migrations/001_init.sql", "/repo/tests/runtime.test.ts"],
      implDag: [
        {
          id: "T8",
          description: "Mirror generated examples",
          dependencies: [],
          expectedFiles: ["/repo/src/runtime.ts"],
          expectedTests: [],
          estimatedComplexity: "medium",
          status: "in-flight",
        },
        {
          id: "T9",
          description: "Own generated examples",
          dependencies: [],
          expectedFiles: ["/repo/examples/admin/users.ts"],
          expectedTests: [],
          estimatedComplexity: "medium",
          status: "pending",
        },
      ],
    })

    const result = repairCurrentTaskBoundaryFromImplPlan(state, PLAN, "/repo", {
      reason: "Approved implementation plan already names these active task files.",
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("not safe to apply automatically")
    expect(result.success ? "" : result.error).toContain("Task \"T9\" already owns file")
    expect(state.implDag?.find((task) => task.id === "T8")?.expectedFiles).toEqual(["/repo/src/runtime.ts"])
    expect(state.fileAllowlist).toContain("/repo/examples/admin/users.ts")
  })

  it("rejects automatic repair when downstream completed tasks require future corrective work", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "TASK_REVISE",
      currentTaskId: "T8",
      fileAllowlist: ["/repo/src/runtime.ts", "/repo/examples/admin/users.ts", "/repo/examples/migrations/001_init.sql", "/repo/tests/runtime.test.ts"],
      implDag: [
        {
          id: "T8",
          description: "Mirror generated examples",
          dependencies: [],
          expectedFiles: ["/repo/src/runtime.ts"],
          expectedTests: [],
          estimatedComplexity: "medium",
          status: "in-flight",
        },
        {
          id: "T9",
          description: "Validate generated examples",
          dependencies: ["T8"],
          expectedFiles: ["/repo/src/validator.ts"],
          expectedTests: [],
          estimatedComplexity: "medium",
          status: "complete",
        },
      ],
    })

    const result = repairCurrentTaskBoundaryFromImplPlan(state, PLAN, "/repo", {
      reason: "Approved implementation plan already names these active task files.",
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("Completed task(s) are impacted")
    expect(state.implDag?.find((task) => task.id === "T9")?.status).toBe("complete")
  })
})
