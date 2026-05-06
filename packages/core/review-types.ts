/**
 * review-types.ts — Review, self-review, and review tool argument contracts.
 */

import type { Phase, WorkflowMode } from "./workflow-primitives"

export interface CriterionResult {
  criterion: string
  met: boolean
  evidence: string
  /**
   * Criterion severity level:
   * - "blocking"          — must be met; standard boolean criteria (default)
   * - "suggestion"        — non-blocking; reported but does not prevent advancement
   * - "design-invariant"  — must be met AND non-rebuttable; used for binary structural
   *                         questions from the design document (prefixed [D] in criteria text).
   *                         The rebuttal loop cannot upgrade these — a design invariant violation
   *                         requires the deviation register to be updated and user-approved.
   */
  severity: "blocking" | "suggestion" | "design-invariant"
  /**
   * Numeric quality score (1-10) for quality-dimension criteria (prefixed [Q]).
   * For [Q] criteria, `met` is derived: score >= 9 → met, score < 9 → not met.
   * Absent for standard boolean criteria.
   */
  score?: number
}

export interface SelfReviewSuccess {
  success: true
  satisfied: boolean
  criteriaResults: CriterionResult[]
}

export interface SelfReviewError {
  success: false
  error: string
  code?: "SELF_REVIEW_FAILED"
  message?: string
}

export type SelfReviewResult = SelfReviewSuccess | SelfReviewError

/**
 * When the review loop is one iteration from the escalation cap and the
 * reviewer's unmet criteria score 7-8 (close to threshold), the agent
 * gets one chance to rebut before escalation to USER_GATE.
 *
 * The rebuttal is dispatched as a fresh ephemeral session where the reviewer
 * sees its own prior verdict plus the agent's counterarguments, and either
 * revises scores upward or maintains its position.
 */
export interface RebuttalRequest {
  phase: Phase
  mode: WorkflowMode | null
  /** The reviewer's original failing criteria (unmet blocking only) */
  reviewerVerdict: CriterionResult[]
  /** The agent's own assessment of those same criteria (its counterarguments) */
  agentAssessment: Array<{
    criterion: string
    met: boolean
    evidence: string
    score?: number
  }>
  /** Artifact paths for the reviewer to re-check if needed */
  artifactPaths: string[]
  /** The full acceptance criteria text */
  criteriaText: string
  /** Parent session ID for TUI visibility */
  parentSessionId?: string
  /** Feature name for session title context */
  featureName?: string | null
  /** Parent model (if available) for subagent session creation */
  parentModel?: string | { modelID: string; providerID?: string }
}

export interface RebuttalSuccess {
  success: true
  /** The reviewer's revised criteria results after considering the rebuttal */
  revisedResults: CriterionResult[]
  /** Whether the reviewer conceded (all blocking now pass) */
  allResolved: boolean
}

export interface RebuttalError {
  success: false
  error: string
  code?: "REBUTTAL_FAILED"
  message?: string
}

export type RebuttalResult = RebuttalSuccess | RebuttalError

export interface MarkSatisfiedArgs {
  criteria_met: Array<{
    criterion: string
    met: boolean
    evidence: string
    /**
     * Optional severity override. Defaults to "blocking" if not provided.
     * - "blocking"         — must be met to advance (default)
     * - "suggestion"       — advisory only, does not block advancement
     * - "design-invariant" — must be met AND cannot be rebutted (used for [D] criteria)
     */
    severity?: "blocking" | "suggestion" | "design-invariant"
    /**
     * Numeric quality score (1-10) for [Q] quality-dimension criteria.
     * For [Q] criteria: score >= 9 means met, score < 9 means not met.
     * The `met` field is overridden by the score for [Q] criteria.
     */
    score?: number
  }>
}

export interface RequestReviewArgs {
  /** Plain text summary of what was built in this phase */
  summary: string
  /** Description of the artifact(s) produced */
  artifact_description: string
  /**
   * Files on disk that are the review source of truth.
   * Public callers must write artifacts to disk first and submit them by path.
   * Inline artifact content is intentionally not part of the public contract.
   */
  artifact_files?: string[]
  /**
   * Markdown artifact text for workflow-authored markdown phases only.
   * Tool handlers may materialize this to .openartisan/<feature>/<artifact>.md
   * before review. This is intentionally distinct from legacy artifact_content,
   * which is not accepted as a review source of truth.
   */
  artifact_markdown?: string
}

/**
 * Explicit file-based review source of truth.
 *
 * Decision note: the approved workflow direction is that public review callers
 * submit on-disk artifact files, not inline artifact text. An alternative would
 * keep a dual public contract (`artifact_content` or `artifact_files`), but that
 * weakens the structural review source of truth and encourages adapter-specific
 * divergence. The public contract therefore exposes file-based review inputs only.
 */
export interface FileArtifactReviewSource {
  artifact_files: string[]
}
