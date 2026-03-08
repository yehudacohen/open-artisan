/**
 * mark-satisfied.ts — The `mark_satisfied` tool definition.
 *
 * The agent calls this during REVIEW sub-states to signal that the self-review
 * is complete. The tool:
 * 1. Receives a structured assessment of each acceptance criterion
 * 2. Checks if all BLOCKING criteria are met
 * 3. If all met → fires `self_review_pass` → state machine advances to USER_GATE
 * 4. If any blocking criterion unmet → fires `self_review_fail` → loops in REVIEW
 */
import type { MarkSatisfiedArgs, CriterionResult } from "../types"

// Re-export for test convenience
export type { CriterionResult }

export const MARK_SATISFIED_DESCRIPTION = `
Call this tool when you have completed self-review of the current artifact.

Provide an assessment of each acceptance criterion for this phase. You MUST evaluate every
criterion independently — do not collapse or skip any. Do not assume quality, verify it.

If ALL blocking criteria are met, this will advance to the user gate.
If any blocking criterion is unmet, you will be asked to continue working.

You will be penalized if you call mark_satisfied with criteria you have not actually checked.
`.trim()

export interface MarkSatisfiedResult {
  passed: boolean
  unmetCriteria: CriterionResult[]
  responseMessage: string
}

/**
 * Evaluates the criteria_met list and returns the review result.
 */
export function evaluateMarkSatisfied(args: MarkSatisfiedArgs): MarkSatisfiedResult {
  const allCriteria = args.criteria_met.map<CriterionResult>((c) => ({
    criterion: c.criterion,
    met: c.met,
    evidence: c.evidence,
    // G9: respect explicit severity; default to "blocking" if not provided
    severity: c.severity ?? "blocking",
  }))

  const unmetBlocking = allCriteria.filter((c) => !c.met && c.severity === "blocking")

  if (unmetBlocking.length === 0) {
    const unmetSuggestions = allCriteria.filter((c) => !c.met && c.severity === "suggestion")
    return {
      passed: true,
      unmetCriteria: unmetSuggestions, // suggestions are reported but don't block
      responseMessage: buildPassMessage(allCriteria.length, unmetSuggestions),
    }
  }

  return {
    passed: false,
    unmetCriteria: unmetBlocking,
    responseMessage: buildFailMessage(unmetBlocking),
  }
}

function buildPassMessage(total: number, unmetSuggestions: CriterionResult[]): string {
  const suggestionNote = unmetSuggestions.length > 0
    ? ` (${unmetSuggestions.length} advisory suggestion(s) not met — these are non-blocking.)`
    : ""
  return (
    `Self-review complete — all blocking criteria satisfied out of ${total} total.${suggestionNote} ` +
    `Advancing to user gate. ` +
    `Present a clear summary of what was built and what acceptance criteria were met.`
  )
}

function buildFailMessage(unmet: CriterionResult[]): string {
  const list = unmet.map((c) => `  - ${c.criterion}: ${c.evidence}`).join("\n")
  return (
    `Self-review incomplete — ${unmet.length} blocking criteria not satisfied:\n${list}\n` +
    `Continue working to address these criteria, then call mark_satisfied again.`
  )
}
