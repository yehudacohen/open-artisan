import { describe, expect, it } from "bun:test"

import { buildWorkflowRuntimeExplanation, classifyWorkflowNextAction } from "#core/workflow-next-action"
import type { WorkflowNextActionKind } from "#core/workflow-next-action"

describe("classifyWorkflowNextAction", () => {
  it.each([
    ["PLANNING", "DRAFT"],
    ["PLANNING", "REDRAFT"],
    ["INTERFACES", "REVISE"],
    ["IMPLEMENTATION", "TASK_REVISE"],
  ])("continues authoring state %s/%s", (phase, phaseState) => {
    const result = classifyWorkflowNextAction({ phase, phaseState, currentTaskId: "T1" })
    expect(result.nextAction).toBe("author_continue")
    expect(result.shouldContinue).toBe(true)
    expect(result.requiresAdapterAction).toBe(false)
    expect(result.continuationMessage).toBeTruthy()
  })

  it.each([
    ["PLANNING", "REVIEW"],
    ["IMPLEMENTATION", "TASK_REVIEW"],
  ])("drains adapter-owned state %s/%s", (phase, phaseState) => {
    const result = classifyWorkflowNextAction({ phase, phaseState, currentTaskId: "T1" })
    expect(result.nextAction).toBe("adapter_drain")
    expect(result.shouldContinue).toBe(true)
    expect(result.requiresAdapterAction).toBe(true)
  })

  it.each([
    ["INTERFACES", "SKIP_CHECK"],
    ["INTERFACES", "CASCADE_CHECK"],
    ["IMPLEMENTATION", "SCHEDULING"],
  ])("classifies structural state %s/%s as adapter-owned drain work", (phase, phaseState) => {
    const result = classifyWorkflowNextAction({ phase, phaseState })
    expect(result.nextAction).toBe("adapter_drain")
    expect(result.shouldContinue).toBe(true)
    expect(result.requiresAdapterAction).toBe(true)
    expect(result.continuationMessage).toContain("Resolve structural workflow state")
  })

  it.each([
    ["PLANNING", "USER_GATE", "stop_user_gate"],
    ["IMPLEMENTATION", "HUMAN_GATE", "stop_human_gate"],
    ["PLANNING", "ESCAPE_HATCH", "stop_escape_hatch"],
    ["DONE", "USER_GATE", "stop_done"],
  ] as Array<[string, string, WorkflowNextActionKind]>)("stops at structural gate %s/%s", (phase, phaseState, nextAction) => {
    const result = classifyWorkflowNextAction({ phase, phaseState })
    expect(result.nextAction).toBe(nextAction)
    expect(result.shouldContinue).toBe(false)
    expect(result.stopReason).toBeTruthy()
  })
})

describe("buildWorkflowRuntimeExplanation", () => {
  it("summarizes phase, blockage reason, next action, and last failure", () => {
    const explanation = buildWorkflowRuntimeExplanation({
      phase: "DISCOVERY",
      phaseState: "REVIEW",
      mode: "INCREMENTAL",
      toolFailureHistory: [{
        toolName: "mark_satisfied",
        message: "Only 1 blocking criteria submitted",
        count: 2,
        phase: "DISCOVERY",
        phaseState: "REVIEW",
      }],
    })

    expect(explanation).toContain("Current phase: DISCOVERY/REVIEW (INCREMENTAL)")
    expect(explanation).toContain("Why blocked: adapter/runtime action is required")
    expect(explanation).toContain("Valid next action: Dispatch isolated phase review for DISCOVERY")
    expect(explanation).toContain("Last failure: mark_satisfied x2")
  })
})
