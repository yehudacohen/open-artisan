/**
 * submit-feedback.ts — The `submit_feedback` tool definition.
 *
 * The agent calls this when a user response has been received at a USER_GATE.
 * The plugin's chat-message hook provides routing hints to the agent; the agent
 * then calls this tool to formally record the user's decision.
 *
 * - feedback_type="approve": triggers `user_approve` event → advances to next phase
 *   (+ git checkpoint)
 * - feedback_type="revise": triggers `user_feedback` event → orchestrator routes
 *   to appropriate REVISE state
 */
import type { SubmitFeedbackArgs } from "../types"

export const SUBMIT_FEEDBACK_DESCRIPTION = `
Call this tool to record the user's response at a review gate.

- feedback_type="approve": the user approved the artifact — this creates a git checkpoint
  and advances to the next phase.
- feedback_type="revise": the user wants changes — the feedback will be routed through the
  orchestrator to identify which artifacts need revision.

Only call this tool in USER_GATE state, after the user has provided their response.
Do NOT call this tool to simulate approval — only after the user has actually responded.
`.trim()

export interface SubmitFeedbackResult {
  feedbackType: "approve" | "revise"
  responseMessage: string
  /** The user's raw feedback text, for passing to the orchestrator on revise */
  feedbackText: string
}

/**
 * Processes and validates the submit_feedback arguments.
 */
export function processSubmitFeedback(args: SubmitFeedbackArgs): SubmitFeedbackResult {
  // Validate feedback_type — unknown values should not silently fall through to "revise"
  if (args.feedback_type !== "approve" && args.feedback_type !== "revise") {
    return {
      feedbackType: "revise",
      feedbackText: args.feedback_text,
      responseMessage: `Warning: Unknown feedback_type "${args.feedback_type}" — treating as "revise". Valid values: "approve", "revise".`,
    }
  }

  if (args.feedback_type === "approve") {
    return {
      feedbackType: "approve",
      feedbackText: args.feedback_text,
      responseMessage: buildApproveMessage(),
    }
  }

  return {
    feedbackType: "revise",
    feedbackText: args.feedback_text,
    responseMessage: buildReviseMessage(args.feedback_text),
  }
}

function buildApproveMessage(): string {
  return (
    `Approval recorded. Creating git checkpoint... ` +
    `Once the checkpoint is created, the workflow will advance to the next phase. ` +
    `Begin the next phase immediately.`
  )
}

function buildReviseMessage(feedbackText: string): string {
  return (
    `Feedback recorded: "${feedbackText.slice(0, 200)}${feedbackText.length > 200 ? "..." : ""}"\n\n` +
    `Transitioning to REVISE state. Begin revision work now based on the feedback above.`
  )
}
