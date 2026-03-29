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

Based on the user's argument, take one of these actions:

**"on" or no argument when workflow is not active:**
1. Run `./artisanenable` to enable workflow hooks
2. Check if the server is running: `artisan ping`
3. If server is not running, start it: `bun run packages/claude-code/bin/artisan-server.ts --project-dir . --daemon`
4. Run `./artisanstate` to show the current state
5. If prior workflow state exists, ask the user whether to resume or start fresh

**"off":**
1. Run `./artisandisable` to disable workflow hooks
2. Tell the user that hooks are now dormant — Claude Code works normally

**"status" or no argument when workflow is active:**
1. Show the state output above
2. Summarize: which phase, what's approved, what's next
