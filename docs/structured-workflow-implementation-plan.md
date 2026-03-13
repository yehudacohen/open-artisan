# Structured Coding Workflow — OpenCode Plugin Implementation Plan

**Version:** v6 — Workflow Modes · Discovery Phase · DAG Execution · Merge Gates · Parallel Abort · Git Checkpoints
**State Machine:** 40 states (34 greenfield) · Up to 6 phase gates · 1 escape hatch · DAG parallel execution
**Date:** March 2026

---

## 1. Overview

This plugin enforces a phased, quality-gated development workflow on OpenCode's AI coding agent. It takes the agent from plan through implementation with self-review loops, user gates, dependency-aware orchestration, divergence detection, DAG-based parallel execution, and git checkpoints at every approval point.

The plugin is designed to be built incrementally in four layers, each independently valuable.

| Layer | Scope | Estimate | Depends On |
|-------|-------|----------|------------|
| 1. Sequential Phases | Mode selection, discovery phase (existing projects), phase state machine, user gates, git checkpoints, tool-blocking (with file allowlist for incremental mode), system prompt steering, compaction resilience | 2–3 weeks | None |
| 2. Orchestrator | Unified feedback routing, dependency graph, change plan builder, divergence detection, escape hatch, intent tracking | 1–2 weeks | Layer 1 |
| 3. Subagent Self-Review | Isolated reviewer sessions, per-phase acceptance criteria, structured review output | 1 week | Layer 1 |
| 4. DAG Execution Engine | DAG scheduler, parallel subagent dispatch, worktree branches, merge gates, auto-reconciliation, parallel abort | 2–3 weeks | Layers 1–3 |

**Total estimated effort:** 6–11 weeks for the full system, with Layer 1 shippable independently.

---

## 2. Design Invariants

These are non-negotiable. Every implementation decision should be validated against this list.

1. **All feedback through orchestrator.** No feedback path bypasses O_ASSESS. User review, self-review issues, alignment drift, merge conflict resolution — all enter the orchestrator.
2. **All iterations are revisions.** O_ROUTE only targets REVISE states, never DRAFT states. Every iteration preserves prior work.
3. **Alignment checked at every merge point.** X_ALIGN runs after every merge gate and after every sequential task completion.
4. **Strategic pivots require user decision.** O_DIVERGE classifies changes as tactical (autonomous) or strategic (user decision required).
5. **Pivots update intent before cascading.** O_INTENT_UPDATE fires before O_PLAN so future divergence checks compare against the updated baseline.
6. **Revisions cascade through dependency graph.** Revising an upstream artifact marks all downstream dependents for re-validation.
7. **Parallel abort on dependency invalidation.** If a revision makes previously-independent tasks dependent, in-flight tasks are aborted and rescheduled.
8. **Git checkpoint on every user approval.** Tagged commit per phase gate. Worktree branches per parallel task. Merge commits at convergence.
9. **Merge conflicts and escape hatch are the only unplanned user touchpoints.** Everything else runs autonomously.
10. **Self-review uses isolated subagent sessions.** The reviewer sees only the artifact and acceptance criteria, never the authoring conversation.
11. **Discovery constrains all subsequent phases (existing-project modes).** The conventions document is a first-class artifact in the dependency graph. Every subsequent phase's acceptance criteria and system prompt include conventions compliance.
12. **Incremental mode enforces a file allowlist.** Only files identified in the approved plan can be written or edited. The tool guard blocks all other file modifications.
13. **Do no harm in incremental mode.** Existing conventions are respected, existing tests must continue to pass, no refactoring outside the scope of the requested change.

---

## 3. Feasibility Against OpenCode's Plugin Model

Before diving into implementation steps, this section maps every required capability to a specific OpenCode hook or API, flags risks based on a review of OpenCode's open issues and PRs, and identifies contribution opportunities.

### 3.1 Confirmed Capabilities (Official API)

| Capability | Hook / API | Notes |
|-----------|-----------|-------|
| Inject phase instructions into system prompt | `experimental.chat.system.transform` | Officially documented. Mutates the system prompt array. Safety fallback restores original if plugin empties the array. |
| Block tools by phase | `tool.execute.before` | Officially documented. Throwing an error blocks the tool and feeds the error message back to the LLM. |
| Track session lifecycle | `session.created`, `session.deleted`, `session.idle` events | Officially documented via the `event` handler. |
| Inject context without triggering response | `client.session.prompt({ noReply: true })` | Confirmed in SDK docs and multiple community plugins. |
| Re-prompt agent on premature stop | `client.session.prompt({ noReply: false })` on `session.idle` | Standard pattern. Used by Oh My OpenCode's continuation enforcer. Known race condition in `opencode run` mode (issue #15267) — safe in TUI mode. |
| Register custom tools | `tool: { ... }` in plugin return object | Officially documented. Zod schema validation. Tools available alongside built-ins. |
| Preserve state on compaction | `experimental.session.compacting` | Officially documented. Can inject context or replace compaction prompt entirely. Note: auto-compaction has reliability issues with Anthropic models (issue #6068) — manual compaction still works. |
| Intercept user messages | `chat.message` hook | Officially documented. `output.parts` array is mutable — can modify messages before they reach the agent. |
| Mutate full message history | `experimental.chat.messages.transform` | Confirmed in prompt construction pipeline analysis. Last-chance mutation before LLM call. |
| Execute shell commands | `$` (Bun shell API) from plugin context | Officially documented. Used for git operations. |
| Dispatch subagent with isolated context | `task` tool / `client.session.prompt` to new session | Subagents run in their own context window with separate tools and system prompt. Context isolation confirmed (issue #5502). |
| Structured JSON output from subagent | `format: { type: "json_schema", schema: {...} }` in prompt body | SDK supports structured output with JSON Schema validation and retry on failure. Merged via PR #8161. |
| TUI toast notifications | `client.tui.showToast` | Confirmed in SDK and community plugins. Useful for phase transition notifications. |
| Abort a session programmatically | `session.abort()` via SDK | Confirmed in issue #11225 — the SDK exposes `session.abort()`. Critical for our parallel abort mechanism. |
| Structured logging | `client.app.log` | Officially documented with debug/info/warn/error levels. |

### 3.2 Gaps and Workarounds

| Capability | Issue | Workaround | Contribution Opportunity |
|-----------|-------|------------|-------------------------|
| **Prevent agent from stopping prematurely** | No official `stop` hook. This is the single most-requested missing feature for workflow plugins. Issue #12472 explicitly states: "Stop hook re-activation requires OpenCode core support — plugins can't force the agent to resume from session.idle." The `session.idle` event is fire-and-forget with no return value mechanism. | Detect `session.idle` and re-prompt with `client.session.prompt`. Cap at 3 retries per state. Known race condition in `opencode run` mode (#15267). Produces visible re-prompt in conversation (minor UX jank). | **HIGH VALUE CONTRIBUTION: Add a `session.stopping` hook** that allows plugins to return `{ continue: true, message: "..." }` to prevent the agent from stopping and inject a continuation prompt. This is a small, well-scoped change to `packages/opencode/src/session/prompt.ts` — before emitting `session.idle`, check plugin stop hooks and re-enter the prompt loop if any return `continue: true`. This single change would eliminate our biggest workaround AND benefit Ralph Wiggum, Oh My OpenCode, and every other continuation-based plugin. |
| **User gate hard stop** | No native "wait for user at checkpoint" concept in TUI. | Agent calls `request_review` custom tool which returns a message asking for user input. Plugin detects next `chat.message` as the user's response and routes through orchestrator. | Low priority. The workaround is adequate — this is how Oh My OpenCode's interview mode already works. |
| **Present structured options to user** | A full `Question` system already exists: `src/question/index.ts`, `src/tool/question.ts`, `/question` server routes. The `question` tool lets the LLM ask structured multiple-choice questions that render in the TUI via `DialogSelect` and block until the user answers. Plugins can call `client.question.*` via the SDK. | Use the `question` tool directly from the agent prompt -- no workaround needed. | **No contribution needed -- already implemented.** |
| **Async parallel subagent dispatch** | Subagent delegation via `task` tool is synchronous/blocking. No native fire-and-forget. Actively requested in issues #15069 and #5887. PR #7756 adds subagent-to-subagent delegation with budgets and hierarchical navigation but doesn't add async dispatch. | Use `client.session.prompt` directly to manage parallel sessions from the plugin (bypassing the `task` tool). Poll `session.idle` events or use `session.status` for completion tracking. Oh My OpenCode's BackgroundTaskManager uses this approach with provider-aware rate limiting. | **HIGH VALUE CONTRIBUTION: Add async task dispatch** with `Task.dispatch()` returning immediately with a task ID, and `Task.status()`/`Task.getResult()` for polling. This is the exact API proposed in #15069. Would require changes to `packages/opencode/src/tool/task.ts`. |
| **Clean subagent cancellation** | `session.abort()` exists in the SDK but the abort cascade from parent to child has issues. Issue #11225 shows orphan processes after abort. Issue #13841 shows subagents hanging with no timeout — the documented 300s timeout is never applied because the config schema uses `.optional()` with no `.default()`. | Use `session.abort()` for cancellation + signal file as fallback. Apply a timeout wrapper around subagent dispatch. | **SMALL CONTRIBUTION: Fix the timeout default** in `packages/opencode/src/config.ts` — change the `timeout` field from `.optional()` to `.optional().default(300000)`. One-line fix that resolves #13841 and prevents indefinite subagent hangs. |
| **Git worktree management** | Plugin needs to create/merge/remove git worktrees programmatically. | Achievable via `$` (Bun shell). Error handling for merge conflicts requires parsing git output. | Not an OpenCode contribution — this is plugin-level implementation. Consider using `simple-git` as a dependency. |

### 3.3 Known Bugs That Affect Us

These are existing OpenCode issues we should monitor or work around:

| Issue | Impact on Our Plugin | Status |
|-------|---------------------|--------|
| **#15267: Race condition between session.idle and continuation** | Our idle handler re-prompt could race with `opencode run` teardown, producing empty assistant turns. | Open. Workaround: detect `opencode run` mode and disable idle handler, or add a small delay before re-prompting. |
| **#6068: Auto-compaction not triggering reliably with Anthropic models** | Long sessions may hit "prompt too long" errors before our compaction hook fires. | Open. Workaround: monitor token usage via `chat.params` hook and trigger manual compaction via command if approaching limit. |
| **#6573: Sessions hang when Task tool spawns subagents via REST API** | If using `opencode serve` mode for our parallel dispatch, subagent sessions may hang indefinitely. Works fine in TUI mode. | Open. Workaround: use TUI mode for Layer 4, or poll aggressively with timeout. |
| **#9674: tool_call tag rendering failure in long sessions** | After long sessions with Oh My OpenCode, tool call rendering can fail. Our custom tools could be affected. | Open. Workaround: `/compact` command resolves it. Our compaction hook may help prevent it. |
| **#5695: Session deletion triggers session list pop-over** | Cleaning up reviewer subagent sessions will flash the session picker UI. | Open. Workaround: don't delete reviewer sessions immediately — batch cleanup on session.deleted of the parent. |

### 3.4 Recommended Contributions (Ordered by Impact)

We recommend contributing these changes to OpenCode before or during plugin development:

**1. `session.stopping` hook (HIGH IMPACT, SMALL SCOPE)**

The single most impactful change for our plugin and the entire workflow plugin ecosystem. Before the session prompt handler emits `session.idle`, it should call a `session.stopping` plugin hook. If any hook returns `{ continue: true, message: "..." }`, the prompt loop re-enters with the injected message instead of going idle.

This eliminates the re-prompt workaround, the race condition in #15267, and the UX jank of visible continuation messages. It's the same pattern as Claude Code's Stop hook (exit code 2 → inject stderr as prompt and continue).

Estimated scope: ~50 lines in `packages/opencode/src/session/prompt.ts`.

**2. Subagent timeout default fix (HIGH IMPACT, TRIVIAL SCOPE)**

One-line change in `packages/opencode/src/config.ts`: change the timeout schema field from `.optional()` to `.optional().default(300000)`. This prevents indefinite subagent hangs (#13841, #11865) which are a critical risk for our Layer 4 parallel execution.

Estimated scope: 1 line.

**3. Async task dispatch (HIGH IMPACT, MEDIUM SCOPE)**

Add `Task.dispatch()` that returns immediately with a task ID, plus `Task.status()` and `Task.getResult()` for polling. This would replace our workaround of manually managing parallel sessions via `client.session.prompt`. The API is already specified in #15069.

Estimated scope: ~200 lines in `packages/opencode/src/tool/task.ts` + SDK type updates.

#### Async Task Dispatch — Research Notes (from reading `task.ts` and `prompt.ts`)

**Current flow (synchronous):**
```
task tool execute()
  → Session.create()        // creates child session
  → SessionPrompt.prompt()  // BLOCKS until child session finishes
  → returns text output
```

The entire parent loop is blocked at `prompt.ts:453` (`await taskTool.execute(...)`) until the subagent completes. There is no way for a parent agent to fire-and-forget a subagent and continue other work.

**How the existing sync path works in detail:**

1. `task.ts:72` — `Session.create()` creates a child session with `parentID: ctx.sessionID`
2. `task.ts:128` — `SessionPrompt.prompt()` runs the full agent loop synchronously and returns the final `MessageV2.WithParts`
3. The abort cascade (`task.ts:121-124`) only fires when the parent's `ctx.abort` signal fires — so the child runs to completion unless the user manually cancels
4. `prompt.ts:121-124` in the `loop()` function — the `state()` map tracks in-flight session IDs; `cancel()` aborts them
5. The result output (`task.ts:145-162`) is built from the final message text only

**Proposed async API design:**

There are two implementation approaches:

**Option A: New `task_dispatch` tool (separate from `task`)** — Cleanest. Doesn't change `task` semantics. The new tool returns a `task_id` immediately, and the agent can later call `task_status` / `task_result`. Downside: requires the LLM to manage task IDs explicitly, which is more complex for the LLM to use correctly.

**Option B: `async: true` parameter on existing `task` tool** — Backward-compatible. Add `async: z.boolean().optional()` to the existing `task` parameter schema. When `async: true`, the tool starts the session and returns immediately with `task_id`. Status polling can be a new `task_status` tool. Downside: slightly complicates the existing tool's execute path.

**Option C: `task.dispatch()` / `task.status()` as internal module functions** — Not an LLM-visible API; instead a plugin-callable API via the SDK. Allows our plugin to dispatch subagents without going through the LLM tool call mechanism. This would be a new SDK method on the client.

**Recommended: Option B** for LLM-visible API because:
- It's backward-compatible (existing task calls unchanged)
- Single tool for LLM to learn
- Already aligned with what issue #5887 and #15069 describe
- Natural extension of the existing `task_id` resume pattern

**Minimal implementation for Option B:**

In `task.ts`, add `async: z.boolean().optional()` to `parameters`. In the `execute` function, after `Session.create()`, if `async === true`:
1. Start `SessionPrompt.prompt()` without awaiting — store the promise in a module-level `Map<sessionID, Promise<...>>`
2. Return immediately with `output: "task_id: ${session.id} (async, use task_status to check)"` 
3. Add a new `TaskStatusTool` that looks up the session's status via `SessionStatus.get(sessionID)` and whether the promise has resolved

Key complexity: The module-level promise map needs to be scoped to the `Instance` (not global) to avoid cross-session leakage — same pattern as `SessionPrompt.state()` which uses `Instance.state()`.

**Files to change:**
- `packages/opencode/src/tool/task.ts` — add `async` param, split execute into sync/async paths, store async promises in `Instance.state()`
- New file: `packages/opencode/src/tool/task-status.ts` — the `task_status` tool
- `packages/opencode/src/tool/registry.ts` — register `task-status` tool
- `packages/opencode/src/session/prompt.ts` — (maybe) expose a way to check if a session promise is pending
- `packages/plugin/src/index.ts` — no changes needed (tools are separate from hooks)

**Issue to link to:** #5887 ("True Async/Background Sub-Agent Delegation") — open, unlabeled, describes exact use case.

**4. TUI choice widget for plugins -- ALREADY EXISTS, no contribution needed**

The `Question` system (`src/question/index.ts`, `src/tool/question.ts`) already provides exactly this. The LLM can call the `question` tool with structured options and the TUI renders a `DialogSelect` widget. The plugin SDK exposes `client.question.*` for the reply/reject lifecycle. This removes contribution #4 from the backlog entirely.

### 3.5 Feasibility Verdict

**Layers 1–3 are fully feasible today.** Every hook is documented and confirmed. The only workaround is `session.idle` re-prompting instead of a native stop hook — annoying but functional.

**Layer 4 is feasible with workarounds, but risky.** The parallel execution depends on managing sessions directly via the SDK, `session.abort()` for cancellation, and timeout wrappers around subagent dispatch. Multiple open bugs (#6573, #13841, #11865) show that subagent lifecycle management has rough edges. Building Layer 4 after contributing the timeout fix (#2 above) and ideally the async task dispatch (#3) would significantly reduce risk.

**Contributing the `session.stopping` hook (#1 above) before starting development would improve every layer.** It's the single highest-leverage change — small in scope, eliminates our biggest workaround, and benefits the entire OpenCode plugin ecosystem.

---

## 4. Layer 1: Sequential Phases + Git Checkpoints

### 4.1 File Structure

```
.opencode/
├── plugins/
│   └── structured-workflow/
│       ├── index.ts                    # Plugin entry, registers all hooks
│       ├── state-machine.ts            # Phase enum, transitions, validation
│       ├── session-state.ts            # Map<sessionId, WorkflowState>
│       ├── artifacts.ts                # Artifact registry and dependency graph
│       ├── mode-detect.ts              # Auto-detection of greenfield vs existing
│       ├── hooks/
│       │   ├── system-transform.ts     # experimental.chat.system.transform
│       │   ├── chat-message.ts         # chat.message — intercept user feedback
│       │   ├── tool-guard.ts           # tool.execute.before — phase gating + file allowlist
│       │   ├── idle-handler.ts         # session.idle — auto-continue
│       │   ├── compaction.ts           # experimental.session.compacting
│       │   └── git-checkpoint.ts       # Commit + tag on approval
│       ├── tools/
│       │   ├── select-mode.ts          # User selects greenfield/refactor/incremental
│       │   ├── mark-satisfied.ts       # LLM signals self-review passed
│       │   ├── request-review.ts       # LLM signals readiness for user gate
│       │   └── submit-feedback.ts      # Structured feedback classification
│       ├── discovery/
│       │   ├── structure-scanner.ts    # File tree, module boundaries
│       │   ├── convention-detector.ts  # Style rules, naming, imports
│       │   ├── architecture-analyzer.ts # Module deps, abstractions (LSP or grep)
│       │   ├── test-scanner.ts         # Test framework, patterns, coverage
│       │   ├── history-analyzer.ts     # Git log, active areas, contributors
│       │   └── docs-reader.ts          # AGENTS.md, README, CONTRIBUTING
│       └── prompts/
│           ├── discovery-refactor.txt
│           ├── discovery-incremental.txt
│           ├── planning.txt
│           ├── interfaces.txt
│           ├── tests.txt
│           ├── impl-plan.txt
│           └── implementation.txt
├── agents/
│   ├── workflow-builder.md             # Full write permissions within phase
│   └── workflow-reviewer.md            # Read-only, critical evaluation focus
└── package.json                        # @opencode-ai/plugin dependency
```

### 4.2 Step 0: Mode Selection (MODE_SELECT)

The first state in every session. Determines which workflow mode applies.

- **Auto-detection:** Check `git log --oneline -1` and file count. If repo has commits and source files → default to "existing project" (prompt user: refactor or incremental). If empty/near-empty → default to greenfield.
- **Custom tool:** Register `select_mode` with options: greenfield, refactor, incremental. User can override auto-detection.
- **Greenfield:** Transition directly to P_DRAFT. Skip discovery.
- **Refactor or Incremental:** Transition to D_SCAN.
- **Mode stored in WorkflowState** and read by all subsequent hooks.

### 4.3 Steps 1–3: Discovery Phase (D_SCAN → D_ANALYZE → D_CONVENTIONS → D_USER)

**Step 1: D_SCAN** — Dispatch parallel read-only explorer subagents:

- **Structure scanner:** `glob`, `list`, `bash` (tree, wc -l) → file tree, module boundaries, file counts by type
- **Convention detector:** `grep`, `read` (lint configs, .editorconfig, tsconfig) → style rules, naming, imports
- **Architecture analyzer:** LSP `documentSymbol`, `workspaceSymbol`, `findReferences` (or grep/read fallback) → module deps, abstractions
- **Test scanner:** `glob` (test files), `read` (runner config), `bash` (framework detection) → test framework, patterns, coverage
- **History analyzer:** `bash` (git log, git shortlog, git blame) → commit patterns, active areas, contributors
- **Docs reader:** `read` (AGENTS.md, README.md, CONTRIBUTING.md, docs/) → existing conventions, setup, architecture docs

**Step 2: D_ANALYZE** — Synthesize scan results. In refactor mode: produce assessment (what exists, what's wrong, target state). In incremental mode: produce conventions document (rules the agent must follow).

**Step 3: D_CONVENTIONS + D_USER** — Agent drafts conventions document → self-review (isolated subagent) → user gate. Approval triggers git checkpoint (`workflow/conventions-v1`). All feedback routes through O_ASSESS.

### 4.4 Step 4: State Machine Core

Implement as a pure TypeScript module with no plugin API dependency. Testable in isolation.

**WorkflowState type:**
- `mode`: Workflow mode enum (GREENFIELD, REFACTOR, INCREMENTAL)
- `phase`: Current phase enum (MODE_SELECT, DISCOVERY, PLANNING, INTERFACES, TESTS, IMPL_PLAN, IMPLEMENTATION)
- `state`: Current state within phase (DRAFT, SCAN, ANALYZE, CONVENTIONS, REVIEW, USER_GATE, REVISE)
- `iterationCount`: Number of self-review iterations in current state
- `approvedArtifacts`: Map of phase → artifact content hash
- `conventions`: The approved conventions document (null in greenfield mode)
- `fileAllowlist`: List of files the agent can modify (incremental mode only, populated from approved plan)
- `sessionId`: OpenCode session ID
- `lastCheckpointTag`: Git tag of last user approval

**Transition function:**
- Signature: `(currentState, event) → nextState | Error`
- Events: `draft_complete`, `self_review_pass`, `self_review_fail`, `user_approve`, `user_feedback`, `revision_complete`
- Invariant validation: reject any transition that would route from a feedback event to a DRAFT state

**Tests:** Unit test every valid transition. Unit test rejection of every invalid transition. Verify the invariant that no feedback path can reach a DRAFT state.

### 4.5 Step 5: Session State Management

**Initialization:** On `session.created` event, create a new WorkflowState at P_DRAFT. On `session.deleted`, clean up.

**Persistence:** Serialize state to `.opencode/workflow-state.json` on every transition. This survives process restarts. On plugin initialization, load existing state if the file exists.

**Concurrency:** Use session ID as the key. Multiple OpenCode sessions can have independent workflow states.

### 4.6 Step 6: System Prompt Injection

Hook: `experimental.chat.system.transform`

On every LLM call, inject:
- The phase-specific instruction file (e.g., `prompts/planning.txt`)
- Current state context: "You are in the PLANNING phase, SELF_REVIEW state, iteration 2 of 3"
- **Workflow mode:** "Mode: INCREMENTAL — do-no-harm directive active"
- **Conventions document** (if in refactor/incremental mode): the approved conventions from the discovery phase, injected as constraints
- **File allowlist** (incremental mode only): "You may only modify these files: [list]"
- List of approved upstream artifacts for cross-reference
- The acceptance criteria checklist for the current phase (including mode-specific criteria)
- Available custom tools and when to call them

The system prompt must clearly state what tools the agent should NOT use (reinforcing the tool guard) and what it should do next. In incremental mode, every prompt includes: "CONSTRAINT: Follow existing conventions. Do not refactor outside the requested scope. All existing tests must continue to pass."

### 4.7 Step 7: Custom Tools for State Signals

Register three tools:

**mark_satisfied:**
```typescript
tool({
  description: "Call when you have completed self-review and believe all acceptance criteria are met. Provide your assessment of each criterion.",
  args: {
    criteria_met: tool.schema.array(tool.schema.object({
      criterion: tool.schema.string(),
      met: tool.schema.boolean(),
      evidence: tool.schema.string(),
    })),
  },
  async execute(args, ctx) {
    const state = getSessionState(ctx.sessionID)
    const allMet = args.criteria_met.every(c => c.met)
    if (allMet) {
      transition(state, 'self_review_pass')
      return "Self-review complete. Presenting work for user review."
    }
    transition(state, 'self_review_fail')
    return `Self-review incomplete. Unmet criteria: ${args.criteria_met.filter(c => !c.met).map(c => c.criterion).join(', ')}. Continue working.`
  },
})
```

**request_review:** Called when agent is ready for user gate. Sets state to USER_GATE and instructs the agent to present a summary and wait.

**submit_feedback:** Invoked by the plugin when user responds at a gate. In Layer 1, classifies feedback as local revision. In Layer 2, routes through orchestrator.

### 4.8 Step 8: Tool Guard by Phase

Hook: `tool.execute.before`

```typescript
"tool.execute.before": async (input, output) => {
  const state = getSessionState(input.sessionID)
  const blocked = getBlockedTools(state.phase)
  if (blocked.includes(input.tool)) {
    throw new Error(
      `Blocked: You are in the ${state.phase} phase. ` +
      `The ${input.tool} tool is not available in this phase. ` +
      `Complete your current work and call request_review when ready.`
    )
  }
}
```

**Phase tool restrictions:**
- DISCOVERY: Block `write`, `edit`. Allow all read-only tools: `read`, `grep`, `glob`, `list`, `bash` (read-only commands), LSP tools.
- PLANNING: Block `write`, `edit`, `bash`. Allow `read`, `search`, `grep`, `glob`.
- INTERFACES: Allow `write`/`edit` only for interface/type files (check file path). Block `bash` except type-checking commands.
- TESTS: Allow `write`/`edit` only for test files. Block `bash` except test runners.
- IMPL_PLAN: Same as PLANNING.
- IMPLEMENTATION: All tools allowed, subject to incremental mode restrictions below.

**Incremental mode file allowlist (additional constraint):**

In incremental mode, after the plan is approved at P_USER, extract the list of files the plan identifies for modification. Store as `state.fileAllowlist`. The tool guard adds an additional check:

```typescript
if (state.mode === 'INCREMENTAL' && ['write', 'edit'].includes(input.tool)) {
  const targetFile = output.args.filePath as string
  if (!state.fileAllowlist.includes(targetFile)) {
    throw new Error(
      `Blocked: Incremental mode — this file is not in the approved plan. ` +
      `Approved files: ${state.fileAllowlist.join(', ')}. ` +
      `If you need to modify this file, route through the orchestrator.`
    )
  }
}
```

### 4.9 Step 9: Git Checkpoints

On every user approval (transition to next phase):

```typescript
async function checkpoint(state: WorkflowState, $: BunShell) {
  const tag = `workflow/${state.phase}-v${state.approvalCount}`
  await $`git add -A`
  await $`git commit -m "workflow: ${state.phase} approved"`
  await $`git tag ${tag}`
  state.lastCheckpointTag = tag
  persistState(state)
}
```

Tag format: `workflow/plan-v1`, `workflow/interfaces-v1`, etc. Version increments on re-approval after revision via orchestrator.

### 4.10 Step 10: Idle Handler / Continuation

Hook: `session.idle` event

```typescript
event: async ({ event }) => {
  if (event.type === "session.idle") {
    const state = getSessionState(event.properties?.session_id)
    if (!state || state.state === 'USER_GATE') return // Expected idle at user gate
    
    if (state.retryCount >= 3) {
      // Escalate to user
      await client.tui.showToast({
        body: { title: "Workflow Stalled", message: `Agent stopped in ${state.phase}/${state.state}. Please provide input.`, variant: "warning" }
      })
      return
    }
    
    state.retryCount++
    await client.session.prompt({
      path: { id: state.sessionId },
      body: {
        noReply: false,
        parts: [{ type: "text", text: `You stopped but the ${state.state} for the ${state.phase} phase is not complete. Continue working against the acceptance criteria. This is retry ${state.retryCount}/3.` }],
      },
    })
  }
}
```

### 4.11 Step 11: Compaction Resilience

Hook: `experimental.session.compacting`

```typescript
"experimental.session.compacting": async (input, output) => {
  const state = getSessionState(input.sessionID)
  if (!state) return
  
  output.context.push(`
## Workflow State — PRESERVE THIS
- Phase: ${state.phase}
- State: ${state.state}
- Iteration: ${state.iterationCount}
- Approved artifacts: ${JSON.stringify(state.approvedArtifacts)}
- Last checkpoint: ${state.lastCheckpointTag}
- Available tools for this phase: ${getAllowedTools(state.phase).join(', ')}
- Next action: ${getNextAction(state)}

## Acceptance Criteria for Current Phase
${getAcceptanceCriteria(state.phase)}
  `)
}
```

---

## 5. Layer 2: Orchestrator

### 5.1 Step 12: Artifact Dependency Graph

```typescript
const DEPENDENCIES: Record<Artifact, Artifact[]> = {
  conventions: [],  // Root artifact in existing-project modes. Absent in greenfield.
  plan: ['conventions'],  // Plan is constrained by conventions (if they exist)
  interfaces: ['plan', 'conventions'],
  tests: ['interfaces'],
  impl_plan: ['plan', 'interfaces', 'tests'],
  implementation: ['impl_plan', 'interfaces', 'tests'],
}

function getDependents(artifact: Artifact): Artifact[] {
  // Topological sort of all downstream dependents
}

// In greenfield mode, remove 'conventions' from all dependency lists
function getEffectiveDependencies(mode: WorkflowMode): Record<Artifact, Artifact[]> {
  if (mode === 'GREENFIELD') {
    return Object.fromEntries(
      Object.entries(DEPENDENCIES)
        .filter(([k]) => k !== 'conventions')
        .map(([k, v]) => [k, v.filter(d => d !== 'conventions')])
    )
  }
  return DEPENDENCIES
}
```

Store approved artifact content (or semantic hash) at each user gate for divergence comparison.

### 5.2 Step 13: O_ASSESS — Impact Assessment

Entry point for ALL feedback. Receives feedback text from user gate or self-review.

Use a subagent LLM call with structured output to classify which artifact(s) the feedback targets:

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: `Given this feedback: "${feedback}"\nAnd these artifacts: ${artifactList}\nWhich artifacts need revision? Return JSON.` }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          affected_artifacts: {
            type: "array",
            items: { type: "string", enum: ["plan", "interfaces", "tests", "impl_plan", "implementation"] },
          },
          root_cause_artifact: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["affected_artifacts", "root_cause_artifact"],
      },
    },
  },
})
```

Walk dependency graph forward from root cause to compute full cascade.

### 5.3 Step 14: O_DIVERGE — Divergence Detection

Compare proposed change scope against stored approved intent.

**Trigger criteria (any one sufficient):**
- Scope expansion: change plan adds artifacts or capabilities not in the original plan
- Architectural shift: change requires modifying fundamental data model or API structure
- Cascade depth ≥ 3: dependency walk shows 3+ artifacts need revision
- Accumulated drift: total revisions since last user approval exceeds semantic distance threshold

Implementation: subagent LLM call with structured boolean output. Tactical → O_PLAN. Strategic → O_USER_DECIDE.

### 5.4 Step 15: O_USER_DECIDE — Escape Hatch

Present to user via agent response:
1. **Original intent** — what was approved at each prior gate
2. **Detected divergence** — what changed and why
3. **Proposed change plan** — what the orchestrator would do
4. **Impact assessment** — which artifacts affected, how far back

User options:
- **Accept drift and update intent** → O_INTENT_UPDATE → O_PLAN
- **Provide alternative direction** → O_INTENT_UPDATE (with user's direction) → O_PLAN
- **Provide entirely new direction** → O_INTENT_UPDATE → O_PLAN (re-scoped)
- **Abort change, continue as-is** → Return to X_ALIGN (or the pre-trigger state)

### 5.5 Step 16: O_INTENT_UPDATE

Record the user's decision as the new baseline intent. This becomes the comparator for future divergence checks. Without this, the next O_DIVERGE call would re-flag the same change.

### 5.6 Step 17: O_PLAN + O_ROUTE

**O_PLAN:** Build minimal ordered revision list. Each entry: artifact name, what specifically needs to change, why.

**O_ROUTE:** Dispatch to earliest affected REVISE state. Inject the full change plan into context via `client.session.prompt({ noReply: true })`. After the first REVISE completes and passes self-review, the orchestrator triggers the next downstream REVISE, cascading through the dependency graph.

---

## 6. Layer 3: Subagent Self-Review

### 6.1 Step 18: Define Reviewer and Builder Agents

Create markdown agent files:

**`.opencode/agents/workflow-reviewer.md`:**
```markdown
---
name: workflow-reviewer
description: Critical evaluator for workflow artifacts. Reviews against structured acceptance criteria.
mode: subagent
tools:
  read: true
  grep: true
  glob: true
  search: true
  write: false
  edit: false
  bash: false
---

You are a critical code reviewer. You receive an artifact and a checklist of acceptance criteria.
Evaluate each criterion independently. Do not assume quality — verify it.
You did NOT write this artifact. Evaluate it as if seeing it for the first time.
Return structured JSON with your assessment of each criterion.
```

**`.opencode/agents/workflow-builder.md`:**
```markdown
---
name: workflow-builder
description: Builds and revises workflow artifacts within phase constraints.
mode: subagent
---

You are building artifacts for a structured coding workflow.
Follow the acceptance criteria exactly. When revising, make incremental changes only.
Never rewrite from scratch. Preserve all prior approved decisions.
```

### 6.2 Step 19: Per-Phase Acceptance Criteria

Each phase has a structured checklist:

**Plan:**
- All user requirements addressed?
- Error/failure cases specified?
- Ambiguous decisions made explicit?
- Data flow described?
- Integration points with external systems identified?
- Non-functional requirements (performance, security) addressed?

**Interfaces:**
- Every method has input types, output types, and error types?
- Data models have all necessary relationships and constraints?
- Naming consistent with plan terminology?
- Missing CRUD operations?
- Missing validation rules?
- Consistent error handling pattern?

**Tests:**
- At least one test per interface method?
- Edge cases covered (empty input, max values, null)?
- Failure modes tested (network errors, invalid data, auth failures)?
- Tests are expected to fail (no implementation leakage)?
- Test descriptions match interface specifications?

**Implementation Plan (DAG):**
- Every interface covered by at least one task?
- Task dependencies are correct and acyclic?
- Parallelizable tasks are truly independent (no shared mutable state)?
- Merge points identified where parallel branches converge?
- Expected test outcomes specified per task?

**Alignment (per-task):**
- Task output matches interface signatures exactly?
- Relevant tests for this task pass?
- No regressions in previously-passing tests?
- Output consistent with prior completed tasks?
- No drift from the approved plan?

### 6.3 Step 20: Review Dispatch and Result Marshaling

Self-review states dispatch a reviewer subagent:

```typescript
const reviewResult = await client.session.prompt({
  path: { id: reviewSessionId },
  body: {
    agent: "workflow-reviewer",
    parts: [
      { type: "text", text: `Review the following artifact against the acceptance criteria.\n\nArtifact files: ${artifactPaths.join(', ')}\n\nAcceptance criteria:\n${criteria}\n\nUpstream artifacts for reference:\n${upstreamSummaries}` },
    ],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          satisfied: { type: "boolean" },
          criteria_results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                criterion: { type: "string" },
                met: { type: "boolean" },
                evidence: { type: "string" },
                severity: { type: "string", enum: ["blocking", "suggestion"] },
              },
            },
          },
        },
        required: ["satisfied", "criteria_results"],
      },
    },
  },
})
```

On `satisfied: false`: feed blocking issues to the builder subagent for revision. Loop until reviewer returns `satisfied: true`, then transition to user gate.

---

## 7. Layer 4: DAG Execution Engine

### 7.1 Step 21: DAG Data Structure

```typescript
interface TaskNode {
  id: string
  description: string
  dependencies: string[]        // IDs of predecessor tasks
  expectedTests: string[]       // Test file paths this task should make pass
  estimatedComplexity: 'small' | 'medium' | 'large'
  status: 'pending' | 'in-flight' | 'complete' | 'aborted'
  worktreeBranch?: string       // Git branch name when in-flight
  worktreePath?: string         // Filesystem path to worktree
}

interface ImplDAG {
  tasks: TaskNode[]
  validate(): { valid: boolean, errors: string[] }  // No cycles, all deps exist, all interfaces covered
  getReady(): TaskNode[]  // Tasks whose deps are all complete
}
```

### 7.2 Step 22: Git Worktree Management

```typescript
async function createWorktree(task: TaskNode, $: BunShell) {
  task.worktreeBranch = `task/${task.id}`
  task.worktreePath = `.worktrees/${task.id}`
  await $`git worktree add -b ${task.worktreeBranch} ${task.worktreePath} HEAD`
}

async function mergeWorktree(task: TaskNode, $: BunShell): Promise<'clean' | 'conflict'> {
  try {
    await $`git merge --no-ff ${task.worktreeBranch} -m "merge: task ${task.id}"`
    await $`git worktree remove ${task.worktreePath}`
    await $`git branch -d ${task.worktreeBranch}`
    return 'clean'
  } catch {
    return 'conflict'
  }
}

async function abortWorktree(task: TaskNode, $: BunShell) {
  // Write abort signal for graceful subagent termination
  await $`touch ${task.worktreePath}/.abort-signal`
  // Force cleanup
  await $`git worktree remove --force ${task.worktreePath}`.catch(() => {})
  await $`git branch -D ${task.worktreeBranch}`.catch(() => {})
  task.status = 'pending'  // Will be rescheduled after revision cascade
  task.worktreeBranch = undefined
  task.worktreePath = undefined
}
```

### 7.3 Step 23: Scheduler (X_SCHEDULE)

On entry: scan DAG for ready tasks. Dispatch up to `maxParallel` (configurable, default 3) tasks as subagent sessions, each with its worktree as working directory.

Track completion via polling or `session.idle` events from subagent sessions. When a task completes and passes self-review, mark `status: 'complete'` and re-enter scheduler for next batch.

### 7.4 Step 24: Merge Gate (X_MERGE)

When the scheduler identifies a ready task whose predecessors were executed in parallel branches:

1. Merge predecessor branches into main
2. If clean merge → proceed to X_ALIGN
3. If conflict → set state to X_MERGE_CONFLICT, present diffs to user
4. After user resolution → X_ALIGN
5. **X_MERGE_CONFLICT → O_ASSESS edge:** If during conflict resolution the user identifies that the conflict was caused by an upstream ambiguity (e.g., "these tasks conflict because the interface didn't specify ownership of this config"), route through the orchestrator for impact assessment instead of proceeding to X_ALIGN

### 7.5 Step 25: Parallel Abort (O_PARALLEL_CHECK + O_ABORT_TASKS)

After any revision that might change the DAG:

1. Compare pre-revision DAG edges against post-revision DAG edges
2. Identify in-flight tasks whose dependency sets changed
3. For each affected task: abort worktree, reset to pending
4. After revision cascade completes, scheduler re-dispatches from updated DAG

**Signal file approach:** Each subagent's system prompt includes: "Before each tool call, check if the file `.abort-signal` exists in your working directory. If it does, stop immediately and report 'Task aborted due to upstream revision.'"

---

## 8. OpenCode Hook Reference

Complete mapping of every workflow capability to its OpenCode API surface.

| Capability | API | Official? | Layer |
|-----------|-----|-----------|-------|
| Phase prompt injection | `experimental.chat.system.transform` | Yes | 1 |
| Tool blocking by phase | `tool.execute.before` (throw to block) | Yes | 1 |
| Detect agent idle | `session.idle` event | Yes | 1 |
| Re-prompt agent | `client.session.prompt({ noReply: false })` | Yes | 1 |
| Silent context injection | `client.session.prompt({ noReply: true })` | Yes | 1 |
| Compaction state preservation | `experimental.session.compacting` | Yes | 1 |
| Custom tool registration | `tool: { ... }` in plugin return | Yes | 1 |
| Git operations | `$` (Bun shell) | Yes | 1 |
| Session lifecycle events | `session.created / deleted` | Yes | 1 |
| Intercept/modify user messages | `chat.message` → `output.parts` mutation | Yes | 2 |
| Mutate full message history | `experimental.chat.messages.transform` | Yes | 2 |
| Structured JSON from subagent | `format: { type: "json_schema" }` in prompt | Yes | 3 |
| TUI toast notifications | `client.tui.showToast` | Yes | 1–4 |
| Structured logging | `client.app.log` | Yes | 1–4 |
| Subagent dispatch | `task` tool / `client.session.prompt` | Yes | 3–4 |
| Parallel subagent management | Polling + session events (no native async) | Workaround | 4 |
| Subagent cancellation | `session.abort()` via SDK (confirmed) + signal file fallback | Yes (abort) / Workaround (signal) | 4 |
| Stop hook (if contributed) | `session.stopping` → return `{ continue, message }` | Proposed contribution | 1–4 |
| Async task dispatch (if contributed) | `Task.dispatch()` / `Task.status()` / `Task.getResult()` | Proposed contribution | 4 |

---

## 9. Risks and Mitigations

| Risk | Severity | Mitigation | Related Issues |
|------|----------|------------|----------------|
| No official stop hook | **High** | `session.idle` + re-prompt. Cap at 3 retries. Known race condition in `opencode run` mode. **Best mitigation: contribute `session.stopping` hook to OpenCode core.** | #12472, #15267 |
| Agent drift in long sessions | High | Compaction hook preserves full state. System prompt re-injected after every compaction. Tool blocking prevents out-of-phase action. | #6068 (compaction reliability) |
| Self-review quality | Medium | Isolated subagent sessions eliminate anchoring bias. Structured checklists with per-criterion evidence requirements. Track iteration counts. | #5502 (context isolation confirmed) |
| Subagent hangs / no timeout | **High** | Apply timeout wrapper around all subagent dispatch. **Contribute one-line timeout default fix to OpenCode core.** Signal file abort as fallback. | #13841, #11865, #6792 |
| Parallel subagent lifecycle | High | Use `session.abort()` (confirmed in SDK) + `client.session.prompt` for parallel dispatch. Poll `session.idle` for completion. **Contribute async task dispatch API to reduce workaround complexity.** | #15069, #5887, #6573 |
| Plugin state corruption | Medium | Persist to JSON on every transition. Validate on load. Log all transitions. Include state version for forward compatibility. | — |
| User gate fatigue | Medium | Concise structured summaries. Diff against prior approved version. Consider configurable skip-able gates for experienced users. | — |
| Merge conflicts in parallel branches | Medium | Worktree isolation prevents filesystem conflicts. DAG planner should identify shared files and serialize tasks that touch them. | — |
| Git worktree edge cases | Medium | Validate git state before operations. Handle dirty worktrees, failed merges, orphaned branches. Use `--force` cleanup as last resort. | #11225 (abort orphan processes) |
| Divergence detection accuracy | Medium | LLM-based classification is probabilistic. Err on the side of flagging. Allow user to dismiss false positives via "abort change" option. | — |
| Session deletion UI flash | Low | Don't delete reviewer sessions immediately — batch cleanup on parent session.deleted event. | #5695 |

---

## 10. Testing Strategy

### Unit Tests
- Every valid state transition produces correct next state
- Every invalid transition is rejected
- No feedback path can reach a DRAFT state (invariant #2)
- Dependency graph walker returns correct cascade order (topologically sorted)
- Dependency graph correctly includes/excludes conventions based on mode
- DAG scheduler identifies ready tasks correctly
- DAG scheduler respects concurrency limits
- Parallel abort correctly identifies affected in-flight tasks
- Mode auto-detection correctly identifies greenfield vs existing projects
- File allowlist enforcement blocks unlisted files in incremental mode

### Integration Tests
- System prompt injection includes correct phase instructions
- Tool guard blocks appropriate tools per phase and provides useful error messages
- Git checkpoint creates tagged commits with correct naming
- Compaction hook preserves and correctly restores workflow state
- Idle handler re-prompts with correct context and respects retry limit
- `chat.message` hook correctly intercepts user feedback at gates

### End-to-End Tests
- Full workflow from MODE_SELECT through DONE in greenfield mode (skips discovery)
- Full workflow from MODE_SELECT through DONE in refactor mode (includes discovery)
- Full workflow from MODE_SELECT through DONE in incremental mode (includes discovery + file allowlist)
- Discovery phase produces valid conventions document from a real codebase
- Incremental mode file allowlist blocks writes to unlisted files
- Conventions document revision cascades correctly through all downstream phases
- Orchestrator cascades revision correctly through dependency graph
- Divergence detection triggers escape hatch on strategic change
- Escape hatch "abort" rolls back to last checkpoint tag
- Parallel execution with clean merge at convergence
- Parallel execution with merge conflict escalation to user
- Merge conflict resolution routes to O_ASSESS when upstream issue detected
- Parallel abort on dependency invalidation mid-execution
- Compaction mid-workflow preserves state and agent continues correctly

---

## 11. Delivery Milestones

| Milestone | Timeline | Deliverable | Shippable? |
|-----------|----------|-------------|------------|
| M0 | Week 0–1 | **OpenCode contributions:** (1) `session.stopping` hook PR, (2) subagent timeout default fix PR. Unblocks M1–M4 with cleaner implementations. | No (upstreaming) |
| M1 | Week 1–4 | Layer 1: Mode selection, discovery phase, sequential phases, user gates, tool blocking (with incremental file allowlist), git checkpoints, compaction | **Yes** — most disciplined agentic workflow available, with existing-project support |
| M2 | Week 4–6 | Layer 2: Orchestrator with unified feedback routing, divergence detection, escape hatch | **Yes** — adds cross-artifact correction |
| M3 | Week 6–7 | Layer 3: Subagent self-review with isolated sessions and structured criteria | **Yes** — dramatically improves review quality |
| M3.5 | Week 7–8 | **OpenCode contribution:** Async task dispatch API PR (#15069). Unblocks clean Layer 4 implementation. | No (upstreaming) |
| M4 | Week 8–11 | Layer 4: DAG execution, parallel subagents, merge gates, parallel abort | **Yes** — adds parallelism for independent tasks |

### Post-M4 Refinements
- Complexity dial: route simple tasks through lightweight loop, complex tasks through full ceremony
- Per-project gate configuration: make some user gates skip-able
- Workflow state dashboard: TUI visualization of current phase, DAG progress, orchestrator activity
- Metrics: iteration counts per phase, time per phase, revision cascade frequency, parallel efficiency
- npm package publication for easy installation via `opencode.json` plugin config
- TUI choice widget: already implemented via the Question system (no contribution needed)
