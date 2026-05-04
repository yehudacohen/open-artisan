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
- artifact_files: required file paths on disk that are the review source of truth

After calling this tool, you will enter REVIEW state and must evaluate the artifact
against the acceptance criteria using mark_satisfied.

Pass artifact file references that the reviewer can read from disk.
Relative artifact_files paths are resolved from the project directory before being stored.
Do not pass legacy artifact_content; normal workflow review is file-based only.
For workflow-authored markdown phases only, you may pass artifact_markdown with
artifact_files: [] and the tool will materialize the canonical .openartisan file
before review.

Markdown artifacts are valid only for markdown phases:
- DISCOVERY conventions: .openartisan/<feature>/conventions.md
- PLANNING plan: .openartisan/<feature>/plan.md
- IMPL_PLAN: .openartisan/<feature>/impl-plan.md

File-based source phases must point at real project files:
- INTERFACES: interface/type/schema files, not markdown
- TESTS: runnable test files, not markdown test plans
- IMPLEMENTATION: changed implementation files

If a phase is not applicable, do not invent placeholder source files. Write the
phase's appropriate on-disk artifact with a specific pass-through/fast-forward
justification, then submit that file for review so the reviewer/user can approve
or reject the fast-forward.

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
  const summary = (args.summary ?? "").trim()
  const artifactDesc = (args.artifact_description ?? "").trim()
  if (!summary) {
    return {
      responseMessage:
        "Warning: Empty summary provided. Provide a brief summary of what was built. " +
        "Proceeding to REVIEW state — call `mark_satisfied` when self-review is complete.",
      phaseInstructions: buildReviewInstructions(),
    }
  }
  if (!artifactDesc) {
    return {
      responseMessage:
        "Warning: Empty artifact_description provided. Describe the artifact(s) produced. " +
        "Proceeding to REVIEW state — call `mark_satisfied` when self-review is complete.",
      phaseInstructions: buildReviewInstructions(),
    }
  }
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
