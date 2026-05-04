# Cross-Plugin Dogfooding Model

This document explains the intended dogfooding model for Open Artisan.

## Principle

Dogfooding is an operational practice.

- One client/plugin is the **driver**.
- The current client/plugin/session coordinating the run is the **supervisor**.

The driver exercises the system and performs the feature work.
The supervisor babysits the run, fixes defects immediately, verifies them, and returns the driver to the interrupted work.

## What the User Should Specify

Only:

1. the driver

Examples:

- current session is OpenCode, driver=`hermes`
- current session is Hermes, driver=`opencode`
- current session is Claude, driver=`hermes`

## What the Driver Does

The driver:

1. runs the workflow
2. exercises real gates, reviews, and implementation tasks
3. exposes framework/product issues naturally through use
4. for plugin/runtime integrations that claim autonomous execution, continues through runnable non-gated work without requiring manual reinvocation between ready steps

## What the Supervisor Does

The supervisor:

1. monitors workflow state and runtime outputs
2. reviews logs and artifacts at natural boundaries
3. enters the bug loop immediately when a real defect is found
4. fixes the repo with targeted tests
5. verifies and checkpoints progress
6. returns the driver to the interrupted work

## Pause Classification

At every pause, classify the reason explicitly:

1. framework/runtime defect
2. correct workflow gate
3. artifact/spec quality gap
4. external/environment blocker

This keeps the supervisor from mislabeling a valid workflow backtrack as a harness failure.

## Bug Loop

When the driver exposes a real issue:

1. detect
2. root-cause
3. define targeted tests
4. implement the smallest correct fix
5. verify the fix
6. checkpoint meaningful progress
7. return to the driver

If a driver/plugin that claims autonomous execution stops between runnable steps and requires a supervisor kick to continue, classify that as a framework/runtime defect, not as normal operator work.

## Required Reviews During Dogfooding

The implementer should inspect:

- `.openartisan/openartisan-errors.log`
- `.openartisan/<feature>/workflow-state.json`
- current phase artifacts under `.openartisan/<feature>/`
- recent commits and current worktree state

When `driver=hermes`, also inspect:

- `~/.hermes/profiles/openartisan/logs/agent.log`
- `~/.hermes/profiles/openartisan/logs/errors.log`
- `.openartisan/.bridge-meta.json`
- `.openartisan/.bridge-clients.json`

This should happen:

1. after repeated review failures
2. after suspicious state drift
3. after each meaningful slice or checkpoint
4. whenever the driver output conflicts with persisted state

## Pre-Resume Checklist

Before returning the driver to interrupted work after a fix:

1. verify the narrow fix tests passed
2. verify persisted workflow state is coherent
3. verify the driver will resume against fresh runtime state
4. verify the next step is an actual safe resume boundary

For Hermes, this includes checking shared-bridge health so the next turn does not attach to stale code or stale bridge metadata.

For autonomous driver paths, this also includes verifying the driver is using the intended launch/resume surface rather than a one-shot foreground path that bypasses continuation behavior.

Do not treat one-shot foreground supervisor launches such as `hermes chat -q`, `openartisan chat -q`, or equivalent single-turn chat wrappers as valid proof of autonomous execution. Those can be acceptable for ad hoc inspection or for sending a reply into an already-existing same session at a truthful gate, but they are not the right launch surface for verifying autonomous driver behavior.

For `driver=hermes`, make the launch surface explicit:

1. Preferred for autonomous verification: Hermes gateway (`hermes gateway start` / `hermes gateway run`) with a real messaging-originated session, because this exercises Hermes's native long-running messaging/runtime model.
2. Acceptable for CLI-only verification: a long-lived interactive or resumable Hermes session started directly through `hermes`/`openartisan` in its own terminal session. The supervisor may later use `hermes -r` / `hermes -c` only to reply into that same existing session at a truthful gate.
3. Not acceptable as the primary verification surface: one-shot `chat -q` launches from the supervisor.

For the preferred Discord path, the workflow should be concrete:

1. verify the `openartisan` profile has Discord credentials/config and the Open Artisan plugin installed
2. start the profile-scoped gateway with `openartisan gateway start` or `openartisan gateway run`
3. send a real Discord message from an allowed user to the configured Hermes bot surface
4. if Discord `require_mention` is enabled, mention the bot or DM it directly
5. let Hermes continue in the background until it reaches a truthful gate or real runtime failure
6. only send another supervisor message at a real gate or after a framework/runtime fix

For this repository, the preferred supervisor entrypoint is the dedicated harness:

```bash
bun run dogfood:discord -- run --feature <feature-name>
```

The harness prints the Discord kickoff text, watches the relevant logs/state files, detects blocking deviations, and can approve a truthful `USER_GATE` by replying into the same Hermes session.

## End-of-Slice Summary

At the end of each meaningful slice, capture:

1. driver step attempted
2. defect or gate encountered
3. pause classification
4. fix applied or not applied
5. tests run
6. checkpoint commit, if any
7. exact remaining workflow phase/state

## Repeated-Incident Rule

If the same bug class appears twice in one dogfooding loop, promote it from one-off recovery to a structural hardening task.

## Important Constraint

Do not encode dogfooding-only process semantics into runtime state unless that work has its own approved design.

For now:

- Hermes/OpenCode/Claude may be the driver
- OpenCode/Hermes/Claude may be the supervisor by being the current coordinating session
- dogfooding remains a practice, not a synthetic protocol field

## Desired Outcome

Over time, this loop should make the harness:

1. more reliable
2. more autonomous
3. less dependent on manual state repair
4. easier to use from any client/plugin pairing

## Autonomous Driver Rule

If a client/plugin/runtime path is presented as an Open Artisan driver, it should be able to:

1. keep progressing automatically between runnable non-gated states
2. stop only at truthful gates, explicit safety stops, or real runtime failures
3. resume using its native session/messaging model rather than supervisor-only manual chat reinvocation
4. be exercised by the supervisor through a launch/resume path that does not itself mask or replace the driver's native continuation model

If those conditions are not met, the path is not fully dogfood-ready and should be treated as an active framework/runtime gap.
