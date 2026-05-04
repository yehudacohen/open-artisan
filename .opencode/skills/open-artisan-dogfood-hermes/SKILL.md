---
name: open-artisan-dogfood-hermes
description: Driver-specific Open Artisan dogfooding guidance for Hermes as the workflow driver.
compatibility: opencode
metadata:
  workflow: dogfooding
  driver: hermes
---

# Hermes Driver Dogfooding

Use this subskill when `driver=hermes`.

## Runtime Truth

Hermes dogfooding must exercise Hermes's native continuation-capable runtime, not a supervisor-launched one-shot chat.

Preferred driver surface:

1. Hermes gateway with the `openartisan` profile and a real messaging-originated session.

Acceptable CLI-only proof:

1. A long-lived interactive or resumable Hermes session started directly through `hermes` or `openartisan` in its own terminal/session.

Not acceptable as primary proof:

- `hermes chat -q`
- `openartisan chat -q`
- equivalent one-shot wrappers launched repeatedly by the supervisor

Supervisor use of `hermes -r` or `hermes -c` is only acceptable for replying into the same existing session at a truthful gate or after a real framework fix.

Supervisor-side bridge calls, direct adapter scripts, direct `oa_*` calls, or direct JSON-RPC `tool.execute` calls are recovery/debug actions only. They do not prove Hermes dogfooding. If any of those are used to advance workflow state, mark the slice as manual recovery and return control to the Hermes driver before approving or claiming success.

## Logs And State

Inspect at minimum:

- `~/.hermes/profiles/openartisan/logs/agent.log`
- `~/.hermes/profiles/openartisan/logs/errors.log`
- `.openartisan/.bridge-meta.json`
- `.openartisan/.bridge-clients.json`
- `.openartisan/<feature>/workflow-state.json`
- current phase artifacts under `.openartisan/<feature>/`
- current worktree status

Look for:

- stale bridge metadata
- socket refusal or no-response
- `.bridge-meta.json` advertising a PID/socket while the PID is not running or `.bridge.sock` is absent
- stale attached clients
- continuation that starts a new session instead of resuming the real one
- repeated supervisor kicks between runnable states
- mismatch between Hermes output and persisted workflow state
- status files that lost the latest review evidence after approval

## Discord/Gateway Path

For gateway dogfooding:

1. Verify the `openartisan` Hermes profile has Discord credentials and allowed user/channel settings.
2. Start the profile gateway with `openartisan gateway start` or `openartisan gateway run`.
3. Send a real Discord message from an allowed user to the configured bot surface.
4. Let Hermes continue autonomously until a truthful gate, safety stop, or runtime failure.
5. Send another supervisor message only at a real gate or after a framework fix.

If Hermes stops in `REVIEW` with `latestReviewResults = null` and `status.md` says `No review results yet`, do not manually submit a reviewer result as if Hermes completed the step. First classify the stop. It is usually a framework/runtime defect unless logs show an external reviewer outage.

If the repository harness is available, prefer it for supervision:

```bash
bun run dogfood:discord -- run --feature <feature-name>
```

## User-Gate Review Expectations

At Hermes-driven gates, verify:

- the artifact/work was produced by the Hermes driver path, not by supervisor substitution
- persisted bridge/session metadata points to the same active run
- the driver respected the relevant Open Artisan phase
- requirements/design/RFP references were used when available
- no stale process is reporting outdated state

Do not approve a Hermes-driven `USER_GATE` until you have independently checked:

1. the persisted workflow is at the gate Hermes claims
2. the latest review results are present for the artifact being approved, unless the gate is intentionally reviewless
3. bridge metadata is fresh enough to trust: recorded PID exists, `.bridge.sock` exists for shared-socket transport, and attached clients include the active Hermes session
4. any implementation gaps found by review have been traced to either artifact/spec quality, review-criteria weakness, runtime defect, or external blocker

## Resume Checklist

Before returning control after a fix:

1. Run targeted verification for Open Artisan changes.
2. Confirm bridge metadata and clients are fresh: PID is running, socket exists when transport is `unix-socket`, and stale clients are not the only apparent owner.
3. Confirm Hermes will attach to updated code/runtime state.
4. Resume through the same native session path, not a new one-shot prompt.

After resuming, observe at least one Hermes-native action before counting the fix as proven. A supervisor-side smoke test is useful evidence, but it is not enough by itself.
