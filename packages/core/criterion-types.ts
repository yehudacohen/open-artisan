/**
 * criterion-types.ts — Public contract for stable reviewer criterion identifiers.
 */

export type CriterionSeverity = "blocking" | "suggestion" | "design-invariant"

/**
 * Stable identifier for a review criterion. Display text may change; IDs should not.
 */
export type CriterionId = string

/**
 * Canonical criterion definition used to render rubrics and match review output.
 */
export interface ReviewCriterionDefinition {
  id: CriterionId
  text: string
  severity: CriterionSeverity
  qualityDimension?: string
}

/**
 * Accepted input shape for review results that may use either stable IDs or legacy text.
 */
export interface CriterionMatchInput {
  criterion: string
  criterionId?: CriterionId
  criterion_id?: CriterionId
}

/**
 * Result of matching a reviewer-supplied criterion to a canonical definition.
 */
export interface CriterionMatchResult {
  matched: boolean
  criterionId: CriterionId | null
  matchedBy: "id" | "text" | null
}
