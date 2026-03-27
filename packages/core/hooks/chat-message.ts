/**
 * chat-message.ts — Intercepts incoming user messages at USER_GATE states.
 *
 * When the workflow is in a USER_GATE sub-state, the next user message is
 * treated as feedback for the current phase. This hook:
 * 1. Detects if the session is in USER_GATE
 * 2. If so, classifies the message as approve or feedback
 * 3. Modifies the message parts to include routing instructions
 *
 * The actual state transition happens in the tool handler (submit_feedback tool),
 * which the agent calls after seeing this hook's injected routing instructions.
 * This hook is a "hint injector" — it doesn't mutate state, it guides the agent.
 */
import type { WorkflowState, Phase, PhaseState } from "../types"
import { APPROVAL_WORDS, APPROVAL_PREFIX_RE } from "../vocabulary"

export interface ChatMessageInput {
  sessionId: string
  parts: Array<{ type: string; text?: string }>
}

export interface ChatMessageOutput {
  /** Mutated parts array with routing instructions prepended */
  parts: Array<{ type: string; text?: string }>
  /** Whether this message was intercepted as a workflow response */
  intercepted: boolean
  /** The detected feedback type, if intercepted */
  feedbackType: "approve" | "feedback" | null
}

// ---------------------------------------------------------------------------
// Approval signal detection (heuristic)
// ---------------------------------------------------------------------------

/**
 * Uses shared vocabulary from vocabulary.ts.
 * Approval patterns: only match when the ENTIRE trimmed message matches.
 * We anchor to end-of-string so "approved but I have a concern" is not matched.
 */
function looksLikeApproval(text: string): boolean {
  const trimmed = text.trim().toLowerCase()
  // Exact match against known approval tokens
  if (APPROVAL_WORDS.has(trimmed)) return true
  // Prefix match: starts with an approval signal and nothing substantive follows
  return APPROVAL_PREFIX_RE.test(trimmed)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Process an incoming user message in the context of the current workflow state.
 * Returns routing instructions to inject into the message, or null if not at a gate.
 */
export function processUserMessage(
  state: WorkflowState,
  parts: Array<{ type: string; text?: string }>,
): ChatMessageOutput {
  // Only intercept at user gate states (USER_GATE or ESCAPE_HATCH)
  if (state.phaseState !== "USER_GATE" && state.phaseState !== "ESCAPE_HATCH") {
    return { parts, intercepted: false, feedbackType: null }
  }

  const textContent = parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join(" ")

  // In ESCAPE_HATCH, the user message is ALWAYS feedback (approval is structurally
  // blocked by the state machine — there is no user_approve transition from ESCAPE_HATCH).
  const isApproval = state.phaseState === "ESCAPE_HATCH" ? false : looksLikeApproval(textContent)
  const feedbackType = isApproval ? "approve" : "feedback"

  // Inject routing instructions as a new leading text part
  const routingNote = state.phaseState === "ESCAPE_HATCH"
    ? buildEscapeHatchNote(state.phase)
    : isApproval
      ? buildApprovalNote(state.phase, state.phaseState)
      : buildFeedbackNote(state.phase, state.phaseState)

  const injectedParts: Array<{ type: string; text?: string }> = [
    { type: "text", text: routingNote },
    ...parts,
  ]

  return {
    parts: injectedParts,
    intercepted: true,
    feedbackType,
  }
}

function buildApprovalNote(phase: Phase, _phaseState: PhaseState): string {
  return (
    `[WORKFLOW GATE — IMMEDIATE ACTION REQUIRED] ` +
    `The user has approved the ${phase} artifact. ` +
    `Call \`submit_feedback\` NOW with feedback_type="approve" and feedback_text set to the user's message. ` +
    `This must be your first and only tool call. Do NOT do anything else first.`
  )
}

function buildFeedbackNote(phase: Phase, _phaseState: PhaseState): string {
  return (
    `[WORKFLOW GATE — IMMEDIATE ACTION REQUIRED] ` +
    `The user has provided feedback on the ${phase} artifact. ` +
    `Call \`submit_feedback\` NOW with feedback_type="revise" and feedback_text set to the user's exact message. ` +
    `This must be your first and only tool call. Do NOT do research or analysis first.`
  )
}

function buildEscapeHatchNote(phase: Phase): string {
  return (
    `[WORKFLOW ESCAPE HATCH — IMMEDIATE ACTION REQUIRED] ` +
    `An escape hatch is active for the ${phase} phase. The user has provided their decision. ` +
    `Call \`submit_feedback\` NOW with feedback_type="revise" and feedback_text set to the user's exact message. ` +
    `This must be your first and only tool call. Do NOT do research or analysis first. ` +
    `Note: approval is NOT available during an escape hatch — only revision feedback.`
  )
}

/**
 * Builds the USER_GATE routing hint to inject into the system prompt.
 *
 * This is used as a replacement for the defunct chat.message hook.
 * The hint is appended to the system prompt at USER_GATE so the agent
 * knows to interpret the next user message as approval or feedback.
 *
 * G6 fix: wired into experimental.chat.system.transform in index.ts.
 */
export function buildUserGateHint(phase: Phase, _phaseState: PhaseState): string {
  return (
    `\n---\n## ⚠ WORKFLOW USER GATE — ${phase} — ACTION REQUIRED\n\n` +
    `A user message has arrived. You MUST call \`submit_feedback\` as your **first and only tool call**.\n\n` +
    `**Do NOT:**\n` +
    `- Do research, web searches, or file reads before calling \`submit_feedback\`\n` +
    `- Re-review or improve the artifact before routing the feedback\n` +
    `- Call any other tool before \`submit_feedback\`\n` +
    `- Simulate or assume approval without calling \`submit_feedback\`\n\n` +
    `**Do:**\n` +
    `- If the user approves (yes / lgtm / approved / looks good / ship it / proceed / etc.):\n` +
    `  → Call \`submit_feedback(feedback_type="approve", feedback_text=<their message>)\`\n` +
    `- If the user requests changes or asks questions:\n` +
    `  → Call \`submit_feedback(feedback_type="revise", feedback_text=<their exact message>)\`\n\n` +
    `Calling \`submit_feedback\` is the ONLY correct response to a user message at USER_GATE.\n` +
    `---`
  )
}
