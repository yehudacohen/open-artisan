/**
 * orchestrator/escape-hatch.ts — Escape hatch presentation (O_USER_DECIDE).
 *
 * When the diverge check classifies a change as "strategic", the orchestrator
 * escalates to the user before proceeding. This module builds the structured
 * presentation the agent shows to the user.
 *
 * The agent shows the escape hatch summary and waits for the user's choice.
 * The user's response is fed back through submit_feedback, which then either:
 * - Proceeds with the orchestrator plan (accept drift / alternative direction)
 * - Aborts the change (abort change option)
 *
 * Design doc §12: Escape Hatch User Experience
 */
import type {
  OrchestratorAssessResult,
  OrchestratorDivergeResult,
  RevisionStep,
  ArtifactKey,
  Phase,
} from "../types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscapeHatchSummary {
  /** The full text block to present to the user */
  presentation: string
  /** The trigger criterion that caused escalation */
  triggerCriterion: string
  /** How many artifacts are affected */
  affectedCount: number
  /** Whether this is a cascade_depth trigger (most severe) */
  isCascade: boolean
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Builds the escape hatch presentation for O_USER_DECIDE.
 * Returns a structured string the agent can present verbatim.
 */
export function buildEscapeHatchPresentation(opts: {
  feedback: string
  intentBaseline: string | null
  assessResult: OrchestratorAssessResult
  divergeResult: OrchestratorDivergeResult
  revisionSteps: RevisionStep[]
  currentPhase: Phase
}): EscapeHatchSummary {
  const { feedback, intentBaseline, assessResult, divergeResult, revisionSteps } = opts

  const triggerCriterion = divergeResult.success && divergeResult.classification === "strategic"
    ? (divergeResult.triggerCriterion ?? "unknown")
    : "unknown"

  const affectedArtifacts: ArtifactKey[] = assessResult.success
    ? assessResult.affectedArtifacts
    : []

  const rootCause: ArtifactKey | null = assessResult.success
    ? assessResult.rootCauseArtifact
    : null

  const isCascade = triggerCriterion === "cascade_depth" || revisionSteps.length >= 3

  const lines: string[] = []

  lines.push("---")
  lines.push("## STRATEGIC CHANGE DETECTED — Your Decision Required")
  lines.push("")
  lines.push(`**Trigger:** ${formatTrigger(triggerCriterion)}`)
  lines.push("")

  // 1. Original intent
  lines.push("### 1. Original Intent")
  if (intentBaseline) {
    lines.push(intentBaseline)
  } else {
    lines.push("*(No baseline intent recorded — this is the first revision)*")
  }
  lines.push("")

  // 2. Detected divergence
  lines.push("### 2. Detected Divergence")
  lines.push(`The following feedback was received:`)
  lines.push(`> ${feedback.slice(0, 500)}${feedback.length > 500 ? "..." : ""}`)
  lines.push("")
  if (assessResult.success) {
    lines.push(`**Root cause artifact:** ${rootCause}`)
    lines.push(`**Assessment:** ${assessResult.reasoning}`)
  }
  if (divergeResult.success) {
    lines.push(`**Classification reasoning:** ${divergeResult.reasoning}`)
  }
  lines.push("")

  // 3. Proposed change plan
  lines.push("### 3. Proposed Change Plan")
  lines.push(`The orchestrator proposes revising **${revisionSteps.length}** artifact(s):`)
  for (let i = 0; i < revisionSteps.length; i++) {
    const step = revisionSteps[i]!
    lines.push(`  ${i + 1}. **${step.artifact}** (${step.phase}/REVISE) — ${step.instructions}`)
  }
  lines.push("")

  // 4. Impact assessment
  lines.push("### 4. Impact Assessment")
  if (affectedArtifacts.length > 0) {
    lines.push(`Affected artifacts: ${affectedArtifacts.join(" → ")}`)
  }
  if (isCascade) {
    lines.push(`**Warning:** This is a deep cascade (${revisionSteps.length} artifacts). All downstream work will need re-review.`)
  }
  lines.push("")

  // Options
  lines.push("### Your Options")
  lines.push("")
  lines.push("**A. Accept and proceed** — The orchestrator will execute the proposed change plan.")
  lines.push("   Respond: `accept` or `proceed`.")
  lines.push("")
  lines.push("**B. Provide alternative direction** — Describe a different approach.")
  lines.push("   The intent baseline is updated with your direction and the orchestrator rebuilds the plan.")
  lines.push("   Respond with your preferred direction (any message longer than a few words that isn't one of the other options).")
  lines.push("")
  lines.push("**C. Start fresh with entirely new direction** — Neither original nor detected drift is right.")
  lines.push("   The intent baseline is cleared and replaced with your new requirements.")
  lines.push("   The orchestrator does a full re-assessment from the current phase.")
  lines.push("   Respond: `new direction: <your new requirements>`")
  lines.push("")
  lines.push("**D. Abort change** — Return to the current state without making any changes.")
  lines.push("   The last approved checkpoint tag can be used to roll back if needed.")
  lines.push("   Respond: `abort`")
  lines.push("")
  lines.push("*Wait for the user's response before proceeding. Do NOT simulate a choice.*")
  lines.push("---")

  return {
    presentation: lines.join("\n"),
    triggerCriterion,
    affectedCount: affectedArtifacts.length,
    isCascade,
  }
}

/** Words/phrases that unambiguously signal abort intent. */
const ABORT_WORDS = new Set([
  "abort", "abort change", "no", "cancel", "stop", "reject",
  "no thanks", "nope", "nah", "nevermind", "never mind", "don't",
  "dont", "skip", "pass", "decline",
])

/** Words/phrases that unambiguously signal accept intent. */
const ACCEPT_WORDS = new Set([
  "accept", "proceed", "yes", "ok", "okay", "go ahead",
  "go", "sure", "yep", "yeah", "y", "approve", "lgtm",
  "continue", "do it",
])

/**
 * Detects whether the user's response to an escape hatch is an abort.
 */
export function isEscapeHatchAbort(text: string): boolean {
  return ABORT_WORDS.has(text.trim().toLowerCase())
}

/**
 * Detects whether the user's response to an escape hatch is an accept.
 */
export function isEscapeHatchAccept(text: string): boolean {
  return ACCEPT_WORDS.has(text.trim().toLowerCase())
}

/**
 * Returns true if the text is a short ambiguous response that doesn't match
 * any known keyword. Callers should treat this as requiring clarification
 * rather than silently falling through to the "alternative direction" path.
 */
export function isEscapeHatchAmbiguous(text: string): boolean {
  const t = text.trim()
  // Only flag short responses (≤ 15 chars) that aren't a recognized keyword
  if (t.length > 15) return false
  const lower = t.toLowerCase()
  return !ABORT_WORDS.has(lower) && !ACCEPT_WORDS.has(lower) && !lower.startsWith("new direction:")
}

/**
 * Detects whether the user's response is "entirely new direction" (option C).
 * Format: "new direction: <requirements>" — clears intentBaseline and does full re-assessment.
 * Returns the new direction text (after the prefix) if matched, null otherwise.
 */
export function parseEscapeHatchNewDirection(text: string): string | null {
  const t = text.trim()
  const match = /^new direction:\s*(.+)/is.exec(t)
  return match ? (match[1]!.trim() || null) : null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTrigger(criterion: string): string {
  switch (criterion) {
    case "scope_expansion":    return "Scope Expansion — proposed change adds artifacts or capabilities not in the original plan"
    case "architectural_shift": return "Architectural Shift — proposed change modifies fundamental data model or API structure"
    case "cascade_depth":      return "Deep Cascade — 3 or more artifacts need revision"
    case "accumulated_drift":  return "Accumulated Drift — many small changes have collectively altered the design"
    default:                   return `Strategic change detected (${criterion})`
  }
}
