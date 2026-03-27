/**
 * Tests for evaluateMarkSatisfied — self-review evaluation logic.
 * Covers G9: suggestion-severity criteria don't block advancement.
 */
import { describe, expect, it } from "bun:test"
import { evaluateMarkSatisfied, countExpectedBlockingCriteria } from "#core/tools/mark-satisfied"

// ---------------------------------------------------------------------------
// All criteria blocking (default behavior)
// ---------------------------------------------------------------------------

describe("evaluateMarkSatisfied — all criteria met", () => {
  it("passes when all criteria are met", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "Has unit tests", met: true, evidence: "15 tests written" },
        { criterion: "No any types", met: true, evidence: "Checked with tsc" },
      ],
    })
    expect(result.passed).toBe(true)
    expect(result.unmetCriteria).toHaveLength(0)
  })

  it("response message mentions criteria count", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "A", met: true, evidence: "e1" },
        { criterion: "B", met: true, evidence: "e2" },
        { criterion: "C", met: true, evidence: "e3" },
      ],
    })
    expect(result.passed).toBe(true)
    expect(result.responseMessage).toContain("3")
  })
})

describe("evaluateMarkSatisfied — blocking criteria unmet", () => {
  it("fails when one blocking criterion is not met", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "Has tests", met: false, evidence: "No test file found" },
        { criterion: "No any types", met: true, evidence: "tsc clean" },
      ],
    })
    expect(result.passed).toBe(false)
    expect(result.unmetCriteria).toHaveLength(1)
    expect(result.unmetCriteria[0]?.criterion).toBe("Has tests")
  })

  it("includes all unmet blocking criteria in responseMessage", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "A", met: false, evidence: "missing A" },
        { criterion: "B", met: false, evidence: "missing B" },
        { criterion: "C", met: true, evidence: "C is fine" },
      ],
    })
    expect(result.passed).toBe(false)
    expect(result.responseMessage).toContain("A")
    expect(result.responseMessage).toContain("B")
    expect(result.responseMessage).not.toContain("C is fine") // C passed, shouldn't be in fail list
  })
})

// ---------------------------------------------------------------------------
// Severity: suggestion (G9)
// ---------------------------------------------------------------------------

describe("evaluateMarkSatisfied — suggestion severity (G9)", () => {
  it("passes when all blocking are met but a suggestion is unmet", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "Core logic works", met: true, evidence: "Tests pass" },
        { criterion: "Could add more docs", met: false, evidence: "Docs minimal", severity: "suggestion" },
      ],
    })
    expect(result.passed).toBe(true)
  })

  it("reports unmet suggestions in unmetCriteria (non-blocking)", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "Core logic", met: true, evidence: "ok" },
        { criterion: "Nice-to-have docs", met: false, evidence: "sparse", severity: "suggestion" },
      ],
    })
    expect(result.passed).toBe(true)
    expect(result.unmetCriteria).toHaveLength(1)
    expect(result.unmetCriteria[0]?.criterion).toBe("Nice-to-have docs")
    expect(result.unmetCriteria[0]?.severity).toBe("suggestion")
  })

  it("mentions unmet suggestions in the pass message", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "Core", met: true, evidence: "ok" },
        { criterion: "Nice", met: false, evidence: "missing", severity: "suggestion" },
      ],
    })
    expect(result.passed).toBe(true)
    // Pass message should note the advisory suggestion
    expect(result.responseMessage).toContain("suggestion")
  })

  it("fails when a blocking criterion is unmet, even if all suggestions are met", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "Core", met: false, evidence: "broken", severity: "blocking" },
        { criterion: "Nice", met: true, evidence: "great", severity: "suggestion" },
      ],
    })
    expect(result.passed).toBe(false)
  })

  it("defaults to blocking when severity is not provided", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "No severity field", met: false, evidence: "missing" },
        // no severity field — should default to blocking
      ],
    })
    expect(result.passed).toBe(false)
    expect(result.unmetCriteria[0]?.severity).toBe("blocking")
  })

  it("explicit blocking severity behaves same as default", () => {
    const withExplicit = evaluateMarkSatisfied({
      criteria_met: [{ criterion: "A", met: false, evidence: "e", severity: "blocking" }],
    })
    const withDefault = evaluateMarkSatisfied({
      criteria_met: [{ criterion: "A", met: false, evidence: "e" }],
    })
    expect(withExplicit.passed).toBe(withDefault.passed)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("evaluateMarkSatisfied — edge cases", () => {
  it("rejects empty criteria list — must evaluate every criterion", () => {
    const result = evaluateMarkSatisfied({ criteria_met: [] })
    expect(result.passed).toBe(false)
    expect(result.responseMessage).toContain("criteria_met is empty")
  })

  it("severity of met criteria doesn't affect pass/fail", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "A", met: true, evidence: "ok", severity: "blocking" },
        { criterion: "B", met: true, evidence: "ok", severity: "suggestion" },
      ],
    })
    expect(result.passed).toBe(true)
    expect(result.unmetCriteria).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Cross-validation: countExpectedBlockingCriteria
// ---------------------------------------------------------------------------

describe("countExpectedBlockingCriteria", () => {
  it("returns 0 for null input", () => {
    expect(countExpectedBlockingCriteria(null)).toBe(0)
  })

  it("counts numbered items in blocking section", () => {
    const text = `**Blocking criteria:**
1. First criterion
2. Second criterion
3. Third criterion

**Suggestion criteria:**
- [S] Nice to have`
    expect(countExpectedBlockingCriteria(text)).toBe(3)
  })

  it("does not count suggestion items", () => {
    const text = `**Blocking criteria:**
1. Only blocking item

**Suggestion criteria (non-blocking):**
1. This looks like numbered but is in suggestion section`
    // Only counts up to "Suggestion criteria" split
    expect(countExpectedBlockingCriteria(text)).toBe(1)
  })

  it("returns 0 for text with no numbered items", () => {
    expect(countExpectedBlockingCriteria("No criteria here")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cross-validation: expectedBlockingCount parameter
// ---------------------------------------------------------------------------

describe("evaluateMarkSatisfied — cross-validation", () => {
  it("rejects when fewer blocking criteria submitted than expected", () => {
    const result = evaluateMarkSatisfied(
      {
        criteria_met: [
          { criterion: "A", met: true, evidence: "ok" },
        ],
      },
      5, // expected 5 blocking criteria
    )
    expect(result.passed).toBe(false)
    expect(result.responseMessage).toContain("Only 1 blocking criteria submitted")
    expect(result.responseMessage).toContain("requires 5")
  })

  it("passes when enough blocking criteria are submitted", () => {
    const result = evaluateMarkSatisfied(
      {
        criteria_met: [
          { criterion: "A", met: true, evidence: "ok" },
          { criterion: "B", met: true, evidence: "ok" },
          { criterion: "C", met: true, evidence: "ok" },
        ],
      },
      3,
    )
    expect(result.passed).toBe(true)
  })

  it("ignores expectedBlockingCount when 0", () => {
    const result = evaluateMarkSatisfied(
      {
        criteria_met: [{ criterion: "A", met: true, evidence: "ok" }],
      },
      0,
    )
    expect(result.passed).toBe(true)
  })

  it("ignores expectedBlockingCount when undefined", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [{ criterion: "A", met: true, evidence: "ok" }],
    })
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Design-invariant ([D]) criteria in mark_satisfied
// ---------------------------------------------------------------------------

describe("evaluateMarkSatisfied — design-invariant [D] criteria", () => {
  it("parses [D] prefix as severity 'design-invariant'", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "[D] No circular dependencies", met: true, evidence: "dep graph clean" },
      ],
    })
    expect(result.passed).toBe(true)
    // Even though it passed, verify the internal parsing via a failing case
    const failResult = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "[D] No circular dependencies", met: false, evidence: "cycle detected" },
      ],
    })
    expect(failResult.passed).toBe(false)
    expect(failResult.unmetCriteria).toHaveLength(1)
    expect(failResult.unmetCriteria[0]!.severity).toBe("design-invariant")
  })

  it("counts design-invariant criteria as blocking for submittedBlockingCount check", () => {
    // expectedBlockingCount = 3, submit 2 blocking + 1 design-invariant = 3 total blocking-class
    const result = evaluateMarkSatisfied(
      {
        criteria_met: [
          { criterion: "A", met: true, evidence: "ok" },
          { criterion: "B", met: true, evidence: "ok" },
          { criterion: "[D] No cycles", met: true, evidence: "clean" },
        ],
      },
      3,
    )
    expect(result.passed).toBe(true)
  })

  it("unmet design-invariant criteria prevent the review from passing", () => {
    const result = evaluateMarkSatisfied({
      criteria_met: [
        { criterion: "Code compiles", met: true, evidence: "tsc clean" },
        { criterion: "[D] Single responsibility", met: false, evidence: "module handles 3 concerns" },
      ],
    })
    expect(result.passed).toBe(false)
    expect(result.unmetCriteria).toHaveLength(1)
    expect(result.unmetCriteria[0]!.criterion).toBe("[D] Single responsibility")
    expect(result.unmetCriteria[0]!.severity).toBe("design-invariant")
  })
})
