import { describe, expect, it } from "bun:test"

import { applyPendingCurrentTaskScopeExpansions, approveCurrentTaskScopeExpansion } from "#core/tools/current-task-scope"
import { makeWorkflowState } from "./helpers/workflow-state"

describe("approveCurrentTaskScopeExpansion", () => {
  it("updates both INCREMENTAL allowlist and current task boundary with absolute paths", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T8",
      fileAllowlist: ["/repo/src/existing.ts"],
      pendingAllowlistExpansions: [{
        files: ["/repo/src/new.ts"],
        reason: "User approved generated example files for T8.",
        sourceArtifact: "implementation",
        requestedAtPhase: "IMPLEMENTATION",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T8",
        description: "Mirror generated examples",
        dependencies: [],
        expectedFiles: ["/repo/src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["src/new.ts"],
      expected_tests: ["tests/new.test.ts"],
      reason: "User explicitly approved the missing generated example files for T8.",
    }, "/repo")

    expect(result.success).toBe(true)
    expect(state.fileAllowlist).toContain("/repo/src/new.ts")
    expect(state.fileAllowlist).toContain("/repo/tests/new.test.ts")
    expect(state.implDag?.[0]?.expectedFiles).toContain("/repo/src/new.ts")
    expect(state.implDag?.[0]?.expectedTests).toContain("/repo/tests/new.test.ts")
    expect(state.pendingAllowlistExpansions).toEqual([])
    expect(state.phaseState).toBe("DRAFT")
  })

  it("normalizes existing relative state and clears equivalent pending allowlist requests", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T1",
      fileAllowlist: ["src/existing.ts"],
      pendingAllowlistExpansions: [{
        files: ["src/new.ts"],
        reason: "User approved generated example files for T1.",
        sourceArtifact: "implementation",
        requestedAtPhase: "IMPLEMENTATION",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T1",
        description: "Update scoped files",
        dependencies: [],
        expectedFiles: ["src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["./src/new.ts"],
      reason: "User explicitly approved the missing generated example files for T1.",
    }, "/repo")

    expect(result.success).toBe(true)
    expect(state.fileAllowlist).toEqual(["/repo/src/existing.ts", "/repo/src/new.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/existing.ts", "/repo/src/new.ts"])
    expect(state.pendingAllowlistExpansions).toEqual([])
  })

  it("requests scope expansion outside USER_GATE and transitions to approval gate without mutating task boundary", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      userGateMessageReceived: false,
      currentTaskId: "T1",
      fileAllowlist: ["/repo/src/existing.ts"],
      implDag: [{
        id: "T1",
        description: "Update scoped files",
        dependencies: [],
        expectedFiles: ["/repo/src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["src/new.ts"],
      reason: "User explicitly approved the missing generated example files for T1.",
    }, "/repo")

    expect(result.success).toBe(true)
    expect(state.fileAllowlist).toEqual(["/repo/src/existing.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/existing.ts"])
    expect(state.phaseState).toBe("USER_GATE")
    expect(state.pendingCurrentTaskScopeExpansions).toEqual([{
      taskId: "T1",
      files: ["/repo/src/new.ts"],
      expectedTests: [],
      reason: "User explicitly approved the missing generated example files for T1.",
      requestedAt: expect.any(Number),
    }])
  })

  it("lets a corrective task request completed-owned files without mutating completed task metadata", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      currentTaskId: "T8",
      fileAllowlist: ["/repo/src/completed.ts", "/repo/src/correction.ts"],
      implDag: [{
        id: "T1",
        description: "Completed owner",
        dependencies: [],
        expectedFiles: ["/repo/src/completed.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "complete",
      }, {
        id: "T8",
        description: "Forward correction",
        dependencies: ["T1"],
        expectedFiles: ["/repo/src/correction.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["src/completed.ts"],
      reason: "User explicitly approved the corrective task touching the completed-owned source file.",
    }, "/repo")

    expect(result.success).toBe(true)
    expect(state.implDag?.find((task) => task.id === "T1")?.expectedFiles).toEqual(["/repo/src/completed.ts"])
    expect(state.implDag?.find((task) => task.id === "T1")?.status).toBe("complete")
    expect(state.implDag?.find((task) => task.id === "T8")?.expectedFiles).toEqual(["/repo/src/correction.ts"])
    expect(state.pendingCurrentTaskScopeExpansions[0]?.files).toEqual(["/repo/src/completed.ts"])
  })

  it("rejects scope expansion at USER_GATE until a real user response is recorded", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: false,
      currentTaskId: "T1",
      fileAllowlist: ["/repo/src/existing.ts"],
      implDag: [{
        id: "T1",
        description: "Update scoped files",
        dependencies: [],
        expectedFiles: ["/repo/src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["src/new.ts"],
      reason: "Attempting to approve a scope expansion without real user input.",
    }, "/repo")

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("real user response")
    expect(state.fileAllowlist).toEqual(["/repo/src/existing.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/existing.ts"])
    expect(state.phaseState).toBe("USER_GATE")
  })

  it("applies pending scope expansion at USER_GATE and returns to active implementation", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T1",
      fileAllowlist: ["/repo/src/existing.ts"],
      pendingCurrentTaskScopeExpansions: [{
        taskId: "T1",
        files: ["/repo/src/new.ts"],
        expectedTests: ["/repo/tests/new.test.ts"],
        reason: "User approved widening the active task boundary.",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T1",
        description: "Update scoped files",
        dependencies: [],
        expectedFiles: ["/repo/src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = applyPendingCurrentTaskScopeExpansions(state, "/repo")

    expect(result.success).toBe(true)
    expect(state.phaseState).toBe("DRAFT")
    expect(state.fileAllowlist).toEqual(["/repo/src/existing.ts", "/repo/src/new.ts", "/repo/tests/new.test.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/existing.ts", "/repo/src/new.ts"])
    expect(state.implDag?.[0]?.expectedTests).toEqual(["/repo/tests/new.test.ts"])
    expect(state.pendingCurrentTaskScopeExpansions).toEqual([])
  })

  it("clears a matching pending scope expansion when directly approved at USER_GATE", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T1",
      fileAllowlist: ["/repo/src/existing.ts"],
      pendingCurrentTaskScopeExpansions: [{
        taskId: "T1",
        files: ["/repo/src/new.ts"],
        expectedTests: ["/repo/tests/new.test.ts"],
        reason: "User approved widening the active task boundary.",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T1",
        description: "Update scoped files",
        dependencies: [],
        expectedFiles: ["/repo/src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["src/new.ts"],
      expected_tests: ["tests/new.test.ts"],
      reason: "User explicitly approved the pending current task scope expansion.",
    }, "/repo")

    expect(result.success).toBe(true)
    expect(state.phaseState).toBe("DRAFT")
    expect(state.fileAllowlist).toEqual(["/repo/src/existing.ts", "/repo/src/new.ts", "/repo/tests/new.test.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/existing.ts", "/repo/src/new.ts"])
    expect(state.implDag?.[0]?.expectedTests).toEqual(["/repo/tests/new.test.ts"])
    expect(state.pendingCurrentTaskScopeExpansions).toEqual([])
  })

  it("rejects direct USER_GATE approval that does not cover an existing pending scope expansion", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T1",
      fileAllowlist: ["/repo/src/existing.ts"],
      pendingCurrentTaskScopeExpansions: [{
        taskId: "T1",
        files: ["/repo/src/pending.ts"],
        expectedTests: [],
        reason: "User approved widening the active task boundary.",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T1",
        description: "Update scoped files",
        dependencies: [],
        expectedFiles: ["/repo/src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["src/other.ts"],
      reason: "User explicitly approved a different current task scope expansion.",
    }, "/repo")

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("pending current-task scope expansion")
    expect(state.phaseState).toBe("USER_GATE")
    expect(state.fileAllowlist).toEqual(["/repo/src/existing.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/existing.ts"])
    expect(state.pendingCurrentTaskScopeExpansions).toHaveLength(1)
  })

  it("approves cleanup files without mutating current task ownership", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T1",
      fileAllowlist: ["/repo/src/existing.ts"],
      approvedCleanupFiles: [],
      implDag: [{
        id: "T1",
        description: "Update scoped files",
        dependencies: [],
        expectedFiles: ["/repo/src/existing.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      cleanup_files: ["src/accidental-shim.ts"],
      reason: "User explicitly approved deleting an accidental file without adding task ownership.",
    }, "/repo")

    expect(result.success).toBe(true)
    expect(state.approvedCleanupFiles).toEqual(["/repo/src/accidental-shim.ts"])
    expect(state.fileAllowlist).toEqual(["/repo/src/existing.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/existing.ts"])
    expect(state.phaseState).toBe("DRAFT")
  })

  it("rejects scope expansion paths outside the project root", () => {
    const state = makeWorkflowState({
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T1",
      implDag: [{
        id: "T1",
        description: "Scoped task",
        dependencies: [],
        expectedFiles: [],
        expectedTests: [],
        estimatedComplexity: "small",
        status: "in-flight",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      files: ["../outside.ts"],
      reason: "User explicitly approved a path, but it is outside the project root.",
    }, "/repo")

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("outside the project root")
  })

  it("rejects non-current task repairs", () => {
    const state = makeWorkflowState({
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      userGateMessageReceived: true,
      currentTaskId: "T1",
      implDag: [{
        id: "T2",
        description: "Other task",
        dependencies: [],
        expectedFiles: [],
        expectedTests: [],
        estimatedComplexity: "small",
        status: "pending",
      }],
    })

    const result = approveCurrentTaskScopeExpansion(state, {
      task_id: "T2",
      files: ["src/other.ts"],
      reason: "Attempting to modify a non-current task boundary.",
    }, "/repo")

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("not the current task")
  })
})
