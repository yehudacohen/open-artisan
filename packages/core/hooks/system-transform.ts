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
import { existsSync, readFileSync } from "node:fs"
import type { WorkflowState, Phase, PhaseState, WorkflowMode } from "../types"
import { MAX_CONVENTIONS_CHARS, MAX_REPORT_CHARS } from "../constants"
import { createImplDAG } from "../dag"
import { nextSchedulerDecision } from "../scheduler"
import { getPhaseToolPolicy } from "./tool-guard"
import { countExpectedBlockingCriteria } from "../tools/mark-satisfied"

// ---------------------------------------------------------------------------
// Prompt file loader (cached)
// ---------------------------------------------------------------------------

const PROMPTS_DIR = join(import.meta.dirname, "..", "prompts")

const promptCache = new Map<string, string>()

function loadPrompt(filename: string): string {
  if (promptCache.has(filename)) return promptCache.get(filename)!
  try {
    // Synchronous read — cached after first call so only runs once per prompt file.
    // Uses readFileSync (imported at module level) since Bun.file().text() is async
    // and this function is synchronous by design (called from buildWorkflowSystemPrompt).
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
      "Design excellence": "DAG structure is logical and efficient — minimal critical path, appropriate parallelism, clean task boundaries. Task categories (scaffold/human-gate/integration/standalone) are correctly assigned.",
      "Architectural cohesion": "Tasks align with the interface and plan structure — no task crosses module boundaries unnecessarily. Integration tasks depend on their corresponding scaffold and human-gate tasks.",
      "Vision alignment": "Every task traces to a planned feature or requirement — no gold-plating tasks, no missing tasks for approved interfaces, task priorities reflect the user's stated priorities",
      "Completeness": "Every interface method has a task, every dependency is explicit, every merge point identified. Tasks requiring external services/credentials are split into scaffold → human-gate → integration chains.",
      "Readiness for execution": "A developer can pick up any ready task and implement it without needing context beyond the task description. Human-gate tasks clearly describe what the human must do and how to verify completion.",
      "Security standards": "Security-critical tasks identified and ordered correctly — auth before features, validation before processing",
      "Operational excellence": "Infrastructure and monitoring tasks included in the DAG — not deferred as afterthoughts. Human-gate tasks for infrastructure provisioning are explicitly modeled, not assumed.",
    },
    IMPLEMENTATION: {
      "Design excellence": "Code is clean, idiomatic, and well-structured — follows SOLID principles, appropriate patterns for the language",
      "Architectural cohesion": "Implementation matches interfaces exactly, follows plan architecture, respects module boundaries",
      "Vision alignment": "Code delivers exactly what the user requested — no feature drift, no missing functionality from the plan, conventions followed, and all upstream artifacts (plan, interfaces, tests) are faithfully realized",
      "Completeness": "All interface methods implemented, all tests passing. CRITICAL stub check: scan for functions returning hardcoded values (return 0, return \"\", return [], return ok({})), functions throwing \"not implemented\" / \"TODO\", placeholder credentials (localhost:5432, test-bucket, dummy-api-key), TODO/FIXME/HACK comments, console.log standing in for real logging, empty catch blocks, and conditional test stubs (if NODE_ENV === 'test'). Exception: tasks with category 'scaffold' may contain stubs for methods that will be implemented by a later integration task. All other tasks must have real, functional implementations — not placeholders.",
      "Readiness for execution": "Code is production-ready — no TODOs, no debug code, no hardcoded values that should be configured. Every function contains real logic, not stub returns. Configuration values come from environment or config files, not inline constants.",
      "Security standards": "Auth implemented correctly, inputs validated, secrets not hardcoded (check for literal API keys, passwords, connection strings in source), error messages don't leak internals",
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
 * Builds the design-invariant criteria block for phases that must comply with
 * a user-authored design document. These criteria use the [D] prefix, meaning
 * they are blocking AND non-rebuttable.
 *
 * The block is only generated when a design doc path is provided.
 */
function getDesignInvariantCriteria(phase: Phase, designDocPath: string): string {
  switch (phase) {
    case "PLANNING":
      return `
**Design-invariant criteria [D] (blocking, non-rebuttable — the design document is at \`${designDocPath}\`):**

These criteria verify compliance with the user-authored design document. If the plan deviates
from the design document, the deviation MUST be explicitly documented in a **deviation register**
and presented at the USER_GATE for user approval. Undocumented deviations are a blocking failure.

[D] criteria CANNOT be rebutted in the review loop — they are binary structural questions,
not quality judgments. If the design says X and the plan does Y, that is a deviation regardless
of whether Y is "simpler" or "equivalent."

1. [D] **Design deviation register present.** The plan includes a section titled "Design Deviations" that
   lists every point where the plan deviates from the design document. Each entry classifies the deviation
   as "equivalent" (no guarantee lost), "downgraded" (structural guarantee replaced with procedural check),
   or "deferred" (feature cut). An empty register is valid if the plan fully conforms to the design.
2. [D] **Every structural invariant from the design document is either structurally enforced or registered
   as a deviation.** Read the design document and identify its structural invariants (state machine
   constraints, type system guarantees, required gates). For each invariant, verify it is either
   (a) preserved in the plan, or (b) listed in the deviation register with the correct classification.
3. [D] **No "downgraded" deviations are hidden.** If the plan replaces a structural guarantee with a
   procedural check (e.g., a state machine constraint replaced by a boolean flag), the deviation register
   must classify it as "downgraded" with a risk note — not "equivalent."`

    case "IMPL_PLAN":
      return `
**Design-invariant criteria [D] (blocking, non-rebuttable — design doc at \`${designDocPath}\`):**

1. [D] **DAG tasks preserve approved design deviations.** Every deviation classified in the plan's
   deviation register is accounted for in the task descriptions. No task silently introduces a new
   deviation that wasn't approved in the planning phase.
2. [D] **Structural guarantees map to specific tasks.** Every structural invariant from the design
   document (that was NOT registered as a deviation) has at least one task that implements or
   preserves that guarantee.`

    case "IMPLEMENTATION":
      return `
**Design-invariant criteria [D] (blocking, non-rebuttable — design doc at \`${designDocPath}\`):**

1. [D] **Implementation matches approved deviation register.** Every "downgraded" or "deferred"
   deviation from the plan's register is implemented exactly as approved — no further downgrades
   beyond what was registered.
2. [D] **Structural invariants from the design document are enforced.** For each structural invariant
   that was NOT registered as a deviation, verify it is enforced by a mechanism that cannot be bypassed
   by the agent in a single code change. Examples of structural enforcement: transition tables that
   reject invalid events, type system constraints (union types, branded types), required function
   parameters, exhaustive switch statements. Examples of NON-structural enforcement that should be
   flagged: boolean flags checked by if-statements, comments saying "do not call this", prompt-level
   instructions, runtime assertions that can be deleted. If an invariant uses a non-structural
   mechanism, it must be registered as a "downgraded" deviation.`

    default:
      return ""
  }
}

/**
 * Returns the structured acceptance criteria checklist for the given phase/mode.
 * These are the exact criteria the agent must evaluate in mark_satisfied.
 *
 * Format: each criterion is a string. The agent maps each to a CriterionResult.
 * Criteria marked [S] are suggestions (non-blocking); all others are blocking.
 * Criteria marked [Q] require a numeric score (1-10) with minimum 9/10.
 * Criteria marked [D] are design-invariant (blocking + non-rebuttable) — only
 * injected when a design document is present (designDocPath is non-null).
 *
 * @param designDocPath  Absolute path to the design document, or null/undefined if none.
 *   When set, [D] design-invariant criteria are appended to PLANNING, IMPL_PLAN,
 *   and IMPLEMENTATION phases.
 */
/**
 * Returns a preview of the acceptance criteria for authoring states (DRAFT, CONVENTIONS, REVISE).
 * The agent sees these while drafting so it knows what the reviewer will evaluate.
 * Returns null for states where criteria preview is not applicable.
 */
export function getAcceptanceCriteriaPreview(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null, designDocPath?: string | null): string | null {
  // Only inject during authoring states — not REVIEW (which gets the full criteria),
  // and not USER_GATE/ESCAPE_HATCH/SCAN/ANALYZE (where criteria aren't actionable).
  if (phaseState !== "DRAFT" && phaseState !== "CONVENTIONS" && phaseState !== "REVISE") return null

  // Get the full criteria text (pass "REVIEW" to get the content)
  const fullCriteria = getAcceptanceCriteria(phase, "REVIEW", mode, designDocPath)
  if (!fullCriteria) return null

  // Re-frame: the authoring agent should use criteria as a checklist, not evaluate them
  return `### Acceptance Criteria Preview — What the Reviewer Will Evaluate

The following criteria will be used by the isolated reviewer when you call \`request_review\`.

**Important:** The reviewer is intentionally rigorous — it evaluates each criterion strictly because
catching issues now prevents costly rework during implementation. This front-loaded effort is by design.

**Before calling \`request_review\`:**
1. Self-evaluate your artifact against EVERY criterion below
2. For each criterion, ask: "Would a strict reviewer accept this?"
3. Fix any weaknesses you find — the reviewer will catch them otherwise
4. Only submit when you're confident all blocking criteria are met

**When the reviewer gives feedback:**
- Be receptive — strict review produces better artifacts
- Iterate on specific issues rather than arguing the reviewer is wrong
- However: push back if the reviewer asks for work that is explicitly planned for a LATER
  phase (e.g., implementation details during PLANNING) or is structurally covered by the
  workflow's state machine (e.g., the next phase will enforce what the reviewer is asking for)

${fullCriteria.replace(/^### Acceptance Criteria/m, "### Criteria")}`
}

export function getAcceptanceCriteria(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null, designDocPath?: string | null): string | null {
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

    case "PLANNING": {
      const designBlock = designDocPath ? getDesignInvariantCriteria("PLANNING", designDocPath) : ""
      const allowlistBlock = mode === "INCREMENTAL"
        ? "9. [INCREMENTAL] Allowlist adequacy reviewed — fileAllowlist covers all remaining phases (or explicitly justified)"
        : ""
      return `### Acceptance Criteria — Plan

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence, and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.
${designDocPath ? "For [D] design-invariant criteria, these are BINARY (met/not met) and CANNOT be rebutted." : ""}

**Blocking criteria (must all pass to advance):**
1. All user requirements explicitly addressed — nothing from the original request is omitted. If a design document or detailed spec exists, the plan must include its substantive content (specific requirements, formulas, interaction sequences, data schemas, constraints), not merely reference the spec by name. A plan that says "details in the spec" without capturing those details is incomplete.
2. Scope boundaries explicit — what is in scope AND what is explicitly out of scope
3. Architecture described — components, communication patterns, data flow
4. Error and failure cases specified — what can fail, how failures surface, recovery strategy
5. No "TBD" items — every ambiguity has been resolved with an explicit decision
6. Data model described — key entities, relationships, constraints, lifecycle
7. Integration points identified — external systems, APIs, databases, filesystem interactions. For adapters or plugins that wrap an existing protocol: enumerate every protocol method/event and confirm each is either handled or explicitly out of scope with justification. Cross-reference the protocol spec or reference implementations to avoid silent omissions
8. Deployment & infrastructure addressed — how the feature reaches production (infrastructure provisioning, credentials/secrets, environment configuration, CI/CD changes, DNS/routing). If no deployment is needed, this must be explicitly stated with justification. Plans that produce working code but ignore deployment are incomplete.
${allowlistBlock}
[If the artifact is a pass-through:] Does the justification for why this phase is low-value hold up? Is the reason specific and verifiable, not vague? Would a reasonable engineer agree? Is the agent being lazy?
No functionality duplicated from existing codebase or installed dependencies, and no well-supported open source package overlooked for the problem being solved. If building custom, justification must be stated explicitly.

${qualityBlock}
${designBlock}

9. User journey completeness — Walk through the end user's experience from installation through daily use: setup/onboarding, configuration, all expected operational modes (including automation/unattended), error recovery, documentation, and integration with the user's existing workflow (version control, CI/CD, tooling). List any capability a reasonable user would expect from a solution like this that is not planned, and justify each omission. If reference implementations or competing solutions exist, compare feature sets and justify gaps. This criterion applies to all projects — libraries, adapters, plugins, services, and applications.

**Suggestion criteria (non-blocking):**
- [S] Non-functional requirements addressed (performance targets, security, scalability)
- [S] Decisions documented with rationale (why this approach over alternatives)`
    }

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
[If the artifact is a pass-through:] Does the justification for why this phase is low-value hold up? Is the reason specific and verifiable, not vague? Would a reasonable engineer agree? Is the agent being lazy?

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
[If the artifact is a pass-through:] Does the justification for why this phase is low-value hold up? Is the reason specific and verifiable, not vague? Would a reasonable engineer agree? Is the agent being lazy?

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Each test is independently runnable (no shared state between tests)
- [S] Concurrency/race condition tests where applicable`

    case "IMPL_PLAN": {
      const designBlock = designDocPath ? getDesignInvariantCriteria("IMPL_PLAN", designDocPath) : ""
      return `### Acceptance Criteria — Implementation Plan (DAG)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (task IDs, interface names), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.
${designDocPath ? "For [D] design-invariant criteria, these are BINARY (met/not met) and CANNOT be rebutted." : ""}

**Blocking criteria (must all pass to advance):**
1. Every interface method is covered by at least one task
2. Task dependencies are correct and acyclic (no circular dependencies)
3. Parallelizable tasks have no shared mutable state (no shared files, no shared DB rows)
4. Merge points explicitly identified where parallel branches converge
5. Expected test outcomes specified per task (which tests become green)
6. Deployment tasks present — if the approved plan includes deployment/infrastructure requirements, the DAG must include corresponding human-gate tasks for provisioning and credentials, and integration tasks that verify deployment. A DAG that implements all code but omits deployment is incomplete.
7. Integration seams covered — for every pair of tasks with a dependency edge, the handoff is explicitly owned. Check: who creates/configures the shared resource (queue, table, DI binding, config entry)? Who writes the glue code that connects producer to consumer? If the answer is ambiguous or "the other task," add an explicit integration task or expand one of the existing tasks to own it. No task should assume adjacent tasks handle boundary wiring.
8. Protocol/API completeness — for adapter, plugin, or integration projects: every method, event, or lifecycle hook in the target protocol that affects correctness must be accounted for. Cross-reference the protocol definition (API docs, reference implementations, or protocol spec) and verify no required calls are omitted. If a protocol method used by reference implementations is intentionally skipped, the omission must be explicitly justified (e.g. "compaction not needed because X manages context internally"). Uncaught omissions here become structural bugs that surface late.
[If the artifact is a pass-through:] Does the justification for why this phase is low-value hold up? Is the reason specific and verifiable, not vague? Would a reasonable engineer agree? Is the agent being lazy?

${qualityBlock}
${designBlock}

**Suggestion criteria (non-blocking):**
- [S] Complexity estimates assigned per task (small/medium/large)
- [S] Critical path identified through the DAG`
    }

    case "IMPLEMENTATION": {
      const designBlock = designDocPath ? getDesignInvariantCriteria("IMPLEMENTATION", designDocPath) : ""
      return `### Acceptance Criteria — Implementation

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (file paths, test outputs), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.
${designDocPath ? "For [D] design-invariant criteria, these are BINARY (met/not met) and CANNOT be rebutted." : ""}

**Blocking criteria (must all pass to advance):**
1. Implementation matches approved interface signatures exactly — no deviations
2. Expected tests for this task pass (run them and report results)
3. No regressions in previously-passing tests
4. No scope creep — only what the plan specifies is implemented
5. Consistent with all prior approved artifacts (plan, interfaces, conventions)
6. No reimplementation of existing utils, dependency capabilities, or functions that exist elsewhere in the codebase
7. If the artifact proposes or builds custom code, is there a well-supported open source package that would have been a better choice? (Consider: maintenance burden, community support, feature completeness)
8. Documentation complete — every user-facing feature, configuration option, and operational mode has documentation (README, inline help, or equivalent). Failure modes and recovery procedures are documented. If a feature exists in code but is not documented, it is not shippable.
9. Test coverage for new code — any functionality added during IMPLEMENTATION that was not in the original TESTS phase must have corresponding tests. Setup scripts, new tools, new dispatch paths, and new error handling all require tests. Untested code paths are not shippable.
[If the artifact is a pass-through:] Does the justification for why this phase is low-value hold up? Is the reason specific and verifiable, not vague? Would a reasonable engineer agree? Is the agent being lazy?

${qualityBlock}
${designBlock}

**Suggestion criteria (non-blocking):**
- [S] Code follows existing naming and style conventions
- [S] No dead code or unnecessary complexity introduced`
    }

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

  // 2b. Design document constraint block (if a design doc is tracked)
  const designDocPath = state.artifactDiskPaths?.design ?? null
  if (designDocPath && (state.phase === "PLANNING" || state.phase === "IMPL_PLAN" || state.phase === "IMPLEMENTATION")) {
    blocks.push(
      `### Design Document — Mandatory Constraint\n\n` +
      `A user-authored design document is tracked at \`${designDocPath}\`.\n` +
      `Read this document before drafting. It defines structural invariants that the ` +
      `${state.phase === "PLANNING" ? "plan" : state.phase === "IMPL_PLAN" ? "implementation plan" : "implementation"} ` +
      `must comply with.\n\n` +
      (state.phase === "PLANNING"
        ? `**You MUST include a "Design Deviations" section** in the plan that lists every point ` +
          `where the plan deviates from the design document. Each deviation must be classified as:\n` +
          `- **equivalent** — no structural guarantee lost (different approach, same protection)\n` +
          `- **downgraded** — structural guarantee replaced with a procedural check (with risk note)\n` +
          `- **deferred** — feature/guarantee cut from this iteration\n\n` +
          `An empty deviation register is valid if the plan fully conforms to the design. ` +
          `The deviation register will be presented to the user at the approval gate.`
        : `The plan's "Design Deviations" register (if present) defines approved deviations. ` +
          `Do not introduce new deviations beyond what was approved in the plan.`),
    )
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

  // 5. Acceptance criteria injection:
  //    - At REVIEW: full structured criteria so the agent knows what to evaluate for mark_satisfied.
  //    - At DRAFT/CONVENTIONS/REVISE: criteria preview so the agent knows what to satisfy before submitting.
  //    If a design doc is tracked, [D] criteria are injected for design compliance.
  const criteria = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, designDocPath)
  if (criteria) {
    blocks.push(criteria)
    // Inject the expected blocking criteria count so the agent knows exactly
    // how many assessments to provide in mark_satisfied. Without this, the
    // agent has to count numbered lines manually and often gets it wrong,
    // wasting review iterations.
    const expectedCount = countExpectedBlockingCriteria(criteria)
    if (expectedCount > 0) {
      blocks.push(
        `**Required:** You must provide exactly **${expectedCount}** blocking criteria assessments ` +
        `when calling \`mark_satisfied\`. Each must have \`criterion\`, \`met\` (boolean), ` +
        `\`evidence\` (specific quote or file reference), and \`severity: "blocking"\`.`
      )
    }
  }
  const criteriaPreview = getAcceptanceCriteriaPreview(state.phase, state.phaseState, state.mode, designDocPath)
  if (criteriaPreview) {
    blocks.push(criteriaPreview)
  }

  return blocks.join("\n\n")
}

/**
 * Builds a context block for Task subagent sessions that inherit a parent's
 * workflow state. Provides the subagent with:
 *
 *   - Current phase/mode/feature context (so it knows WHERE it is in the workflow)
 *   - Artifact disk paths (so it can read conventions, interfaces, tests, plan)
 *   - Mode constraints (INCREMENTAL allowlist, REFACTOR conventions, etc.)
 *   - Full DAG with task statuses (so it can see what's done and what's pending)
 *   - Tool restrictions (workflow tools are blocked; file writes follow parent policy)
 *   - Instructions on how to report completion (back to parent, not via workflow tools)
 *
 * Does NOT include: workflow tool descriptions, acceptance criteria, review
 * instructions, or sub-state routing hints — those are parent-only concerns.
 *
 * Pure function — does NOT mutate anything.
 */
export function buildSubagentContext(parentState: WorkflowState): string {
  const lines: string[] = []

  lines.push("---")
  lines.push("## WORKFLOW CONTEXT — SUBAGENT SESSION")
  lines.push("")
  lines.push("You are a **Task subagent** working within a structured workflow.")
  lines.push("The parent session manages workflow state — you focus on implementation work.")
  lines.push("")
  lines.push(`**Phase:** ${parentState.phase} / **Sub-state:** ${parentState.phaseState}`)
  lines.push(`**Mode:** ${parentState.mode ?? "not yet selected"}`)
  if (parentState.featureName) {
    lines.push(`**Feature:** ${parentState.featureName}`)
  }
  lines.push("")

  // Mode constraints
  if (parentState.mode === "INCREMENTAL") {
    lines.push("### Do-No-Harm Directive (INCREMENTAL mode)")
    lines.push("- Modify ONLY files in the approved allowlist")
    lines.push("- Do NOT refactor outside the requested scope")
    lines.push("- Follow existing conventions exactly — your code must be indistinguishable from existing code")
    lines.push("- All existing tests must continue to pass")
    lines.push("- Do NOT use bash to write/modify files — use write/edit tools only")
    lines.push("")
    if (parentState.fileAllowlist.length > 0) {
      lines.push("**Approved file allowlist:**")
      for (const f of parentState.fileAllowlist) {
        lines.push(`  - ${f}`)
      }
      lines.push("")
    }
  } else if (parentState.mode === "REFACTOR") {
    lines.push("### Refactor Mode Constraints")
    lines.push("- Follow the target patterns from the conventions document")
    lines.push("- All existing tests must pass after each change")
    lines.push("")
  }

  // Conventions reference
  if (parentState.conventions && parentState.mode !== "GREENFIELD") {
    const conventionsPath = parentState.artifactDiskPaths?.["conventions"]
    lines.push("### Conventions Document")
    lines.push("The following conventions are MANDATORY. Treat them as hard requirements.")
    lines.push("")
    if (conventionsPath && existsSync(conventionsPath)) {
      lines.push(`Read the conventions document at \`${conventionsPath}\` before starting any work.`)
    } else {
      const text = parentState.conventions.length > MAX_CONVENTIONS_CHARS
        ? parentState.conventions.slice(0, MAX_CONVENTIONS_CHARS) + "\n\n[... truncated ...]"
        : parentState.conventions
      lines.push(text)
    }
    lines.push("")
  }

  // Artifact disk paths — so the subagent can reference upstream artifacts
  const pathEntries = Object.entries(parentState.artifactDiskPaths).filter(([, v]) => v)
  if (pathEntries.length > 0) {
    lines.push("### Upstream Artifacts (on disk)")
    lines.push("Reference these approved artifacts while working:")
    lines.push("")
    for (const [key, path] of pathEntries) {
      lines.push(`- **${key}**: \`${path}\``)
    }
    lines.push("")
  }

  // DAG status — full task list with current statuses
  if (parentState.implDag && parentState.implDag.length > 0) {
    const tasks = parentState.implDag
    const complete = tasks.filter((t) => t.status === "complete").length
    const total = tasks.length
    lines.push(`### Implementation DAG (${complete}/${total} complete)`)
    lines.push("")
    lines.push("| Task | Status | Description | Expected Tests |")
    lines.push("|------|--------|-------------|----------------|")
    for (const t of tasks) {
      const statusIcon =
        t.status === "complete" ? "DONE" :
        t.status === "in-flight" ? "IN-FLIGHT" :
        t.status === "aborted" ? "ABORTED" :
        t.status === "delegated" ? "DELEGATED" :
        t.status === "human-gated" ? "HUMAN-GATED" :
        "PENDING"
      const tests = t.expectedTests.length > 0 ? t.expectedTests.join(", ") : "—"
      const desc = t.description.length > 80 ? t.description.slice(0, 77) + "..." : t.description
      lines.push(`| ${t.id} | ${statusIcon} | ${desc} | ${tests} |`)
    }
    lines.push("")
  }

  // Phase-specific instructions (implementation.txt content)
  if (parentState.phase === "IMPLEMENTATION") {
    const promptFile = getPhasePromptFilename(parentState.phase, parentState.mode)
    if (promptFile) {
      lines.push(loadPrompt(promptFile))
      lines.push("")
    }
  }

  // Tool restrictions
  lines.push("### Subagent Tool Restrictions")
  lines.push("")
  lines.push("You **cannot** call workflow control tools (`mark_task_complete`, `request_review`,")
  lines.push("`submit_feedback`, `select_mode`, `mark_satisfied`, etc.). Only the parent session")
  lines.push("manages workflow state transitions.")
  lines.push("")
  lines.push("You **can** use all other tools (read, write, edit, bash, glob, grep, etc.)")
  lines.push("subject to the mode constraints above.")
  lines.push("")
  lines.push("### Reporting Completion")
  lines.push("")
  lines.push("When you finish your assigned work:")
  lines.push("1. Ensure all relevant tests pass (run them with bash)")
  lines.push("2. Report what you implemented, which files were created/modified, and test results")
  lines.push("3. The parent session will call `mark_task_complete` for each finished task")
  lines.push("")
  lines.push("---")

  return lines.join("\n")
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
      lines.push("Continue immediately in this turn; do not wait for user input.")
      lines.push("When finished, call `mark_scan_complete`.")
      break
    case "ANALYZE":
      lines.push("You are analyzing the scan results. Synthesize your findings.")
      lines.push("Continue immediately in this turn; do not wait for user input.")
      lines.push("When analysis is complete, call `mark_analyze_complete` to transition to CONVENTIONS state.")
      lines.push("Do NOT start drafting until you have called `mark_analyze_complete`.")
      break
    case "CONVENTIONS":
      lines.push("You are drafting the conventions document.")
      lines.push("Continue immediately in this turn; do not wait for user input.")
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
      lines.push("If you discover a fundamental flaw in an earlier phase's artifact that cannot be addressed here, call `propose_backtrack`.")
      // Layer 4: Inject next task from DAG when in IMPLEMENTATION/DRAFT
      if (state.phase === "IMPLEMENTATION" && !state.implDag) {
        // No DAG available — point the agent to the plan artifacts for context.
        // This happens when IMPL_PLAN was approved without artifact_content
        // (e.g. pass-through in INCREMENTAL mode).
        lines.push("")
        lines.push("**No task DAG available** — implement according to the approved plan.")
        const planPath = state.artifactDiskPaths?.["plan"]
        const implPlanPath = state.artifactDiskPaths?.["impl_plan"]
        if (implPlanPath && existsSync(implPlanPath)) {
          lines.push(`Read the implementation plan at \`${implPlanPath}\` for task details.`)
        } else if (planPath && existsSync(planPath)) {
          lines.push(`Read the plan at \`${planPath}\` for implementation details.`)
        }
        lines.push("Implement all tasks described in the plan, then call `request_review`.")
      }
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
            if (decision.blockedTasks.length > 0) {
              // DAG state inconsistency — tasks have unresolvable dependencies
              lines.push("**DAG BLOCKED:** All remaining tasks have incomplete dependencies.")
              lines.push("Call `submit_feedback` to alert the user of the scheduling conflict.")
            } else {
              // Waiting for active work (in-flight tasks or delegated sub-workflows)
              lines.push(`**Waiting:** ${decision.message}`)
            }
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
    case "ESCAPE_HATCH":
      lines.push("**ESCAPE HATCH ACTIVE** — A strategic change was detected.")
      lines.push("The escape hatch presentation has been shown to the user.")
      lines.push("**MANDATORY:** Call `submit_feedback` as your FIRST and ONLY tool call with the user's response.")
      lines.push("The user's response is one of: `accept`, a description of alternative direction, or `abort`.")
      lines.push("Do NOT perform any research, analysis, or other tool calls before calling `submit_feedback`.")
      lines.push("Do NOT proceed with any work until the escape hatch is resolved.")
      break
    case "USER_GATE":
      {
        lines.push("The artifact is awaiting user approval.")
        lines.push("")
        lines.push("**MANDATORY PROTOCOL — READ CAREFULLY:**")
        lines.push("1. If the user's message is artifact feedback (approval, revision requests, or comments about the artifact):")
        lines.push("   a. Your FIRST and ONLY tool call must be `submit_feedback`.")
        lines.push("   b. Do NOT do research, searches, analysis, or any other tool calls first.")
        lines.push("   c. Do NOT rewrite, improve, or re-review the artifact before routing the feedback.")
        lines.push("   d. If the user approves → call `submit_feedback(feedback_type='approve', ...)`.")
        lines.push("   e. If the user requests changes → call `submit_feedback(feedback_type='revise', ...)`.")
        lines.push("   f. Capture the user's message verbatim in `feedback_text`.")
        lines.push("2. If the user's message is casual conversation, a question, or meta-discussion NOT about the artifact:")
        lines.push("   Simply respond conversationally. Do NOT call `submit_feedback`. The user can chat with you without every message being treated as artifact feedback.")
        lines.push("   Examples: asking about your experience, discussing the project generally, asking clarifying questions.")
        lines.push("")
        lines.push("Routing non-feedback messages through `submit_feedback` corrupts the workflow state.")
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
      lines.push("If the revision reveals a fundamental upstream problem, call `propose_backtrack` instead of trying to fix it in-place.")
      break
  }

  return lines.join("\n")
}
