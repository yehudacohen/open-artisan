import type { TaskCategory } from "./dag"
import type { Phase, PhaseState, WorkflowMode } from "./workflow-primitives"

function getQualityCriteria(phase: Phase): string {
  const descriptions: Record<Phase, Record<string, string>> = {
    MODE_SELECT: {} as Record<string, string>,
    DONE: {} as Record<string, string>,
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
      "Completeness": "Every applicable interface method tested, relevant error paths covered, and edge cases considered without requiring unrelated failure classes",
      "Readiness for execution": "Tests will compile and run (expect failures) once implementations exist — no missing setup or imports",
      "Security standards": "Security-relevant boundaries for this feature are tested where applicable — auth/privilege tests are not required for features that introduce no auth or privilege boundary",
      "Operational excellence": "Operational behavior is tested where applicable — logs, retries, and timeouts are not required for features that introduce no logging, retry, or timeout behavior",
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
    `Use the full 1-10 range honestly. Reward excellence just as clearly as you punish flaws — do not compress scores into a narrow band.`,
    `Scoring guide: 1-2 = fundamentally broken, 3-4 = major gaps, 5-6 = mixed/adequate but clearly incomplete, 7-8 = strong with meaningful improvement still needed, 9 = excellent and ready to advance, 10 = exceptional work that materially exceeds the normal quality bar for this phase.`,
    ``,
  ]
  let n = 1
  for (const [dim, desc] of Object.entries(dims)) {
    lines.push(`${n}. [Q] **${dim}** — ${desc}`)
    n++
  }

  return lines.join("\n")
}

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

export function getPhaseStructuralGate(phase: Phase): string {
  const uncertaintyGate = " If multiple viable approaches exist, the artifact must make a decision, document the alternatives considered, and explain tradeoffs/risks so the choice can be presented at USER_GATE; unresolved ambiguity is a blocking failure."
  switch (phase) {
    case "PLANNING":
      return "**Bespoke structural gate — Plan review:** verify the artifact owns structure, wiring, and integration decisions explicitly. Architecture boundaries, protocol/API coverage, deployment/infrastructure, user journey, failure modes, and every integration seam must be concrete enough that later phases cannot silently invent or omit them." + uncertaintyGate
    case "INTERFACES":
      return "**Bespoke structural gate — Interfaces review:** verify the reviewed artifacts are real source contracts and that structure is encoded in types/schemas/APIs, not prose. Contracts must include lifecycle/configuration/error boundaries and enough wiring surface for tests and implementation to connect components without guessing." + uncertaintyGate
    case "TESTS":
      return "**Bespoke structural gate — Tests review:** verify the reviewed artifacts are runnable tests that exercise behavior through the intended public/runtime seams. Tests must catch missing wiring, integration boundary drift, and helper-only implementations, not merely assert isolated helpers exist." + uncertaintyGate
    case "IMPL_PLAN":
      return "**Bespoke structural gate — Implementation-plan review:** verify the DAG makes structure and wiring executable. Every task must own clear files, dependencies, handoffs, task category, expected tests, and any scaffold → human-gate → integration chain needed for real runtime completion." + uncertaintyGate
    case "IMPLEMENTATION":
      return "**Bespoke structural gate — Implementation review:** verify the shipped runtime is wired end-to-end. Helpers, adapters, guards, clients, bridge paths, docs, tests, and dogfood evidence must agree with the approved scope; half-integrated shared paths fail even if isolated unit tests pass." + uncertaintyGate
    default:
      return "**Bespoke structural gate — Self-review:** inspect actual artifacts and file evidence, not intent. If structure, wiring, or integration claims cannot be verified from files or command output, mark the criterion unmet." + uncertaintyGate
  }
}

export function getAcceptanceCriteriaPreview(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null, designDocPath?: string | null): string | null {
  if (phaseState !== "DRAFT" && phaseState !== "CONVENTIONS" && phaseState !== "REVISE") return null

  const fullCriteria = buildPhaseAcceptanceCriteria(phase, mode, designDocPath)
  if (!fullCriteria) return null

  return `### Required Review Rubric / Acceptance Criteria Preview — What the Reviewer Will Evaluate

The following required review rubric will be used by the isolated reviewer when you call \`request_review\`.
Treat it as the implementation contract for this phase, not optional guidance.

**Important:** The reviewer is intentionally rigorous — it evaluates each criterion strictly because
catching issues now prevents costly rework during implementation. This front-loaded effort is by design.

**Before calling \`request_review\`:**
1. Self-evaluate your artifact against EVERY criterion below
2. For each criterion, ask: "Would a strict reviewer accept this?"
3. Fix any weaknesses you find — the reviewer will catch them otherwise
4. Only submit when you're confident all blocking criteria are met

**When the reviewer gives feedback:**
- Be receptive — strict review produces better artifacts
- Iterate on specific issues when they align with the current approved user intent
- Push back when reviewer feedback resurrects requirements the user explicitly superseded,
  conflicts with later approved feedback, or asks for a different product direction than the
  one currently approved
- However: push back if the reviewer asks for work that is explicitly planned for a LATER
  phase (e.g., implementation details during PLANNING) or is structurally covered by the
  workflow's state machine (e.g., the next phase will enforce what the reviewer is asking for)

${fullCriteria.replace(/^### Acceptance Criteria/m, "### Criteria")}`
}

export function buildPhaseAcceptanceCriteria(phase: Phase, mode: WorkflowMode | null, designDocPath?: string | null): string | null {
  const qualityBlock = getQualityCriteria(phase)
  const structuralGate = getPhaseStructuralGate(phase)

  switch (phase) {
    case "DISCOVERY":
      if (mode === "REFACTOR") return `### Acceptance Criteria — Conventions Document (Refactor Mode)

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (quote or file reference), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

${structuralGate}

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

${structuralGate}

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

      return null

    case "PLANNING": {
      const designBlock = designDocPath ? getDesignInvariantCriteria("PLANNING", designDocPath) : ""
      const allowlistBlock = mode === "INCREMENTAL"
        ? "9. [INCREMENTAL] Allowlist adequacy reviewed — the approved file allowlist covers every file named by the plan, every component/seam the plan says will change, and every likely implementation/test file needed for those changes. Missing plausible files for stated work is blocking unless the plan explicitly narrows that work out of scope."
        : ""
      return `### Acceptance Criteria — Plan

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence, and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.
${designDocPath ? "For [D] design-invariant criteria, these are BINARY (met/not met) and CANNOT be rebutted." : ""}

${structuralGate}

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

${structuralGate}

**Blocking criteria (must all pass to advance):**
1. Reviewed artifacts are real interface/type/schema files in the project source tree — not markdown planning/design documents and not files under .openartisan/
2. Every function/method has input types, output types, and error types — no \`any\`, no missing types
3. Every data model has all fields, their types, optional vs required, and relationships
4. Every enum is fully defined with all valid values
5. Error types are structured — not just \`Error\` strings
6. Naming is consistent with the plan's terminology throughout
7. Consistent error handling pattern across all interfaces
8. CRUD operations: for every data model, create/read/update/delete operations are specified (where applicable)
[If the artifact is a pass-through:] Does the justification for why this phase is low-value hold up? Is the reason specific and verifiable, not vague? Would a reasonable engineer agree? Is the agent being lazy?

${qualityBlock}

**Suggestion criteria (non-blocking):**
- [S] Validation constraints specified for inputs with ranges, formats, or invariants
- [S] JSDoc / docstring comments on all public interfaces`

    case "TESTS": return `### Acceptance Criteria — Test Suite

Evaluate each criterion independently. For each, state whether it is met (true/false),
provide specific evidence (test names, counts), and mark severity (blocking/suggestion).
For [Q] quality criteria, provide a score from 1 to 10. Minimum passing score is 9/10.

${structuralGate}

**Blocking criteria (must all pass to advance):**
1. Reviewed artifacts are real runnable test/spec files in the project test/source tree — not markdown test plans and not files under .openartisan/
2. At least one test per interface method/function
3. Happy path tested for each operation
4. Edge cases covered where applicable — empty input, maximum values, null/undefined, boundary conditions. Do not require irrelevant edge classes; score N/A as satisfied when the artifact or approved plan explains why they do not apply.
5. Failure modes tested where applicable — invalid data, network errors, auth failures, timeouts. Do not require network/auth/timeout tests for local-only features that introduce no network, auth, or timeout behavior; instead verify the relevant failure modes named by the interfaces/plan.
6. Tests are expected to FAIL — no implementation has leaked in (verify by inspecting imports and logic)
7. Test descriptions map directly to interface specifications
8. Tests import from interfaces, not from implementations
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

${structuralGate}

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

${structuralGate}

**Blocking criteria (must all pass to advance):**
1. Implementation matches approved interface signatures exactly — no deviations
2. Expected tests for this task pass (run them and report results)
3. No regressions in previously-passing tests
4. No scope creep — only what the plan specifies is implemented
5. Consistent with all prior approved artifacts (plan, interfaces, conventions)
6. No reimplementation of existing utils, dependency capabilities, or functions that exist elsewhere in the codebase
7. If the artifact proposes or builds custom code, is there a well-supported open source package that would have been a better choice? (Consider: maintenance burden, community support, feature completeness)
8. No placeholder tests for claimed-complete scope — tests covering the current scope must be real and runnable, not TODOs, pending/skipped placeholders, or assertions that only prove a helper exists. If the implementation claims a runtime behavior is complete, the tests must exercise that runtime behavior.
9. No helper-only or half-integrated implementations — shared infrastructure, helper utilities, bridge/adapter plumbing, and client-facing entry points must be wired into real runtime call sites for the claimed scope. A helper added without the corresponding runtime integration fails review unless the task is explicitly scoped as scaffold-only.
10. No partial client integration for shared runtime paths — when the implementation claims support for shared infrastructure or multi-client behavior, every claimed client/adapter path must be integrated, or any omitted path must be explicitly documented as out of scope in the approved artifacts. Half-integrated shared paths are not shippable.
11. Documentation complete — every user-facing feature, configuration option, operational mode, and client/runtime behavior has documentation (README, inline help, or equivalent). Failure modes and recovery procedures are documented. If a feature exists in code but is not documented, it is not shippable.
12. Test coverage for new code — any functionality added during IMPLEMENTATION that was not in the original TESTS phase must have corresponding tests. Setup scripts, new tools, new dispatch paths, and new error handling all require tests. Untested code paths are not shippable.
13. No duplicated policy or gate logic without justification — workflow policy, guard behavior, approval routing, and client/runtime safety rules should have a single authoritative implementation unless duplication is explicitly necessary and justified. Copy-pasted policy logic that can drift is a blocking defect.
 14. Autonomous runtime claims must be operationally true — if the implementation claims an agent/plugin/runtime can continue work autonomously, it must keep progressing between runnable non-gated states without requiring manual reinvocation, and stop only at truthful gates, explicit safety stops, or real runtime failures. If autonomy depends on a specific launch or resume path, that path must be documented and verified.
 15. Dogfooding/runtime verification present for integration-heavy work — for adapter, plugin, bridge, session, or multi-client runtime changes, review must include evidence from the actual execution surface being changed (for example the real driver plugin/session path, fresh process attach/resume behavior, or gateway delivery path), not only unit seams or mocked helpers.
 16. Docs and shipped runtime behavior are aligned after revise cycles — if implementation changed the runtime architecture, class names, launch path, or operational semantics, all user/developer docs and gap-analysis docs must describe the currently shipped behavior, not an earlier draft or transitional design.
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

export function getAcceptanceCriteria(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null, designDocPath?: string | null): string | null {
  if (phaseState !== "REVIEW") return null
  return buildPhaseAcceptanceCriteria(phase, mode, designDocPath)
}

export function buildSelfReviewStructuralGate(phase: Phase): string {
  return `## Bespoke Structural Review Gate\n${getPhaseStructuralGate(phase)}\n\nUse this as an additional lens while evaluating the acceptance criteria. Do not add new criteria unless the artifact fails this gate; instead, cite the closest acceptance criterion and mark it unmet with structural evidence.`
}

export function getTaskReviewCheckCountLabel(hasAdjacentTasks: boolean): string {
  return hasAdjacentTasks ? "ten" : "nine"
}

export function buildTaskReviewRubric(input: { taskCategory?: TaskCategory; hasAdjacentTasks: boolean }): string {
  const taskCategory = input.taskCategory ?? "standalone"
  const stubsAcceptable = taskCategory === "scaffold"
  const lines: string[] = []

  lines.push("## Review Instructions")
  lines.push("")
  lines.push("Perform the following checks:")
  lines.push("")
  lines.push("1. **Run the tests.** Find and run the project's test suite (check package.json, Makefile, or equivalent")
  lines.push("   for the test command). If specific expected tests are listed above, run those. Report the results.")
  lines.push("2. **Verify interface alignment.** Read the approved interfaces/types and verify the implementation")
  lines.push("   matches the signatures exactly — no missing methods, no extra methods, correct types.")
  lines.push("3. **Check for regressions.** Run the full test suite (not just this task's tests) and confirm")
  lines.push("   no previously-passing tests are now failing.")
  lines.push("4. **Check conventions alignment.** If conventions are available, verify the implementation follows")
  lines.push("   naming, error handling, and structural patterns.")
  lines.push("5. **Reject placeholder tests for claimed-complete scope.** If the task adds or updates tests for")
  lines.push("   the behavior it claims to complete, verify they are real tests of runtime behavior — not TODOs,")
  lines.push("   skipped/pending placeholders, or assertions that only prove helpers exist.")
  lines.push("6. **Stub/placeholder detection.** Scan the implementation for:")
  lines.push("   - Functions that return hardcoded values (`return 0`, `return \"\"`, `return []`, `return ok({})`, `return { rowsCopied: 0 }`)")
  lines.push("   - Functions that only throw `\"not implemented\"`, `\"TODO\"`, or similar sentinel errors")
  lines.push("   - Placeholder credentials (`localhost:5432`, `test-bucket`, `dummy-api-key`, `xxx`, `changeme`)")
  lines.push("   - Comments indicating deferred work: `TODO`, `FIXME`, `HACK`, `in production we would...`, `placeholder`")
  lines.push("   - `console.log` / `print` statements standing in for real logging or error handling")
  lines.push("   - Empty catch blocks or catch-all error swallowing (`catch (e) {}`, `catch (_) { /* ignore */ }`)")
  lines.push("   - Conditional stubs: `if (process.env.NODE_ENV === 'test') return mockData`")
  if (stubsAcceptable) {
    lines.push("")
    lines.push(`   **This task has category "scaffold" — stubs ARE acceptable** for methods that will be`)
    lines.push("   implemented by a later integration task. However, the scaffold must still compile,")
    lines.push("   satisfy type signatures, and have the correct wiring/structure. Flag stubs only if")
    lines.push("   they are missing from the interface (unimplemented methods) or have incorrect signatures.")
  } else {
    lines.push("")
    lines.push(`   **This task has category "${taskCategory}" — stubs are NOT acceptable.**`)
    lines.push("   If ANY of the above patterns are found, the task FAILS. List every instance with file:line.")
    lines.push("   The implementation must contain real, functional logic — not placeholders.")
  }

  lines.push("")
  lines.push("7. **Reject helper-only or drifting policy integrations.** If this task adds shared infrastructure,")
  lines.push("   client/adapter plumbing, workflow policy, approval routing, or guard logic, verify:")
  lines.push("   - the new code is wired into a real runtime call path for the scope this task claims")
  lines.push("   - claimed shared or multi-client behavior is integrated everywhere this task says it is")
  lines.push("   - policy/gate logic is not duplicated in a second place without a clear justification")
  lines.push("   Prefix these issues with `INTEGRATION_GAP:` when a runtime path is missing, or `POLICY_DUP:`")
  lines.push("   when duplicated policy logic can drift between codepaths.")
  lines.push("")
  lines.push("8. **Structural wiring gate.** For structure, wiring, and integration-heavy work, verify the")
  lines.push("   task changes are reachable through the real entry point that owns the behavior. A helper,")
  lines.push("   registry entry, adapter method, or bridge path that is not connected to its caller fails review.")

  if (input.hasAdjacentTasks) {
    lines.push("")
    lines.push("9. **Integration seam check.** Review the boundaries between this task and its adjacent tasks")
    lines.push("   (listed in the \"Adjacent Tasks\" section above). For each boundary, verify:")
    lines.push("   - **Shared resources are configured:** If this task produces or consumes a shared resource")
    lines.push("     (queue, database table, config entry, DI binding, environment variable), verify the resource")
    lines.push("     is actually created/configured — not just assumed to exist.")
    lines.push("   - **Data contracts match:** If this task passes data to/from an adjacent task, verify the")
    lines.push("     data shape (types, field names, serialization format) matches on both sides.")
    lines.push("   - **Error propagation is handled:** If an upstream task can fail, verify this task handles")
    lines.push("     that failure (not just the happy path). If this task can fail, verify downstream tasks")
    lines.push("     can detect and handle the failure.")
    lines.push("   - **No \"not my responsibility\" gaps:** If something needs to happen at the boundary and")
    lines.push("     neither this task nor the adjacent task clearly owns it, flag it as INTEGRATION_GAP.")
    lines.push("")
    lines.push("   Prefix integration issues with 'INTEGRATION_GAP:' and describe what is missing and which")
    lines.push("   task boundary is affected (e.g., 'INTEGRATION_GAP: T1→T2: queue config not created').")
  }

  lines.push("")
  lines.push("## Quality Scoring")
  lines.push("")
  lines.push("In addition to the pass/fail checks above, score the implementation on these dimensions (1-10):")
  lines.push("- **[Q] Code quality** — naming clarity, structure, readability, idiomatic patterns. Minimum: 8/10.")
  lines.push("- **[Q] Error handling** — edge cases covered, failure modes handled, no silent swallowing. Minimum: 8/10.")
  lines.push("")
  lines.push("Use the full 1-10 range honestly. Reward excellence just as clearly as you punish flaws; do not compress scores into a narrow band.")
  lines.push("Scoring guide: 1-2 = fundamentally broken, 3-4 = major gaps, 5-6 = mixed/adequate but clearly incomplete, 7 = decent but still below task-review pass quality, 8 = strong and passing, 9 = excellent, 10 = exceptional.")
  lines.push("If ANY quality score is below 8, the task FAILS regardless of other checks. Include specific")
  lines.push("evidence for each score (cite file:line for low scores, explain what needs improvement).")

  return lines.join("\n")
}

export function buildTaskImplementationRubricPreview(): string {
  return [
    "**Task review rubric:** before calling `mark_task_complete`, assume an isolated reviewer will check:",
    "- relevant and full test results, including regressions",
    "- exact alignment with approved interfaces, plan, and conventions",
    "- real runtime behavior, not placeholders, TODOs, skipped tests, or helper-only wiring",
    "- structural wiring reaches the real entry point for the claimed behavior",
    "- integration seams with prerequisite and downstream tasks",
    "- code quality and error handling scores",
    "",
    "**Final implementation phase rubric:** this task also contributes to the final IMPLEMENTATION review. Keep these blocking checks satisfied while coding:",
    "- exact alignment with approved interfaces, plan, tests, implementation plan, and conventions",
    "- no scope creep, duplicate policy logic, helper-only wiring, partial client/runtime integration, or placeholder tests",
    "- documentation and tests for any user-visible or newly introduced runtime behavior",
    "- autonomous/runtime claims are verified on the real execution surface, not only mocked seams",
  ].join("\n")
}
