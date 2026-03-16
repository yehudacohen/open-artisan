/**
 * vocabulary.ts — Shared keyword sets for intent classification.
 *
 * Consolidates approval, accept, and abort keyword vocabularies that were
 * previously duplicated across chat-message.ts and escape-hatch.ts.
 * Single source of truth prevents drift between the two classification paths.
 */

// ---------------------------------------------------------------------------
// Approval keywords — used at USER_GATE for normal approval detection
// ---------------------------------------------------------------------------

/**
 * Words/phrases that unambiguously signal user approval.
 * Used by chat-message.ts (processUserMessage) and escape-hatch.ts (isEscapeHatchAccept).
 * All entries must be lowercase and trimmed.
 */
export const APPROVAL_WORDS = new Set([
  "approve", "approved", "accept", "lgtm", "looks good", "ship it",
  "yes", "y", "ok", "okay", "good", "perfect", "done",
  "continue", "proceed", "next", "go ahead", "go",
  "sure", "yep", "yeah", "do it",
  "✓", "👍",
])

/**
 * Prefix-anchored regex for approval detection.
 * Matches when the message starts with an approval signal and has no
 * substantive continuation (only punctuation/whitespace follows).
 * Used for messages that look like "approved!" or "yes." but not "yes but I have concerns".
 */
export const APPROVAL_PREFIX_RE = /^(approve[sd]?|accept|lgtm|looks good|ship it|yes|y|ok|okay|good|perfect|done|continue|proceed|next|go ahead|go|sure|yep|yeah|do it)[.!?\s]*$/i

// ---------------------------------------------------------------------------
// Abort keywords — used at escape hatch for abort detection
// ---------------------------------------------------------------------------

/**
 * Words/phrases that unambiguously signal abort/reject intent.
 * Used by escape-hatch.ts (isEscapeHatchAbort).
 * All entries must be lowercase and trimmed.
 */
export const ABORT_WORDS = new Set([
  "abort", "abort change", "no", "cancel", "stop", "reject",
  "no thanks", "nope", "nah", "nevermind", "never mind", "don't",
  "dont", "skip", "pass", "decline",
])
