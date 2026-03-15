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
import { join } from "node:path"
import { existsSync } from "node:fs"
import type { WorkflowState, Phase, PhaseState, WorkflowMode } from "../types"
import { MAX_CONVENTIONS_CHARS, MAX_REPORT_CHARS } from "../utils"
import { createImplDAG } from "../dag"
import { nextSchedulerDecision } from "../scheduler"
import { getPhaseToolPolicy } from "./tool-guard"

// ---------------------------------------------------------------------------
// Prompt file loader (cached)
// ---------------------------------------------------------------------------

const PROMPTS_DIR = join(import.meta.dirname, "..", "prompts")

const promptCache = new Map<string, string>()

function loadPrompt(filename: string): string {
  if (promptCache.has(filename)) return promptCache.get(filename)!
  try {
    // Synchronous read — cached after first call so only runs once per prompt file.
    // Uses node:fs readFileSync (Bun re-exports this) since Bun.file().text() is async
    // and this function is synchronous by design (called from buildWorkflowSystemPrompt).
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
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

// ---------------------------------------------------------------------------
// Phase progress indicator
// ---------------------------------------------------------------------------

const GREENFIELD_PHASES: Phase[] = ["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"]
const FULL_PHASES: Phase[] = ["DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"]

function phaseProgress(phase: Phase, mode: WorkflowMode | null): string | null {
  const phases = mode === "GREENFIELD" ? GREENFIELD_PHASES : FULL_PHASES
  const idx = phases.indexOf(phase)
  if (idx < 0) return null
  return `Phase ${idx + 1} of ${phases.length}`
}

function buildStateHeader(state: WorkflowState): string {
  const lines: string[] = []

  lines.push("---")
  lines.push("## STRUCTURED WORKFLOW — ACTIVE")
  lines.push("")
  lines.push(`**Phase:** ${state.phase} / **Sub-state:** ${state.phaseState}`)
  lines.push(`**Mode:** ${state.mode ?? "not yet selected"}`)
  if (state.featureName) {
    lines.push(`**Feature:** ${state.featureName} → artifacts at \`.openartisan/${state.featureName}/\``)
  }

  const progress = phaseProgress(state.phase, state.mode)
  if (progress) {
    lines.push(`**Progress:** ${progress}`)
  }

  if (state.iterationCount > 0) {
    lines.push(`**Iteration:** ${state.iterationCount} (in current phase/sub-state)`)
  }
  if (state.lastCheckpointTag) {
    lines.push(`**Last checkpoint:** \`${state.lastCheckpointTag}\``)
  }
  lines.push("")

  // At MODE_SELECT, show the mode-detection suggestion (stored in dedicated field)
  if (state.phase === "MODE_SELECT" && state.modeDetectionNote) {
    lines.push("### Auto-Detection Result")
    lines.push(state.modeDetectionNote)
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
  // If the conventions file has been written to disk, instruct the agent to read it
  // rather than embedding the full text inline (avoids truncation in long contexts).
  if (state.conventions && state.mode !== "GREENFIELD") {
    const conventionsPath = state.artifactDiskPaths?.["conventions"]
    lines.push("### Conventions Document (from Discovery Phase)")
    lines.push("The following conventions are MANDATORY. Treat them as hard requirements.")
    lines.push("")
    if (conventionsPath && existsSync(conventionsPath)) {
      lines.push(`The approved conventions document is saved at \`${conventionsPath}\`.`)
      lines.push("**Read this file now** before doing any work. It contains binding constraints.")
    } else {
      // Fallback: inline injection for sessions pre-dating disk path tracking (v8 → v9 migration)
      const text = state.conventions.length > MAX_CONVENTIONS_CHARS
        ? state.conventions.slice(0, MAX_CONVENTIONS_CHARS) +
          `\n\n[... conventions truncated at ${MAX_CONVENTIONS_CHARS} chars — read the full file for complete constraints ...]`
        : state.conventions
      lines.push(text)
    }
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

// ---------------------------------------------------------------------------
// Quality criteria — six dimensions scored 1-10, minimum 9/10 to pass
// ---------------------------------------------------------------------------

/**
 * Returns the quality-dimension criteria block for a given phase.
 * Each [Q] criterion is a blocking criterion that requires a numeric score.
 * Score >= 9/10 → passes. Score < 9 → fails (must revise and re-review).
 *
 * The seven quality dimensions (applied to every phase):
 *   1. Design excellence — elegance, simplicity, appropriate patterns
 *   2. Architectural cohesion — internal consistency, clear boundaries, no contradictions
 *   3. Vision alignment — fidelity to user's original intent AND upstream approved artifacts
 *   4. Completeness — no gaps, nothing left implicit that should be explicit
 *   5. Readiness for execution — could the next phase proceed without questions?
 *   6. Security standards — auth, input validation, secrets handling, least privilege
 *   7. Operational excellence — observability, error recovery, deployment, monitoring
 */
function getQualityCriteria(phase: Phase): string {
  const descriptions: Record<Phase, Record<string, string>> = {
    MODE_SELECT: {} as Record<string, string>, // unreachable
    DONE: {} as Record<string, string>,        // unreachable
    DISCOVERY: {
      "Design excellence": "Conventions document is well-structured, clear, and actionable — not a raw dump of observations",
      "Architectural cohesion": "Conventions are internally consistent — no contradictory rules, clear hierarchy of importance",
      "Vision alignment": "Conventions accurately reflect what the user asked to build — discovery findings are relevant to the stated intent, not generic boilerplate",
      "Completeness": "No significant codebase convention is missing — naming, error handling, testing, imports, file org all covered",
      "Readiness for execution": "A developer unfamiliar with the codebase could follow these conventions without asking questions",
      "Security standards": "Security-relevant conventions identified — auth patterns, secret handling, input validation, dependency policies",
      "Operational excellence": "Logging, monitoring, and deployment conventions documented where they exist in the codebase",
    },
    PLANNING: {
      "Design excellence": "Plan is elegant and well-reasoned — chosen approaches are appropriate, not over-engineered or under-designed",
      "Architectural cohesion": "All components fit together coherently — no contradictions between sections, consistent terminology throughout",
      "Vision alignment": "Every design decision traces back to the user's original intent — no scope creep, no dropped requirements, and conventions document (if approved) is respected",
      "Completeness": "Every requirement is addressed, every integration specified, every failure mode covered — no implicit assumptions",
      "Readiness for execution": "An engineer could begin implementing interfaces directly from this plan without needing clarification",
      "Security standards": "Auth flows, data protection, secrets management, input validation, and least-privilege access are explicitly designed",
      "Operational excellence": "Monitoring, alerting, logging strategy, deployment pipeline, rollback plan, and incident response are covered",
    },
    INTERFACES: {
      "Design excellence": "Interfaces are clean, minimal, and well-named — appropriate abstractions, no god objects or leaky abstractions",
      "Architectural cohesion": "Interfaces align with the plan's architecture — module boundaries match, naming is consistent end-to-end",
      "Vision alignment": "Interfaces faithfully realize the approved plan — every planned component has corresponding types, no interfaces exist that weren't planned, conventions are followed",
      "Completeness": "Every data model, every API endpoint, every error type, every enum is fully specified — no gaps",
      "Readiness for execution": "A developer can write tests and implementations against these interfaces without ambiguity",
      "Security standards": "Auth interfaces defined, input validation types specified, sensitive data marked, error types don't leak internals",
      "Operational excellence": "Health check interfaces, metrics types, log event types, and configuration interfaces specified",
    },
    TESTS: {
      "Design excellence": "Tests are well-structured, readable, and follow established patterns — clear arrange/act/assert",
      "Architectural cohesion": "Test organization mirrors the interface structure — easy to find the test for any interface method",
      "Vision alignment": "Tests validate the behaviors the user actually requested — happy paths match the plan's use cases, edge cases reflect the plan's failure modes, not invented scenarios",
      "Completeness": "Every interface method tested, every error path covered, every edge case considered",
      "Readiness for execution": "Tests will compile and run (expect failures) once implementations exist — no missing setup or imports",
      "Security standards": "Auth failure paths tested, input validation boundaries tested, privilege escalation scenarios covered",
      "Operational excellence": "Error handling tests verify correct log output, tests for retry/timeout behavior, degradation paths tested",
    },
    IMPL_PLAN: {
      "Design excellence": "DAG structure is logical and efficient — minimal critical path, appropriate parallelism, clean task boundaries",
      "Architectural cohesion": "Tasks align with the interface and plan structure — no task crosses module boundaries unnecessarily",
      "Vision alignment": "Every task traces to a planned feature or requirement — no gold-plating tasks, no missing tasks for approved interfaces, task priorities reflect the user's stated priorities",
      "Completeness": "Every interface method has a task, every dependency is explicit, every merge point identified",
      "Readiness for execution": "A developer can pick up any ready task and implement it without needing context beyond the task description",
      "Security standards": "Security-critical tasks identified and ordered correctly — auth before features, validation before processing",
      "Operational excellence": "Infrastructure and monitoring tasks included in the DAG — not deferred as afterthoughts",
    },
    IMPLEMENTATION: {
      "Design excellence": "Code is clean, idiomatic, and well-structured — follows SOLID principles, appropriate patterns for the language",
      "Architectural cohesion": "Implementation matches interfaces exactly, follows plan architecture, respects module boundaries",
      "Vision alignment": "Code delivers exactly what the user requested — no feature drift, no missing functionality from the plan, conventions followed, and all upstream artifacts (plan, interfaces, tests) are faithfully realized",
      "Completeness": "All interface methods implemented, all tests passing, no stubs or placeholder code",
      "Readiness for execution": "Code is production-ready — no TODOs, no debug code, no hardcoded values that should be configured",
      "Security standards": "Auth implemented correctly, inputs validated, secrets not hardcoded, error messages don't leak internals",
      "Operational excellence": "Logging at appropriate levels, metrics emitted, health checks work, graceful degradation implemented",
    },
  }

  const dims = descriptions[phase]
  if (!dims || Object.keys(dims).length === 0) return ""

  const lines: string[] = [
    `**Quality criteria (blocking — each scored 1-10, minimum 9/10 to pass):**`,
    `For each [Q] criterion below, provide a numeric \`score\` (1-10) and evidence justifying the score.`,
    `A score below 9 means the criterion is NOT met and the artifact must be improved before advancing.`,
    `Be a harsh critic — 9/10 means excellent with at most minor nits. 10/10 means flawless.`,
    ``,
  ]
  let n = 1
  for (const [dim, desc] of Object.entries(dims)) {
    lines.push(`${n}. [Q] **${dim}** — ${desc}`)
    n++
  }

  return lines.join("\n")
}

/**
 * Returns the structured acceptance criteria checklist for the given phase/mode.
 * These are the exact criteria the agent must evaluate in mark_satisfied.
 *
 * Format: each criterion is a string. The agent maps each to a CriterionResult.
 * Criteria marked [S] are suggestions (non-blocking); all others are blocking.
 * Criteria marked [Q] require a numeric score (1-10) with minimum 9/10.
 */
export function getAcceptanceCriteria(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null): string | null {
  if (phaseState !== "REVIEW") return null

  const qualityBlock = getQualityCriteria(phase)

  switch (phase) {
    case "DISCOVERY":
      if (mode === "REFACTOR") return `### Acceptance Criteria — Conventions Document (Refactor Mode)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (quote or file reference), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

**Blocking criteria (must all pass to advance):**
1. Existing architecture accurately described — module boundaries, key abstractions, data flow
2. Current patterns documented with concrete examples — naming, error handling, test structure, import style
3. Problem areas identified with specific evidence (not vague — must cite actual files/patterns)
4. Target state described for each problem area (what it should look like after refactoring)
5. Migration path is feasible and incremental (not "rewrite everything")
6. Risk areas identified — high coupling, no test coverage, complex state machines

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Contributor patterns from git history noted
- [S] Existing docs (AGENTS.md, CONTRIBUTING.md) incorporated`

      if (mode === "INCREMENTAL") return `### Acceptance Criteria — Conventions Document (Incremental Mode)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (quote or file reference), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

**Blocking criteria (must all pass to advance):**
1. Existing architecture accurately described — module boundaries, dependency directions
2. Naming conventions documented with examples — files, functions, classes, variables, constants
3. Error handling pattern documented — how errors are typed, surfaced, propagated
4. Test conventions documented — framework, file naming, assertion style, mock patterns
5. Import patterns documented — relative vs absolute, barrel files, module aliases
6. File organization documented — where new files of each type should go
7. Existing constraints listed — files/directories that must NOT be touched (from AGENTS.md / CONTRIBUTING.md)

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Git history activity patterns noted (hot files, recent areas of change)
- [S] "DO NOT TOUCH" list explicitly enumerated`

      return null // GREENFIELD skips discovery

    case "PLANNING": return `### Acceptance Criteria — Plan

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence, and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

**Blocking criteria (must all pass to advance):**
1. All user requirements explicitly addressed — nothing from the original request is omitted
2. Scope boundaries explicit — what is in scope AND what is explicitly out of scope
3. Architecture described — components, communication patterns, data flow
4. Error and failure cases specified — what can fail, how failures surface, recovery strategy
5. No "TBD" items — every ambiguity has been resolved with an explicit decision
6. Data model described — key entities, relationships, constraints, lifecycle
7. Integration points identified — external systems, APIs, databases, filesystem interactions

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Non-functional requirements addressed (performance targets, security, scalability)
- [S] Decisions documented with rationale (why this approach over alternatives)`

    case "INTERFACES": return `### Acceptance Criteria — Interfaces & Data Models

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (file path and line), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

**Blocking criteria (must all pass to advance):**
1. Every function/method has input types, output types, and error types — no \`any\`, no missing types
2. Every data model has all fields, their types, optional vs required, and relationships
3. Every enum is fully defined with all valid values
4. Error types are structured — not just \`Error\` strings
5. Naming is consistent with the plan's terminology throughout
6. Consistent error handling pattern across all interfaces
7. CRUD operations: for every data model, create/read/update/delete operations are specified (where applicable)

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Validation constraints specified for inputs with ranges, formats, or invariants
- [S] JSDoc / docstring comments on all public interfaces`

    case "TESTS": return `### Acceptance Criteria — Test Suite

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (test names, counts), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

**Blocking criteria (must all pass to advance):**
1. At least one test per interface method/function
2. Happy path tested for each operation
3. Edge cases covered — empty input, maximum values, null/undefined, boundary conditions
4. Failure modes tested — network errors, invalid data, auth failures, timeouts
5. Tests are expected to FAIL — no implementation has leaked in (verify by inspecting imports and logic)
6. Test descriptions map directly to interface specifications
7. Tests import from interfaces, not from implementations

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Each test is independently runnable (no shared state between tests)
- [S] Concurrency/race condition tests where applicable`

    case "IMPL_PLAN": return `### Acceptance Criteria — Implementation Plan (DAG)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (task IDs, interface names), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

**Blocking criteria (must all pass to advance):**
1. Every interface method is covered by at least one task
2. Task dependencies are correct and acyclic (no circular dependencies)
3. Parallelizable tasks have no shared mutable state (no shared files, no shared DB rows)
4. Merge points explicitly identified where parallel branches converge
5. Expected test outcomes specified per task (which tests become green)

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Complexity estimates assigned per task (small/medium/large)
- [S] Critical path identified through the DAG`

    case "IMPLEMENTATION": return `### Acceptance Criteria — Implementation

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (file paths, test outputs), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

**Blocking criteria (must all pass to advance):**
1. Implementation matches approved interface signatures exactly — no deviations
2. Expected tests for this task pass (run them and report results)
3. No regressions in previously-passing tests
4. No scope creep — only what the plan specifies is implemented
5. Consistent with all prior approved artifacts (plan, interfaces, conventions)

${qualityBlock}

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

  // 4. Blocked tools list (M10 — impl plan §4.6)
  if (state.phase !== "MODE_SELECT" && state.phase !== "DONE") {
    const policy = getPhaseToolPolicy(state.phase, state.phaseState, state.mode, state.fileAllowlist)
    if (policy.blocked.length > 0) {
      blocks.push(`### Blocked Tools\nThe following tool categories are **blocked** in ${state.phase}/${state.phaseState}: ${policy.blocked.map((t) => `\`${t}\``).join(", ")}.\n${policy.allowedDescription}`)
    }
  }

  // 5. At REVIEW state: inject structured acceptance criteria so the agent
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
    lines.push("")
    lines.push("Call `select_mode` with the chosen mode AND a `feature_name`.")
    lines.push("The `feature_name` is **required** — derive a short kebab-case slug from the user's request")
    lines.push("(e.g. 'cloud-cost-platform', 'auth-refactor', 'fix-billing-bug').")
    lines.push("All artifacts will be written to `.openartisan/<feature_name>/`.")
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
      // Inject discovery fleet report reference if available
      if (state.discoveryReport) {
        lines.push("")
        lines.push("### Discovery Fleet Report")
        lines.push("The following was gathered by parallel scanner subagents. Use it as your primary source for the conventions draft.")
        lines.push("")
        const reportPath = state.artifactDiskPaths?.["discovery_report" as keyof typeof state.artifactDiskPaths]
        if (reportPath && existsSync(reportPath as string)) {
          lines.push(`The discovery fleet report is saved at \`${reportPath}\`.`)
          lines.push("**Read this file now** — it contains the full codebase analysis from all 6 scanner subagents.")
        } else {
          // Fallback: inline for sessions pre-dating disk path tracking
          const report = state.discoveryReport
          lines.push(
            report.length > MAX_REPORT_CHARS
              ? report.slice(0, MAX_REPORT_CHARS) + `\n\n[... discovery report truncated at ${MAX_REPORT_CHARS} chars — the .openartisan/${state.featureName ? state.featureName + "/" : ""}discovery-report.md file contains the full report ...]`
              : report,
          )
        }
      }
      break
    case "DRAFT":
      lines.push(`You are drafting the ${state.phase} artifact.`)
      lines.push("When the draft is complete, call `request_review`.")
      // Layer 4: Inject next task from DAG when in IMPLEMENTATION/DRAFT
      if (state.phase === "IMPLEMENTATION" && state.implDag) {
        try {
          const dag = createImplDAG(Array.from(state.implDag))
          const decision = nextSchedulerDecision(dag)
          if (decision.action === "dispatch") {
            lines.push("")
            lines.push("### Next Implementation Task (from approved DAG)")
            lines.push(decision.prompt)
          } else if (decision.action === "complete") {
            lines.push("")
            lines.push(`**DAG status: All tasks complete.** ${decision.message}`)
            lines.push("Call `request_review` now to submit the completed implementation for review.")
          } else if (decision.action === "blocked") {
            lines.push("")
            lines.push("**DAG BLOCKED:** All remaining tasks have incomplete dependencies.")
            lines.push("Call `submit_feedback` to alert the user of the scheduling conflict.")
          }
        } catch (err) {
          // Non-fatal — scheduler failure should not block the DRAFT phase
          lines.push("")
          lines.push(`**Warning:** DAG scheduler error — proceed with manual task ordering. (${err instanceof Error ? err.message : String(err)})`)
        }
      }
      break
    case "REVIEW":
      lines.push("Self-review is in progress.")
      lines.push("Read the acceptance criteria for this phase (listed below) and evaluate each one independently.")
      lines.push("Do NOT assume quality — read the actual files you produced and verify each criterion.")
      lines.push("When evaluation is complete, call `mark_satisfied` with your per-criterion assessment.")
      lines.push("If any blocking criterion is not met, address it first, then call `mark_satisfied` again.")
      lines.push("If a blocking issue is caused by an upstream artifact (e.g. plan, interfaces, conventions),")
      lines.push("note it in the evidence and mark it unmet — it will escalate to the user after repeated failures.")
      // Remind the agent where the artifact lives so it can verify claims
      {
        const artifactKey = state.phase === "DISCOVERY" ? "conventions"
          : state.phase === "PLANNING" ? "plan"
          : state.phase === "IMPL_PLAN" ? "impl-plan"
          : null
        const diskPath = artifactKey ? state.artifactDiskPaths?.[artifactKey as keyof typeof state.artifactDiskPaths] : null
        if (diskPath && existsSync(diskPath as string)) {
          lines.push("")
          lines.push(`**Artifact location:** \`${diskPath}\` — read this file to verify your criteria assessments.`)
          lines.push("Do NOT pass `artifact_content` to `mark_satisfied` — the reviewer reads the file directly.")
        }
      }
      break
    case "USER_GATE":
      if (state.escapePending) {
        lines.push("**ESCAPE HATCH ACTIVE** — A strategic change was detected.")
        lines.push("The escape hatch presentation has been shown to the user.")
        lines.push("**MANDATORY:** Call `submit_feedback` as your FIRST and ONLY tool call with the user's response.")
        lines.push("The user's response is one of: `accept`, a description of alternative direction, or `abort`.")
        lines.push("Do NOT perform any research, analysis, or other tool calls before calling `submit_feedback`.")
        lines.push("Do NOT proceed with any work until the escape hatch is resolved.")
      } else {
        lines.push("The artifact is awaiting user approval.")
        lines.push("")
        lines.push("**MANDATORY PROTOCOL — READ CAREFULLY:**")
        lines.push("1. The user's message IS their response to the artifact.")
        lines.push("2. Your FIRST and ONLY tool call must be `submit_feedback`.")
        lines.push("3. Do NOT do research, searches, analysis, or any other tool calls first.")
        lines.push("4. Do NOT rewrite, improve, or re-review the artifact before routing the feedback.")
        lines.push("5. If the user approves → call `submit_feedback(feedback_type='approve', ...)`.")
        lines.push("6. If the user requests changes → call `submit_feedback(feedback_type='revise', ...)`.")
        lines.push("7. Capture the user's message verbatim in `feedback_text`.")
        lines.push("")
        lines.push("Violating this protocol (doing work before calling `submit_feedback`) corrupts the workflow state.")
      }
      break
    case "REVISE":
      lines.push("You are in REVISE state. Apply the feedback and call `request_review` — no check-ins needed.")
      lines.push("")
      lines.push("**MANDATORY PROTOCOL — REVISE IS AUTONOMOUS:**")
      lines.push("1. Apply ALL feedback points from the last `submit_feedback` call.")
      lines.push("2. Make targeted, incremental changes only. Do NOT rewrite from scratch.")
      lines.push("3. Preserve all prior approved decisions. Only change what the feedback specifically addresses.")
      lines.push("4. When ALL changes are made, call `request_review` with the full revised artifact in `artifact_content`.")
      lines.push("5. Do NOT ask the user for confirmation before calling `request_review`.")
      lines.push("6. Do NOT ask 'Shall I proceed?' or 'Ready to review?' — just call `request_review`.")
      lines.push("7. Do NOT present a summary and wait — finish the work and call the tool.")
      lines.push("")
      lines.push("The next human interaction point is USER_GATE after review passes. Until then, proceed autonomously.")
      break
  }

  return lines.join("\n")
}
