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
import { existsSync } from "node:fs"
import type { WorkflowState } from "../types"
import { MAX_CONVENTIONS_CHARS, MAX_REPORT_CHARS } from "../constants"
import { getNextActionForState } from "../utils"

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

  // Conventions — reference disk file if available, otherwise inline.
  // After compaction the agent must re-read the conventions from disk
  // rather than relying on the truncated version in the compaction context.
  if (state.conventions) {
    lines.push("### Conventions Document (Approved — Read Only)")
    const conventionsPath = state.artifactDiskPaths?.["conventions"]
    if (conventionsPath && existsSync(conventionsPath)) {
      lines.push(`The approved conventions document is at \`${conventionsPath}\`.`)
      lines.push("Read this file before continuing — it contains mandatory constraints for all phases.")
    } else {
      // Fallback inline for pre-v9 sessions
      const text = state.conventions.length > MAX_CONVENTIONS_CHARS
        ? state.conventions.slice(0, MAX_CONVENTIONS_CHARS) +
          `\n\n[... conventions truncated at ${MAX_CONVENTIONS_CHARS} chars ...]`
        : state.conventions
      lines.push(text)
    }
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

  // Discovery report — reference disk file if available, otherwise inline.
  if (state.discoveryReport) {
    lines.push("### Discovery Fleet Report (Preserved)")
    const reportPath = state.artifactDiskPaths?.["discovery_report" as keyof typeof state.artifactDiskPaths]
    if (reportPath && existsSync(reportPath as string)) {
      lines.push(`The discovery fleet report is at \`${reportPath}\`.`)
      lines.push("Read this file when drafting the conventions document.")
    } else {
      // Fallback inline for pre-v9 sessions
      const report = state.discoveryReport.length > MAX_REPORT_CHARS
        ? state.discoveryReport.slice(0, MAX_REPORT_CHARS) +
          `\n\n[... discovery report truncated at ${MAX_REPORT_CHARS} chars ...]`
        : state.discoveryReport
      lines.push(report)
    }
    lines.push("")
  }

  // Implementation DAG — needed for IMPLEMENTATION task tracking after compaction
  if (state.implDag && state.implDag.length > 0) {
    lines.push("### Implementation DAG Status")
    for (const task of state.implDag) {
      lines.push(`  - **${task.id}** [${task.status}]: ${task.description.slice(0, 100)}`)
    }
    lines.push("")
  }

  // Escape hatch state — needed so the agent knows an escape hatch is active
  if (state.phaseState === "ESCAPE_HATCH") {
    lines.push("### Escape Hatch")
    lines.push("**An escape hatch is currently ACTIVE.** Wait for the user's decision before proceeding.")
    if (state.pendingRevisionSteps && state.pendingRevisionSteps.length > 0) {
      lines.push("Pending revision steps:")
      for (const step of state.pendingRevisionSteps) {
        lines.push(`  - ${step.artifact} (${step.phase}/REVISE): ${step.instructions.slice(0, 100)}`)
      }
    }
    lines.push("")
  }

  // Available workflow tools
  lines.push("### Available Workflow Tools")
  lines.push("- `select_mode` — select workflow mode (GREENFIELD / REFACTOR / INCREMENTAL)")
  lines.push("- `mark_scan_complete` — signal end of DISCOVERY/SCAN")
  lines.push("- `mark_analyze_complete` — signal end of DISCOVERY/ANALYZE")
  lines.push("- `request_review` — submit draft for self-review")
  lines.push("- `mark_satisfied` — report self-review results")
  lines.push("- `mark_task_complete` — complete a DAG implementation task")
  lines.push("- `resolve_human_gate` — activate a human gate for a DAG task")
  lines.push("- `submit_feedback` — record user approval or revision request")
  lines.push("")

  // Acceptance criteria summary (if in REVIEW)
  if (state.phaseState === "REVIEW") {
    lines.push("### Acceptance Criteria")
    lines.push(`Re-read the acceptance criteria for the ${state.phase} phase from the system prompt.`)
    lines.push("Evaluate each criterion independently. Call `mark_satisfied` with your assessment.")
    lines.push("")
  }

  // What to do next
  lines.push("### What To Do Next")
  lines.push(getNextActionForState(state.phase, state.phaseState))

  return lines.join("\n")
}
