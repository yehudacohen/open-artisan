# Discord Dogfood Harness

This harness is test/support infrastructure for end-to-end Hermes/Open Artisan dogfooding through Discord. It is not Open Artisan product runtime.

## Purpose

The harness helps a supervisor:

1. verify the `openartisan` Hermes gateway/runtime is ready
2. print the exact Discord kickoff message for a feature
3. monitor workflow state and log files in a loop
4. detect blocking bridge/runtime deviations quickly
5. resolve the active Hermes session id for follow-up replies
6. approve a truthful `USER_GATE` by replying into the same Hermes session

## What it does not do

It does not impersonate a Discord user. The kickoff message still has to be sent from a real allowed Discord user account, because Hermes's Discord adapter ignores its own bot-authored messages.

## Command

```bash
bun run dogfood:discord -- <command> [options]
```

Commands:

1. `status`
2. `run`
3. `approve`

## Typical workflow

1. Start the Hermes gateway for the `openartisan` profile.
2. Run the harness:

```bash
bun run dogfood:discord -- run --feature pglite-roadmap-backend
```

3. Copy the printed kickoff message and send it on Discord from an allowed user.
4. Let the harness watch:
   - `.openartisan/<feature>/workflow-state.json`
   - `.openartisan/openartisan-errors.log`
   - `~/.hermes/profiles/openartisan/logs/agent.log`
   - `~/.hermes/profiles/openartisan/logs/errors.log`
   - `.openartisan/.bridge-clients.json`
5. If the workflow reaches `USER_GATE`, either:
   - let the harness stop and run `approve`, or
   - pass `--auto-approve` when appropriate for the current dogfood scenario

## Examples

Show current status and kickoff instructions:

```bash
bun run dogfood:discord -- status --feature pglite-roadmap-backend
```

Run the watch loop and auto-approve using the default `approve` token:

```bash
bun run dogfood:discord -- run --feature pglite-roadmap-backend --auto-approve
```

Approve a gate manually:

```bash
bun run dogfood:discord -- approve --feature pglite-roadmap-backend
```

Approve a gate with an explicit Hermes session id:

```bash
bun run dogfood:discord -- approve --feature pglite-roadmap-backend --session-id 20260420_123456_abcdef
```

## Notes

1. The harness prefers a real Hermes session id from persisted workflow state.
2. If workflow state is still bound to `default`, it falls back to:
   - active Hermes bridge clients
   - recent `Bridge started for session ...` lines in Hermes `agent.log`
3. Recent bridge/runtime failures are treated as blocking deviations and stop the watch loop so the supervisor can intervene honestly.
