---
name: open-artisan-dogfood-claude
description: Driver-specific Open Artisan dogfooding guidance for Claude Code as the workflow driver.
compatibility: opencode
metadata:
  workflow: dogfooding
  driver: claude
---

# Claude Code Driver Dogfooding

Use this subskill when `driver=claude`.

## Runtime Truth

Claude dogfooding must exercise the Claude Code adapter and bridge, not a manual prompt-only workflow.

Acceptable driver surface:

1. Claude Code session with Open Artisan enabled through `/artisan on` or equivalent explicit enablement.
2. Claude Code hooks connected to the shared local bridge.

Not acceptable as proof:

- Claude following copied workflow instructions while hooks are disabled.
- Supervisor manually running workflow CLI commands for the driver except at explicit recovery points.
- A stale bridge that predates relevant Open Artisan code changes.

## Setup Checks

Before launch or resume, verify when accessible:

- `.claude/skills/artisan/SKILL.md` is installed in the driver project.
- `./artisan` wrapper exists and points to the intended Open Artisan checkout.
- `.openartisan/.enabled` exists only when enforcement is intentionally enabled.
- Claude hook settings include the Open Artisan hook commands.
- The shared bridge metadata is compatible with the current repo and code.

## Logs And State

Inspect at minimum:

- `.openartisan/.bridge-meta.json`
- `.openartisan/.bridge-clients.json`
- `.openartisan/<feature>/workflow-state.json`
- current phase artifacts under `.openartisan/<feature>/`
- Claude-visible driver messages and hook/CLI failures
- current worktree status

Look for:

- hooks disabled when the run claims enforcement
- CLI commands bypassing intended guard behavior
- stale bridge or incompatible protocol metadata
- user-gate stops without clear artifact summaries
- weak self-review in agent-only mode

## User-Gate Review Expectations

Because Claude adapter review can be agent-only, the supervisor must be extra strict at `USER_GATE`:

- independently inspect the artifact, not just the agent's self-review
- compare against design docs/RFPs/issues when available
- verify phase restrictions were enforced by hooks
- identify whether weak output indicates a Claude adapter prompt/template gap
- request revision rather than approve vague or non-repository-specific artifacts

## Resume Checklist

Before returning control after a fix:

1. Run targeted Open Artisan tests when adapter code changed.
2. Restart the Claude bridge if stale code or metadata is possible.
3. Confirm `.openartisan/.enabled` and active session state match the intended run.
4. Resume through Claude's hook-backed session, not supervisor-only CLI execution.
