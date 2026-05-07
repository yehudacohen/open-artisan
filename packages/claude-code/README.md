# Open Artisan — Claude Code Adapter

Claude Code integration for the open-artisan phased workflow engine. Enforces a structured MODE_SELECT -> DISCOVERY -> PLANNING -> INTERFACES -> TESTS -> IMPL_PLAN -> IMPLEMENTATION -> DONE workflow on Claude Code agents.

## Architecture

The adapter consists of three components communicating via a Unix domain socket:

```
Claude Code (host)
  |
  |-- /artisan skill          Toggle workflow on/off, show state
  |
  |-- PreToolUse hook ------> artisan-hook ---> socket ---> guard.check
  |     Enforces tool guard on every tool call
  |
  |-- Bash("artisan ...") --> artisan CLI ----> socket ---> tool.execute
  |     Workflow commands (select-mode, mark-task-complete, etc.)
  |
  |-- Stop hook ------------> artisan-hook ---> socket ---> idle.check
  |-- SessionStart hook ----> artisan-hook ---> socket ---> sessionCreated + prompt.build
  |-- PreCompact hook ------> artisan-hook ---> socket ---> prompt.compaction
  |
  |-- CLAUDE.md includes CLAUDE-WORKFLOW.md (static instructions)

artisan-server (background process)
  |-- Unix socket: .openartisan/.bridge.sock
  |-- Bridge engine in-process (core state machine + tool guard)
  |-- PID file: .openartisan/.bridge-pid
  |-- Session file: .openartisan/.active-session
  |-- Enabled flag: .openartisan/.enabled
```

### Why not MCP?

MCP tools are optional — Claude can ignore them and use Write/Edit/Bash directly, bypassing the workflow. The adapter uses Claude Code hooks instead, which intercept EVERY tool call. The tool guard structurally enforces the state machine: writes are blocked during restricted phases, per-task file restrictions limit the agent to the current DAG task's files, and the agent must call `artisan` CLI commands to advance through phases.

### Why CLI via Bash instead of native tools?

Claude Code doesn't support custom native tools. MCP provides custom tools but they're suggestions, not enforcement. By routing workflow commands through the Bash tool, every command goes through the PreToolUse hook where the tool guard can validate it. The `artisan` CLI connects to the running server via the Unix socket and executes the command against the state machine.

## Components

### artisan-server (`bin/artisan-server.ts`)

Long-lived background process that hosts the bridge engine and Unix socket. Started by `/artisan on` or the SessionStart hook. Daemonizes on startup.

- Creates the core engine (EngineContext with SessionStateStore, StateMachine, SessionRegistry)
- Loads persisted workflow state from the Open Artisan runtime backend (`.openartisan/workflow-db/open-artisan.pg` by default)
- Opens Unix socket for hook scripts and CLI
- Uses isolated phase review via hook-dispatched reviewer subprocesses; the human reviews at USER_GATE

### Shared local bridge behavior

The Claude Code adapter now treats the bridge as a shared local service scoped to one project/state directory:

- One bridge per `projectDir` / `.openartisan/`
- Hook scripts and the CLI reuse a live compatible bridge when one already exists
- If no compatible bridge exists, Claude starts a new one and attaches to it
- If bridge metadata or socket state is stale, Claude treats it as recoverable local state rather than a live ownership conflict
- A single Claude session detaching does not shut down the bridge if other clients are still attached

Shared bridge state is tracked through:

- `.openartisan/.bridge-pid`
- `.openartisan/.bridge.sock`
- `.openartisan/.bridge-meta.json`
- `.openartisan/.bridge-clients.json`

What users should expect:

- Opening another Claude Code session in the same repo should normally reuse the existing bridge rather than starting a competing one.
- Stopping one Claude session should not interrupt another client that is still using the same repo bridge.
- The bridge state files in `.openartisan/` are local operational artifacts, not user config files.
- If the bridge is healthy, Claude should attach quietly; if it is stale or incompatible, Claude should fail with a reason instead of guessing.

### Failure handling and recovery

The shared bridge path uses conservative recovery rules:

- malformed or missing metadata -> attach fails safely instead of guessing
- stale PID/socket artifacts -> classified as stale and cleaned only through the bridge's explicit stale-state path
- incompatible bridge metadata/protocol -> rejected instead of attached blindly
- shutdown while clients remain -> blocked unless an explicit force path is used for bridge process teardown
- socket timeout or connection failure -> handled as bridge unavailable, allowing Claude to retry or start a fresh compatible bridge path

Recovery checklist for Claude users:

1. Retry the command once if Claude reports the bridge as unavailable.
2. Inspect `.openartisan/.bridge-meta.json` and `.openartisan/.bridge-clients.json` if behavior looks inconsistent.
3. If the bridge files are clearly stale, restart the local bridge process instead of manually deleting random workflow files.
4. If another client is still attached, let that client exit cleanly before forcing shutdown.
5. If a repo is wedged, restart the background server and re-run `/artisan on` or the relevant Claude workflow entrypoint.

### artisan CLI (`bin/artisan.ts`)

The interface Claude uses to call workflow tools via Bash. Connects to the Unix socket, sends a JSON-RPC request, prints the result.

Simple commands use CLI flags:
```bash
./artisan select-mode --mode GREENFIELD --feature-name cloud-cost
./artisan state
./artisan ping
./artisan enable
./artisan disable
```

Complex commands accept JSON on stdin (avoids Bash quoting issues):
```bash
echo '{"summary":"Plan ready","artifact_description":"Plan","artifact_files":[".openartisan/cloud-cost/plan.md"]}' | ./artisan request-review
echo '{"task_id":"T1","implementation_summary":"Built auth module","tests_passing":true}' | ./artisan mark-task-complete
echo '{"feedback_type":"approve","feedback_text":"Looks good"}' | ./artisan submit-feedback
```

### artisan-hook (`bin/artisan-hook.ts`)

Thin CLI that Claude Code hook scripts invoke. Reads hook input from stdin, connects to the socket, sends the appropriate JSON-RPC request, formats the response per Claude Code hook conventions.

Subcommands: `pre-tool-use`, `stop`, `session-start`, `pre-compact`, `post-tool-use`

All hooks check `.openartisan/.enabled` first. When disabled, hooks return permissive defaults (allow all, no prompt injection, no re-prompting). This enables the on/off toggle.

### /artisan skill (`.claude/skills/artisan/SKILL.md`)

User-invoked slash command for toggling the workflow:

- `/artisan on` — Enables enforcement, starts the server, discovers existing state
- `/artisan off` — Disables enforcement, stops the server
- `/artisan status` — Shows current workflow state (phase, mode, task, approved artifacts)
- `/artisan` (no args) — Status when enabled, prompts to enable when disabled

## Hook Behavior

### PreToolUse (every tool call)

1. Check `.enabled` flag — if absent, allow all
2. If Bash tool and command contains `./artisan `: always allow (workflow commands bypass the guard)
3. Otherwise: call `guard.check` on the bridge
4. If blocked: exit 2 (tool call prevented, reason shown to Claude)
5. If allowed: exit 0 with `additionalContext` containing current phase/state

This enforces:
- No writes during PLANNING/IMPL_PLAN (text-only phases)
- Only interface files during INTERFACES
- Only test files during TESTS
- Only current task's `expectedFiles` during IMPLEMENTATION
- No .env writes ever
- Bash write operators blocked in INCREMENTAL mode

### Stop (Claude finishes responding)

1. Check `.enabled` — if absent, allow stop
2. Call `idle.check` on the bridge
3. If reprompt: exit 2 (prevents Claude from stopping, injects reprompt message)
4. If escalate: exit 2 (injects escalation message)
5. If ignore: exit 0 (Claude stops normally)

### SessionStart (session begins/resumes/compacts)

1. Check `.enabled` — if absent, no injection
2. Ensure server is running (spawn if needed)
3. Register session with the bridge
4. Call `prompt.build` to get the workflow system prompt
5. Return prompt as hook output (injected into conversation)

On `compact` events: re-injects the current state context so workflow context survives context window compression.

### PreCompact (before context compression)

1. Check `.enabled` — if absent, skip
2. Call `prompt.compaction` to get the preservation context
3. Return context as hook output

## Review Mode

Claude Code adapter mode runs the bridge with isolated review capabilities:

- **mark_satisfied**: Reserved for isolated phase reviewer submissions. Author-facing CLI/MCP calls are blocked during REVIEW.
- **submit_feedback(revise)**: Routes directly to REVISE (no orchestrator classification — treats all revision feedback as tactical).
- **mark_analyze_complete**: Accepts the agent's scan summary directly.
- **propose_backtrack**: Accepts the backtrack without orchestrator validation.

This means phase review is handled by an isolated reviewer subprocess before USER_GATE, and the human reviews the artifact after the reviewer passes it.

## Toggle Mechanism

The workflow enforcement is opt-in per session:

- `.openartisan/.enabled` file: when present, hooks are active
- `./artisan enable`: creates the file, starts the server
- `./artisan disable`: removes the file, stops the server
- All hooks check this file first — when absent, they return permissive defaults

This means Claude Code works normally when the workflow is disabled. No tool blocking, no prompt injection, no re-prompting. Enable it with `/artisan on` when you want the phased discipline.

## Session Tracking

Claude Code provides a `session_id` in hook inputs but not in Bash tool calls. The adapter tracks sessions via:

1. **SessionStart hook**: Writes the session_id to `.openartisan/.active-session`
2. **CLI commands**: Read the session_id from `.openartisan/.active-session`
3. **Server**: Maintains an in-memory map of registered sessions

This means each Claude Code window gets its own tracked session. Concurrent windows work correctly because each registers its own session_id.

## Setup

Run the setup script to configure a project:

```bash
bun run packages/claude-code/bin/artisan-setup.ts
```

This:
1. Creates `.openartisan/` directory
2. Merges hooks into `.claude/settings.json` (preserves existing config)
3. Creates `/artisan` skill at `.claude/skills/artisan/SKILL.md`
4. Places `CLAUDE-WORKFLOW.md` alongside CLAUDE.md
5. Creates `./artisan` CLI wrapper script

## File Structure

```
packages/claude-code/
  bin/
    artisan-server.ts       Background server (socket + bridge engine)
    artisan-hook.ts         Hook CLI (one-shot socket client)
    artisan.ts              Workflow CLI (stdin JSON + flags)
    artisan-setup.ts        Project setup
  src/
    socket-transport.ts     Unix domain socket JSON-RPC transport
    hook-handlers.ts        PreToolUse, Stop, SessionStart, PreCompact handlers
    constants.ts            Socket path, timeouts, default responses
  templates/
    settings.json.tmpl      .claude/settings.json hooks template
    SKILL.md                /artisan skill definition
    CLAUDE-WORKFLOW.md      Static workflow instructions for CLAUDE.md
```

## Dependencies

- `json-rpc-2.0` — Already in the project (used by the bridge)
- `pino` — Already in the project (structured logging)
- `packages/core/` — Core engine (state machine, hooks, tools)
- `packages/bridge/` — Bridge server (JSON-RPC method handlers, protocol types)

No new external dependencies.
