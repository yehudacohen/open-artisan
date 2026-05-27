import { describe, expect, it } from "bun:test"

import {
  parseReviewArtifactAllowlistExpansionDecision,
  precheckReviewArtifactAllowlistExpansion,
  validateReviewArtifactAllowlistExpansionDecision,
} from "#core/review-artifact-allowlist-expansion"
import { makeWorkflowState } from "./helpers/workflow-state"

describe("review artifact allowlist expansion", () => {
  it("accepts a reviewed TESTS artifact file before an implementation DAG exists", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "TESTS",
      phaseState: "USER_GATE",
      fileAllowlist: ["/repo/src/runtime.ts"],
      reviewArtifactFiles: ["/repo/tests/auth-tenancy-billing.test.ts"],
    })

    const result = precheckReviewArtifactAllowlistExpansion({
      state,
      cwd: "/repo",
      effectiveAllowlist: state.fileAllowlist,
      missingFiles: ["/repo/tests/auth-tenancy-billing.test.ts"],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.files).toEqual(["/repo/tests/auth-tenancy-billing.test.ts"])
      expect(result.evidence.join("\n")).toContain("No implementation DAG exists yet")
    }
  })

  it("rejects files that were not reviewed", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "TESTS",
      phaseState: "USER_GATE",
      reviewArtifactFiles: ["/repo/tests/reviewed.test.ts"],
    })

    const result = precheckReviewArtifactAllowlistExpansion({
      state,
      cwd: "/repo",
      effectiveAllowlist: [],
      missingFiles: ["/repo/tests/unreviewed.test.ts"],
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("not one of the reviewed artifact files")
  })

  it("rejects TESTS expansion for non-test files", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "TESTS",
      phaseState: "USER_GATE",
      reviewArtifactFiles: ["/repo/src/runtime.ts"],
    })

    const result = precheckReviewArtifactAllowlistExpansion({
      state,
      cwd: "/repo",
      effectiveAllowlist: [],
      missingFiles: ["/repo/src/runtime.ts"],
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("non-test file")
  })

  it("rejects expansion that would rewrite completed DAG task ownership", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "TESTS",
      phaseState: "USER_GATE",
      reviewArtifactFiles: ["/repo/tests/task.test.ts"],
      approvedArtifacts: { impl_plan: "approved" },
      implDag: [{
        id: "T1",
        description: "Completed task",
        dependencies: [],
        expectedFiles: [],
        expectedTests: ["/repo/tests/task.test.ts"],
        estimatedComplexity: "small",
        status: "complete",
      }],
    })

    const result = precheckReviewArtifactAllowlistExpansion({
      state,
      cwd: "/repo",
      effectiveAllowlist: [],
      missingFiles: ["/repo/tests/task.test.ts"],
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("completed/aborted task ownership")
  })

  it("rejects expansion not represented by an already approved implementation plan", () => {
    const state = makeWorkflowState({
      mode: "INCREMENTAL",
      phase: "TESTS",
      phaseState: "USER_GATE",
      reviewArtifactFiles: ["/repo/tests/new.test.ts"],
      approvedArtifacts: { impl_plan: "approved" },
      implDag: [{
        id: "T1",
        description: "Future task",
        dependencies: [],
        expectedFiles: ["/repo/src/runtime.ts"],
        expectedTests: [],
        estimatedComplexity: "small",
        status: "pending",
      }],
    })

    const result = precheckReviewArtifactAllowlistExpansion({
      state,
      cwd: "/repo",
      effectiveAllowlist: [],
      missingFiles: ["/repo/tests/new.test.ts"],
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("approved IMPL_PLAN does not assign")
  })

  it("requires reviewer to approve exactly the failed reviewed files", () => {
    const result = validateReviewArtifactAllowlistExpansionDecision({
      files: ["/repo/tests/a.test.ts"],
      cwd: "/repo",
      decision: {
        approved: true,
        architecturally_sound: true,
        dag_safe: true,
        confidence: "high",
        reason: "Safe scoped test expansion.",
        approved_files: ["/repo/tests/a.test.ts", "/repo/tests/b.test.ts"],
        rejected_files: [],
      },
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("exactly")
  })

  it("parses structured reviewer decisions", () => {
    const result = parseReviewArtifactAllowlistExpansionDecision(JSON.stringify({
      approved: true,
      architecturally_sound: true,
      dag_safe: true,
      confidence: "high",
      reason: "Safe scoped test expansion.",
      approved_files: ["/repo/tests/a.test.ts"],
      rejected_files: [],
    }))

    expect(result.success).toBe(true)
    if (result.success) expect(result.decision.approved_files).toEqual(["/repo/tests/a.test.ts"])
  })
})
