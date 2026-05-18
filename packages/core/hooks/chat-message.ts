/**
 * chat-message.ts — Intercepts incoming user messages at workflow gate states.
 *
 * When the workflow is in a USER_GATE/HUMAN_GATE sub-state, user decisions are
 * routed through submit_feedback. Clarification/meta questions are deliberately
 * left as normal conversation so asking "what am I reviewing?" does not corrupt
 * the workflow into REVISE or falsely resolve a manual gate.
 * 1. Detects if the session is in a user-facing gate
 * 2. If so, classifies or routes the message
 * 3. Modifies the message parts to include routing instructions
 *
 * The actual state transition happens in the tool handler (submit_feedback tool),
 * which the agent calls after seeing this hook's injected routing instructions.
 * This hook is a "hint injector" — it doesn't mutate state, it guides the agent.
 */
import type { WorkflowState } from "../workflow-state-types"
import type { Phase, PhaseState } from "../workflow-primitives"
import {
  APPROVAL_DISQUALIFIER_RE,
  APPROVAL_FILLER_WORDS,
  APPROVAL_PREFIX_RE,
  APPROVAL_WORDS,
} from "../vocabulary"

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
  route?: {
    kind: "approve-with-meta"
    feedbackType: "approve"
    decisionText: string
    metaText: string
    reason: string
  }
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
  if (/\b(?:do\s+not|don't|dont|not|cannot|can't|wont|won't)\s+approve\b/.test(trimmed)) return false
  // Exact match against known approval tokens
  if (APPROVAL_WORDS.has(trimmed)) return true
  // Prefix match: starts with an approval signal and nothing substantive follows
  if (APPROVAL_PREFIX_RE.test(trimmed)) return true

  const normalized = trimmed.replace(/[.!?]/g, "").trim()
  if (/\bapprove\s+(?:the\s+)?(?:user\s+)?gate\b/.test(normalized)) return true
  if (/^i\s+approve\b/.test(normalized) && !/\b(?:but|except|unless|however|please|fix|add|remove|revise)\b/.test(normalized)) return true

  // Accept short approval + non-substantive tail patterns like
  // "approved, thanks" or "yes please", but reject substantive follow-ups.
  const prefixMatch = normalized.match(/^(approve[sd]?|accept|lgtm|looks good|ship it|yes|y|ok|okay|good|perfect|done|continue|proceed|next|go ahead|go|sure|yep|yeah|do it)(?:\s*[,;]\s*|\s+)(.+)$/i)
  if (prefixMatch) {
    const tail = prefixMatch[2]?.trim() ?? ""
    if (tail && !APPROVAL_DISQUALIFIER_RE.test(tail) && APPROVAL_FILLER_WORDS.has(tail)) {
      return true
    }
  }

  // Allow short combinations of approval-only tokens, e.g. "ok, approved"
  const segments = trimmed
    .split(/(?:,|;|\band\b|\s+\/\s+)/i)
    .map((segment) => segment.trim())
    .filter(Boolean)

  return segments.length > 1 && segments.every((segment) => APPROVAL_PREFIX_RE.test(segment))
}

function splitApprovalWithMeta(text: string): { decisionText: string; metaText: string } | null {
  const match = text.trim().match(/^(.+?)([.!?])\s+(.+)$/)
  if (!match) return null
  const decisionText = match[1]?.trim() ?? ""
  const metaText = match[3]?.trim() ?? ""
  if (!looksLikeApproval(decisionText)) return null
  if (!looksLikeUserGateMetaQuestion(metaText)) return null
  return { decisionText, metaText }
}

export function looksLikeUserGateMetaQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ")
  if (!normalized) return false

  if (
    /\b(?:update me|status update|progress update|what changed|what has changed|what did you change|where are we|what's next|what is next)\b/.test(normalized) ||
    /\b(?:status|progress)\b.*\?/.test(normalized)
  ) {
    return true
  }

  const asksForArtifactChange = /\b(?:add|remove|fix|revise|change|update|rewrite|include|exclude|replace)\b/.test(normalized)
  if (asksForArtifactChange) return false

  return (
    /\bwhat\s+(am\s+i|are\s+we|should\s+i|do\s+i)\s+reviewing\b/.test(normalized) ||
    /\bwhat\s+(should|do)\s+i\s+review\b/.test(normalized) ||
    /\bwhat\s+(is|are)\s+(the\s+)?(artifact|artifacts|review\s+artifact|review\s+assets)\b/.test(normalized) ||
    /\b(which|what)\s+files?\s+(am\s+i|should\s+i|do\s+i|are\s+we)\s+review/.test(normalized) ||
    /\bwhere\s+(is|are)\s+(the\s+)?(artifact|artifacts|files?|review\s+assets)\b/.test(normalized) ||
    /\b(can|could)\s+you\s+(summarize|explain|show|list)\s+(what|which|the\s+files|the\s+artifact|the\s+review)/.test(normalized) ||
    /\b(have|has|did|are|is|was|were)\b.*\b(tasks?|implementation|tests?|verification|review)\b.*\b(implemented|complete|done|finished|pass(?:ed)?|green)\b/.test(normalized) ||
    /\b(have|has|did|are|is|was|were)\b.*\b(implemented|complete|done|finished|pass(?:ed)?|green)\b.*\b(tasks?|implementation|tests?|verification|review)\b/.test(normalized) ||
    /\b(all|which|what)\s+(implementation\s+)?tasks?\b.*\b(done|complete|implemented|finished)\b/.test(normalized) ||
    /\bhow\s+(has|was|is)\s+(your\s+)?experience\b/.test(normalized) ||
    /\bhow\s+(did|does)\s+(open[- ]artisan|workflow|dogfood(?:ing)?)\s+(feel|go|work)\b/.test(normalized) ||
    /\bwhat\s+was\s+(your\s+)?experience\b/.test(normalized) ||
    /\b(open[- ]artisan|workflow|dogfood(?:ing)?)\b.*\b(experience|rough|friction|worked|working)\b/.test(normalized) ||
    /\bdo\s+you\s+think\b.*\b(right|good|ready|correct|sound)\b/.test(normalized)
  )
}

function looksLikeEscapeHatchClarification(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ")
  if (!normalized) return false
  return (
    /\bwhat\s+(is|does)\s+(the\s+)?escape\s+hatch\b/.test(normalized) ||
    /\bwhat\s+are\s+(my|the)\s+options\b/.test(normalized) ||
    /\b(can|could)\s+you\s+(explain|summarize)\s+(the\s+)?escape\s+hatch\b/.test(normalized) ||
    /\bwhat\s+happens\s+if\b/.test(normalized)
  )
}

function looksLikeConditionalApproval(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ")
  if (!normalized) return false
  if (/\b(?:but|except|unless|however|revise|change|fix|add|remove)\b/.test(normalized)) return false
  return (
    /\bif\s+(?:you|we|that|this|so)\b.*\b(?:i\s+)?approve\b/.test(normalized) ||
    /\bif\s+(?:you|we|that|this|so)\b.*\b(?:approved|lgtm|looks good|ship it|proceed)\b/.test(normalized)
  )
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
  // Only intercept at user-facing gate states.
  if (state.phaseState !== "USER_GATE" && state.phaseState !== "ESCAPE_HATCH" && state.phaseState !== "HUMAN_GATE") {
    return { parts, intercepted: false, feedbackType: null }
  }

  const textContent = parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join(" ")

  const isConditionalApproval = state.phaseState === "ESCAPE_HATCH" ? false : looksLikeConditionalApproval(textContent)
  const approvalWithMeta = state.phaseState === "ESCAPE_HATCH" ? null : splitApprovalWithMeta(textContent)

  if (state.phaseState === "ESCAPE_HATCH" && looksLikeEscapeHatchClarification(textContent)) {
    return { parts, intercepted: false, feedbackType: null }
  }

  if (state.phaseState === "HUMAN_GATE") {
    if (looksLikeUserGateMetaQuestion(textContent)) {
      return { parts, intercepted: false, feedbackType: null }
    }
    return {
      parts: [
        { type: "text", text: buildHumanGateNote(state) },
        ...parts,
      ],
      intercepted: true,
      feedbackType: "approve",
    }
  }

  // In ESCAPE_HATCH, non-clarification user messages are decisions/feedback
  // (approval is structurally blocked by the state machine).
  if (state.phaseState !== "ESCAPE_HATCH" && !approvalWithMeta && !isConditionalApproval && looksLikeUserGateMetaQuestion(textContent)) {
    return { parts, intercepted: false, feedbackType: null }
  }

  const isApproval = state.phaseState === "ESCAPE_HATCH" ? false : Boolean(approvalWithMeta) || looksLikeApproval(textContent) || isConditionalApproval
  const feedbackType = isApproval ? "approve" : "feedback"

  // Inject routing instructions as a new leading text part
  const routingNote = state.phaseState === "ESCAPE_HATCH"
    ? buildEscapeHatchNote(state.phase)
    : isApproval
      ? buildApprovalNote(state.phase, state.phaseState, approvalWithMeta?.metaText)
      : buildFeedbackNote(state.phase, state.phaseState)

  const injectedParts: Array<{ type: string; text?: string }> = [
    { type: "text", text: routingNote },
    ...parts,
  ]

  return {
    parts: injectedParts,
    intercepted: true,
    feedbackType,
    ...(approvalWithMeta ? {
      route: {
        kind: "approve-with-meta" as const,
        feedbackType: "approve" as const,
        decisionText: approvalWithMeta.decisionText,
        metaText: approvalWithMeta.metaText,
        reason: "User supplied an approval decision followed by a meta/clarification follow-up.",
      },
    } : {}),
  }
}

function buildApprovalNote(phase: Phase, _phaseState: PhaseState, metaText?: string): string {
  return (
    `[WORKFLOW GATE — IMMEDIATE ACTION REQUIRED] ` +
    `The user has approved the ${phase} artifact. ` +
    `Call \`submit_feedback\` NOW with feedback_type="approve" and feedback_text set to the user's message. ` +
    `This must be your first and only tool call. Do NOT do anything else first.` +
    (metaText ? ` After the workflow approval is recorded, answer the user's meta follow-up normally: ${metaText}` : "")
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

function buildHumanGateNote(state: WorkflowState): string {
  const unresolved = (state.implDag ?? [])
    .filter((task) => task.status === "human-gated" && (!task.humanGate || !task.humanGate.resolved))
    .map((task) => task.id)
  const taskHint = unresolved.length > 0
    ? ` Current unresolved human-gated task IDs: ${unresolved.join(", ")}.`
    : ""
  return (
    `[WORKFLOW HUMAN GATE — IMMEDIATE ACTION REQUIRED] ` +
    `The user has provided a response for a manual implementation gate.${taskHint} ` +
    `If they confirmed one or more gates are resolved, call \`submit_feedback\` NOW with ` +
    `feedback_type="approve", feedback_text set to the user's message, and resolved_human_gates listing the resolved task IDs. ` +
    `Do not approve the implementation artifact from HUMAN_GATE; only resolve the listed human-gated tasks.`
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
    `\n---\n## WORKFLOW USER GATE — ${phase}\n\n` +
    `The artifact is awaiting the user's decision. Route artifact decisions through \`submit_feedback\`; answer clarification, status, dogfood, or experience questions normally.\n\n` +
    `**Do when the user gives an artifact decision:**\n` +
    `- If the user approves (yes / lgtm / approved / looks good / ship it / proceed / etc.):\n` +
    `  → Call \`submit_feedback(feedback_type="approve", feedback_text=<their message>)\`\n` +
    `- If the user requests artifact changes or gives review feedback:\n` +
    `  → Call \`submit_feedback(feedback_type="revise", feedback_text=<their exact message>)\`\n\n` +
    `**Do not call \`submit_feedback\` for clarification/meta questions.** For example, if the user asks "what am I reviewing?", "have we implemented all tasks?", or "how was Open Artisan?", answer normally and continue waiting at USER_GATE.\n\n` +
    `Do not do research, file reads, or artifact changes before routing a real approval/revision decision through \`submit_feedback\`.\n` +
    `---`
  )
}
