import { describe, expect, it } from "bun:test"

import { analyzeTaskBoundaryChange, applyTaskBoundaryChange } from "#core/tools/transitions"
import type { AnalyzeTaskBoundaryChangeArgs, ApplyTaskBoundaryChangeArgs } from "#core/tool-types"
import { makeWorkflowState } from "./helpers/workflow-state"

describe("task boundary changes", () => {
  it("detects ownership overlaps after normalizing relative and absolute paths", () => {
    const state = makeWorkflowState({
      phase: "IMPLEMENTATION",
      mode: "INCREMENTAL",
      fileAllowlist: ["src/shared.ts", "tests/shared.test.ts"],
      implDag: [
        {
          id: "T1",
          description: "First task",
          dependencies: [],
          expectedFiles: [],
          expectedTests: [],
          estimatedComplexity: "medium",
          status: "in-flight",
        },
        {
          id: "T2",
          description: "Second task",
          dependencies: [],
          expectedFiles: ["/repo/src/shared.ts"],
          expectedTests: ["/repo/tests/shared.test.ts"],
          estimatedComplexity: "medium",
          status: "pending",
        },
      ],
    })

    const args = {
      task_id: "T1",
      add_files: ["./src/shared.ts"],
      remove_files: [],
      add_expected_tests: ["tests/shared.test.ts"],
      remove_expected_tests: [],
      reason: "User approved moving shared files into the active task boundary.",
    } as unknown as AnalyzeTaskBoundaryChangeArgs
    const result = analyzeTaskBoundaryChange(args, state, "/repo")

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.analysis.overlappingOwnedFiles.map(String)).toEqual(["/repo/src/shared.ts"])
    expect(result.analysis.overlappingExpectedTests.map(String)).toEqual(["/repo/tests/shared.test.ts"])
  })

  it("applies boundary repairs using canonical absolute task paths", () => {
    const state = makeWorkflowState({
      phase: "IMPLEMENTATION",
      mode: "GREENFIELD",
      implDag: [
        {
          id: "T1",
          description: "First task",
          dependencies: [],
          expectedFiles: ["src/old.ts"],
          expectedTests: [],
          estimatedComplexity: "medium",
          status: "in-flight",
        },
      ],
    })

    const args = {
      task_id: "T1",
      add_files: ["src/new.ts"],
      remove_files: ["./src/old.ts"],
      add_expected_tests: ["tests/new.test.ts"],
      remove_expected_tests: [],
      expected_impacted_tasks: ["T1"],
      expected_reset_tasks: [],
      reason: "User approved replacing the old file with the new scoped implementation file.",
    } as unknown as ApplyTaskBoundaryChangeArgs
    const result = applyTaskBoundaryChange(args, state, "/repo")

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.updatedNodes[0]?.expectedFiles).toEqual(["/repo/src/new.ts"])
    expect(result.updatedNodes[0]?.expectedTests).toEqual(["/repo/tests/new.test.ts"])
  })

  it("rejects boundary changes that would reset completed tasks", () => {
    const state = makeWorkflowState({
      phase: "IMPLEMENTATION",
      mode: "GREENFIELD",
      implDag: [
        {
          id: "T1",
          description: "Completed owner",
          dependencies: [],
          expectedFiles: ["/repo/src/shared.ts"],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "complete",
        },
        {
          id: "T2",
          description: "Future correction",
          dependencies: ["T1"],
          expectedFiles: ["/repo/src/correction.ts"],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "pending",
        },
      ],
    })

    const args = {
      task_id: "T2",
      add_files: ["/repo/src/shared.ts"],
      remove_files: [],
      add_expected_tests: [],
      remove_expected_tests: [],
      expected_impacted_tasks: ["T1", "T2"],
      expected_reset_tasks: ["T1"],
      reason: "Attempt to move a completed task file into future task ownership.",
    } as unknown as ApplyTaskBoundaryChangeArgs
    const result = applyTaskBoundaryChange(args, state, "/repo")

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.message).toContain("Completed task(s) cannot be reset")
    expect(state.implDag?.find((task) => task.id === "T1")?.status).toBe("complete")
  })
})
