/**
 * Tests for processSubmitFeedback.
 */
import { describe, expect, it } from "bun:test"
import type { TaskNode } from "#core/dag"
import { buildSubmitFeedbackClarificationMessage, findReviewedArtifactFilesOutsideAllowlist, findUnresolvedHumanGates, isUserGateMetaFeedback, materializeImplPlanDag, normalizeApprovalFilePaths, processSubmitFeedback, resolveSubmitFeedbackHumanGates, validateSubmitFeedbackGate, validateSubmitFeedbackImplPlanApproval } from "#core/tools/submit-feedback"

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
})

describe("isUserGateMetaFeedback", () => {
  it("detects status and experience questions as non-revision meta feedback", () => {
    expect(isUserGateMetaFeedback("have we implemented all the implementation tasks? How has your experience with open-artisan been?")).toBe(true)
  })

  it("does not classify real change requests as meta feedback", () => {
    expect(isUserGateMetaFeedback("Can you add section on authentication?")).toBe(false)
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
    expect(normalizeApprovalFilePaths(["src/a.ts", "/tmp/b.ts"], "/repo")).toEqual(["/repo/src/a.ts", "/tmp/b.ts"])
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
