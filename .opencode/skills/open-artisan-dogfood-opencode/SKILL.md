---
name: open-artisan-dogfood-opencode
description: Driver-specific Open Artisan dogfooding guidance for OpenCode as the workflow driver.
compatibility: opencode
metadata:
  workflow: dogfooding
  driver: opencode
---

# OpenCode Driver Dogfooding

Use this subskill when `driver=opencode`.

## Runtime Truth

OpenCode dogfooding must exercise the Open Artisan OpenCode plugin, not just a normal Build session following instructions manually.

Acceptable driver surfaces:

1. A primary OpenCode session running the `artisan` agent.
2. A primary OpenCode session running the `robot-artisan` agent when autonomous user-gate behavior is intentionally under test.

Not acceptable as proof of OpenCode driver behavior:

- A normal Build/Plan session pretending to follow the workflow.
- A one-shot prompt that does not keep workflow state in the plugin.
- Supervisor manual edits that bypass the driver's current phase restrictions.

## Setup Checks

Before launch or resume, verify:

- `.opencode/plugins/open-artisan.ts` is present and resolves to the Open Artisan plugin.
- `.opencode/plugins/open-artisan` is present and resolves to the Open Artisan plugin directory.
- `.opencode/agents/artisan.md` and `.opencode/agents/robot-artisan.md` are available.
- `.opencode/package.json` includes `@opencode-ai/plugin`.
- OpenCode was restarted after plugin or agent changes if the current process may have stale config.

## Logs And State

Inspect at minimum:

- `.opencode/openartisan-errors.log`
- `.openartisan/<feature>/workflow-state.json`
- current phase artifacts under `.openartisan/<feature>/`
- OpenCode-visible driver messages and tool calls
- current worktree status

Look for:

- missing or stale plugin activation
- driver running as `build` instead of `artisan`/`robot-artisan`
- impossible phase/task combinations
- phase tool-policy bypasses
- repeated idle reprompts
- weak review criteria that let low-quality artifacts pass
- user-gate approvals without evidence-backed investigation

## User-Gate Review Expectations

For OpenCode-driven gates, the supervisor should specifically check whether the OpenCode plugin caused the driver to:

- submit a real artifact via workflow tools
- enter `REVIEW` before `USER_GATE`
- preserve artifact paths and state coherently
- stop at `USER_GATE` unless using intentional `robot-artisan` auto-approval
- obey file-write restrictions for the current phase
- produce artifacts that cite applicable design docs/RFPs/issues when they exist

## Defect Signals

Treat these as Open Artisan defects unless evidence shows external causes:

- OpenCode driver can write files during blocked phases.
- OpenCode driver reaches a later phase without the required workflow tool transition.
- OpenCode driver repeatedly stops in runnable non-gated states.
- USER_GATE messaging is unclear enough that the supervisor cannot tell what is being approved.
- Review criteria do not force repository-specific evidence for a non-trivial feature.

## Resume Checklist

Before returning control to an OpenCode driver after a fix:

1. Run targeted Open Artisan verification when code changed.
2. Confirm the TypeKro workflow state is coherent.
3. Restart or reload OpenCode if plugin/agent/skill code changed and stale runtime is possible.
4. Confirm the next driver action is a true workflow resume point.
