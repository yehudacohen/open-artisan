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
import { looksLikeUserGateMetaQuestion } from "../hooks/chat-message"

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

export function stripWorkflowRoutingNotes(text: string): string {
  return text
    .replace(/\[WORKFLOW (?:GATE|ESCAPE HATCH) — IMMEDIATE ACTION REQUIRED\][\s\S]*?(?=(?:\n\s*){2,}|$)/g, "")
    .replace(/The user has (?:approved|provided feedback on)[\s\S]*?Do NOT (?:do anything else first|do research or analysis first)\.?/g, "")
    .trim()
}

export function isUserGateMetaFeedback(text: string): boolean {
  return looksLikeUserGateMetaQuestion(stripWorkflowRoutingNotes(text))
}

export function isEscapeHatchClarificationFeedback(text: string): boolean {
  const normalized = stripWorkflowRoutingNotes(text).trim().toLowerCase().replace(/\s+/g, " ")
  return (
    /\bwhat\s+(is|does)\s+(the\s+)?escape\s+hatch\b/.test(normalized) ||
    /\bwhat\s+are\s+(my|the)\s+options\b/.test(normalized) ||
    /\b(can|could)\s+you\s+(explain|summarize)\s+(the\s+)?escape\s+hatch\b/.test(normalized) ||
    /\bwhat\s+happens\s+if\b/.test(normalized)
  )
}

/**
 * Processes and validates the submit_feedback arguments.
 */
export function processSubmitFeedback(args: SubmitFeedbackArgs): SubmitFeedbackResult {
  const feedbackText = stripWorkflowRoutingNotes(args.feedback_text)
  // Validate feedback_type — unknown values should not silently fall through to "revise"
  if (args.feedback_type !== "approve" && args.feedback_type !== "revise") {
    return {
      feedbackType: "revise",
      feedbackText,
      responseMessage: `Warning: Unknown feedback_type "${args.feedback_type}" — treating as "revise". Valid values: "approve", "revise".`,
    }
  }

  if (args.feedback_type === "approve") {
    return {
      feedbackType: "approve",
      feedbackText,
      responseMessage: buildApproveMessage(),
    }
  }

  return {
    feedbackType: "revise",
    feedbackText,
    responseMessage: buildReviseMessage(feedbackText),
  }
}

function buildApproveMessage(): string {
  return (
    `Approval recorded. Creating git checkpoint... ` +
    `Once the checkpoint is created, the workflow will advance to the next phase. ` +
    `Begin the next phase immediately; do not stop, summarize, or wait for user input unless the next state is a user-facing gate or terminal state.`
  )
}

function buildReviseMessage(feedbackText: string): string {
  return (
    `Feedback recorded: "${feedbackText.slice(0, 200)}${feedbackText.length > 200 ? "..." : ""}"\n\n` +
    `Transitioning to REVISE state. Begin revision work now based on the feedback above.`
  )
}
