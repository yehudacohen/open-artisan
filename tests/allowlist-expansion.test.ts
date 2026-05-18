import { describe, expect, it } from "bun:test"

import { applyPendingAllowlistExpansions, recordAllowlistExpansionRequest } from "#core/tools/allowlist-expansion"
import { makeWorkflowState } from "./helpers/workflow-state"

describe("recordAllowlistExpansionRequest", () => {
  it("rejects paths outside the project root", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
    })

    const result = recordAllowlistExpansionRequest(state, {
      files: ["../outside.ts", "/tmp/secret.ts"],
      reason: "User approved checking strict path validation.",
      source_artifact: "impl_plan",
    }, "/repo")

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("outside the project root")
    expect(state.pendingAllowlistExpansions).toEqual([])
    expect(state.phaseState).toBe("DRAFT")
  })
})

describe("applyPendingAllowlistExpansions", () => {
  it("updates the active task boundary while applying approved implementation allowlist expansion", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      currentTaskId: "T8",
      fileAllowlist: ["/repo/src/runtime.ts"],
      pendingAllowlistExpansions: [{
        files: ["/repo/src/new.ts", "/repo/tests/new.test.ts"],
        reason: "User approved additional active task files.",
        sourceArtifact: "impl_plan",
        requestedAtPhase: "IMPLEMENTATION",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T8",
        description: "Active task",
        dependencies: [],
        expectedFiles: ["/repo/src/runtime.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = applyPendingAllowlistExpansions(state)

    expect(result.success).toBe(true)
    expect(state.fileAllowlist).toContain("/repo/src/new.ts")
    expect(state.implDag?.[0]?.expectedFiles).toContain("/repo/src/new.ts")
    expect(state.implDag?.[0]?.expectedTests).toContain("/repo/tests/new.test.ts")
    expect(state.phaseState).toBe("DRAFT")
  })

  it("canonicalizes persisted allowlist, request, and task paths when cwd is provided", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "USER_GATE",
      currentTaskId: "T8",
      fileAllowlist: ["src/runtime.ts"],
      pendingAllowlistExpansions: [{
        files: ["/repo/src/new.ts", "tests/new.test.ts"],
        reason: "User approved additional active task files.",
        sourceArtifact: "impl_plan",
        requestedAtPhase: "IMPLEMENTATION",
        requestedAt: 1,
      }],
      implDag: [{
        id: "T8",
        description: "Active task",
        dependencies: [],
        expectedFiles: ["src/runtime.ts"],
        expectedTests: [],
        estimatedComplexity: "medium",
        status: "in-flight",
      }],
    })

    const result = applyPendingAllowlistExpansions(state, "/repo")

    expect(result.success).toBe(true)
    expect(state.fileAllowlist).toEqual(["/repo/src/runtime.ts", "/repo/src/new.ts", "/repo/tests/new.test.ts"])
    expect(state.implDag?.[0]?.expectedFiles).toEqual(["/repo/src/runtime.ts", "/repo/src/new.ts"])
    expect(state.implDag?.[0]?.expectedTests).toEqual(["/repo/tests/new.test.ts"])
    expect(state.pendingAllowlistExpansions).toEqual([])
  })
})
