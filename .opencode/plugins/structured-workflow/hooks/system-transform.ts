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
import type { WorkflowState, Phase, PhaseState, WorkflowMode } from "../types"

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

  // At MODE_SELECT, show the auto-detection result so the agent can use it to inform the user
  if (state.phase === "MODE_SELECT" && state.intentBaseline?.startsWith("[Auto-detected")) {
    lines.push("### Auto-Detection Result")
    lines.push(state.intentBaseline)
    lines.push("")
  }

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
// Acceptance criteria (design doc §11) — injected at REVIEW state only
// ---------------------------------------------------------------------------

/**
 * Returns the structured acceptance criteria checklist for the given phase/mode.
 * These are the exact criteria the agent must evaluate in mark_satisfied.
 *
 * Format: each criterion is a string. The agent maps each to a CriterionResult.
 * Criteria marked [S] are suggestions (non-blocking); all others are blocking.
 */
function getAcceptanceCriteria(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null): string | null {
  if (phaseState !== "REVIEW") return null

  switch (phase) {
    case "DISCOVERY":
      if (mode === "REFACTOR") return `### Acceptance Criteria — Conventions Document (Refactor Mode)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (quote or file reference), and mark severity (blocking/suggestion).

**Blocking criteria (must all pass to advance):**
1. Existing architecture accurately described — module boundaries, key abstractions, data flow
2. Current patterns documented with concrete examples — naming, error handling, test structure, import style
3. Problem areas identified with specific evidence (not vague — must cite actual files/patterns)
4. Target state described for each problem area (what it should look like after refactoring)
5. Migration path is feasible and incremental (not "rewrite everything")
6. Risk areas identified — high coupling, no test coverage, complex state machines

**Suggestion criteria (non-blocking):**
- [S] Contributor patterns from git history noted
- [S] Existing docs (AGENTS.md, CONTRIBUTING.md) incorporated`

      if (mode === "INCREMENTAL") return `### Acceptance Criteria — Conventions Document (Incremental Mode)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (quote or file reference), and mark severity (blocking/suggestion).

**Blocking criteria (must all pass to advance):**
1. Existing architecture accurately described — module boundaries, dependency directions
2. Naming conventions documented with examples — files, functions, classes, variables, constants
3. Error handling pattern documented — how errors are typed, surfaced, propagated
4. Test conventions documented — framework, file naming, assertion style, mock patterns
5. Import patterns documented — relative vs absolute, barrel files, module aliases
6. File organization documented — where new files of each type should go
7. Existing constraints listed — files/directories that must NOT be touched (from AGENTS.md / CONTRIBUTING.md)

**Suggestion criteria (non-blocking):**
- [S] Git history activity patterns noted (hot files, recent areas of change)
- [S] "DO NOT TOUCH" list explicitly enumerated`

      return null // GREENFIELD skips discovery

    case "PLANNING": return `### Acceptance Criteria — Plan

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence, and mark severity (blocking/suggestion).

**Blocking criteria (must all pass to advance):**
1. All user requirements explicitly addressed — nothing from the original request is omitted
2. Scope boundaries explicit — what is in scope AND what is explicitly out of scope
3. Architecture described — components, communication patterns, data flow
4. Error and failure cases specified — what can fail, how failures surface, recovery strategy
5. No "TBD" items — every ambiguity has been resolved with an explicit decision
6. Data model described — key entities, relationships, constraints, lifecycle
7. Integration points identified — external systems, APIs, databases, filesystem interactions

**Suggestion criteria (non-blocking):**
- [S] Non-functional requirements addressed (performance targets, security, scalability)
- [S] Decisions documented with rationale (why this approach over alternatives)`

    case "INTERFACES": return `### Acceptance Criteria — Interfaces & Data Models

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (file path and line), and mark severity (blocking/suggestion).

**Blocking criteria (must all pass to advance):**
1. Every function/method has input types, output types, and error types — no \`any\`, no missing types
2. Every data model has all fields, their types, optional vs required, and relationships
3. Every enum is fully defined with all valid values
4. Error types are structured — not just \`Error\` strings
5. Naming is consistent with the plan's terminology throughout
6. Consistent error handling pattern across all interfaces

**Suggestion criteria (non-blocking):**
- [S] Validation constraints specified for inputs with ranges, formats, or invariants
- [S] JSDoc / docstring comments on all public interfaces`

    case "TESTS": return `### Acceptance Criteria — Test Suite

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (test names, counts), and mark severity (blocking/suggestion).

**Blocking criteria (must all pass to advance):**
1. At least one test per interface method/function
2. Happy path tested for each operation
3. Edge cases covered — empty input, maximum values, null/undefined, boundary conditions
4. Failure modes tested — network errors, invalid data, auth failures, timeouts
5. Tests are expected to FAIL — no implementation has leaked in (run them to verify)
6. Test descriptions map directly to interface specifications
7. Tests import from interfaces, not from implementations

**Suggestion criteria (non-blocking):**
- [S] Each test is independently runnable (no shared state between tests)
- [S] Concurrency/race condition tests where applicable`

    case "IMPL_PLAN": return `### Acceptance Criteria — Implementation Plan (DAG)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (task IDs, interface names), and mark severity (blocking/suggestion).

**Blocking criteria (must all pass to advance):**
1. Every interface method is covered by at least one task
2. Task dependencies are correct and acyclic (no circular dependencies)
3. Parallelizable tasks have no shared mutable state (no shared files, no shared DB rows)
4. Merge points explicitly identified where parallel branches converge
5. Expected test outcomes specified per task (which tests become green)

**Suggestion criteria (non-blocking):**
- [S] Complexity estimates assigned per task (small/medium/large)
- [S] Critical path identified through the DAG`

    case "IMPLEMENTATION": return `### Acceptance Criteria — Implementation

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (file paths, test outputs), and mark severity (blocking/suggestion).

**Blocking criteria (must all pass to advance):**
1. Implementation matches approved interface signatures exactly — no deviations
2. Expected tests for this task pass (run them and report results)
3. No regressions in previously-passing tests
4. No scope creep — only what the plan specifies is implemented
5. Consistent with all prior approved artifacts (plan, interfaces, conventions)

**Suggestion criteria (non-blocking):**
- [S] Code follows existing naming and style conventions
- [S] No dead code or unnecessary complexity introduced`

    default:
      return null
  }
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

  // 3. Current sub-state context (with MODE_SELECT and DONE special cases)
  blocks.push(buildSubStateContext(state))

  // 4. At REVIEW state: inject structured acceptance criteria so the agent
  //    knows exactly what to evaluate for mark_satisfied
  const criteria = getAcceptanceCriteria(state.phase, state.phaseState, state.mode)
  if (criteria) {
    blocks.push(criteria)
  }

  return blocks.join("\n\n")
}

function buildSubStateContext(state: WorkflowState): string {
  const lines: string[] = ["### Current Action"]

  // Special-case terminal and entry phases before checking phaseState
  if (state.phase === "MODE_SELECT") {
    lines.push("You are at the start of the workflow. Select the appropriate mode:")
    lines.push("")
    lines.push("- **GREENFIELD** — New project from scratch. No discovery phase. Full creative freedom.")
    lines.push("- **REFACTOR** — Existing project where you want to restructure patterns or architecture.")
    lines.push("- **INCREMENTAL** — Existing project where you want to add or fix specific functionality (do-no-harm).")
    lines.push("")
    lines.push("The auto-detection suggestion (if shown above) is advisory — you can override it.")
    lines.push("Call `select_mode` with the chosen mode to begin.")
    return lines.join("\n")
  }

  if (state.phase === "DONE") {
    lines.push("The workflow is complete. All phases have been approved and a final git checkpoint has been created.")
    lines.push("You may present a summary of what was built and what decisions were made.")
    return lines.join("\n")
  }

  switch (state.phaseState) {
    case "SCAN":
      lines.push("You are scanning the codebase. Use read-only tools only (glob, grep, read, list).")
      lines.push("When finished, call `mark_scan_complete`.")
      break
    case "ANALYZE":
      lines.push("You are analyzing the scan results. Synthesize your findings.")
      lines.push("When analysis is complete, call `mark_analyze_complete` to transition to CONVENTIONS state.")
      lines.push("Do NOT start drafting until you have called `mark_analyze_complete`.")
      break
    case "CONVENTIONS":
      lines.push("You are drafting the conventions document.")
      lines.push("When the draft is complete, call `request_review`.")
      break
    case "DRAFT":
      lines.push(`You are drafting the ${state.phase} artifact.`)
      lines.push("When the draft is complete, call `request_review`.")
      break
    case "REVIEW":
      lines.push("Self-review is in progress.")
      lines.push("Read the acceptance criteria for this phase (listed below) and evaluate each one independently.")
      lines.push("Do NOT assume quality — read the actual files you produced and verify each criterion.")
      lines.push("When evaluation is complete, call `mark_satisfied` with your per-criterion assessment.")
      lines.push("If any blocking criterion is not met, address it first, then call `mark_satisfied` again.")
      break
    case "USER_GATE":
      lines.push("The artifact is ready for user review.")
      lines.push("Present a clear summary of what was produced, key decisions made, and any tradeoffs.")
      lines.push("Wait for the user's response. Do NOT proceed until they respond via `submit_feedback`.")
      lines.push("Do NOT simulate approval — wait for the actual user message.")
      break
    case "REVISE":
      lines.push("You are revising the artifact based on feedback.")
      lines.push("Make targeted, incremental changes only. Do NOT rewrite from scratch.")
      lines.push("Preserve all prior approved decisions. Only change what the feedback specifically addresses.")
      lines.push("When revision is complete, call `request_review`.")
      break
  }

  return lines.join("\n")
}
