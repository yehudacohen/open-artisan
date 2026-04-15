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

Important safety rule:

- Never enable workflow enforcement unless the user explicitly asks for `/artisan on`, `artisan on`, or clearly asks to enable the Claude Code workflow in this session.
- If the user says they are in build mode, out of artisan mode, or using Hermes/Open Artisan as the dogfooding path from build mode, do not enable Artisan in Claude Code. Keep this session dormant and explain that Hermes should drive the workflow instead.
- No argument means status only. It is never permission to enable the workflow.

Based on the user's argument, take one of these actions:

**"on" only when the user explicitly asked to enable workflow in Claude Code:**
1. Run `./artisan enable` to enable workflow hooks
2. Check if the server is running: `./artisan ping`
3. If server is not running, start it: `bun run packages/claude-code/bin/artisan-server.ts --project-dir . --daemon`
4. Run `./artisan state` to show the current state
5. If prior workflow state exists, ask the user whether to resume or start fresh

**"off":**
1. Run `./artisan disable` to disable workflow hooks
2. Tell the user that hooks are now dormant — Claude Code works normally

**"status" or no argument:**
1. Show the state output above
2. Summarize: which phase, what's approved, what's next
