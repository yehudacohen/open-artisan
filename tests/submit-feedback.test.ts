/**
 * Tests for processSubmitFeedback.
 */
import { describe, expect, it } from "bun:test"
import type { TaskNode } from "#core/dag"
import { buildSubmitFeedbackClarificationMessage, findReviewedArtifactFilesOutsideAllowlist, findUnresolvedHumanGates, isUserGateMetaFeedback, materializeForwardOnlyImplPlanDag, materializeImplPlanDag, normalizeApprovalFilePaths, processSubmitFeedback, resolveSubmitFeedbackHumanGates, validateSubmitFeedbackGate, validateSubmitFeedbackImplPlanApproval } from "#core/tools/submit-feedback"

function task(overrides: Partial<TaskNode>): TaskNode {
  return {
    id: "T1",
    description: "Task one",
    dependencies: [],
    expectedTests: [],
    expectedFiles: [],
    estimatedComplexity: "small",
    status: "pending",
    ...overrides,
  }
}

const validImplPlan = `
## Task T1: Build foundation
**Dependencies:** none
**Expected tests:** tests/a.test.ts
**Files:** src/a.ts
**Complexity:** small

Implement the foundation.
`

describe("processSubmitFeedback — approve path", () => {
  it("returns feedbackType='approve'", () => {
    const result = processSubmitFeedback({
      feedback_text: "Looks great!",
      feedback_type: "approve",
    })
    expect(result.feedbackType).toBe("approve")
  })

  it("preserves feedback_text in feedbackText", () => {
    const result = processSubmitFeedback({
      feedback_text: "LGTM",
      feedback_type: "approve",
    })
    expect(result.feedbackText).toBe("LGTM")
  })

  it("approve responseMessage mentions checkpoint or advancing", () => {
    const result = processSubmitFeedback({
      feedback_text: "Approved",
      feedback_type: "approve",
    })
    // Should mention git checkpoint and/or next phase
    const msg = result.responseMessage.toLowerCase()
    expect(
      msg.includes("checkpoint") || msg.includes("next phase") || msg.includes("advance"),
    ).toBe(true)
  })

  it("approve responseMessage requires immediate continuation after non-terminal advancement", () => {
    const result = processSubmitFeedback({
      feedback_text: "Approved",
      feedback_type: "approve",
    })
    expect(result.responseMessage).toContain("Begin the next phase immediately")
    expect(result.responseMessage).toContain("do not stop")
    expect(result.responseMessage).toContain("wait for user input")
  })

  it("does not silently approve approval-plus-revision text", () => {
    const result = processSubmitFeedback({
      feedback_text: "approved, but please fix the allowlist",
      feedback_type: "approve",
    })

    expect(result.feedbackType).toBe("revise")
    expect(result.responseMessage.toLowerCase()).toContain("revision")
  })
})

describe("isUserGateMetaFeedback", () => {
  it("detects status and experience questions as non-revision meta feedback", () => {
    expect(isUserGateMetaFeedback("have we implemented all the implementation tasks? How has your experience with open-artisan been?")).toBe(true)
  })

  it("does not classify real change requests as meta feedback", () => {
    expect(isUserGateMetaFeedback("Can you add section on authentication?")).toBe(false)
  })

  it("classifies exact Open Artisan feel questions as meta feedback", () => {
    expect(isUserGateMetaFeedback("how did Open Artisan feel?")).toBe(true)
  })
})

describe("submit_feedback shared gate guards", () => {
  it("allows user-facing gate states", () => {
    expect(validateSubmitFeedbackGate("USER_GATE")).toBeNull()
    expect(validateSubmitFeedbackGate("ESCAPE_HATCH")).toBeNull()
    expect(validateSubmitFeedbackGate("HUMAN_GATE")).toBeNull()
  })

  it("rejects non-gate states", () => {
    expect(validateSubmitFeedbackGate("DRAFT")).toContain("USER_GATE")
  })

  it("returns clarification messages for meta revise feedback", () => {
    const msg = buildSubmitFeedbackClarificationMessage("revise", "USER_GATE", "have we implemented all the implementation tasks?")
    expect(msg).toContain("clarification/status question")
  })

  it("does not block real revision feedback", () => {
    const msg = buildSubmitFeedbackClarificationMessage("revise", "USER_GATE", "Please add auth details")
    expect(msg).toBeNull()
  })
})

describe("submit_feedback incremental allowlist helpers", () => {
  it("normalizes approval file paths against cwd", () => {
    expect(normalizeApprovalFilePaths(["src/a.ts", "/repo/b.ts"], "/repo")).toEqual(["/repo/src/a.ts", "/repo/b.ts"])
  })

  it("ignores workflow artifact paths when checking reviewed files", () => {
    const outside = findReviewedArtifactFilesOutsideAllowlist({
      reviewArtifactFiles: ["/repo/.openartisan/feature/plan.md", "src/a.ts", "src/b.ts"],
      artifactDiskPaths: { plan: "/repo/.openartisan/feature/plan.md" },
      allowlist: ["src/a.ts"],
      cwd: "/repo",
    })
    expect(outside).toEqual(["/repo/src/b.ts"])
  })
})

describe("submit_feedback IMPL_PLAN approval helpers", () => {
  it("validates parseable executable implementation plans", () => {
    const error = validateSubmitFeedbackImplPlanApproval({
      planContent: validImplPlan,
      mode: "INCREMENTAL",
      effectiveAllowlist: ["src/a.ts", "tests/a.test.ts"],
      cwd: "/repo",
      parseFixInstruction: "Fix it.",
    })
    expect(error).toBeNull()
  })

  it("reports parse errors with the adapter-provided fix instruction", () => {
    const error = validateSubmitFeedbackImplPlanApproval({
      planContent: "## Not a task",
      mode: "GREENFIELD",
      effectiveAllowlist: [],
      cwd: "/repo",
      parseFixInstruction: "Use the task format.",
    })
    expect(error).toContain("Failed to parse implementation plan")
    expect(error).toContain("Use the task format")
  })

  it("materializes DAG nodes and first ready task", () => {
    const materialized = materializeImplPlanDag(validImplPlan)
    expect(materialized?.nodes.map((node) => node.id)).toEqual(["T1"])
    expect(materialized?.currentTaskId).toBe("T1")
  })

  it("materializes DAG task file sets as absolute paths when cwd is provided", () => {
    const materialized = materializeImplPlanDag(validImplPlan, "/repo")
    expect(materialized?.nodes[0]?.expectedFiles).toEqual(["/repo/src/a.ts"])
    expect(materialized?.nodes[0]?.expectedTests).toEqual(["/repo/tests/a.test.ts"])
  })

  it("forward-only materialization preserves completed tasks and appends future corrective tasks", () => {
    const revisedPlan = `
## Task T1: Build foundation
**Dependencies:** none
**Expected tests:** tests/a.test.ts
**Files:** src/a.ts
**Complexity:** small

Already completed.

## Task T2: Correct foundation behavior
**Dependencies:** none
**Expected tests:** tests/a.test.ts
**Files:** src/a.ts
**Complexity:** small

Add a forward corrective task instead of rewriting T1.
`
    const completed = task({ id: "T1", status: "complete", description: "Build foundation — Already completed.", expectedFiles: ["/repo/src/a.ts"], expectedTests: ["/repo/tests/a.test.ts"] })

    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T1")).toEqual(completed)
    expect(materialized.nodes.find((node) => node.id === "T2")?.status).toBe("pending")
    expect(materialized.currentTaskId).toBe("T2")
  })

  it("accepts immutable completed history when a future task owns missing executable readiness", () => {
    const revisedPlan = `
## Task T1: Historical foundation
**Dependencies:** none
**Expected tests:** none
**Verification commands:** none
**Files:** none
**Complexity:** small

Already completed before executable metadata was required.

## Task T8: Correct historical readiness evidence
**Dependencies:** T1
**Expected tests:** tests/final-readiness.test.ts
**Verification commands:** bun test tests/final-readiness.test.ts
**Files:** src/final-readiness.ts, tests/final-readiness.test.ts
**Complexity:** medium

Own the evidence and final-review readiness gap left by T1 without rewriting T1.
`
    const completed = task({
      id: "T1",
      status: "complete",
      description: "Historical foundation — Already completed before executable metadata was required.",
      expectedFiles: [],
      expectedTests: [],
      verificationCommands: [],
    })

    const contractError = validateSubmitFeedbackImplPlanApproval({
      planContent: revisedPlan,
      mode: "INCREMENTAL",
      effectiveAllowlist: ["src/final-readiness.ts", "tests/final-readiness.test.ts"],
      cwd: "/repo",
      parseFixInstruction: "Fix it.",
    })
    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(contractError).toBeNull()
    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T1")).toEqual(completed)
    expect(materialized.nodes.find((node) => node.id === "T8")?.expectedFiles).toEqual([
      "/repo/src/final-readiness.ts",
      "/repo/tests/final-readiness.test.ts",
    ])
    expect(materialized.currentTaskId).toBe("T8")
  })

  it("ignores executable metadata when comparing completed task descriptions", () => {
    const revisedPlan = `
## Task T3: Historical task
**Dependencies:** none
**Expected tests:** none
**Files:** none
**Complexity:** small

Implementation: Preserve completed history. Required Files: none / Expected tests: none

## Task T4: Forward correction
**Dependencies:** T3
**Expected tests:** tests/final.test.ts
**Files:** src/final.ts, tests/final.test.ts
**Complexity:** small

Own follow-up readiness without rewriting T3.
`
    const completed = task({
      id: "T3",
      status: "complete",
      description: "Historical task — Implementation: Preserve completed history.",
      expectedFiles: [],
      expectedTests: [],
      verificationCommands: [],
    })

    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T3")).toEqual(completed)
    expect(materialized.currentTaskId).toBe("T4")
  })

  it("does not classify parser truncation of long completed descriptions as a rewrite", () => {
    const longImplementation = Array.from({ length: 30 }, (_, index) => `step-${index}-preserved-history`).join(" ")
    const description = `Long completed task — Implementation: ${longImplementation}`
    const revisedPlan = `
## Task T3: Long completed task
**Dependencies:** none
**Expected tests:** none
**Files:** none
**Complexity:** medium

Implementation: ${longImplementation}

## Task T4: Forward correction
**Dependencies:** T3
**Expected tests:** tests/final.test.ts
**Files:** src/final.ts, tests/final.test.ts
**Complexity:** small

Own follow-up readiness without rewriting T3.
`
    const completed = task({
      id: "T3",
      status: "complete",
      description,
      expectedFiles: [],
      expectedTests: [],
      verificationCommands: [],
      estimatedComplexity: "medium",
    })

    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T3")).toEqual(completed)
    expect(materialized.currentTaskId).toBe("T4")
  })

  it("accepts legacy completed descriptions persisted with the old 500-character parser cap", () => {
    const longImplementation = Array.from({ length: 30 }, (_, index) => `step-${index}-legacy-history`).join(" ")
    const fullDescription = `Legacy completed task — Implementation: ${longImplementation}`
    const revisedPlan = `
## Task T3: Legacy completed task
**Dependencies:** none
**Expected tests:** none
**Files:** none
**Complexity:** medium

Implementation: ${longImplementation}

## Task T4: Forward correction
**Dependencies:** T3
**Expected tests:** tests/final.test.ts
**Files:** src/final.ts, tests/final.test.ts
**Complexity:** small

Own follow-up readiness without rewriting T3.
`
    const completed = task({
      id: "T3",
      status: "complete",
      description: fullDescription.slice(0, 500),
      expectedFiles: [],
      expectedTests: [],
      verificationCommands: [],
      estimatedComplexity: "medium",
    })

    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T3")).toEqual(completed)
    expect(materialized.currentTaskId).toBe("T4")
  })

  it("compares completed implementation prose without treating surrounding review metadata as a rewrite", () => {
    const revisedPlan = `
## Task T5: Documentation cleanup
**Dependencies:** none
**Expected tests:** none
**Files:** none
**Complexity:** medium

Intentional deletion targets:

- build/tmp/generated.js

Implementation:

- Preserve existing docs cleanup.
- Keep generated artifacts outside default discovery.

Acceptance:

- Final review understands the deletion metadata.

## Task T6: Forward correction
**Dependencies:** T5
**Expected tests:** tests/final.test.ts
**Files:** src/final.ts, tests/final.test.ts
**Complexity:** small

Own follow-up readiness without rewriting T5.
`
    const completed = task({
      id: "T5",
      status: "complete",
      description: "Documentation cleanup — Implementation: - Preserve existing docs cleanup. - Keep generated artifacts outside default discovery.",
      dependencies: [],
      expectedFiles: [],
      expectedTests: [],
      verificationCommands: [],
      estimatedComplexity: "medium",
    })

    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T5")).toEqual(completed)
    expect(materialized.currentTaskId).toBe("T6")
  })

  it("compares completed acceptance prose without treating markdown scheduling notes as a rewrite", () => {
    const revisedPlan = `
## Task T7: Final verification sweep
**Dependencies:** none
**Expected tests:** tests/final.test.ts
**Files:** none
**Complexity:** medium

Acceptance:

- All approved focused tests pass.
- Template/example parity passes.

## Scheduling Notes

- Execute T9 after T8 if final-review metadata still needs repair.
- T6 is optional and human-gated.

## Task T9: Forward deletion metadata repair
**Dependencies:** T7
**Expected tests:** none
**Files:** none
**Complexity:** small

Own follow-up deletion metadata without rewriting T7.
`
    const completed = task({
      id: "T7",
      status: "complete",
      description: "Final verification sweep — Acceptance: - All approved focused tests pass. - Template/example parity passes. ## Scheduling Notes - T6 is optional and human-gated.",
      expectedFiles: [],
      expectedTests: ["/repo/tests/final.test.ts"],
      verificationCommands: [],
      estimatedComplexity: "medium",
    })

    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T7")).toEqual(completed)
    expect(materialized.currentTaskId).toBe("T9")
  })

  it("materializes future intentional deletion targets without mutating completed task expected files", () => {
    const revisedPlan = `
## Task T1: Historical generator task
**Dependencies:** none
**Expected tests:** none
**Files:** src/deleted-openfga.ts, src/kept.ts
**Complexity:** small

Implementation: Historical task remains immutable.

## Task T9: Deletion metadata repair
**Dependencies:** T1
**Expected tests:** none
**Files:** none
**Intentional deletion targets:** src/deleted-openfga.ts
**Complexity:** small

Implementation: Mark deleted OpenFGA files as final-review deletion targets.
`
    const completed = task({
      id: "T1",
      status: "complete",
      description: "Historical generator task — Implementation: Historical task remains immutable.",
      expectedFiles: ["/repo/src/deleted-openfga.ts", "/repo/src/kept.ts"],
      expectedTests: [],
    })

    const materialized = materializeForwardOnlyImplPlanDag(revisedPlan, "/repo", [completed])

    expect(materialized.success).toBe(true)
    if (!materialized.success) return
    expect(materialized.nodes.find((node) => node.id === "T1")).toEqual(completed)
    expect(materialized.nodes.find((node) => node.id === "T9")?.intentionalDeletionTargets).toEqual(["/repo/src/deleted-openfga.ts"])
  })

  it("forward-only materialization rejects rewrites of completed task metadata", () => {
    const rewrittenPlan = `
## Task T1: Rewritten foundation
**Dependencies:** none
**Expected tests:** tests/a.test.ts
**Files:** src/a.ts, src/new.ts
**Complexity:** small

Attempts to rewrite completed task ownership.
`
    const completed = task({ id: "T1", status: "complete", description: "Original completed foundation", expectedFiles: ["/repo/src/a.ts"], expectedTests: ["/repo/tests/a.test.ts"] })

    const materialized = materializeForwardOnlyImplPlanDag(rewrittenPlan, "/repo", [completed])

    expect(materialized.success).toBe(false)
    if (materialized.success) return
    expect(materialized.error).toContain("Completed task \"T1\" is immutable")
    expect(materialized.error).toContain("add a future corrective")
  })

  it("explains missing deleted historical files when completed task Files metadata is changed", () => {
    const rewrittenPlan = `
## Task T1: Historical generator task
**Dependencies:** none
**Expected tests:** none
**Files:** src/kept.ts
**Complexity:** small

Implementation: Historical task remains immutable.

## Task T10: Deletion metadata repair
**Dependencies:** T1
**Expected tests:** none
**Files:** none
**Intentional deletion targets:** src/deleted-openfga.ts
**Complexity:** small

Implementation: Mark deleted OpenFGA files as final-review deletion targets.
`
    const completed = task({
      id: "T1",
      status: "complete",
      description: "Historical generator task — Implementation: Historical task remains immutable.",
      expectedFiles: ["/repo/src/kept.ts", "/repo/src/deleted-openfga.ts"],
      expectedTests: [],
    })

    const materialized = materializeForwardOnlyImplPlanDag(rewrittenPlan, "/repo", [completed])

    expect(materialized.success).toBe(false)
    if (materialized.success) return
    expect(materialized.error).toContain("missing from revised plan: /repo/src/deleted-openfga.ts")
    expect(materialized.error).toContain("Do not remove deleted historical files")
    expect(materialized.error).toContain("Intentional deletion targets/Deleted files")
  })

  it("forward-only materialization rejects description-only rewrites of completed tasks", () => {
    const rewrittenPlan = `
## Task T1: Renamed completed foundation
**Dependencies:** none
**Expected tests:** tests/a.test.ts
**Files:** src/a.ts
**Complexity:** small

Attempts to rewrite completed task description only.
`
    const completed = task({ id: "T1", status: "complete", description: "Original completed foundation", expectedFiles: ["/repo/src/a.ts"], expectedTests: ["/repo/tests/a.test.ts"] })

    const materialized = materializeForwardOnlyImplPlanDag(rewrittenPlan, "/repo", [completed])

    expect(materialized.success).toBe(false)
    if (materialized.success) return
    expect(materialized.error).toContain("Completed task \"T1\" is immutable")
    expect(materialized.error).toContain("description")
  })
})

describe("submit_feedback human-gate resolution", () => {
  it("finds unresolved human-gated tasks", () => {
    const unresolved = findUnresolvedHumanGates({
      implDag: [
        task({ id: "T1", status: "human-gated", humanGate: { whatIsNeeded: "Configure creds", why: "Needed", verificationSteps: "Check env", resolved: false } }),
        task({ id: "T2", status: "complete" }),
      ],
    })
    expect(unresolved.map((node) => node.id)).toEqual(["T1"])
  })

  it("resolves requested human gates and computes next dispatch", () => {
    const result = resolveSubmitFeedbackHumanGates(
      {
        concurrency: { maxParallelTasks: 1 },
        implDag: [
          task({ id: "T1", status: "human-gated", humanGate: { whatIsNeeded: "Configure creds", why: "Needed", verificationSteps: "Check env", resolved: false } }),
          task({ id: "T2", description: "Follow-up", dependencies: ["T1"], status: "pending" }),
        ],
      },
      ["T1"],
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.resolution.resolvedIds).toEqual(["T1"])
    expect(result.resolution.remainingGates).toEqual([])
    expect(result.resolution.nextDecision.action).toBe("dispatch")
    expect(result.resolution.updatedNodes.find((node) => node.id === "T1")?.humanGate?.resolved).toBe(true)
  })

  it("reports invalid human-gate ids", () => {
    const result = resolveSubmitFeedbackHumanGates(
      { concurrency: { maxParallelTasks: 1 }, implDag: [task({ id: "T1", status: "human-gated" })] },
      ["missing"],
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("not found")
  })
})

describe("processSubmitFeedback — revise path", () => {
  it("returns feedbackType='revise'", () => {
    const result = processSubmitFeedback({
      feedback_text: "Please fix the error handling",
      feedback_type: "revise",
    })
    expect(result.feedbackType).toBe("revise")
  })

  it("preserves feedback_text in feedbackText", () => {
    const result = processSubmitFeedback({
      feedback_text: "Fix the error handling",
      feedback_type: "revise",
    })
    expect(result.feedbackText).toBe("Fix the error handling")
  })

  it("revise responseMessage includes the feedback text (truncated)", () => {
    const feedback = "The function is missing a null check"
    const result = processSubmitFeedback({
      feedback_text: feedback,
      feedback_type: "revise",
    })
    expect(result.responseMessage).toContain(feedback)
  })

  it("revise responseMessage truncates very long feedback at 200 chars", () => {
    const longFeedback = "x".repeat(250)
    const result = processSubmitFeedback({
      feedback_text: longFeedback,
      feedback_type: "revise",
    })
    // Should contain "..." indicating truncation
    expect(result.responseMessage).toContain("...")
    // The message should not contain the full 250-char string verbatim
    expect(result.responseMessage).not.toContain(longFeedback)
  })

  it("revise responseMessage does NOT say 'wait for routing instructions' (M3 fix)", () => {
    const result = processSubmitFeedback({
      feedback_text: "needs changes",
      feedback_type: "revise",
    })
    expect(result.responseMessage.toLowerCase()).not.toContain("wait for routing")
  })

  it("revise responseMessage says to begin revision now (M3 fix)", () => {
    const result = processSubmitFeedback({
      feedback_text: "needs changes",
      feedback_type: "revise",
    })
    const msg = result.responseMessage.toLowerCase()
    expect(msg.includes("begin") || msg.includes("revise") || msg.includes("revision")).toBe(true)
  })

  it("strips injected workflow routing notes from recorded feedback", () => {
    const result = processSubmitFeedback({
      feedback_text:
        "Please add the missing tests.\n\n" +
        "[WORKFLOW GATE — IMMEDIATE ACTION REQUIRED] The user has provided feedback on the INTERFACES artifact. Call `submit_feedback` NOW with feedback_type=\"revise\" and feedback_text set to the user's exact message. This must be your first and only tool call. Do NOT do research or analysis first.",
      feedback_type: "revise",
    })
    expect(result.feedbackText).toBe("Please add the missing tests.")
    expect(result.responseMessage).not.toContain("WORKFLOW GATE")
  })
})

describe("processSubmitFeedback — feedback_type validation", () => {
  it("unknown feedback_type treated as revise with warning", () => {
    const result = processSubmitFeedback({
      feedback_text: "test",
      feedback_type: "invalid_value" as any,
    })
    expect(result.feedbackType).toBe("revise")
    expect(result.responseMessage.toLowerCase()).toContain("unknown")
  })

  it("empty string feedback_type treated as revise with warning", () => {
    const result = processSubmitFeedback({
      feedback_text: "test",
      feedback_type: "" as any,
    })
    expect(result.feedbackType).toBe("revise")
    expect(result.responseMessage.toLowerCase()).toContain("unknown")
  })
})
