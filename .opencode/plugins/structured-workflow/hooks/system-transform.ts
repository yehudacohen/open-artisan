/**
 * system-transform.ts — Injects phase-specific instructions into every LLM call.
 *
 * Uses the `experimental.chat.system.transform` hook. Prepends a block at the
 * beginning of the system prompt array describing:
 * - Current phase and sub-state
 * - Workflow mode (and its constraints)
 * - Conventions document (if in REFACTOR/INCREMENTAL mode and approved)
 * - File allowlist (INCREMENTAL mode only)
 * - Acceptance criteria for this phase
 * - Which tools are allowed/blocked
 * - What the agent should do next
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { WorkflowState, Phase, WorkflowMode } from "../types"

// ---------------------------------------------------------------------------
// Prompt file loader (cached)
// ---------------------------------------------------------------------------

const PROMPTS_DIR = join(import.meta.dirname, "..", "prompts")

const promptCache = new Map<string, string>()

function loadPrompt(filename: string): string {
  if (promptCache.has(filename)) return promptCache.get(filename)!
  try {
    const content = readFileSync(join(PROMPTS_DIR, filename), "utf-8")
    promptCache.set(filename, content)
    return content
  } catch {
    return `## Phase: ${filename.replace(".txt", "")}\n(prompt file not found)`
  }
}

function getPhasePromptFilename(phase: Phase, mode: WorkflowMode | null): string | null {
  switch (phase) {
    case "DISCOVERY":
      if (mode === "REFACTOR") return "discovery-refactor.txt"
      if (mode === "INCREMENTAL") return "discovery-incremental.txt"
      return null // GREENFIELD skips discovery
    case "PLANNING":
      return "planning.txt"
    case "INTERFACES":
      return "interfaces.txt"
    case "TESTS":
      return "tests.txt"
    case "IMPL_PLAN":
      return "impl-plan.txt"
    case "IMPLEMENTATION":
      return "implementation.txt"
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// State header builder
// ---------------------------------------------------------------------------

function buildStateHeader(state: WorkflowState): string {
  const lines: string[] = []

  lines.push("---")
  lines.push("## STRUCTURED WORKFLOW — ACTIVE")
  lines.push("")
  lines.push(`**Phase:** ${state.phase} / **Sub-state:** ${state.phaseState}`)
  lines.push(`**Mode:** ${state.mode ?? "not yet selected"}`)

  if (state.iterationCount > 0) {
    lines.push(`**Iteration:** ${state.iterationCount} (in current phase/sub-state)`)
  }
  if (state.lastCheckpointTag) {
    lines.push(`**Last checkpoint:** \`${state.lastCheckpointTag}\``)
  }
  lines.push("")

  // Mode constraints summary
  if (state.mode === "INCREMENTAL") {
    lines.push("### Do-No-Harm Directive (INCREMENTAL mode)")
    lines.push("- Modify ONLY files in the approved allowlist")
    lines.push("- Do NOT refactor outside the requested scope")
    lines.push("- Follow existing conventions exactly")
    lines.push("- All existing tests must continue to pass")
    lines.push("- If you need to touch an unlisted file, STOP and call submit_feedback")
    lines.push("")
    if (state.fileAllowlist.length > 0) {
      lines.push("**Approved file allowlist:**")
      for (const f of state.fileAllowlist) {
        lines.push(`  - ${f}`)
      }
      lines.push("")
    }
  } else if (state.mode === "REFACTOR") {
    lines.push("### Refactor Mode Constraints")
    lines.push("- Follow the target patterns from the conventions document")
    lines.push("- All existing tests must pass after each task")
    lines.push("- New patterns must be documented")
    lines.push("")
  }

  // Conventions document injection
  // NOTE: The full conventions document is injected on every LLM call for the remainder
  // of the session. For very large conventions documents this is wasteful, but keeping
  // state consistent across the session matters more than token savings.
  // TODO (optimization): if conventions exceeds ~3000 tokens, summarize it once at
  // approval time and inject the summary instead of the full text.
  // Cap at MAX_CONVENTIONS_CHARS to prevent extreme context blowup.
  const MAX_CONVENTIONS_CHARS = 12_000 // ~3000 tokens at ~4 chars/token
  if (state.conventions && state.mode !== "GREENFIELD") {
    const text = state.conventions.length > MAX_CONVENTIONS_CHARS
      ? state.conventions.slice(0, MAX_CONVENTIONS_CHARS) +
        `\n\n[... conventions truncated at ${MAX_CONVENTIONS_CHARS} chars to conserve context ...]`
      : state.conventions
    lines.push("### Conventions Document (from Discovery Phase)")
    lines.push("The following conventions are MANDATORY. Treat them as hard requirements.")
    lines.push("")
    lines.push(text)
    lines.push("")
  }

  // Approved artifacts summary
  if (Object.keys(state.approvedArtifacts).length > 0) {
    lines.push("### Approved Artifacts")
    lines.push("These artifacts have been reviewed and approved by the user:")
    for (const [artifact, hash] of Object.entries(state.approvedArtifacts)) {
      lines.push(`  - **${artifact}** (content hash: ${hash})`)
    }
    lines.push("")
  }

  lines.push("---")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface SystemTransformInput {
  sessionId: string
  /** The current mutable system prompt array (will be mutated in place via unshift) */
  parts: Array<{ type: string; text: string }>
}

/**
 * Builds the workflow system prompt block for the given state.
 * Returns the string to prepend to the system prompt.
 * Pure function — does NOT mutate anything.
 */
export function buildWorkflowSystemPrompt(state: WorkflowState): string {
  const blocks: string[] = []

  // 1. State header (phase, mode, constraints)
  blocks.push(buildStateHeader(state))

  // 2. Phase-specific instructions
  const promptFile = getPhasePromptFilename(state.phase, state.mode)
  if (promptFile) {
    blocks.push(loadPrompt(promptFile))
  }

  // 3. Current sub-state context
  blocks.push(buildSubStateContext(state))

  return blocks.join("\n\n")
}

function buildSubStateContext(state: WorkflowState): string {
  const lines: string[] = ["### Current Action"]

  switch (state.phaseState) {
    case "SCAN":
      lines.push("You are scanning the codebase. Use read-only tools only.")
      lines.push("When finished, call `mark_scan_complete`.")
      break
    case "ANALYZE":
      lines.push("You are analyzing the scan results. Synthesize your findings.")
      lines.push("When analysis is complete, call `mark_analyze_complete` to transition to CONVENTIONS state.")
      lines.push("Do NOT start drafting until you have called `mark_analyze_complete`.")
      break
    case "CONVENTIONS":
    case "DRAFT":
      lines.push("You are drafting the artifact for this phase.")
      lines.push("When the draft is complete, call `request_review`.")
      break
    case "REVIEW":
      lines.push("Self-review is in progress.")
      lines.push("Evaluate the artifact against the acceptance criteria.")
      lines.push("When all criteria are satisfied, call `mark_satisfied` with your assessment.")
      lines.push("If any blocking criterion is not met, address it and call `mark_satisfied` again.")
      break
    case "USER_GATE":
      lines.push("The artifact is ready for user review.")
      lines.push("Present a clear summary to the user and wait for their response.")
      lines.push("Do NOT proceed until the user responds via `submit_feedback`.")
      break
    case "REVISE":
      lines.push("You are revising the artifact based on feedback.")
      lines.push("Make incremental changes only. Do NOT rewrite from scratch.")
      lines.push("Preserve all prior approved decisions. When revision is complete, call `request_review`.")
      break
  }

  return lines.join("\n")
}
