# Open Artisan — Hermes Agent Adapter

Hermes Agent v0.5.0 plugin that enforces the open-artisan phased workflow (MODE_SELECT -> DISCOVERY -> PLANNING -> INTERFACES -> TESTS -> IMPL_PLAN -> IMPLEMENTATION -> DONE) on Hermes-powered coding agents.

## Architecture

```
Hermes Agent (Python host)
  |
  |-- Plugin: open-artisan (~/.hermes/plugins/open-artisan/)
  |     |
    |     |-- register(ctx) entry point
    |     |     |-- workflow tools (oa_select_mode, oa_request_review, oa_reset_task, etc.)
  |     |     |-- Wrapper tools replacing write_file, edit_file, execute_command
  |     |     |-- pre_llm_call hook -> prompt.build (per-turn injection)
  |     |     |-- on_session_start/end hooks -> lifecycle management
  |     |
  |     |-- bridge_client.py -> spawns Bun subprocess, JSON-RPC stdio
  |
  |-- Bridge Server (packages/bridge/cli.ts, Bun subprocess)
        |-- JSON-RPC 2.0 over stdin/stdout
        |-- Agent-only capabilities (no SubagentDispatcher)
        |-- Core state machine, tool guard, session state
```

### Why wrapper tools instead of hooks?

Hermes v0.5.0 hooks are **observation-only** — `pre_tool_call` return values are ignored and exceptions are swallowed. There is no mechanism to block a tool call from a hook. To enforce the tool guard structurally, the adapter registers wrapper versions of file-write tools that call `guard.check` before delegating to the original handler. If the guard blocks, the wrapper returns an error string that the LLM sees.

### Why per-turn prompt injection?

Hermes's `pre_llm_call` hook can return `{"context": "text"}` to inject into the system prompt for that specific LLM call. This is better than one-shot injection — the agent always sees the current phase instructions, even after the workflow advances mid-session.

### Why stdio subprocess (not Unix socket)?

The Hermes plugin lives inside the agent process. It can own a subprocess and communicate via stdin/stdout. This is simpler than the Claude Code adapter's Unix socket approach (which was necessary because Claude Code hooks are ephemeral processes that can't share a subprocess).

## Components

### Bridge Client (`bridge_client.py`)

Python module that spawns the bridge server (`bun run packages/bridge/cli.ts`) as a subprocess and communicates via newline-delimited JSON-RPC 2.0 over stdin/stdout.

```python
from hermes_adapter.bridge_client import StdioBridgeClient

bridge = StdioBridgeClient()
bridge.start("/path/to/project")  # attaches to a compatible shared bridge or spawns one

result = bridge.call("tool.execute", {
    "name": "select_mode",
    "args": {"mode": "GREENFIELD", "feature_name": "my-feature"},
    "context": {"sessionId": "default", "directory": "/path/to/project"}
})

bridge.shutdown()
```

- Thread-safe (lock on stdin/stdout access)
- Auto-reconnect on subprocess death
- Eager init in `on_session_start` (not lazy — every session uses the bridge)
- Capabilities: `selfReview="agent-only"`, `orchestrator=False`, `discoveryFleet=False`

### Shared local bridge behavior

Hermes now uses the same local shared bridge lifecycle as Claude Code:

- one bridge per `projectDir` / `.openartisan/`
- Hermes discovers bridge metadata before spawning a subprocess
- Hermes attaches to a live compatible bridge when possible
- Hermes starts a fresh bridge only when no compatible bridge exists
- Hermes detaches without shutting down bridges that are still in use by other clients

Shared bridge artifacts are local and inspectable:

- `.openartisan/.bridge-pid`
- `.openartisan/.bridge.sock`
- `.openartisan/.bridge-meta.json`
- `.openartisan/.bridge-clients.json`

What Hermes users should expect:

- Starting Hermes in a repo that already has a healthy local bridge should usually attach to that bridge instead of spawning a second owner.
- Hermes session shutdown should not tear down the bridge if another local client is still attached.
- Shared bridge metadata is operational state for recovery/debugging, not user-auth configuration.
- Errors should be explicit: incompatible bridge, malformed metadata, stale state, or broken transport should each surface as a distinct failure mode instead of being silently ignored.

### Failure handling and recovery

Shared-bridge recovery rules for Hermes are explicit:

- malformed metadata -> reported as attach failure
- incompatible protocol metadata -> rejected rather than reused
- stale pid/socket/metadata -> classified as stale bridge state
- transport timeout / broken bridge -> surfaced as `failed_attach` or reconnect failure
- detach while other clients remain -> returns shutdown blocked with remaining client ids

Recovery checklist for Hermes users:

1. Retry once if Hermes reports a bridge attach failure caused by a transient transport issue.
2. Inspect `.openartisan/.bridge-meta.json` and `.openartisan/.bridge-clients.json` before manually deleting state.
3. If the bridge state is stale, restart the local bridge path rather than removing unrelated workflow files.
4. If another client is still attached, let that client exit or explicitly coordinate a forced shutdown.
5. If Hermes cannot reconnect to the bridge subprocess, restart the Hermes session so persisted workflow state can be reloaded cleanly.

### Workflow Tools (`workflow_tools.py`)

Hermes remains the primary exercise path for dogfooding Open Artisan behavior, but that is an operational practice rather than a bridge/runtime contract. The adapter should stay truthful about workflow state and should not invent extra dogfooding-specific state just to reflect operator process.

Workflow tools registered in the `open-artisan` toolset via `ctx.register_tool()`. Each delegates to the bridge's `tool.execute` method.

| Hermes Tool | Bridge Tool | Purpose |
|------------|-------------|---------|
| `oa_select_mode` | `select_mode` | Choose GREENFIELD/REFACTOR/INCREMENTAL |
| `oa_mark_scan_complete` | `mark_scan_complete` | Complete discovery scan |
| `oa_mark_analyze_complete` | `mark_analyze_complete` | Complete discovery analysis |
| `oa_mark_satisfied` | `mark_satisfied` | Submit self-review criteria |
| `oa_mark_task_complete` | `mark_task_complete` | Complete a DAG task |
| `oa_reset_task` | `reset_task` | Reset one or more DAG tasks back to pending |
| `oa_request_review` | `request_review` | Submit artifact for review |
| `oa_submit_feedback` | `submit_feedback` | Approve or request revision |
| `oa_check_prior_workflow` | `check_prior_workflow` | Check for prior state |
| `oa_resolve_human_gate` | `resolve_human_gate` | Set human gate on task |
| `oa_propose_backtrack` | `propose_backtrack` | Go back to earlier phase |
| `oa_spawn_sub_workflow` | `spawn_sub_workflow` | Delegate task to child |
| `oa_query_parent_workflow` | `query_parent_workflow` | Read parent state |
| `oa_query_child_workflow` | `query_child_workflow` | Read child state |
| `oa_state` | `state.get` | Show current workflow state |

All handlers return JSON strings (Hermes handler contract). The `oa_` prefix avoids collisions with built-in tools. Toolset name: `"open-artisan"`.

### Guard Wrappers (`guard_wrappers.py`)

Wrapper tools that replace Hermes's built-in file-write tools with guarded versions.

```python
# register_guard_wrappers(ctx, bridge) wraps all guarded tools at once.
# Each wrapper calls guard.check before delegating to the original handler:

async def _guarded_handler(bridge, original_handler, tool_name, session_id, args):
    result = bridge.call("guard.check", {
        "sessionId": session_id,
        "toolName": tool_name,
        "args": args
    })
    if result and not result.get("allowed", True):
        return json.dumps({
            "error": result.get("reason", f"{tool_name} blocked by workflow guard"),
            "phase": result.get("phase", ""),
            "phaseState": result.get("phaseState", ""),
        })
    return await original_handler(args)
```

**Wrapped tools:**
- `write_file` — file write guard
- `edit_file` — file write guard
- `create_file` — file write guard
- `execute_command` — bash guard + artisan passthrough (commands containing `artisan` bypass the guard)
- `patch_file` — file write guard (if present)

The wrapper registers with the same tool name, overriding the built-in. Plugins load after core tools, so the override takes effect.

### System Prompt Injection (`prompt_hook.py`)

Registered via `ctx.register_hook("pre_llm_call", callback)`. On every LLM call:

1. Calls `bridge.call("prompt.build", {"sessionId": session_id})`
2. Returns `{"context": prompt_text}` which Hermes injects into the ephemeral system prompt

This means the agent always sees:
- Current phase and sub-state
- Phase-specific instructions (what to do in DRAFT, REVIEW, USER_GATE, REVISE)
- Blocked tools list
- Acceptance criteria (during REVIEW)
- Current DAG task assignment (during IMPLEMENTATION)
- Conventions document (if approved)

The prompt is rebuilt from scratch each turn — no stale state.

### Session Lifecycle

- `on_session_start` hook → `bridge.call("lifecycle.sessionCreated", {"sessionId": ...})`
- `on_session_end` hook → `bridge.call("lifecycle.sessionDeleted", {"sessionId": ...})`
- Session ID comes from Hermes's `session_id` kwarg on hook callbacks

## Self-Review Mode

The bridge runs with agent-only capabilities:
- `selfReview: "agent-only"` — `oa_mark_satisfied` evaluates the agent's own criteria (no isolated reviewer)
- `orchestrator: false` — `oa_submit_feedback(revise)` routes directly to REVISE (no LLM classification)
- `discoveryFleet: false` — `oa_mark_analyze_complete` accepts the agent's scan summary directly

The agent self-evaluates, the human reviews at USER_GATE.

## Installation

### As a Hermes plugin (drop-in):
```bash
cp -r packages/adapter-hermes/hermes_adapter ~/.hermes/plugins/open-artisan
cp packages/adapter-hermes/plugin.yaml ~/.hermes/plugins/open-artisan/
```

### As a pip package:
```bash
pip install -e packages/adapter-hermes/
```

### Project setup:
```bash
python -m hermes_adapter --project-dir /path/to/project
```

This creates `.openartisan/` and `.hermes.md` (project-level workflow instructions).

### Recommended profile setup:
```bash
python -m hermes_adapter --project-dir /path/to/project --profile openartisan
```

This also:
- installs/updates the `open-artisan` plugin in the Hermes profile
- writes `OPENARTISAN_BRIDGE_CLI` into `~/.hermes/profiles/<profile>/.env`
- creates the plugin root `__init__.py` shim Hermes requires

## Configuration

The plugin is active whenever installed. To disable, either:
- Remove from `~/.hermes/plugins/`
- Add `"open-artisan"` to `disabled_toolsets` in Hermes config

The bridge subprocess is spawned eagerly in `on_session_start` and stays alive for the session.

## Robot-Artisan Mode (Automated Workflows)

To run fully automated workflows without human approval at USER_GATE, pass `agent="robot-artisan"` when creating the session:

```python
# In your Hermes integration code:
bridge.call("lifecycle.sessionCreated", {
    "sessionId": session_id,
    "agent": "robot-artisan"
})
```

When `activeAgent` is `"robot-artisan"`, the `pre_llm_call` hook automatically:
1. Detects USER_GATE state
2. Spawns an isolated auto-approver subprocess (`claude --print`)
3. Evaluates the artifact against phase-specific criteria
4. Auto-approves if confidence >= 0.7, otherwise routes to REVISE with feedback

**Requirements:**
- `claude` CLI must be installed and on PATH (for the auto-approver subprocess)
- If `claude` is not available, the hook falls back gracefully — the agent continues at USER_GATE and can be approved manually

**Note:** Robot-artisan mode still enforces all structural guarantees. The auto-approver runs in an isolated subprocess with no access to the authoring conversation. It can reject artifacts that don't meet quality standards.

## Per-Task Review

During IMPLEMENTATION, each `oa_mark_task_complete` call triggers an isolated per-task review:

1. Bridge sets `taskCompletionInProgress` gate (blocks further writes)
2. The `pre_llm_call` hook detects the pending review
3. Spawns `claude --print` subprocess with the review prompt (isolated context)
4. Review checks: tests pass, interface alignment, regressions, conventions, stub detection, integration seams
5. Quality scores: code_quality and error_handling (minimum 8/10)
6. If review passes: task advances. If fails: task reverts to pending with issues.

If `claude` CLI is unavailable, the review auto-accepts with a failing score (task reverts to pending). After 10 failed review iterations, the task is force-accepted — the full implementation review at `oa_request_review` will catch remaining issues.

## Troubleshooting

### Bridge subprocess not starting

```
BridgeError: Failed to spawn bridge subprocess: ...
```

**Causes:**
- `bun` not installed or not on PATH
- Bridge CLI not found at expected location

**Fix:**
```bash
# Verify bun is installed
bun --version

# Set bridge CLI path explicitly
export OPENARTISAN_BRIDGE_CLI=/path/to/packages/bridge/cli.ts

# Re-run setup to verify
python -m hermes_adapter --project-dir . --profile openartisan
```

### Another bridge process is already running

If Hermes is attaching to a repo already used by another Open Artisan client,
you may see:

```text
Bridge RPC error: Another bridge process is already running (PID ...)
```

To let Hermes take over the repo bridge for its session:

```bash
export OPENARTISAN_BRIDGE_TAKEOVER=1
```

With takeover enabled, the Hermes adapter will stop the existing bridge PID,
clear the stale bridge pid/socket files, and retry bridge init once.

### Bridge subprocess dies mid-session

The adapter auto-reconnects on the next tool call. If reconnection fails:

```
BridgeError: Bridge subprocess died and reconnect failed
```

**Fix:** Restart the Hermes session. The bridge state is persisted to `.openartisan/<feature>/workflow-state.json` and will be restored on restart.

### Per-task review subprocess fails

```
Isolated reviewer (claude CLI) not available or timed out
```

**Causes:**
- `claude` CLI not installed
- Anthropic API key not configured
- Review prompt too large (timeout after 3 minutes)

**Behavior:** Task reverts to pending (graceful degradation). The agent can re-attempt `oa_mark_task_complete`. After 10 failures, the task is force-accepted.

### Guard blocks unexpected tool

```
{"error": "writes blocked in PLANNING/DRAFT", "phase": "PLANNING", "phaseState": "DRAFT"}
```

This is expected. The workflow guard blocks file writes during planning phases. Check the blocked-per-phase table in `.hermes.md` for what's allowed in each phase/sub-state.

## File Structure

```
packages/adapter-hermes/
  hermes_adapter/
    __init__.py          register(ctx) entry point
    bridge_client.py     JSON-RPC stdio subprocess transport
    workflow_tools.py    13 workflow tool registrations + oa_state
    guard_wrappers.py    Wrapper tools for file-write enforcement
    prompt_hook.py       pre_llm_call -> prompt.build injection
    constants.py         Schemas, toolset name, bridge command
  plugin.yaml            Hermes plugin manifest
  pyproject.toml         pip packaging
  .hermes.md.tmpl        Template for project workflow instructions
  README.md
  tests/
    test_bridge_client.py
    test_workflow_tools.py
    test_guard_wrappers.py
    test_prompt_hook.py
    test_integration.py
```

## Bridge Protocol

The adapter communicates with the bridge via JSON-RPC 2.0 over stdio. Key methods:

```python
# Initialize
bridge.call("lifecycle.init", {
    "projectDir": "/path/to/project",
    "capabilities": {"selfReview": "agent-only", "orchestrator": False, "discoveryFleet": False}
})

# Execute workflow tool
bridge.call("tool.execute", {
    "name": "select_mode",
    "args": {"mode": "GREENFIELD", "feature_name": "my-feature"},
    "context": {"sessionId": "default", "directory": "/path/to/project"}
})

# Check tool guard
result = bridge.call("guard.check", {
    "sessionId": "default", "toolName": "write_file",
    "args": {"path": "src/main.py", "content": "..."}
})
# result = {"allowed": False, "reason": "writes blocked in PLANNING/DRAFT", ...}

# Get workflow prompt for injection
prompt = bridge.call("prompt.build", {"sessionId": "default"})
# prompt = "## Workflow Phase: PLANNING\n..."
```

## Dependencies

- **Runtime**: Python 3.10+, Hermes Agent v0.5.0+, Bun (for bridge server)
- **Bridge**: `packages/bridge/cli.ts` (spawned as subprocess)
- **Core**: `packages/core/` (loaded by the bridge, not by Python directly)
- **No new npm packages**: Bridge uses existing `json-rpc-2.0` + `pino`
- **No new pip packages**: Uses only Python stdlib (`subprocess`, `json`, `threading`)
