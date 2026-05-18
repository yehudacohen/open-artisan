---
name: open-artisan
description: Use Open Artisan correctly from OpenCode, including build-mode opt-in, opt-out, and workflow-state expectations.
compatibility: opencode
metadata:
  workflow: open-artisan
  driver: opencode
---

# Open Artisan In OpenCode

Use this skill when the user asks to use, resume, disable, debug, or dogfood Open Artisan from OpenCode.

## Core Rule

Open Artisan is enforced by the OpenCode plugin and workflow tools, not by copying workflow instructions into a normal chat.

- Keep `.opencode/plugins/open-artisan.ts` installed unless the user explicitly asks to uninstall or edit plugin registration.
- Do not disable Open Artisan by renaming plugin files.
- In build mode, workflow opt-in and opt-out are prompt-driven. When the user asks to opt out, call `disable_open_artisan`; do not edit state by hand.
- In `artisan` or `robot-artisan` mode, workflow enforcement is locked on and cannot be switched off by prompt.
- Treat direct state or artifact edits as recovery actions, not successful workflow progress.

## Agent Modes

Open Artisan is active by default for these agents:

- `artisan`
- `robot-artisan`

Normal `build` sessions stay dormant unless the user explicitly opts in with phrasing such as:

- `use Open Artisan`
- `enable workflow`
- `switch to Open Artisan`

After opt-in, the session is recorded as `build-artisan` and the plugin should inject workflow prompts and enforce guards. This is still a build-mode session that the user can later opt out of by prompt through `disable_open_artisan`.

`artisan` and `robot-artisan` sessions are different: they are workflow-native modes and must stay active. If the user asks to disable Open Artisan from one of those modes, explain that they need to switch to a normal build session instead.

## Turning It Off

If the user explicitly asks to stop using Open Artisan in a build-driven session, call `disable_open_artisan`. This control path is local to OpenCode, outside the Open Artisan bridge server, and is not a bridge/MCP workflow tool. Examples:

- `turn off Open Artisan`
- `open-artisan off`
- `disable workflow`
- `do not use Open Artisan`

Expected behavior:

- The plugin remains installed.
- `activeAgent` becomes `build` for the session through `disable_open_artisan`.
- System prompt injection stops for that dormant session.
- Tool guards stop blocking normal build-mode work for that dormant session.

Do not rename, delete, or move plugin files to satisfy an off request.
Do not manually edit `.openartisan` state files to satisfy a normal build-mode opt-out.
Do not route build-mode opt-out through bridge/MCP workflow tools; use `disable_open_artisan` only.

If the current agent is `artisan` or `robot-artisan`, `disable_open_artisan` is not available and opt-out must be rejected. Those modes cannot become dormant in-place.

## Workflow Expectations

When Open Artisan is active:

- Start with `check_prior_workflow` before `select_mode` when beginning or resuming a feature.
- Use a short kebab-case feature name.
- Advance only through workflow tools for phase transitions.
- Submit real artifact files to review gates when the phase requires them.
- Respect guarded write tools and phase file policies.
- Stop at `USER_GATE` unless the active agent is intentionally `robot-artisan`.

## Debugging Checklist

When behavior is surprising, inspect:

- `.openartisan/openartisan-errors.log`
- `.openartisan/<feature>/workflow-state.json` when present
- `.openartisan/<feature>/status.md` when present
- current OpenCode session agent metadata
- whether `.opencode/plugins/open-artisan.ts` is installed
- whether OpenCode was restarted after plugin, agent, or skill changes

For OpenCode sessions, do not treat `.openartisan/.bridge-pid` as authoritative. Bridge metadata is relevant to bridge-backed adapters such as Claude Code and Hermes, not native OpenCode plugin activation.

## Defect Signals

Treat these as Open Artisan defects until proven otherwise:

- Build mode cannot turn off an explicitly opted-in workflow without removing plugin files.
- A build-mode opt-out prompt requires manual state editing instead of `disable_open_artisan`.
- `artisan` or `robot-artisan` mode can be switched off by prompt.
- A dormant build session still receives workflow prompt injection.
- A dormant build session is blocked by workflow write guards.
- An active workflow can write outside the current phase policy.
- Runtime state and persisted `.openartisan/<feature>/workflow-state.json` disagree about the current phase.
- DB operation lease failures wedge workflow attach, resume, or `select_mode` beyond the configured retry window.

When a defect blocks the user, pause feature progress, fix Open Artisan structurally, run targeted tests, then return to the interrupted workflow state.
