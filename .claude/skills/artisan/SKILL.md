---
name: artisan
description: Toggle open-artisan workflow enforcement on/off and show current workflow state.
allowed-tools: Bash(./artisan *)
argument-hint: [on|off|status]
disable-model-invocation: true
---

# Open Artisan Workflow Control

Current workflow state:
!`./artisan state 2>/dev/null || echo "Server not running"`

Use this skill only to control Claude Code's Open Artisan adapter for the current project.

## Safety Rules

- Never enable workflow enforcement unless the user explicitly asks for `/artisan on`, `artisan on`, or clearly asks to enable the Claude Code workflow in this session.
- If the user says they are in build mode, out of artisan mode, or using Hermes/OpenCode as the dogfooding driver, do not enable Artisan in Claude Code. Keep this Claude session dormant and explain which driver should own workflow progress.
- No argument means status only. It is never permission to enable the workflow.
- Do not manually edit `.openartisan` state files to turn the workflow on or off.
- Do not use this skill to bypass a workflow gate, review token, allowlist, or task boundary.

## Commands

For `on`, only when the user explicitly asked to enable workflow in Claude Code:

1. Run `./artisan enable` to enable workflow hooks.
2. Check whether the server is running with `./artisan ping`.
3. If the server is not running, start it with `bun run packages/claude-code/bin/artisan-server.ts --project-dir . --daemon`.
4. Run `./artisan state` to show the current state.
5. If prior workflow state exists, ask the user whether to resume or start fresh.

For `off`:

1. Run `./artisan disable` to disable workflow hooks.
2. Tell the user that hooks are now dormant and Claude Code works normally.

For `status` or no argument:

1. Show the state output above.
2. Summarize the current phase, approved artifacts, active task when present, and next expected action.

## Current Enforcement Truths

- When enabled, Claude `PreToolUse` hooks fail closed for write-like tool calls if guard evaluation crashes or the bridge guard is unavailable.
- `INCREMENTAL` interface and test writes must be both phase-shaped and allowlisted.
- Scope or allowlist expansion must be explicitly approved at a real `USER_GATE`; do not self-approve it with workflow tools.
- Bridge review submissions require valid isolated-review tokens and matching artifact hashes before state can change.
- Persisted feature ownership is authoritative. If a resumed session conflicts with persisted ownership, stop and investigate instead of forcing state forward.
