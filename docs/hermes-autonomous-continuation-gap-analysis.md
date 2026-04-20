# Hermes Autonomous Continuation Gap Analysis

## Goal

Make the Hermes adapter behave like a truthful Open Artisan driver that keeps progressing work until a real stop condition, while staying faithful to:

- bridge-owned workflow state and `idle.check`
- Hermes-native session behavior
- gateway-owned messaging delivery semantics
- Open Artisan structural gates
- explicit, reviewable continuation boundaries

## Current Implemented State

The current continuation implementation now lives primarily in:

- `packages/adapter-hermes/hermes_adapter/__init__.py`
- `packages/adapter-hermes/hermes_adapter/continuation.py`
- `packages/adapter-hermes/tests/test_continuation.py`
- `packages/adapter-hermes/tests/test_integration.py`

### What is now true

1. `on_session_start`
   - starts/attaches the bridge
   - calls `lifecycle.sessionCreated`
   - forwards `agent` when present

2. `pre_llm_call`
   - remains a per-turn observational hook
   - ensures workflow session state is available
   - dispatches isolated per-task review when requested by the bridge
   - dispatches robot-artisan auto-approval behavior at `USER_GATE`
   - calls `prompt.build`
   - is not the continuation trigger

3. `on_session_end`
   - asks bridge `idle.check` whether continuation should happen
   - when `idle.check` returns `reprompt`, builds a structured continuation request
   - delegates continuation execution to `hermes_adapter.continuation`
   - logs blocked outcomes truthfully, including missing gateway routing fields
   - detaches and shuts down normally on real stop conditions

4. `continuation.py`
   - classifies continuation surfaces as `direct_cli`, `gateway_messaging`, or `unknown`
   - extracts gateway routing metadata into a structured `gatewayRouting` payload
   - builds structured continuation requests from session-end context plus `idle.check`
   - resolves direct vs gateway continuation strategies explicitly
   - returns truthful blocked outcomes with `missingFields` when messaging metadata is incomplete
   - currently implements:
     - `NativeSessionDirectContinuationRunner`
     - `GatewayBackgroundContinuationHandoff`

5. tests
   - continuation helper behavior is covered in `test_continuation.py`
   - adapter session-end integration is covered in `test_integration.py`
   - current adapter-hermes suite passes with these semantics

## Hermes Runtime Truth

The Hermes docs/source still imply the same architectural constraints that shaped this work:

1. `pre_llm_call`
   - fires once per turn before the tool loop
   - injects ephemeral context into the current user turn
   - is not a continuation hook

2. `on_session_end`
   - runs after a conversation turn exits
   - cannot itself re-enter the conversation loop in-process

3. CLI resume semantics
   - `--resume` / `--continue` restore Hermes session lineage
   - these are valid session-level primitives, but are not the same thing as a dedicated in-process continuation runner

4. messaging semantics
   - gateway owns routing, delivery, and background-task lifecycle
   - plugin hooks alone do not own cross-platform delivery semantics
   - `/background` creates a separate background session and is not same-session continuation

## What This Feature Has Closed

### Closed gap 1: continuation is no longer assembled ad hoc in `__init__.py`

The adapter entrypoint no longer builds the old raw shell command directly inside `_on_session_end`.
Instead it:

- asks `idle.check`
- builds a structured continuation request
- routes through explicit continuation helpers and strategy execution

This keeps the adapter thinner and makes continuation behavior testable.

### Closed gap 2: gateway continuation now executes through a gateway-owned worker path

Messaging-originated continuation is no longer treated as “not implemented” or silently ignored.
With complete routing metadata, the adapter now launches a gateway-owned continuation worker via `GatewayBackgroundContinuationHandoff` and hands delivery back to the real Hermes gateway adapter path.
When routing metadata is incomplete, it still fails truthfully as:

- `blocked` with `missingFields`

This means messaging continuation now has a real execution backend, while still preserving honest diagnostics when routing prerequisites are missing.

### Closed gap 3: blocked diagnostics are now explicit

When gateway continuation cannot proceed, the adapter now logs the missing routing fields instead of hiding the reason behind a generic blocked message.

### Closed gap 4: silent cleanup swallowing has been reduced

The adapter now logs `clear_session` failures instead of silently swallowing them, improving continuation/debugging visibility.

## Remaining Gaps

### Remaining gap 1: direct CLI continuation still relies on a detached worker launch boundary

Direct CLI continuation is now implemented by `NativeSessionDirectContinuationRunner`.
It no longer shells out through `hermes chat --resume ... --query ...`; instead it launches a Python worker that:

- restores the existing Hermes session with `SessionDB`
- constructs `AIAgent`
- calls `run_conversation()` with the bridge-provided continuation prompt

This materially closes the original design gap around CLI runtime semantics.
The remaining limitation is more specific: continuation still crosses a detached worker-process boundary rather than being re-entered from the current process. Session/runtime behavior is now Hermes-native, but the launch boundary is still worker-based.

### Remaining gap 2: gateway continuation now runs through the real gateway path, but lacks end-to-end proof across all supported platforms

`GatewayBackgroundContinuationHandoff` now launches a gateway-owned worker that constructs a real gateway adapter path and sends responses back through the originating platform adapter using the supplied routing context.

The remaining gap is not that gateway execution is missing; it is that broad end-to-end proof across supported platforms and deployment configurations is still limited.

### Remaining gap 3: no true end-to-end continuation proof yet

Current tests verify helper behavior and adapter integration seams, including truthful gateway blocking/handoff outcomes.
They do not yet prove:

- actual same-session Hermes-native in-process continuation for CLI
- actual gateway-owned background execution and redelivery
- repeated continue-stop-continue behavior across real Hermes/gateway runtimes

### Remaining gap 4: dogfooding supervisor surface is still external

The repo’s dogfooding/supervisor model is still operationally valid, but there is not yet a first-class supervisor-oriented continuation runner with explicit runtime control and observability.

## Current Architecture Summary

### Truth source

Open Artisan bridge `idle.check` remains the sole source of truth for:

- `reprompt`
- `ignore`
- `escalate`

### Implemented continuation strategies

1. direct CLI strategy
   - represented by `direct_runner`
   - executed by `NativeSessionDirectContinuationRunner`
   - restores the existing session via `SessionDB` and continues through `AIAgent.run_conversation(...)`

2. messaging strategy
   - represented by `gateway_handoff`
   - executed by `GatewayBackgroundContinuationHandoff`
   - launches a gateway-owned worker that sends results back through the originating platform adapter

### Truthful stop behavior

The adapter now cleanly distinguishes:

- continuation requested and launched
- continuation requested and handed off
- continuation blocked with explicit missing metadata
- continuation skipped because no valid strategy exists
- real workflow stop conditions

## Recommended Next Engineering Steps

1. Replace `SubprocessDirectContinuationRunner` with a Hermes-native direct continuation runner based on sync/session APIs.
2. Replace `StructuredGatewayContinuationHandoff` with a real gateway-owned execution handoff.
3. Add end-to-end tests that prove real runtime continuation for both direct and messaging surfaces.
4. Add supervisor/operator documentation once the runtime backends are fully implemented.

## Acceptance Criteria Status

### Satisfied now

- bridge `idle.check` remains the continuation truth source
- adapter continuation logic is structured instead of ad hoc in `__init__.py`
- direct CLI continuation now uses a Hermes-native session/runtime worker path built on `SessionDB` + `AIAgent.run_conversation(...)`
- messaging continuation now uses a real gateway-owned worker path when routing metadata is present
- blocked messaging continuation reports missing metadata truthfully
- docs can now describe the shipped continuation model honestly

### Not yet satisfied

- direct CLI continuation still launches through a detached worker boundary rather than re-entering from the current process
- end-to-end runtime continuation is not yet proven beyond adapter-level and worker-launch integration tests across all supported messaging platforms

## Bottom Line

This feature is materially implemented and substantially more truthful than the old shell-based adapter entrypoint behavior.

What exists now is a correct continuation boundary with real runtime backends:

- bridge decides whether to continue
- adapter classifies the execution surface
- direct CLI continuation runs through a Hermes-native session/runtime worker path
- messaging continuation runs through a gateway-owned worker path when routing metadata is available
- missing gateway data fails honestly
- docs and tests describe the shipped behavior

What still remains is deeper end-to-end proof across real runtime environments and, if desired later, eliminating the detached worker launch boundary for direct CLI continuation.
