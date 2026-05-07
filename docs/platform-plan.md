# Open Artisan — Platform-Agnostic Refactor Plan

**Status:** Phases 1-4 complete. Phase 5a (Claude Code) complete. Phase 5b (Hermes) in progress. Phase 6 (Parallel DAG) next. Phase 7 (OpenClaw) last.

## Overview

Open Artisan started as an OpenCode-only plugin. This plan extracts the core engine into a platform-agnostic package and builds adapters for multiple AI coding agent platforms.

```
┌─────────────────────────────────────────────────────┐
│                   Platform Adapters                  │
│  ┌──────────┐  ┌──────────┐  ┌──────┐  ┌────────┐  │
│  │ OpenCode │  │  Claude   │  │Hermes│  │OpenClaw│  │
│  │ (in-proc)│  │  Code    │  │(py)  │  │(in-proc│  │
│  │          │  │ (hooks)  │  │      │  │  TBD)  │  │
│  └────┬─────┘  └────┬─────┘  └──┬───┘  └───┬────┘  │
│       │              │           │          │       │
│       │         ┌────┴───────────┴──┐       │       │
│       │         │   Bridge Server   │       │       │
│       │         │  (JSON-RPC 2.0)   │       │       │
│       │         └────────┬──────────┘       │       │
│       │                  │                  │       │
│  ┌────┴──────────────────┴──────────────────┴────┐  │
│  │              Core Engine (packages/core/)      │  │
│  │  State Machine · Session State · Tool Guard    │  │
│  │  Artifacts · Scheduler · Self-Review · Hooks   │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Phases

### Phase 1: Core Extraction ✅

Extracted platform-agnostic modules from the OpenCode plugin into `packages/core/`.

- State machine (`state-machine.ts`) — pure, side-effect-free FSM
- Session state (`session-state.ts`) — pluggable persistence via `StateBackend` interface
- Tool guard (`hooks/tool-guard.ts`) — phase-gated write restrictions
- System prompt builder (`hooks/system-transform.ts`)
- All tool handlers (`tools/*.ts`)
- Artifact dependency graph, scheduler, self-review, orchestrator, discovery
- Import aliases: `#core/*` → `packages/core/*`

### Phase 2: Concurrent Sessions ✅

Per-feature state files, pluggable persistence, file-level locking, session registry.

- `StateBackend` interface (read/write/remove/list/lock)
- `FileSystemStateBackend` with per-feature JSON files (`.openartisan/<featureName>/workflow-state.json`)
- `SessionRegistry` replacing ad-hoc session tracking
- Two-layer locking: in-process promise chains + cross-process lockfiles
- Schema v20: storage format migration from single-file to per-feature

### Phase 3: Nested Sub-Workflows ✅

Delegation of DAG tasks to independent child workflow sessions.

- `parentWorkflow` and `childWorkflows` fields on WorkflowState
- `"delegated"` TaskStatus (treated like in-flight for dependencies)
- Tools: `spawn_sub_workflow`, `query_parent_workflow`, `query_child_workflow`
- State nesting: `.openartisan/<parent>/sub/<child>/workflow-state.json`
- Timeout detection (`SUB_WORKFLOW_TIMEOUT_MS` = 30 min)
- Cascade abort sync when parent plan changes
- Schema v21 at delivery; current runtime schema is v24.

### Phase 4: Bridge Server ✅

JSON-RPC 2.0 server for out-of-process adapters.

- `packages/bridge/` — JSON-RPC methods over stdio or authenticated local Unix socket
- `createBridgeEngine` (transport-agnostic) + `createBridgeServer` / socket transport adapters
- Capabilities model: `{ selfReview, orchestrator, discoveryFleet }`
- OpenCode agent-review mode remains available; bridge adapters use isolated reviewer subprocesses for task and phase review submissions.
- Shared transition functions in `packages/core/tools/transitions.ts`
- PID file lifecycle, structured logging (pino), policy version tracking
- Schema v24: orchestrator-driven artifact tracking (`reviewArtifactFiles`, `expectedFiles` on DAG tasks) plus approved artifact-file provenance

### Phase 5a: Claude Code Adapter ✅

`packages/claude-code/` — hooks + CLI + Unix socket.

- **Transport:** Unix domain socket (`.openartisan/.bridge.sock`) for one-shot JSON-RPC from hook scripts
- **Guard enforcement:** PreToolUse hook (exit 2 = block). Per-task file restriction via `expectedFiles`.
- **Workflow tools:** `./artisan` CLI via Bash. JSON on stdin for complex args.
- **Prompt injection:** SessionStart hook (one-shot) + PreToolUse `additionalContext` (per-tool-call phase reminder)
- **Toggle:** `.enabled` file + `/artisan` skill (on/off/status)
- **Compaction:** PreCompact hook preserves workflow state
- Design doc: `packages/claude-code/README.md`

### Phase 5b: Hermes Agent Adapter 🔄 (in progress)

`packages/adapter-hermes/` — Python plugin + stdio subprocess.

- **Transport:** Bridge subprocess over stdin/stdout, with shared socket-token support when attaching to a Claude-hosted bridge
- **Guard enforcement:** Wrapper tools replacing built-in file-write handlers (hooks can't block in Hermes)
- **Workflow tools:** Native Hermes tools via `registry.register()` with `oa_` prefix
- **Prompt injection:** `pre_llm_call` hook returns `{"context": text}` — per-turn injection (better than Claude Code's one-shot)
- **Session lifecycle:** `on_session_start`/`on_session_end` hooks
- Design doc: `packages/adapter-hermes/README.md`

### Phase 6: Parallel DAG Execution 📋 (planned, next after 5b)

Concurrent task execution within the IMPLEMENTATION phase.

- `nextSchedulerDecisions()` returns batch of ready tasks (up to concurrency limit)
- `store.updateTask()` for atomic per-task DAG mutations (CAS)
- `WorktreeManager` interface: create/remove/merge/sweep
- Git worktree per parallel task, pre-warming at IMPL_PLAN approval
- `complete_parallel_task` tool with merge conflict resolution
- New `"blocked-merge"` TaskStatus (parent session resolves conflicts)
- Per-task timeout derived from `estimatedComplexity`
- Concurrency config: global `.openartisan/config.yaml` + per-feature override at `select_mode`

### Phase 7: OpenClaw Adapter 📋 (planned, after Phase 6)

In-process TypeScript plugin with capability-detected hooks. Details TBD — depends on OpenClaw's plugin API at implementation time.

## Key Architecture Decisions

### Bridge is the abstraction layer, not the adapters
Each adapter is idiomatic to its platform (Claude Code uses hooks+CLI, Hermes uses plugin tools+wrappers). The bridge JSON-RPC protocol is the consistency layer. Adapters don't share code — they share the protocol.

### Structural enforcement over advisory
Gates are enforced in code (tool guard, state machine transitions), not prompts. The agent cannot bypass the workflow through rationalization. Hooks block tool calls (Claude Code) or wrapper tools reject them (Hermes).

### Isolated review for bridge adapters
Claude Code and Hermes use `capabilities: { selfReview: "isolated", orchestrator: false, discoveryFleet: false }`. The bridge exposes tokenized review-context methods; adapter hooks spawn isolated reviewer subprocesses and submit `submit_task_review` / `submit_phase_review` with one-time review tokens. OpenCode keeps its native in-process subagent reviewer path.

### Per-task file enforcement (v24)
DAG tasks declare `expectedFiles` in the IMPL_PLAN. The tool guard restricts writes to the current task's files. `mark_task_complete` accumulates files into `reviewArtifactFiles` for the reviewer. No directory scanning heuristics.

### self_review_fail → REVISE (not REVIEW loop)
When the reviewer rejects, the agent goes to REVISE (not back to REVIEW). The agent can do actual work in REVISE, then call `request_review` to re-enter REVIEW. This also enables `propose_backtrack` from REVISE.

## Current Test Count

`bun run verify:all` runs generated-artifact checks, TypeScript typecheck, whitespace diff checks, Bun tests, core package tests, bridge package tests, PGlite repository tests, and Hermes pytest coverage.

## File Structure

```
packages/
  core/                     Platform-agnostic engine
    workflow-state-types.ts Schema v24, WorkflowState, interfaces
    state-machine.ts        34-state FSM, 12 transition events
    session-state.ts        Pluggable persistence, migrations
    state-backend-fs.ts     FileSystem backend
    hooks/                  system-transform, tool-guard, idle, compaction, chat-message
    tools/                  Tool handlers and shared transition logic
    scheduler.ts            Sequential DAG scheduler
    dag.ts                  TaskNode with expectedFiles
    self-review.ts          Isolated reviewer dispatch
    artifacts.ts            7-artifact dependency graph
    constants.ts            PHASE_ORDER, limits, timeouts
    ...

  bridge/                   JSON-RPC 2.0 server
    server.ts               createBridgeEngine + createBridgeServer
    protocol.ts             Method types, capabilities, GuardCheckResult
    cli.ts                  Stdio entry point
    methods/                lifecycle, state, guard, prompt, message, idle, tool-execute
    pid-file.ts             PID lifecycle
    structured-log.ts       Pino logger with traceId

  claude-code/              Claude Code adapter
    bin/                    artisan-server, artisan (CLI), artisan-hook, artisan-setup
    src/                    socket-transport, hook-handlers, constants
    templates/              CLAUDE-WORKFLOW.md, settings.json.tmpl, SKILL.md

  adapter-hermes/           Hermes Agent adapter (Python)
    hermes_adapter/         Plugin source (bridge_client, workflow_tools, guard_wrappers, prompt_hook)
    plugin.yaml             Hermes manifest
    tests/                  Python tests

.opencode/plugins/open-artisan/   OpenCode adapter (reference implementation)
  index.ts                        3900+ lines, all hooks + tools

docs/
  structured-workflow-design.md   Engine design doc (current schema v24)
  structured-workflow-implementation-plan.md   Original implementation roadmap
  platform-plan.md                This file
```
