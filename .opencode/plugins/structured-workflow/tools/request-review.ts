/**
 * request-review.ts — The `request_review` tool definition.
 *
 * The agent calls this when a DRAFT is complete and ready for self-review.
 * This signals the state machine to advance to REVIEW state, and kicks off
 * the self-review process (which in Layer 3 uses an isolated subagent).
 *
 * In Layer 1 (current scope), the same session transitions to REVIEW and
 * the agent self-reviews inline using the acceptance criteria.
 */
import type { RequestReviewArgs } from "../types"

export const REQUEST_REVIEW_DESCRIPTION = `
Call this tool when you have completed the current draft and are ready for self-review.

Provide:
- summary: a brief description of what was built in this phase
- artifact_description: a description of the artifact(s) produced (files written, key decisions)

After calling this tool, you will enter REVIEW state and must evaluate the artifact
against the acceptance criteria using mark_satisfied.

Do NOT call this tool until the draft is complete. Do NOT call it as a progress checkpoint —
only call it when the artifact is ready for critical evaluation.
`.trim()

export interface RequestReviewResult {
  responseMessage: string
  phaseInstructions: string
}

/**
 * Builds the response when the agent calls request_review.
 */
export function processRequestReview(args: RequestReviewArgs): RequestReviewResult {
  return {
    responseMessage: buildResponseMessage(args),
    phaseInstructions: buildReviewInstructions(),
  }
}

function buildResponseMessage(args: RequestReviewArgs): string {
  return (
    `Request for review recorded.\n\n` +
    `**Summary:** ${args.summary}\n\n` +
    `**Artifact:** ${args.artifact_description}\n\n` +
    `You are now in REVIEW state. Evaluate this artifact critically against the acceptance criteria below. ` +
    `You did NOT just write this — evaluate it as if seeing it for the first time. ` +
    `When your evaluation is complete, call \`mark_satisfied\` with your assessment.`
  )
}

function buildReviewInstructions(): string {
  return (
    `## Self-Review Instructions\n\n` +
    `1. Read the acceptance criteria for this phase from the system prompt.\n` +
    `2. Evaluate EACH criterion independently — do not collapse or skip any.\n` +
    `3. For each criterion, provide:\n` +
    `   - Whether it is met (true/false)\n` +
    `   - Specific evidence from the artifact\n` +
    `4. Call \`mark_satisfied\` with your full assessment.\n` +
    `5. If any blocking criterion is not met, address it before calling mark_satisfied again.\n\n` +
    `Do not assume quality — verify it by reading the actual files you produced.`
  )
}
