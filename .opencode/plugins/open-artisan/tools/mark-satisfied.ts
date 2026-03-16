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
 * Counts the expected blocking criteria from the acceptance criteria text.
 * Looks for numbered lines within the "Blocking criteria" section.
 */
export function countExpectedBlockingCriteria(criteriaText: string | null): number {
  if (!criteriaText) return 0
  // Match numbered items (e.g., "1.", "2.") in the blocking criteria section
  const blockingSection = criteriaText.split(/\*\*Suggestion criteria/i)[0] ?? criteriaText
  const numbered = blockingSection.match(/^\d+\.\s/gm)
  return numbered?.length ?? 0
}

/**
 * Evaluates the criteria_met list and returns the review result.
 *
 * @param args - The submitted criteria assessments
 * @param expectedBlockingCount - Optional: expected number of blocking criteria from
 *   getAcceptanceCriteria(). If provided and the submitted count is less, the review
 *   fails with a warning to evaluate all criteria.
 * @param iterationInfo - Optional: current iteration count for display in fail messages.
 */
export function evaluateMarkSatisfied(args: MarkSatisfiedArgs, expectedBlockingCount?: number, iterationInfo?: { current: number; max: number }): MarkSatisfiedResult {
  if (!args.criteria_met || args.criteria_met.length === 0) {
    return {
      passed: false,
      unmetCriteria: [],
      responseMessage:
        "Error: criteria_met is empty. You must evaluate every acceptance criterion " +
        "for this phase and provide a non-empty array. Re-read the criteria and call " +
        "mark_satisfied again with your per-criterion assessments.",
    }
  }

  // Cross-validate: if the expected blocking count is known, reject submissions
  // that evaluate fewer blocking criteria than expected (prevents gaming).
  if (expectedBlockingCount && expectedBlockingCount > 0) {
    const submittedBlockingCount = args.criteria_met.filter((c) => (c.severity ?? "blocking") === "blocking").length
    if (submittedBlockingCount < expectedBlockingCount) {
      return {
        passed: false,
        unmetCriteria: [],
        responseMessage:
          `Error: Only ${submittedBlockingCount} blocking criteria submitted, but this phase requires ${expectedBlockingCount}. ` +
          `You must evaluate ALL blocking criteria independently. Re-read the acceptance criteria and call ` +
          `mark_satisfied again with assessments for all ${expectedBlockingCount} blocking criteria.`,
      }
    }
  }

  const allCriteria = args.criteria_met.map<CriterionResult>((c) => {
    const isQualityCriterion = c.criterion.startsWith("[Q]")
    // For [Q] quality criteria with a score, `met` is derived from the score threshold.
    // Score >= 9 → met; score < 9 → not met. This prevents the agent from claiming
    // "met" while giving a low score.
    const met = (isQualityCriterion && typeof c.score === "number")
      ? c.score >= 9
      : c.met
    return {
      criterion: c.criterion,
      met,
      evidence: isQualityCriterion && typeof c.score === "number"
        ? `${c.evidence} (score: ${c.score}/10)`
        : c.evidence,
      // G9: respect explicit severity; default to "blocking" if not provided
      severity: c.severity ?? "blocking",
      ...(typeof c.score === "number" ? { score: c.score } : {}),
    }
  })

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
    responseMessage: buildFailMessage(unmetBlocking, iterationInfo),
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

function buildFailMessage(unmet: CriterionResult[], iterationInfo?: { current: number; max: number }): string {
  const list = unmet.map((c) => {
    const scoreNote = typeof c.score === "number" ? ` [score: ${c.score}/10, needs ≥9]` : ""
    return `  - ${c.criterion}: ${c.evidence}${scoreNote}`
  }).join("\n")
  const iterationNote = iterationInfo
    ? `Review iteration ${iterationInfo.current} of ${iterationInfo.max}. `
    : ""
  return (
    `${iterationNote}Self-review incomplete — ${unmet.length} blocking criteria not satisfied:\n${list}\n` +
    `Continue working to address these criteria, then call mark_satisfied again.`
  )
}
