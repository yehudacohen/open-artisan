import { describe, expect, it } from "bun:test"

import {
  buildTaskImplementationRubricPreview,
  buildTaskReviewRubric,
  buildPhaseAcceptanceCriteria,
  getAcceptanceCriteria,
  getAcceptanceCriteriaPreview,
  getPhaseStructuralGate,
} from "#core/rubrics"

describe("shared rubrics", () => {
  it("uses the same phase criteria for reviewer and author preview", () => {
    const canonical = buildPhaseAcceptanceCriteria("TESTS", "GREENFIELD")
    const criteria = getAcceptanceCriteria("TESTS", "REVIEW", "GREENFIELD")
    const preview = getAcceptanceCriteriaPreview("TESTS", "DRAFT", "GREENFIELD")

    expect(canonical).toContain("Bespoke structural gate — Tests review")
    expect(criteria).toContain("Bespoke structural gate — Tests review")
    expect(criteria).toContain("real runnable test/spec files")
    expect(preview).toContain("Bespoke structural gate — Tests review")
    expect(preview).toContain("real runnable test/spec files")
  })

  it("does not require irrelevant TESTS failure classes", () => {
    const criteria = buildPhaseAcceptanceCriteria("TESTS", "GREENFIELD")

    expect(criteria).toContain("Failure modes tested where applicable")
    expect(criteria).toContain("Do not require network/auth/timeout tests for local-only features")
    expect(criteria).toContain("without requiring unrelated failure classes")
    expect(criteria).toContain("auth/privilege tests are not required")
    expect(criteria).toContain("logs, retries, and timeouts are not required")
  })

  it("keeps canonical phase rubrics available outside REVIEW state", () => {
    expect(getAcceptanceCriteria("IMPLEMENTATION", "DRAFT", "GREENFIELD")).toBeNull()

    const canonical = buildPhaseAcceptanceCriteria("IMPLEMENTATION", "GREENFIELD")
    expect(canonical).toContain("Acceptance Criteria — Implementation")
    expect(canonical).toContain("minimum 9/10")
    expect(canonical).toContain("No helper-only or half-integrated implementations")
  })

  it("has bespoke structural gates for plan, interfaces, tests, and implementation", () => {
    expect(getPhaseStructuralGate("PLANNING")).toContain("Plan review")
    expect(getPhaseStructuralGate("PLANNING")).toContain("integration seam")
    expect(getPhaseStructuralGate("PLANNING")).toContain("alternatives considered")
    expect(getPhaseStructuralGate("PLANNING")).toContain("tradeoffs/risks")
    expect(getPhaseStructuralGate("INTERFACES")).toContain("Interfaces review")
    expect(getPhaseStructuralGate("INTERFACES")).toContain("source contracts")
    expect(getPhaseStructuralGate("TESTS")).toContain("Tests review")
    expect(getPhaseStructuralGate("TESTS")).toContain("runtime seams")
    expect(getPhaseStructuralGate("IMPLEMENTATION")).toContain("Implementation review")
    expect(getPhaseStructuralGate("IMPLEMENTATION")).toContain("wired end-to-end")
  })

  it("shares structural wiring language between task prompt preview and task reviewer", () => {
    const promptPreview = buildTaskImplementationRubricPreview()
    const reviewerRubric = buildTaskReviewRubric({ taskCategory: "standalone", hasAdjacentTasks: true })

    expect(promptPreview).toContain("structural wiring reaches the real entry point")
    expect(reviewerRubric).toContain("Structural wiring gate")
    expect(reviewerRubric).toContain("real entry point")
    expect(reviewerRubric).toContain("Integration seam check")
  })
})
