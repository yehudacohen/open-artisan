# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Open Artisan is an OpenCode plugin that enforces a phased, quality-gated workflow on AI coding agents. It wraps agents in a table-driven finite state machine that enforces eight sequential phases (MODE_SELECT → DISCOVERY → PLANNING → INTERFACES → TESTS → IMPL_PLAN → IMPLEMENTATION → DONE), each with independent isolated review before advancing.

## Commands

```bash
# Install dependencies (both root and plugin)
bun install && cd .opencode && bun install && cd ..

# Run all tests (uses the repo's split runner for PGlite-heavy files)
bun run test

# Run a single test file
bun test tests/state-machine.test.ts

# Watch mode
bun test --watch

# Debug logging (set before running opencode)
OPENARTISAN_DEBUG=1 opencode
```

There is no build step — the plugin loads TypeScript directly via Bun.

## Architecture

### Plugin Entry Point & Wiring

`index.ts` registers all hooks and tools with the OpenCode SDK. Hooks intercept system prompts, tool calls, idle events, and compaction. Tools drive phase transitions.

### State Machine (`state-machine.ts`)

Pure, side-effect-free table-driven FSM. 34 valid (Phase, PhaseState) combinations, 12 named transition events. All phase progression goes through `transition()` which validates current state before advancing. The transition table is built in `buildTable()`.

### Session State (`session-state.ts`, `state-backend-fs.ts`, `open-artisan-state-backend-db.ts`)

Pluggable persistence via `StateBackend` interface (read/write/remove/list/lock). The default runtime backend is the PGlite-backed repository (`.openartisan/open-artisan.db`) exposed through `open-artisan-state-backend-db.ts`; `FileSystemStateBackend` remains the explicit legacy/fallback backend and stores per-feature state at `.openartisan/<featureName>/workflow-state.json`. Current workflow-state schema is v24, with migrations for prior versions. Sub-workflow state nests under parent feature state. Sessions without a featureName (pre-MODE_SELECT) are memory-only. Two-layer locking combines per-feature promise chains with backend locks; persisted updates re-read the latest backend snapshot while holding the backend lock before mutating. `validateWorkflowState()` runs before every persist.

### Session Registry (`session-registry.ts`)

`SessionRegistry` interface tracks session lifecycle and parent-child relationships. Primary sessions get their own WorkflowState; child sessions (subagent reviewers, orchestrator, discovery) inherit the parent's tool policy. Replaces the ad-hoc `activeSession` wrapper and `childSessionParents` Map on EngineContext.

### Hooks (`hooks/`)

- **`system-transform.ts`** — Injects phase-specific prompt instructions into the system message
- **`tool-guard.ts`** — Restricts file writes per phase (e.g., INTERFACES phase → only type files; TESTS → only test files). Default blocks all writes; new phases must be explicitly handled
- **`idle-handler.ts`** — Re-prompts the agent after 10s idle (MAX_IDLE_RETRIES = 3)
- **`git-checkpoint.ts`** — Creates tagged commits (`workflow/<phase>-v<N>`) at approval gates
- **`compaction.ts`** — Summarizes conversation for long sessions
- **`chat-message.ts`** — USER_GATE hint injection

### Tools (`tools/`)

Each tool validates state, calls `transition()`, and updates session state. Key tools: `select_mode`, `mark_scan_complete`, `mark_analyze_complete`, `mark_satisfied`, `request_review` (accepts `artifact_files` for file-based phases), `submit_feedback`, `mark_task_complete` (accumulates DAG `expectedFiles` into `reviewArtifactFiles`), `spawn_sub_workflow`, `query_parent_workflow`, `query_child_workflow`. Tool names must be added to `WORKFLOW_TOOL_NAMES` in `index.ts` so the tool guard allows them (currently 13 tools).

### Artifact Dependency Graph (`artifacts.ts`)

7 artifacts (design, conventions, plan, interfaces, tests, impl_plan, implementation) connected by 12 dependency edges forming a DAG. Revising an upstream artifact triggers cascading re-validation of all downstream dependents.

### Orchestrator (`orchestrator/`)

Two-stage LLM classification of user feedback: assess (which artifacts affected) → diverge (tactical vs strategic). Tactical feedback is handled by the agent; strategic feedback escalates via escape hatch. Cascade depth ≥ 3 forces escalation.

### Discovery (`discovery/`)

Six parallel scanner subagents analyze the existing codebase (structure, conventions, architecture, test patterns, history, docs). 3-minute timeout per scanner, at least 3 of 6 must succeed.

### Implementation DAG (`dag.ts`, `impl-plan-parser.ts`, `scheduler.ts`)

The IMPL_PLAN artifact is parsed from Markdown into a task DAG. Each task declares `expectedFiles` (the files it will create/modify) via the `**Files:**` metadata field. Sequential scheduler executes tasks with per-task review (`task-review.ts`) and drift detection (`task-drift.ts`). TaskStatus values: `pending`, `in-flight`, `complete`, `aborted`, `human-gated`, `delegated`. Delegated tasks are handled by child sub-workflows — downstream tasks block until the delegation completes or times out (`SUB_WORKFLOW_TIMEOUT_MS` = 30 min).

### Sub-Workflows (`tools/spawn-sub-workflow.ts`, `tools/query-workflow.ts`, `tools/complete-sub-workflow.ts`)

`spawn_sub_workflow` delegates a DAG task to an independent child session that runs its own MODE_SELECT → DONE cycle. Child state nests under parent on disk (`.openartisan/<parent>/sub/<child>/`). Parent tracks children via `childWorkflows` array; child links back via `parentWorkflow` field. `query_parent_workflow` / `query_child_workflow` provide read-only cross-workflow inspection. Child completion automatically propagates to parent (delegated → complete). Timeout and cascade-abort sync children when parent's plan changes.

### Bridge Server (`packages/bridge/`)

JSON-RPC 2.0 server over stdio using the `json-rpc-2.0` library. Wraps the core engine for out-of-process adapters (Claude Code, Hermes). 13 methods: lifecycle (init/ping/shutdown/sessionCreated/sessionDeleted), state.get, guard (check/policy), prompt (build/compaction), message.process, idle.check, tool.execute. PID file at `.openartisan/.bridge-pid` with stale detection. Structured logging via pino with traceId correlation. Entry point: `packages/bridge/cli.ts`.

### Review (`self-review.ts`, bridge isolated reviewers)

OpenCode dispatches an ephemeral `workflow-reviewer` subagent in a fresh session that sees only the artifact and acceptance criteria — never the authoring conversation. Bridge adapters (Claude Code, Hermes) dispatch isolated reviewer subprocesses and require one-time bridge-local review tokens for `submit_task_review` and `submit_phase_review`. 5-minute timeout, escalates to USER_GATE after 10 iterations.

**Artifact tracking (v24):** The reviewer receives explicit file paths from the orchestrator, not heuristic directory scans. For IMPLEMENTATION, file paths accumulate automatically from each DAG task's `expectedFiles` at `mark_task_complete` time. For INTERFACES/TESTS, the agent passes `artifact_files` in `request_review`. The reviewer also always sees `artifactDiskPaths` (plan, conventions, impl_plan locations) for cross-reference.

### Three Modes

- **GREENFIELD** — Discovery skipped, no constraints
- **REFACTOR** — Full 6-scanner discovery, existing tests must pass
- **INCREMENTAL** — Full discovery + file allowlist + do-no-harm policy (bash write operators blocked)

## Key Conventions

- **Import alias**: `#plugin/*` maps to `.opencode/plugins/open-artisan/*`, `#core/*` maps to `packages/core/*`, `#bridge/*` maps to `packages/bridge/*` (configured in package.json imports + bunfig.toml)
- **TypeScript strict mode** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- **All constants** live in `constants.ts` — no magic numbers/strings in other files
- **Result types** use discriminated unions: `{ success: true; data: T } | { success: false; error: string }`
- **Naming**: `create*` (factories), `dispatch*` (subagent calls), `build*` (string construction), `handle*` (event handlers)
- **Gates must be structural, not advisory** — enforce in state machine or tool guard, never rely on prompts alone
- **Test mocks**: Only mock the OpenCode SDK. Tests preload `tests/__mocks__/register-opencode-plugin.ts` via bunfig.toml

## Modifying the State Machine

1. Update transition table in `state-machine.ts` `buildTable()`
2. Update `VALID_PHASE_STATES` in `types.ts` if adding new phase/state combinations
3. Update `validateWorkflowState()` in `types.ts` for any new state fields
4. Bump `SCHEMA_VERSION` in `types.ts` and add migration logic in `session-state.ts`
5. Add transition tests in `tests/state-machine.test.ts`
6. Update `docs/structured-workflow-design.md`

## Debugging

- Errors/warnings always persist to `.openartisan/openartisan-errors.log` (JSON lines) regardless of debug flag
- OpenCode SDK logs: `~/.local/share/opencode/log/`
- Commit style: conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`)

@include CLAUDE-WORKFLOW.md
