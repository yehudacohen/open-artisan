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
  for (const step of revisionSteps) {
    lines.push(`  ${revisionSteps.indexOf(step) + 1}. **${step.artifact}** (${step.phase}/REVISE) — ${step.instructions}`)
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
  lines.push("   Respond: `accept` or describe any adjustments you want to the plan.")
  lines.push("")
  lines.push("**B. Provide alternative direction** — Describe a different approach.")
  lines.push("   Respond with your preferred direction and the orchestrator will rebuild the plan.")
  lines.push("")
  lines.push("**C. Abort change** — Return to the current state without making any changes.")
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

/**
 * Detects whether the user's response to an escape hatch is an abort.
 */
export function isEscapeHatchAbort(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t === "abort" || t === "abort change" || t === "no" || t === "cancel"
}

/**
 * Detects whether the user's response to an escape hatch is an accept.
 */
export function isEscapeHatchAccept(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t === "accept" || t === "proceed" || t === "yes" || t === "ok" || t === "okay"
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
