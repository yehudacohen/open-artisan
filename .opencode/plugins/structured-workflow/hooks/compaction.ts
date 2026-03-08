/**
 * compaction.ts — Injects workflow state into the compaction context.
 *
 * Uses the `experimental.session.compacting` hook. When OpenCode compacts
 * a long session, this hook ensures the workflow state is preserved so the
 * agent knows exactly where it is and what to do next after compaction.
 *
 * The injected context block is:
 * 1. Current phase and sub-state (the most critical piece)
 * 2. Workflow mode and its constraints
 * 3. Approved artifacts (so the agent doesn't re-derive them)
 * 4. Conventions document (if present)
 * 5. File allowlist (if INCREMENTAL mode)
 * 6. Last checkpoint tag
 * 7. What the agent should do next
 */
import type { WorkflowState, Phase, PhaseState } from "../types"

// ---------------------------------------------------------------------------
// Context block builder
// ---------------------------------------------------------------------------

/**
 * Builds the workflow state preservation block for compaction context injection.
 * Returns the context string to inject.
 */
export function buildCompactionContext(state: WorkflowState): string {
  const lines: string[] = []

  lines.push("## WORKFLOW STATE — CRITICAL: PRESERVE THIS")
  lines.push("")
  lines.push("The conversation above was compacted. The following is the current workflow state.")
  lines.push("You MUST continue from exactly this state. Do NOT restart or skip ahead.")
  lines.push("")

  lines.push("### Current Position")
  lines.push(`- **Phase:** ${state.phase}`)
  lines.push(`- **Sub-state:** ${state.phaseState}`)
  lines.push(`- **Workflow mode:** ${state.mode ?? "not yet selected"}`)
  lines.push(`- **Iteration count:** ${state.iterationCount}`)
  if (state.lastCheckpointTag) {
    lines.push(`- **Last approved checkpoint:** \`${state.lastCheckpointTag}\``)
  }
  lines.push("")

  // Approved artifacts
  if (Object.keys(state.approvedArtifacts).length > 0) {
    lines.push("### Approved Artifacts")
    lines.push("These have been reviewed and approved by the user:")
    for (const [artifact, hash] of Object.entries(state.approvedArtifacts)) {
      lines.push(`  - **${artifact}** — content hash: ${hash}`)
    }
    lines.push("")
  }

  // Conventions (if applicable) — capped at same limit as system-transform
  // to prevent compaction context itself from exceeding model limits.
  const MAX_CONVENTIONS_CHARS = 12_000
  if (state.conventions) {
    const text = state.conventions.length > MAX_CONVENTIONS_CHARS
      ? state.conventions.slice(0, MAX_CONVENTIONS_CHARS) +
        `\n\n[... conventions truncated at ${MAX_CONVENTIONS_CHARS} chars ...]`
      : state.conventions
    lines.push("### Conventions Document (Approved — Read Only)")
    lines.push(text)
    lines.push("")
  }

  // File allowlist (INCREMENTAL only)
  if (state.mode === "INCREMENTAL" && state.fileAllowlist.length > 0) {
    lines.push("### File Allowlist (INCREMENTAL mode — DO NO HARM)")
    lines.push("You may ONLY modify these files:")
    for (const f of state.fileAllowlist) {
      lines.push(`  - ${f}`)
    }
    lines.push("")
  }

  // Mode detection note (advisory only — shown at MODE_SELECT)
  if (state.modeDetectionNote && state.phase === "MODE_SELECT") {
    lines.push("### Mode Detection Suggestion")
    lines.push(state.modeDetectionNote)
    lines.push("")
  }

  // Intent baseline — the user's actual task description, captured from first message
  if (state.intentBaseline) {
    lines.push("### Original Intent (User's Request)")
    lines.push(state.intentBaseline)
    lines.push("")
  }

  // What to do next
  lines.push("### What To Do Next")
  lines.push(getNextAction(state.phase, state.phaseState))

  return lines.join("\n")
}

function getNextAction(phase: Phase, phaseState: PhaseState): string {
  if (phase === "MODE_SELECT") {
    return "Present the three workflow modes to the user (GREENFIELD, REFACTOR, INCREMENTAL) and ask them to select one using the `select_mode` tool."
  }
  if (phaseState === "SCAN") {
    return "Continue scanning the codebase with read-only tools. Call `mark_scan_complete` when finished."
  }
  if (phaseState === "ANALYZE") {
    return "Continue analyzing scan results. Synthesize findings into a coherent picture of the codebase. Call `mark_analyze_complete` when analysis is complete."
  }
  if (phaseState === "DRAFT" || phaseState === "CONVENTIONS") {
    return `Continue drafting the ${phase} artifact. Review the acceptance criteria and ensure full coverage. Call \`request_review\` when complete.`
  }
  if (phaseState === "REVIEW") {
    return `Continue self-reviewing the ${phase} artifact against the acceptance criteria. Evaluate each criterion independently. Call \`mark_satisfied\` when done.`
  }
  if (phaseState === "USER_GATE") {
    return `The artifact is ready for user review. Present a clear summary to the user and WAIT for their response. Do not proceed until they respond.`
  }
  if (phaseState === "REVISE") {
    return `Continue revising the ${phase} artifact based on the feedback. Make incremental changes only — do NOT rewrite from scratch. Call \`request_review\` when revision is complete.`
  }
  if (phase === "DONE") {
    return "The workflow is complete. All phases have been approved."
  }
  return `Continue working on the ${phase}/${phaseState} state.`
}
