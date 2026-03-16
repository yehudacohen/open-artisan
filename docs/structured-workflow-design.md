# Structured Coding Workflow — Design Document

**Version:** v10 (reflects implementation as of schema v15, March 2026)
**Status:** This document describes the **current implemented system**, not aspirational design. Section 14 documents structural gaps that have all been resolved. Section 14.6 documents meta-structural improvements that prevent agents from silently downgrading structural guarantees. Section 15 documents deferred features.

---

## 1. Problem Statement

AI coding agents fail not because the models lack capability, but because they skip the engineering discipline that produces correct code. They lunge into implementation without a plan, produce interfaces ad-hoc, write tests as an afterthought, and have no mechanism to detect when their foundations are wrong. When they do detect a problem, they rewrite from scratch instead of correcting incrementally — wasting all prior refinement.

Existing agentic harnesses optimize for persistence or parallelism but not for structural quality. None enforce phased discipline, none track artifact dependencies, and none can cascade corrections backward through a dependency graph when an upstream artifact is found to be wrong.

Critically, nearly all of them assume greenfield development. In practice, most real engineering work happens in existing codebases — either adding features to a live product or refactoring legacy code toward better patterns. A workflow that doesn't understand the terrain it's operating in will produce technically correct but practically destructive changes.

This plugin enforces a phased, quality-gated workflow that mirrors how experienced engineers actually build software: understand what exists, plan against that reality, define interfaces, write tests, plan the implementation, then implement one task at a time — verifying alignment at every step.

**Core enforcement philosophy:** If the agent can bypass a quality gate through rationalization, the gate must be enforced in code, not just prompts.

---

## 2. Design Principles

1. **Know the terrain.** Before any planning begins, the agent discovers the existing codebase's structure, conventions, patterns, and constraints. In greenfield mode this is skipped. In existing-project modes this produces a conventions document that constrains all subsequent phases.

2. **Plan before code.** No implementation artifact is produced until the plan, interfaces, tests, and implementation plan have each been individually reviewed and approved.

3. **Revise, never rewrite.** Every iteration is incremental. No feedback path leads to a DRAFT state. Prior approved decisions are preserved and refined. This is enforced structurally: the state machine's `transition()` function rejects any event that would produce a DRAFT state from a REVISE or USER_GATE state.

4. **Single feedback funnel.** All user feedback at USER_GATE enters the orchestrator (assess → diverge → route). No feedback bypasses the dependency graph.

5. **Catch drift early.** Per-task review checks alignment after every task completion. Per-task drift check (task-drift.ts) updates downstream task descriptions when drift is detected. Full implementation review catches accumulated drift at the end.

6. **Escalate strategic decisions.** Tactical corrections proceed autonomously. Strategic pivots — scope expansion, architectural shifts, deep cascading changes — are escalated to the user via the escape hatch.

7. **Isolate reviewers from authors.** Self-review runs in separate hidden subagent sessions that see only the artifact and acceptance criteria, never the conversation that produced it. This eliminates anchoring bias.

8. **Checkpoint everything.** Every user approval creates a git-tagged commit. Rollback is always possible to the last checkpoint.

9. **Do no harm (when told not to).** In incremental mode on existing projects, every change is constrained to the minimum necessary. Existing conventions are respected. Existing tests must continue to pass. Files outside the approved scope cannot be touched.

10. **Agent-aware activation.** The plugin detects which agent file is active and goes fully dormant for non-artisan agents (Plan, Build). Only `artisan` and `robot-artisan` agents activate the workflow. This prevents the plugin from interfering with standard OpenCode usage.

---

## 3. Workflow Modes

The workflow operates in one of three modes, selected at session start via `select_mode`. The mode determines whether a discovery phase runs, what constraints are applied throughout, and how aggressive the agent is allowed to be.

### 3.1 Mode Definitions

| Mode | When to Use | Discovery Phase | Constraints |
|------|------------|-----------------|-------------|
| **Greenfield** | New project, empty or near-empty repo | Skipped | None — full creative freedom. Agent defines all conventions. |
| **Refactor** | Existing project, goal is to improve structure/patterns | Full discovery: scan, analyze, produce assessment + conventions | Agent can modify any file, but must produce a transformation plan showing before/after state. Existing tests must pass after each task. New patterns documented in conventions. |
| **Incremental** | Existing project, goal is to add/fix specific functionality | Full discovery: scan, analyze, produce conventions as constraints | **Do-no-harm directive.** Agent can only modify files explicitly approved in the plan. Existing conventions must be followed. Existing tests must continue to pass. No refactoring outside the scope of the requested change. File allowlist enforced by tool guard. |

### 3.2 Mode Auto-Detection

At session creation, `detectMode()` runs heuristics (git history presence, source file count) and stores the result in `state.modeDetectionNote`. This suggestion is displayed to the agent at MODE_SELECT as advisory — the user explicitly calls `select_mode` with their chosen mode and a `feature_name`.

The `feature_name` (required, kebab-case) creates a subdirectory under `.openartisan/` for artifact isolation. Multiple features can coexist in the same repo: `.openartisan/auth-refactor/`, `.openartisan/billing-api/`, etc.

### 3.3 Discovery Phase Detail

The discovery phase dispatches 6 parallel scanner subagents via `discovery/index.ts`:

| Scanner | Tools Used | Output |
|---------|-----------|--------|
| **Structure scanner** | `glob`, `list`, `bash` | File tree, module boundaries, package structure, file counts by type |
| **Convention detector** | `grep`, `read`, `bash` | Coding style, naming patterns, import conventions, formatting rules |
| **Architecture analyzer** | `grep`, `read`, symbol search | Dependency graph between modules, key abstractions, interface patterns |
| **Test pattern scanner** | `glob`, `read`, `bash` | Test framework, test organization, coverage patterns, test naming |
| **History analyzer** | `bash` (git log, git shortlog) | Commit patterns, active areas, recent changes, contributor patterns |
| **Existing docs reader** | `read` | Existing documented conventions, setup instructions, architecture decisions |

Scanners run with `agent: "workflow-reviewer"` (hidden subagent) and a 3-minute timeout (`SCANNER_TIMEOUT_MS`). At least 3 of 6 must succeed (`MIN_SCANNERS_THRESHOLD`) for the report to be used. The combined report is stored in `state.discoveryReport` and written to disk as `discovery-report.md`.

### 3.4 Mode-Specific Constraints

These constraints are injected into the system prompt at every phase and enforced by the tool guard:

**Incremental mode (Do No Harm):**
- Tool guard enforces a **file allowlist** — only files identified in the approved plan can be written/edited
- Writes to unlisted files are blocked with a specific error message
- Bash write operators (`>`, `>>`, `tee`, `sed -i`) are blocked in all sub-states (enforced via `bashCommandPredicate`)
- The conventions document is read-only — the agent follows it but cannot modify it

**Refactor mode:**
- Agent can modify any file but must follow the target patterns from the conventions document
- All existing tests must pass after each task

---

## 4. Agent Architecture

The plugin uses 5 agent files. Only `artisan` and `robot-artisan` appear in the Tab UI; the others are hidden subagents invoked programmatically.

### 4.1 Agent Definitions

| Agent File | Mode | Hidden | Tab UI | Purpose |
|-----------|------|--------|--------|---------|
| `artisan.md` | `primary` | no | **Artisan** (green) | Standard workflow with human approval gates |
| `robot-artisan.md` | `primary` | no | **Robot Artisan** (orange) | Autonomous workflow with AI-delegated approvals |
| `workflow-reviewer.md` | `subagent` | yes | hidden | Isolated reviewer for self-review, rebuttal, task-review, discovery scanners |
| `workflow-orchestrator.md` | `subagent` | yes | hidden | Orchestrator assess/diverge classification |
| `auto-approver.md` | `subagent` | yes | hidden | Robot-artisan USER_GATE evaluation |

The Tab switcher shows: **Plan** | **Build** | **Artisan** | **Robot Artisan**

### 4.2 Agent Detection and Dormancy

The `activeAgent` field on `WorkflowState` (schema v13) tracks which agent file is driving the session. Detection works through custom tool `execute()` context:

1. `context.agent` is available inside custom tool `execute()` — NOT in `tool.execute.before` hooks
2. Every custom tool calls `detectAgent()` at the top of its execute handler
3. The first tool call in a session captures the agent name and persists it

**Dormancy rules:**
- `activeAgent === null` → ACTIVE (backward compatibility — not yet detected)
- `activeAgent` in `{"artisan", "robot-artisan"}` → ACTIVE (full workflow)
- `activeAgent` not in that set → DORMANT (skip all tool blocking, prompt injection, idle handling, and compaction context)

When dormant, the plugin is invisible. Non-artisan agents (Plan, Build) experience no tool blocking, no system prompt injection, no idle re-prompts.

### 4.3 Robot-Artisan Mode

Robot-artisan replaces human gates with AI evaluation:

**Auto-approval at USER_GATE:** When `activeAgent === "robot-artisan"` and the workflow reaches USER_GATE (via self-review pass or escalation), `auto-approve.ts` dispatches an `auto-approver` subagent:
- The auto-approver evaluates the artifact against completeness, correctness, alignment, and quality
- An `isEscalation` flag is passed when the review cap was hit, making the auto-approver more lenient on quality scores but strict on correctness and completeness
- Returns `{ approve: boolean, confidence: number, reasoning: string, feedback?: string }`
- Confidence >= 0.7 → auto-approve (sets `userGateMessageReceived = true`)
- Confidence < 0.7 → returns revision feedback for the agent to address
- On dispatch failure → graceful fallback to normal USER_GATE behavior

**Human gate auto-abort:** When all remaining DAG tasks are blocked behind human gates (infrastructure provisioning, credential setup), robot-artisan auto-aborts those tasks and their transitive dependents via `dag.getDependents()`. If non-blocked work remains, the agent continues. If all remaining work is human-gated, the agent proceeds to review.

### 4.4 Session Wiring

All `session.create()` calls pass:
- `agent:` — the appropriate agent name for auditability in the TUI session tree
- `parentID:` — the parent session ID (when available) for session tree hierarchy

| Dispatch Site | Agent | parentID Source |
|--------------|-------|-----------------|
| Discovery scanners (`discovery/index.ts`) | `workflow-reviewer` | parent session |
| Self-review (`self-review.ts`) | `workflow-reviewer` | parent session |
| Task review (`task-review.ts`) | `workflow-reviewer` | parent session |
| Orchestrator assess/diverge (`orchestrator/llm-calls.ts`) | `workflow-orchestrator` | `activeSessionId` getter |
| Auto-approval (`auto-approve.ts`) | `auto-approver` | parent session |
| Per-task drift check (`task-drift.ts`) | `workflow-orchestrator` | parent session |

---

## 5. State Machine

The workflow uses a simplified state machine encoding states as `(Phase, PhaseState)` tuples. There are 8 phases and 8 possible sub-states, with `VALID_PHASE_STATES` constraining the valid combinations to 34 pairs (MODE_SELECT: 1, DISCOVERY: 7, five standard phases × 5 each: 25, DONE: 1).

### 5.1 Phases and Sub-States

```
Phase           Valid Sub-States
─────────────   ──────────────────────────────────────────────
MODE_SELECT     DRAFT (sentinel only)
DISCOVERY       SCAN, ANALYZE, CONVENTIONS, REVIEW, USER_GATE, ESCAPE_HATCH, REVISE
PLANNING        DRAFT, REVIEW, USER_GATE, ESCAPE_HATCH, REVISE
INTERFACES      DRAFT, REVIEW, USER_GATE, ESCAPE_HATCH, REVISE
TESTS           DRAFT, REVIEW, USER_GATE, ESCAPE_HATCH, REVISE
IMPL_PLAN       DRAFT, REVIEW, USER_GATE, ESCAPE_HATCH, REVISE
IMPLEMENTATION  DRAFT, REVIEW, USER_GATE, ESCAPE_HATCH, REVISE
DONE            DRAFT (sentinel only)
```

### 5.2 Events

| Event | Meaning | Fired By |
|-------|---------|----------|
| `mode_selected` | User chose a mode and feature name | `select_mode` tool |
| `scan_complete` | Discovery scan finished | `mark_scan_complete` tool |
| `analyze_complete` | Discovery analysis finished | `mark_analyze_complete` tool |
| `draft_complete` | Phase artifact drafted | `request_review` tool |
| `self_review_pass` | Isolated reviewer passes | `mark_satisfied` (via self-review) |
| `self_review_fail` | Isolated reviewer fails | `mark_satisfied` (via self-review) |
| `escalate_to_user` | Review iteration cap reached | `mark_satisfied` (after MAX_REVIEW_ITERATIONS) |
| `user_approve` | User approves artifact | `submit_feedback(approve)` |
| `user_feedback` | User requests changes | `submit_feedback(revise)` → orchestrator |
| `escape_hatch_triggered` | Strategic pivot detected at USER_GATE | Orchestrator diverge → strategic classification |
| `revision_complete` | Revision done, ready for re-review | `request_review` tool |

### 5.3 Phase Pattern (Repeating Unit)

Every sequential phase (PLANNING through IMPLEMENTATION) follows this five-state pattern:

```
DRAFT ──[draft_complete]──► REVIEW ──[self_review_fail]──► REVIEW (loop)
                                    ──[self_review_pass]──► USER_GATE
                                    ──[escalate_to_user]──► USER_GATE
                            USER_GATE ──[user_approve]──► next Phase/DRAFT
                                      ──[user_feedback]──► orchestrator → REVISE
                                      ──[escape_hatch_triggered]──► ESCAPE_HATCH
                            ESCAPE_HATCH ──[user_feedback]──► REVISE
                                         (user_approve NOT valid — SM rejects it)
                            REVISE ──[revision_complete]──► REVIEW
```

The DISCOVERY phase has a prefix: SCAN → ANALYZE → CONVENTIONS → REVIEW → USER_GATE → REVISE.

### 5.4 Phase Progression

```
MODE_SELECT
    ├── [greenfield] ──► PLANNING/DRAFT
    └── [existing]   ──► DISCOVERY/SCAN
                            ↓
                         DISCOVERY ──[approve]──► PLANNING/DRAFT
                                                      ↓
                                                   PLANNING ──[approve]──► INTERFACES/DRAFT
                                                                               ↓
                                                                            INTERFACES ──[approve]──► TESTS/DRAFT
                                                                                                         ↓
                                                                                                      TESTS ──[approve]──► IMPL_PLAN/DRAFT
                                                                                                                               ↓
                                                                                                                            IMPL_PLAN ──[approve]──► IMPLEMENTATION/DRAFT
                                                                                                                                                          ↓
                                                                                                                                                        IMPLEMENTATION ──[approve]──► DONE
                                                                                                                                                                                              ↓
                                                                                                                                                                                           DONE ──[user message]──► MODE_SELECT (auto-reset)
```

**DONE → MODE_SELECT auto-reset:** When a user sends a new message after a completed workflow (phase = DONE), the `chat.message` hook automatically resets the session to MODE_SELECT so a new workflow cycle can begin. This prevents the agent from working outside the workflow framework after the first workflow completes. The reset:
- **Clears** transient fields: `iterationCount`, `retryCount`, `currentTaskId`, `feedbackHistory`, `implDag`, `pendingRevisionSteps`, `escapePending`, `taskCompletionInProgress`, `taskReviewCount`, `pendingFeedback`, `revisionBaseline`, `userGateMessageReceived`.
- **Preserves** cross-cycle context: `mode`, `approvedArtifacts`, `conventions`, `fileAllowlist`, `featureName`, `artifactDiskPaths`, `activeAgent`, `phaseApprovalCounts`, `lastCheckpointTag`, `approvalCount`.
- **Sets** `intentBaseline` to the user's new message text (truncated to 2000 chars).

### 5.5 Design Invariant: Revise, Never Rewrite

The state machine enforces that `user_feedback` events produce REVISE states, never DRAFT states. This is checked structurally in `state-machine.ts` — the transition function rejects any event that would produce a DRAFT→DRAFT loop. Every iteration preserves prior work.

### 5.6 What the State Machine Does NOT Model

The orchestrator (assess, diverge, route) and execution engine (task scheduling, per-task review, drift check) are **procedural code**, not state machine states. The original v6 design specified 40 states including X_* and O_* states for these subsystems. The implementation consolidates them into function calls within the tool handlers. The structural gaps identified in the original analysis (Section 14) have all been resolved.

---

## 6. Artifact Dependency Graph

Artifacts are the outputs of each phase. When the orchestrator receives user feedback, it identifies the affected artifact, walks this graph forward, and builds a cascade of downstream artifacts needing re-validation.

The dependency graph is dense (12 direct edges across 7 artifacts). The authoritative representation is the list below — `getAllDependents()` walks transitive dependencies for cascade routing (e.g., revising Conventions touches all 5 downstream artifacts).

Implemented in `artifacts.ts` as:
```
design → []                                          (conditional — only if design doc detected)
conventions → []
plan → [conventions]   (+design if design doc exists)
interfaces → [conventions, plan]
tests → [interfaces]
impl_plan → [plan, interfaces, tests]
implementation → [plan, impl_plan, interfaces, tests]
```

The `design → plan` edge is injected at runtime by `createArtifactGraph(hasDesignDoc)`. See Section 14.6.1.

**Cascade examples:**
- Revising **Conventions** → 5 downstream (everything). Triggers escape hatch (cascade depth >= 3).
- Revising **Interfaces** → 3 downstream (tests, impl_plan, implementation). Triggers escape hatch.
- Revising **Plan** → 4 downstream. Triggers escape hatch.
- Revising **Tests** → 2 downstream (impl_plan, implementation). Tactical.
- Revising **Impl Plan** → 1 downstream (implementation). Tactical.

In greenfield mode, the Conventions artifact does not exist and the graph starts at Plan.

### 6.1 Cascade Auto-Skip

When the orchestrator routes a cascade to a phase where no changes are needed (e.g., revising the plan doesn't actually affect interfaces), the system deterministically auto-skips that step at cascade ENTRY using `cascadeAutoSkip()`. This prevents the agent from entering no-op REVISE phases where tool guards would block it from doing anything useful.

Auto-skip uses the revision baseline (see Section 10.3) to detect whether an artifact has changed between the cascade entry point and the current state. If unchanged, the step is skipped and the cascade advances to the next downstream phase.

**Implementation details** (`cascadeAutoSkip()` in `index.ts`):
- Loops up to 10 iterations (safety bound) advancing through pending revision steps
- For mid-cascade steps: advances to the next step's target phase in REVISE state
- For the final cascade step: fast-forwards to USER_GATE (the cascade is complete, ready for review)
- Standalone REVISE (non-cascade, `pendingRevisionSteps` is null or empty) is NOT auto-skipped — only cascade steps are eligible
- Baseline is re-captured at each step transition

---

## 7. Orchestrator

The orchestrator is a set of procedural functions (not state machine states) that classify and route user feedback. All feedback at USER_GATE passes through the orchestrator.

### 7.1 Flow

```
submit_feedback(revise, feedback_text)
    ↓
handleNormalRevise()
    ↓
orchestrator.route(feedback, state, ...)
    ↓
assess(feedback) → { rootArtifact, affectedArtifacts, reasoning }    [LLM call]
    ↓
diverge(assessment, state) → "tactical" | "strategic"                 [LLM call]
    ↓
┌── tactical: buildRevisionSteps() → pendingRevisionSteps → REVISE
└── strategic: buildEscapeHatchPresentation() → USER_GATE (escapePending=true)
```

### 7.2 Assess

The `assess` function (LLM call via `createAssessFn` in `orchestrator/llm-calls.ts`) receives the feedback text, current state summary, and approved artifact hashes. It returns:
- `rootCauseArtifact`: the artifact directly affected by the feedback
- `affectedArtifacts`: all downstream artifacts (via dependency graph walk)
- `reasoning`: explanation of the scoping decision

### 7.3 Diverge

The `diverge` function (LLM call via `createDivergeFn`) classifies the change as tactical or strategic. **Hard rule:** if 3 or more *materially affected* artifacts exist (i.e., artifacts that have been approved or are currently in progress — not just theoretical downstream nodes), the classification is forced to `"strategic"` regardless of the LLM output.

### 7.4 Revision Plan

`buildRevisionSteps()` (pure function in `orchestrator/route.ts`) builds an ordered list of `RevisionStep` objects targeting REVISE states. Steps are ordered by the topological sort of the artifact dependency graph. Each step includes the target phase, affected artifact key, and revision instructions.

### 7.5 Orchestrator Sessions

Orchestrator LLM calls use ephemeral sessions with `agent: "workflow-orchestrator"` and `parentID` set to the `activeSessionId` (tracked via a getter closure). Sessions are cleaned up after the call unless `parentID` was provided (child sessions are cleaned up with the parent).

---

## 8. Escape Hatch

When the orchestrator classifies a change as strategic, the escape hatch fires:

1. `escapePending` is set to `true` on the workflow state
2. `pendingRevisionSteps` stores the orchestrator's proposed cascade
3. The system prompt instructs the agent to present the escape hatch to the user
4. The agent presents: original intent, detected divergence, proposed change plan, impact assessment

The user chooses from four options:

| Option | What Happens |
|--------|-------------|
| **Accept drift** ("accept"/"proceed") | Intent baseline updated. Cascade proceeds. `escapePending` cleared. |
| **Alternative direction** (substantive text) | Intent baseline updated with user's direction. Orchestrator reassesses — may trigger a second escape hatch if the alternative is also strategic. |
| **New direction** ("new direction: ...") | Full re-assessment with user's new requirements. Intent baseline replaced entirely. |
| **Abort** ("abort") | State reset. `escapePending` and `pendingRevisionSteps` cleared. No revisions applied. |

Classification of the user's response is done by keyword matching in `isEscapeHatchAbort()` and `handleEscapeHatch()` in `tools/submit-feedback-handlers.ts`.

**Ambiguity handling:** Short responses (≤ `MAX_AMBIGUOUS_RESPONSE_LENGTH` chars) that don't match any keyword are classified as ambiguous by `isEscapeHatchAmbiguous()` in `orchestrator/escape-hatch.ts`. The agent is prompted to re-present the options more clearly.

---

## 9. Divergence Detection

The divergence check classifies proposed changes as tactical or strategic. Any one criterion triggers the escape hatch:

| Criterion | Description | Detection Method |
|-----------|-------------|-----------------|
| Scope expansion | Change adds artifacts or capabilities not in the approved plan | LLM classification in `diverge` call |
| Architectural shift | Change requires modifying fundamental data model, API structure, or system boundaries | LLM classification |
| Cascade depth >= 3 | Dependency walk shows 3+ artifacts need revision | **Hard-coded** in `llm-calls.ts` — `affectedCount >= 3` forces strategic |
| Accumulated drift | Total semantic distance of all revisions since last approval exceeds threshold | LLM classification with `feedbackHistory` context |

The cascade depth >= 3 criterion is the only deterministic trigger. The other three rely on LLM classification with the approved artifact hashes and feedback history passed as context.

---

## 10. Persistence and Schema

### 10.1 Schema Versioning

Workflow state is persisted as JSON in OpenCode's data directory. The schema version (currently v15) is stamped on every state object. On load, states with mismatched versions are migrated forward using `??=` defaulting for new fields. States with future versions are discarded.

### 10.2 WorkflowState Fields (Schema v15)

| Field | Type | Added | Purpose |
|-------|------|-------|---------|
| `schemaVersion` | `15` | v1 | Forward-compatibility guard |
| `sessionId` | `string` | v1 | OpenCode session ID |
| `mode` | `WorkflowMode \| null` | v1 | GREENFIELD / REFACTOR / INCREMENTAL |
| `phase` | `Phase` | v1 | Current high-level phase |
| `phaseState` | `PhaseState` | v1 | Sub-state within the phase |
| `iterationCount` | `number` | v1 | Self-review iterations in current phase |
| `retryCount` | `number` | v1 | Idle re-prompt retries |
| `approvedArtifacts` | `Partial<Record<ArtifactKey, string>>` | v1 | SHA-256 hashes of approved artifact content |
| `conventions` | `string \| null` | v1 | Full conventions document text |
| `fileAllowlist` | `string[]` | v1 | INCREMENTAL mode write-allowed paths |
| `lastCheckpointTag` | `string \| null` | v1 | Git tag of last approved checkpoint |
| `approvalCount` | `number` | v1 | Total user approvals (monotonic) |
| `orchestratorSessionId` | `string \| null` | v2 | Dedicated orchestrator session |
| `intentBaseline` | `string \| null` | v2 | User's original intent statement |
| `escapePending` | `boolean` | v2 | Escape hatch in progress |
| `pendingRevisionSteps` | `RevisionStep[] \| null` | v2 | Cascade plan awaiting resolution |
| `modeDetectionNote` | `string \| null` | v3 | Auto-detection advisory |
| `discoveryReport` | `string \| null` | v4 | Combined discovery scanner output |
| `implDag` | `TaskNode[] \| null` | v5 | Serialized implementation DAG |
| `currentTaskId` | `string \| null` | v6 | Active DAG task pointer |
| `feedbackHistory` | `Array<{phase, feedback, timestamp}>` | v6 | Accumulated drift tracking |
| `phaseApprovalCounts` | `Partial<Record<Phase, number>>` | v7 | Per-phase approval counter for tags |
| `userGateMessageReceived` | `boolean` | v8 | Anti-self-approval guard |
| `artifactDiskPaths` | `Partial<Record<ArtifactKey, string>>` | v9 | Absolute paths of artifacts on disk |
| `featureName` | `string \| null` | v10 | Subdirectory under `.openartisan/` |
| `revisionBaseline` | `{type, hash\|sha} \| null` | v11 | Diff gate snapshot at REVISE entry |
| `activeAgent` | `string \| null` | v13 | Agent file driving this session |
| `taskCompletionInProgress` | `string \| null` | v14 | Re-entry guard for `mark_task_complete` |
| `taskReviewCount` | `number` | v15 | Per-task review iteration counter |
| `pendingFeedback` | `string \| null` | v15 | Crash-safe feedback persistence |

### 10.3 Revision Baseline (Diff Gate)

At REVISE entry, `captureRevisionBaseline()` snapshots the artifact state:
- **In-memory phases** (PLANNING, DISCOVERY, IMPL_PLAN): SHA-256 content hash of the artifact file on disk (`type: "content-hash"`)
- **File-based phases** (INTERFACES, TESTS, IMPLEMENTATION): SHA-256 hash of `git diff` output (`type: "git-sha"` — note: the type name is legacy; the value is a content hash of the diff, not a commit SHA)

The implementation uses `git diff` output hashing rather than commit SHAs to prevent false positives during cascades. When the orchestrator routes a cascade through multiple phases, the agent may not have committed yet — storing HEAD SHA would show "changed" even when the relevant artifact files are untouched.

At `request_review` time, `hasArtifactChanged()` compares the current state against the baseline. If unchanged, the agent is blocked from transitioning to REVIEW — it must actually make changes. This prevents lazy no-op revisions where the agent calls `request_review` without addressing the feedback.

---

## 11. Git Strategy

| Event | Git Action |
|-------|------------|
| User approves at phase gate | `git add -A && git commit && git tag workflow/<phase>-v<N>` |
| Orchestrator revision cascade | Revisions committed on main, re-tagged on next approval |

Tag format: `workflow/<phase>-v<N>` where `N` comes from `phaseApprovalCounts[phase]` (starts at 1, increments on each re-approval of the same phase).

**Not implemented:** Worktree branches, merge gates, merge commits, `git reset --hard` on escape hatch abort. See Section 15 (Deferred).

---

## 12. Per-Phase Acceptance Criteria

Each phase has structured acceptance criteria evaluated by the isolated reviewer subagent. Criteria come in four types:

- **Blocking criteria** (numbered) — must all pass to advance
- **[D] Design-invariant criteria** — blocking AND non-rebuttable (see Section 14.6.2). Only injected when a design document is tracked.
- **[Q] Quality criteria** — scored 1-10, minimum 9/10 to pass (7 dimensions)
- **[S] Suggestion criteria** — non-blocking, advisory only

### 12.1 Quality Dimensions (All Phases)

Every phase is scored on these 7 dimensions:

1. **Design excellence** — elegance, simplicity, appropriate patterns
2. **Architectural cohesion** — internal consistency, clear boundaries, no contradictions
3. **Vision alignment** — fidelity to user's intent AND upstream approved artifacts
4. **Completeness** — no gaps, nothing left implicit that should be explicit
5. **Readiness for execution** — could the next phase proceed without questions?
6. **Security standards** — auth, input validation, secrets handling, least privilege
7. **Operational excellence** — observability, error recovery, deployment, monitoring

Each dimension has phase-specific descriptions. A score below 9 means the criterion is NOT met. Scores 7-8 are eligible for rebuttal (see Section 12.3).

### 12.2 Phase-Specific Blocking Criteria

The full criteria are defined in `getAcceptanceCriteria()` in `hooks/system-transform.ts`. Key highlights:

- **DISCOVERY:** Conventions document must be actionable and complete — not a raw dump of observations
- **PLANNING:** No "TBD" items — every ambiguity must be resolved with an explicit decision
- **INTERFACES:** Every function must have input types, output types, and error types — no `any`
- **TESTS:** Tests must fail — no implementation leakage
- **IMPL_PLAN:** DAG must be acyclic with correct dependencies. Task categories (scaffold/human-gate/integration/standalone) must be correctly assigned.
- **IMPLEMENTATION:** Critical stub check — scans for hardcoded returns, TODO/FIXME, placeholder credentials, empty catch blocks. Exception: scaffold tasks may contain stubs for methods implemented by later integration tasks.

### 12.3 Agent Rebuttal Loop

When a review fails and the agent is one iteration from the escalation cap (`MAX_REVIEW_ITERATIONS - 1`), the system dispatches a rebuttal. Criteria scoring 7-8 (close to threshold) where the agent disagrees are sent to a fresh reviewer session. If the reviewer concedes, the review passes without escalation. This reduces unnecessary user interruptions over scope disagreements.

**`[D]` criteria are excluded from rebuttal.** Design-invariant criteria cannot be rationalized away by either the agent or the reviewer. They are binary structural requirements from the design document.

### 12.4 Review Escalation

After `MAX_REVIEW_ITERATIONS` (10) consecutive review failures, the system escalates to USER_GATE with a structured verdict table showing each unresolved criterion, its score, and the reviewer's evidence. The user can then approve as-is or provide specific revision guidance.

---

## 13. Tool System

### 13.1 Custom Workflow Tools

| Tool | Phase/State | Purpose |
|------|------------|---------|
| `select_mode` | MODE_SELECT | Choose workflow mode + feature name |
| `mark_scan_complete` | DISCOVERY/SCAN | Signal scan phase complete |
| `mark_analyze_complete` | DISCOVERY/ANALYZE | Signal analysis complete |
| `request_review` | */DRAFT, */CONVENTIONS, */REVISE | Submit artifact for review |
| `mark_satisfied` | */REVIEW | Submit criteria assessment (triggers isolated reviewer) |
| `submit_feedback` | */USER_GATE | Route user feedback (approve or revise) |
| `mark_task_complete` | IMPLEMENTATION/DRAFT, IMPLEMENTATION/REVISE | Complete a DAG task (triggers per-task review) |
| `resolve_human_gate` | IMPLEMENTATION/* | Activate a human gate for a DAG task |

### 13.2 Tool Guard

The `tool.execute.before` hook intercepts every tool call and applies phase-specific blocking:

**Passthrough tools** (`PASSTHROUGH_TOOL_NAMES`): Always allowed regardless of phase. Includes `todowrite`, `todoread`, `task`, `glob`, `grep`, `read`, `webfetch`, `google_search`, `skill`, `question`. These are checked by exact match BEFORE the substring match on blocked categories, preventing false positives (e.g., `"todowrite".includes("write")` → true).

**Blocked categories** per phase: The `getPhaseToolPolicy()` function returns category-level blocks. When a `writePathPredicate` is present, writes matching the predicate are allowed even though `write`/`edit` may not appear in the blocked array — the predicate acts as an allowlist and all non-matching writes are rejected.

| Phase | Sub-State | Blocked | Writes Allowed To | Bash |
|-------|-----------|---------|-------------------|------|
| MODE_SELECT | * | `write`, `edit` | nothing | allowed |
| DONE | * | `write`, `edit`, `bash` | nothing | blocked |
| DISCOVERY | SCAN, ANALYZE | `write`, `edit`, `bash` | nothing | blocked |
| DISCOVERY | CONVENTIONS | `bash` | `.openartisan/` only | blocked |
| DISCOVERY | REVIEW | (none) | `.openartisan/` only | allowed |
| DISCOVERY | REVISE | (none) | `.openartisan/` only | allowed |
| DISCOVERY | USER_GATE, ESCAPE_HATCH | `write`, `edit` | nothing | allowed |
| PLANNING, IMPL_PLAN | DRAFT | `write`, `edit`, `bash` | nothing | blocked |
| PLANNING, IMPL_PLAN | REVIEW | (none) | `.openartisan/` only | allowed |
| PLANNING, IMPL_PLAN | REVISE | (none) | `.openartisan/` only | allowed |
| PLANNING, IMPL_PLAN | USER_GATE, ESCAPE_HATCH | `write`, `edit` | nothing | allowed |
| INTERFACES | DRAFT | `bash` | interface/type/schema files | blocked |
| INTERFACES | REVIEW, REVISE, USER_GATE, ESCAPE_HATCH | (none) | interface/type/schema files | allowed |
| TESTS | DRAFT | `bash` | test files | blocked |
| TESTS | REVIEW, REVISE, USER_GATE, ESCAPE_HATCH | (none) | test files | allowed |
| IMPLEMENTATION | * (GREENFIELD/REFACTOR) | (none) | any file (except `.env`) | allowed |
| IMPLEMENTATION | * (INCREMENTAL, with allowlist) | (none) | allowlisted files only | allowed (write operators blocked) |
| IMPLEMENTATION | * (INCREMENTAL, no allowlist) | `write`, `edit` | nothing | allowed |

**Security:** `.env` and `.env.*` files are blocked from writes in ALL phases including IMPLEMENTATION (enforced via `isEnvFile()` in `tool-guard.ts`). INCREMENTAL mode additionally blocks bash write operators (`>`, `>>`, `tee`, `sed -i`).

**Child session guard:** Child sessions (subagents) inherit the parent's tool policy but additionally block all workflow tool names. This prevents state mutation races.

**Agent-aware dormancy:** If `state.activeAgent` is set and not in `ARTISAN_AGENT_NAMES`, the entire tool guard is skipped.

### 13.3 System Prompt Injection

The `system.transform` hook prepends a workflow context block to every LLM call:

1. **State header** — current phase, sub-state, mode, feature name, progress indicator
2. **Phase-specific instructions** — loaded from `prompts/*.txt`
3. **Design document constraint** — if a design doc is tracked, a mandatory constraint block instructs the agent to read it before drafting (PLANNING, IMPL_PLAN, IMPLEMENTATION only)
4. **Sub-state context** — specific instructions for what to do next (call which tool)
5. **Blocked tools list** — which tool categories are blocked in this state
6. **Acceptance criteria** — at REVIEW state, the full criteria checklist (includes `[D]` criteria when design doc is tracked)

At USER_GATE, a routing hint is appended as an additional system block instructing the agent to route the user's message through `submit_feedback`.

**Agent-aware dormancy:** If `state.activeAgent` is set and not in `ARTISAN_AGENT_NAMES`, no prompt injection occurs.

### 13.4 Idle Handler

When the agent goes idle without completing a tool call, the `session.idle` event fires. The handler:
1. Checks if the current state expects activity (DRAFT, REVIEW, SCAN, ANALYZE, CONVENTIONS, REVISE — all should have the agent working). USER_GATE, ESCAPE_HATCH, MODE_SELECT, and DONE are expected idle states.
2. Re-prompts the agent with a state-specific nudge (e.g., "You are in DRAFT state. Call request_review when done.")
3. Tracks retries via `retryCount` — after `MAX_IDLE_RETRIES` (3), hard-escalates: shows a toast notification AND sends an in-session prompt telling the agent to stop and ask the user for help. Retry count resets so the agent gets fresh attempts after user input.
4. Uses a 10-second cooldown (`IDLE_COOLDOWN_MS`) to prevent cascading re-prompts

### 13.5 Compaction Hook

When OpenCode compacts the conversation, the `experimental.session.compacting` hook injects the current workflow state as structured context. This ensures the agent retains its workflow position after compaction.

---

## 14. Resolved Structural Gaps

These gaps were identified by comparing the simplified state machine against the original 40-state design. All five have been resolved as of schema v15.

### 14.1 Re-Entry Guard on `mark_task_complete` -- RESOLVED

**Implementation:** `taskCompletionInProgress: string | null` on WorkflowState (schema v14). Set to the task ID at the start of `mark_task_complete`, cleared in a `finally` block. Concurrent calls are rejected with an error message. This is a data guard that prevents race conditions on the DAG without requiring a state machine change.

### 14.2 Per-Task Drift -> Orchestrator Routing -- RESOLVED

**Implementation:** `task-drift.ts` dispatches a lightweight LLM alignment check after each task passes per-task review. The check compares planned vs actual implementation and proposes updated descriptions for downstream dependent tasks. If drift is detected, the DAG node descriptions are patched before persisting. If the check fails, graceful degradation accepts the task as-is. This restores the original `X_ALIGN -> O_ASSESS` structural guarantee procedurally.

### 14.3 Escape Hatch as PhaseState -- RESOLVED

**Implementation:** `ESCAPE_HATCH` is now a first-class PhaseState in the state machine. Transitions: `USER_GATE -> ESCAPE_HATCH` (via `escape_hatch_triggered`), `ESCAPE_HATCH -> REVISE` (via `user_feedback`). The state machine structurally prevents `user_approve` from ESCAPE_HATCH because that event is not in the transition table. All hooks (chat-message, idle-handler, compaction, tool-guard, system-transform) recognize ESCAPE_HATCH. Cross-field invariant: `escapePending && phaseState !== "ESCAPE_HATCH"` is a validation error.

### 14.4 Per-Task Review Iteration Cap -- RESOLVED

**Implementation:** `taskReviewCount: number` on WorkflowState (schema v15) + `MAX_TASK_REVIEW_ITERATIONS = 10` constant. Incremented on each `mark_task_complete` call. When the cap is reached, per-task review is bypassed and the task is accepted (the full implementation review at `request_review` catches issues). Counter resets to 0 when `currentTaskId` changes.

### 14.5 Crash-Safe Feedback Persistence -- RESOLVED

**Implementation:** `pendingFeedback: string | null` on WorkflowState (schema v15). Set before calling `handleEscapeHatch` or `handleNormalRevise` (which invoke `orchestrator.route()`), cleared in a `finally` block after the handler completes. If the process crashes during the orchestrator LLM call, the feedback text survives in persisted state.

### 14.6 Meta-Structural Improvements — Preventing Silent Guarantee Downgrades

**Problem:** The workflow allowed the agent to silently downgrade structural guarantees from a design document to "documented gaps" without the user explicitly approving that tradeoff. The five gaps in §14.1–14.5 were themselves examples: each was a structural guarantee from the design that the implementation agent converted to a procedural note. The root cause was that the workflow had no mechanism to make guarantee-weakening decisions visible.

**Approach:** Four improvements, all now implemented:

#### 14.6.1 Design Document as Tracked Artifact (Item 3)

`"design"` is a new `ArtifactKey`. The artifact graph conditionally includes a `design → plan` dependency edge when a design document is detected. Detection checks these paths in order: `.openartisan/<feature>/design.md` (if feature name set), `.openartisan/design.md`, `docs/design.md`, `DESIGN.md`, `design.md`, `docs/DESIGN.md`. Detection runs at plugin init and again at `select_mode` time when the feature name is known.

The design doc has no owning phase (it's user-authored). `getOwningPhase("design")` throws. `getReviseTarget("design")` routes to PLANNING as the nearest agent-controlled artifact.

**Files:** `artifacts.ts` (graph edges, topo order), `artifact-store.ts` (`detectDesignDoc()`), `index.ts` (wiring at init + select_mode), `orchestrator/llm-calls.ts` (ASSESS_SYSTEM_PROMPT).

#### 14.6.2 `[D]` Design-Invariant Criterion Severity (Item 2)

A new criterion severity: `"design-invariant"` (prefix `[D]`). Like `"blocking"`, unmet `[D]` criteria prevent phase advancement. Unlike `"blocking"`, `[D]` criteria are **non-rebuttable** — the rebuttal loop excludes them from `rebuttableCriteria`. This makes binary structural questions from the design document impossible to rationalize away.

**Files:** `types.ts` (severity type), `self-review.ts` (parsing + blocking logic), `tools/mark-satisfied.ts` (same), `index.ts` (rebuttal exclusion).

#### 14.6.3 Deviation Register in PLANNING Acceptance Criteria (Item 1)

When a design document is tracked, `[D]` acceptance criteria are injected into PLANNING, IMPL_PLAN, and IMPLEMENTATION phases. The PLANNING phase requires the agent to include a "Design Deviations" section classifying each deviation as **equivalent** (different approach, same protection), **downgraded** (structural → procedural, with risk note), or **deferred** (cut from this iteration). The deviation register is presented to the user at the approval gate.

A "Design Document — Mandatory Constraint" block is injected into the system prompt for these phases, instructing the agent to read the design doc before drafting and comply with its structural invariants.

**Files:** `hooks/system-transform.ts` (`getDesignInvariantCriteria()`, `getAcceptanceCriteria()` signature, system prompt injection).

#### 14.6.4 Architectural Alignment at IMPLEMENTATION Review (Item 4)

The `[D]` criteria for the IMPLEMENTATION phase (injected by `getDesignInvariantCriteria()`) include checks that the accumulated implementation matches the approved deviation register and that structural invariants from the design doc are enforced by mechanisms that cannot be bypassed in a single code change (transition tables, type constraints, required parameters) rather than procedural guards (boolean flags, if-statements, comments). The prompt gives concrete examples of each category to help the reviewer make consistent judgments. This is folded into the same mechanism as Item 1.

**Design principle:** The design doc is optional but incentivized. When present, structural guarantees activate automatically. When absent, the `[D]` criteria are not injected and the workflow proceeds normally.

---

## 15. Deferred — Parallel Execution

The original v6 design specified a full parallel execution engine with worktree branches, merge gates, and parallel abort. This is explicitly deferred pending the OpenCode async task dispatch API.

### 15.1 What's Deferred

| Feature | Description | Blocking On |
|---------|-------------|-------------|
| **DAG parallel dispatch** | Multiple tasks executing simultaneously via subagents | OpenCode async task dispatch API |
| **Worktree branches** | Each parallel task runs in its own `git worktree` branch | Parallel dispatch |
| **Merge gates** | Reconcile parallel branch outputs at convergence points | Worktrees |
| **Merge conflict resolution** | User-facing gate when auto-merge fails | Merge gates |
| **X_ALIGN alignment check** | Post-merge alignment against plan, interfaces, tests | Merge gates |
| **Parallel abort** | Cancel in-flight subagents when dependency graph is invalidated | Parallel dispatch |
| **`git reset --hard` rollback** | Escape hatch abort rolls back to last checkpoint | Risk assessment needed |

### 15.2 What's Already Built (Sequential)

The DAG infrastructure exists and is ready for parallel execution:
- `dag.ts` — `ImplDAG` with `getReady()`, `getReadyHumanGates()`, `getDependents()`, `isComplete()`
- `scheduler.ts` — `nextSchedulerDecision()` with dispatch/complete/blocked/awaiting-human actions
- `TaskNode` has `worktreeBranch` and `worktreePath` fields (defined, unused, reserved)
- `markTaskInFlight()` exists; cascading abort logic is inline in `index.ts` (sets task status to `"aborted"` and walks `dag.getDependents()`)

The current implementation dispatches one task at a time via the tool response from `mark_task_complete`. No worktrees, no merge gates.

### 15.3 Upstream Contributions Needed

| Contribution | Purpose | Status |
|-------------|---------|--------|
| `session.stopping` hook | Graceful subagent termination | Not pursued — `session.idle` used as workaround |
| Async task dispatch API | Fire-and-forget subagent sessions | Not pursued — sequential scheduling used |

---

## 16. Design Invariants

These must hold true at all times. Items marked *(procedural)* are enforced by code logic rather than the state machine structure. Items marked *(deferred)* require parallel execution.

1. **All feedback through orchestrator.** No feedback path bypasses assess → diverge → route.
2. **All iterations are revisions.** The state machine structurally rejects events that would produce DRAFT from REVISE/USER_GATE.
3. **Alignment at every task completion** *(procedural)*. Per-task review checks interface alignment and test regressions. Per-task drift check (task-drift.ts) updates downstream task descriptions when deviation is detected.
4. **Strategic pivots require user decision.** Escape hatch fires on cascade depth >= 3 (hard-coded) or LLM-classified strategic changes.
5. **Pivots update intent before cascading.** Intent baseline updated in the same `store.update()` as the REVISE transition.
6. **Revisions cascade through dependency graph.** `pendingRevisionSteps` + `cascadeAutoSkip` handle multi-step cascades.
7. **Parallel abort on dependency invalidation** *(deferred)*. Sequential execution eliminates the need.
8. **Git checkpoint on every user approval.** Tagged commits at every gate.
9. **Human gates and escape hatch are the only unplanned user touchpoints** (in artisan mode). Robot-artisan mode replaces user gates with auto-approval.
10. **Self-review uses isolated subagent sessions.** Hidden `workflow-reviewer` agent with `tools: { write: false, edit: false }` and `disallowedTools` list that explicitly blocks all workflow tool names plus `patch`, `create`, `overwrite`.
11. **Discovery constrains all subsequent phases.** Conventions document is a first-class artifact in the dependency graph.
12. **Incremental mode enforces a file allowlist.** Tool guard blocks writes to unlisted files.
13. **The plugin is dormant for non-artisan agents.** Agent-aware activation prevents interference with standard OpenCode usage.
14. **`.env` files are never writable.** The tool guard blocks writes to `.env` and `.env.*` in all phases, including IMPLEMENTATION.

---

## 17. Constants Reference

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `SCHEMA_VERSION` | 15 | `types.ts` | Schema forward-compatibility |
| `MAX_REVIEW_ITERATIONS` | 10 | `constants.ts` | Self-review loop cap before escalation |
| `MAX_TASK_REVIEW_ITERATIONS` | 10 | `constants.ts` | Per-task review iteration cap |
| `MAX_IDLE_RETRIES` | 3 | `constants.ts` | Idle re-prompt retries before escalation |
| `IDLE_COOLDOWN_MS` | 10,000 | `constants.ts` | Debounce between idle re-prompts |
| `SELF_REVIEW_TIMEOUT_MS` | 300,000 (5 min) | `constants.ts` | Self-review subagent timeout |
| `TASK_REVIEW_TIMEOUT_MS` | 180,000 (3 min) | `constants.ts` | Per-task review subagent timeout |
| `SCANNER_TIMEOUT_MS` | 180,000 (3 min) | `constants.ts` | Discovery scanner subagent timeout |
| `ORCHESTRATOR_TIMEOUT_MS` | 60,000 (1 min) | `llm-calls.ts` | Orchestrator LLM call timeout |
| `DRIFT_CHECK_TIMEOUT_MS` | 30,000 (30 sec) | `task-drift.ts` | Per-task drift check timeout |
| `AUTO_APPROVE_TIMEOUT_MS` | 120,000 (2 min) | `auto-approve.ts` | Auto-approver subagent timeout |
| `AUTO_APPROVE_CONFIDENCE_THRESHOLD` | 0.7 | `auto-approve.ts` | Minimum confidence for auto-approval |
| `MIN_SCANNERS_THRESHOLD` | 3 | `constants.ts` | Minimum successful scanners for discovery |
| `MAX_ARTIFACT_PATHS` | 20 | `constants.ts` | Cap on artifact file paths sent to reviewer |
| `MAX_CONVENTIONS_CHARS` | 12,000 | `constants.ts` | Conventions truncation in system prompt |
| `MAX_REPORT_CHARS` | 16,000 | `constants.ts` | Discovery report truncation in system prompt |
| `MAX_ARTIFACT_CONTENT_CHARS` | 10,000 | `constants.ts` | Inline artifact content truncation |
| `MAX_INTENT_BASELINE_CHARS` | 2,000 | `constants.ts` | Intent baseline text cap |
| `MAX_FEEDBACK_CHARS` | 2,000 | `constants.ts` | Feedback text cap |
| `MAX_SUMMARY_CHARS` | 500 | `constants.ts` | Summary text cap |
| `MAX_ESCAPE_FEEDBACK_CHARS` | 500 | `constants.ts` | Escape hatch feedback text cap |
| `MAX_TASK_DESCRIPTION_CHARS` | 100 | `constants.ts` | Task description text cap |
| `MAX_STEP_INSTRUCTION_CHARS` | 100 | `constants.ts` | Revision step instruction cap |
| `MAX_AMBIGUOUS_RESPONSE_LENGTH` | 15 | `constants.ts` | Escape hatch ambiguity detection threshold |

---

## 18. File Structure

```
.opencode/
├── agents/
│   ├── artisan.md                  # Primary agent — structured workflow with human gates
│   ├── robot-artisan.md            # Primary agent — autonomous workflow with AI gates
│   ├── workflow-reviewer.md        # Hidden subagent — isolated reviewer
│   ├── workflow-orchestrator.md    # Hidden subagent — orchestrator classify
│   └── auto-approver.md            # Hidden subagent — robot-artisan gate
└── plugins/
    └── open-artisan/
        ├── index.ts                # Plugin entry — hooks, tools, wiring
        ├── types.ts                # All interfaces, enums, schema
        ├── state-machine.ts        # Pure transition function
        ├── session-state.ts        # State persistence (JSON file store)
        ├── constants.ts            # All magic numbers
        ├── client-types.ts         # Typed plugin client interface
        ├── utils.ts                # Shared utilities
        ├── logger.ts               # TUI toast-based logger
        ├── vocabulary.ts           # Shared keyword sets
        ├── artifacts.ts            # Artifact dependency graph
        ├── artifact-store.ts       # Disk artifact writer
        ├── mode-detect.ts          # Auto-detection heuristics
        ├── dag.ts                  # DAG data structures + ImplDAG
        ├── impl-plan-parser.ts     # Markdown DAG parser
        ├── scheduler.ts            # Sequential task scheduler
        ├── self-review.ts          # Isolated self-review dispatch
        ├── task-review.ts          # Per-task review dispatch
        ├── auto-approve.ts         # Robot-artisan auto-approval dispatch
        ├── task-drift.ts           # Per-task alignment check after review
        ├── revision-baseline.ts    # Diff gate (REVISE entry snapshot)
        ├── hooks/
        │   ├── system-transform.ts # System prompt injection
        │   ├── chat-message.ts     # USER_GATE message detection
        │   ├── tool-guard.ts       # Phase-specific tool blocking
        │   ├── idle-handler.ts     # Idle re-prompt logic
        │   ├── compaction.ts       # Compaction context injection
        │   └── git-checkpoint.ts   # Git tag on approval
        ├── tools/
        │   ├── select-mode.ts      # Mode selection handler
        │   ├── mark-satisfied.ts   # Review criteria evaluation
        │   ├── request-review.ts   # Artifact submission + diff gate
        │   ├── submit-feedback.ts  # Feedback routing (approve/revise)
        │   ├── submit-feedback-handlers.ts  # Escape hatch, cascade, normal revise
        │   ├── mark-scan-complete.ts
        │   ├── mark-analyze-complete.ts
        │   ├── mark-task-complete.ts
        │   └── artifact-paths.ts   # Artifact path resolver
        ├── orchestrator/
        │   ├── route.ts            # Orchestrator routing logic
        │   ├── llm-calls.ts        # Assess/diverge LLM dispatch
        │   └── escape-hatch.ts     # Escape hatch presentation + classification
        ├── discovery/
        │   └── index.ts            # Discovery fleet dispatch (6 scanners)
        └── prompts/
            ├── discovery-refactor.txt
            ├── discovery-incremental.txt
            ├── planning.txt
            ├── interfaces.txt
            ├── tests.txt
            ├── impl-plan.txt
            └── implementation.txt

tests/
├── state-machine.test.ts
├── session-state.test.ts
├── validate-state.test.ts
├── index-integration.test.ts
├── system-transform.test.ts
├── chat-message.test.ts
├── phase-tool-policy.test.ts
├── idle-handler.test.ts
├── compaction.test.ts
├── self-review.test.ts
├── task-review.test.ts
├── select-mode.test.ts
├── mark-satisfied.test.ts
├── request-review.test.ts
├── request-review-gate.integration.test.ts
├── submit-feedback.test.ts
├── submit-feedback-handlers.test.ts
├── escape-hatch.test.ts
├── escape-hatch-wiring.test.ts
├── mark-scan-complete.test.ts
├── mark-analyze-complete.test.ts
├── mark-task-complete.test.ts
├── human-gates.test.ts
├── revision-baseline.test.ts
├── git-checkpoint.test.ts
├── mode-detect.test.ts
├── impl-plan-parser.test.ts
├── dag.test.ts
├── scheduler.test.ts
├── orchestrator.test.ts
├── llm-calls.test.ts
├── discovery-fleet.test.ts
├── artifact-graph.test.ts
├── artifact-paths.test.ts
└── utils.test.ts
```

**Test count:** 989 tests across 35 files (schema v15).

---

## 19. Comparison with Existing Approaches

| Dimension | Ralph Wiggum | Oh My OpenCode | Weave | Open Artisan |
|-----------|-------------|----------------|-------|-------------|
| Core pattern | `while(true)` loop | Multi-agent orchestration | Plan → Review → Execute | Phased state machine with dependency DAG |
| State tracking | None (infers from git) | Session-level | Plan file with checkboxes | 34-state machine persisted to JSON (schema v15) |
| Quality control | None structural | Approval-biased review | Single review pass | Iterative isolated self-review per phase with 7-dimension quality scoring (9/10 threshold) + per-task review |
| User involvement | Fire-and-forget | Interview mode at start | Plan approval | Up to 6 phase gates + escape hatch. Robot-artisan mode: fully autonomous with AI gates |
| Dependency tracking | None | None | None | Full artifact dependency graph with cascade |
| Backtracking | None (forward only) | None | None | Orchestrator routes to any upstream REVISE state |
| Divergence detection | None | None | None | LLM-based classification + hard cascade-depth trigger + escape hatch |
| Parallelism | None (single loop) | Background tasks | Sequential | Sequential (DAG infrastructure ready for parallel) |
| Git integration | Inferred from history | None structural | Checkpoint-based resume | Tagged commits per phase gate |
| Agent modes | Single agent | Multiple agents | Single agent | 5 agents: 2 primary (artisan, robot-artisan) + 3 hidden subagents |
| Existing project support | None | Codebase-aware via context files | None structural | Full discovery phase, 3 modes, do-no-harm directive with file allowlist |
