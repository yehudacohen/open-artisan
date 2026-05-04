---
name: dogfood
description: Run cross-plugin Open Artisan dogfooding with an explicit driver, while the invoking client/session acts as the supervisor.
argument-hint: driver=<opencode|hermes|claude>
---

# Cross-Plugin Dogfooding

Use this skill when the user wants to dogfood Open Artisan by designating:

- a **driver**: the client/plugin actively exercising the workflow
- a **supervisor**: the current client/plugin/session invoking this skill

The driver and supervisor may be the same plugin or different plugins.

## Core Rule

Dogfooding is an operational loop, not a synthetic runtime contract.

- The driver exists to exercise the system honestly.
- The implementer exists to babysit the run, detect defects, fix them immediately, verify them, and return the driver to the interrupted work.
- Do not invent dogfooding-only bridge/runtime state just to track process.
- Any state mutation performed directly by the supervisor is a recovery action, not dogfood evidence. Label it as such and return to the driver before claiming the driver succeeded.

## Required Inputs

The user should only need to provide:

- `driver`

The supervisor is implicit: it is the current session using this skill.

Everything else should be derived from the current repo state, workflow artifacts, and runtime behavior.

## Role Model

### Driver

The driver is responsible for:

1. Running the planned workflow or feature slice.
2. Exercising real workflow phases, approvals, reviews, and implementation tasks.
3. Exposing framework defects naturally through actual use.
4. If it claims autonomous execution, continuing through runnable non-gated states without repeated manual supervisor reinvocation.

The driver is **not** responsible for papering over framework bugs.

### Supervisor

The supervisor is responsible for:

1. Monitoring the driver's progress and outputs.
2. Detecting bugs, weak workflow behavior, parser/runtime drift, and review/gate anomalies.
3. Immediately switching to bug-loop mode when a real issue is found.
4. Fixing the issue in the repo with targeted tests.
5. Verifying the fix.
6. Returning control to the driver to continue the interrupted work.

## Bug Loop

When the driver exposes a real framework or runtime issue, the supervisor must:

1. Stop feature progress at the current slice boundary.
2. State the exact expected vs actual behavior.
3. Reproduce or confirm the issue from repo/runtime evidence.
4. Add or identify targeted tests.
5. Implement the smallest correct fix.
6. Run the targeted verification.
7. Commit the checkpoint if progress is meaningful.
8. Resume the driver from the interrupted workflow state.

Do not defer known framework issues to a later cleanup if they are actively blocking or degrading dogfooding quality.

If a driver/plugin/runtime path that claims autonomous execution stops between ready steps and requires the supervisor to keep kicking it forward, treat that as a framework/runtime defect to fix now.

## Pause Classification

At every pause or interruption, classify the stop explicitly as one of:

1. **framework/runtime defect**
2. **correct workflow gate**
3. **artifact/spec quality gap**
4. **external/environment blocker**

This prevents the supervisor from treating a legitimate workflow rejection like a harness bug, or vice versa.

## Log Review Cadence

Pause at natural boundaries to inspect logs and artifacts before continuing:

1. After a workflow phase review fails repeatedly.
2. After any manual-looking recovery or suspicious state drift.
3. After each completed slice or major checkpoint.
4. Whenever the driver output seems inconsistent with persisted workflow state.

Inspect at minimum:

- `.openartisan/openartisan-errors.log`
- `.openartisan/<feature>/workflow-state.json`
- current phase artifacts under `.openartisan/<feature>/`
- recent commits and current worktree state

When `driver=hermes`, also inspect at minimum:

- `~/.hermes/profiles/openartisan/logs/agent.log`
- `~/.hermes/profiles/openartisan/logs/errors.log`
- `.openartisan/.bridge-meta.json`
- `.openartisan/.bridge-clients.json`

Look for:

- stale review results
- latch drift (`taskCompletionInProgress`)
- impossible phase/task combinations
- planning/implementation contract mismatches
- adapter/runtime/tool-surface mismatches
- docs drifting away from runtime truth
- shared-bridge socket refusal/no-response
- `.bridge-meta.json` advertising a PID/socket while the PID is not running or `.bridge.sock` is absent
- stale bridge ownership or stale attached clients
- resumed task-review drift after restart/reattach
- status files that lost the latest review evidence after approval

## Pre-Resume Checklist

Before returning control to the driver after any framework/runtime fix:

1. Confirm the targeted tests passed.
2. Confirm persisted workflow state is coherent.
3. Confirm the driver will attach to fresh code/runtime state, not a stale bridge or stale process.
4. Confirm the next step is a real resume point, not an inferred one.

For `driver=hermes`, this specifically means checking whether the shared bridge process or metadata needs to be refreshed so Hermes does not continue against stale code.
It also means checking that Hermes is using the intended continuation-capable launch/resume path, not a one-shot foreground path that bypasses autonomous continuation behavior.

Do **not** use one-shot foreground `hermes chat -q`, `openartisan chat -q`, or equivalent supervisor-launched single-turn chat invocations as the primary launch surface when verifying autonomous driver behavior. Those paths are valid for ad hoc inspection or sending a reply into an already-existing same session, but they are not valid proof that the driver can keep running autonomously between ready steps.

For `driver=hermes`, choose one of these explicit launch surfaces:

1. Preferred: Hermes gateway (`hermes gateway start` / `hermes gateway run`) with a real messaging-originated session.
2. Acceptable for CLI-only proof: a long-lived interactive/resumable Hermes session started directly through `hermes` or `openartisan` in its own terminal session.
3. Supervisor use of `hermes -r` / `hermes -c` is only for replying into that same existing session at a truthful gate, not for primary launch.
4. Not acceptable for primary verification: `hermes chat -q`, `openartisan chat -q`, or equivalent one-shot wrappers.

Supervisor-side bridge calls, direct adapter scripts, direct `oa_*` calls, or direct JSON-RPC `tool.execute` calls are recovery/debug actions only. They do not prove Hermes dogfooding. If any of those are used to advance workflow state, mark the slice as manual recovery and return control to the Hermes driver before approving or claiming success.

When using the preferred Discord/gateway path for `driver=hermes`, the supervisor should make the runtime steps explicit:

1. Ensure the `openartisan` Hermes profile has the required Discord settings (`DISCORD_BOT_TOKEN`, allowed users/channels, and the plugin installed).
2. Start the profile-scoped gateway with `openartisan gateway start` (background service) or `openartisan gateway run` (foreground for debugging).
3. Start the driver by sending a real Discord message from an allowed user to the configured Open Artisan Hermes bot surface:
   - if `require_mention: true`, mention the bot in the configured channel/thread or DM it directly
   - if a home channel is configured, use that channel as the default operator entrypoint
4. Let Hermes continue autonomously from there.
5. The supervisor should only send another message when:
    - replying at a truthful `USER_GATE`, or
    - intentionally steering after a real blocker/framework fix

If Hermes stops in `REVIEW` with `latestReviewResults = null` and `status.md` says `No review results yet`, do not manually submit a reviewer result as if Hermes completed the step. First classify the stop. It is usually a framework/runtime defect unless logs show an external reviewer outage.

Do not approve a Hermes-driven `USER_GATE` until the persisted workflow is at the gate Hermes claims, latest review results are present for the artifact being approved unless the gate is intentionally reviewless, bridge metadata is fresh enough to trust, and any implementation gaps found by review have been classified.

In this repository, prefer using the dedicated harness once it exists:

```bash
bun run dogfood:discord -- run --feature <feature-name>
```

That harness prints the exact Discord kickoff message, watches workflow/log state, detects blocking deviations, and can reply into the same Hermes session for gate approval.

## Operating Loop

1. Confirm the designated `driver` and `implementer`.
2. Resume or start the intended workflow through the driver's real continuation-capable surface.
3. Let the driver progress one slice at a time.
4. After each meaningful step, review logs/artifacts/state.
5. If a defect is found, switch immediately to supervisor bug-loop mode.
6. Fix, test, verify, and checkpoint.
7. Return to the driver and continue.
8. Repeat until the workflow is complete.

## End-of-Slice Summary

At the end of each meaningful slice, record a compact summary that includes:

1. driver step attempted
2. defect or gate encountered
3. stop classification
4. fix applied or not applied
5. tests run
6. checkpoint commit, if any
7. exact persisted workflow phase/state remaining

## Repeated-Incident Rule

If the same bug class appears twice in one dogfooding loop, stop treating it as a one-off recovery and treat it as a structural hardening task.

## Generalization Rules

The loop must work for any combination of:

- driver: `opencode`, `hermes`, or `claude`
- supervisor: whichever client/session is currently using this skill

Examples:

- current session is OpenCode, `driver=hermes`
- current session is Hermes, `driver=opencode`
- current session is Claude, `driver=hermes`

The same principles apply regardless of pairing:

- the driver exercises the system
- the supervisor fixes the system

## Constraints

- Keep fixes minimal and structural.
- Prefer runtime truth over docs, prompts, or operator habit.
- Do not add synthetic process-only semantics to the framework unless that work has its own approved design.
- Keep dogfooding operationally explicit in docs and behavior, but not as fake runtime state.

## Success Criteria

This skill is being used well when:

1. The driver keeps making forward progress.
2. Bugs are fixed immediately when found.
3. The supervisor regularly reviews logs and workflow state rather than trusting surface output.
4. The same bug does not require repeated manual repair after its fix.
5. The system becomes more autonomous over time because the engine itself is getting stronger.
6. A claimed autonomous driver no longer requires repeated supervisor reinvocation between runnable steps.
7. Supervisor launch/observe behavior does not accidentally bypass the driver's native continuation model.
