# Conventions: open-artisan plugin

## Architecture
- Pure functional state machine in `state-machine.ts` — no side effects, transition table lookup only
- `store.update(sessionId, draft => { ... })` for all state mutations — immer-style draft pattern
- Tool handlers in `index.ts` read `state` at the top then call `store.update` at the end — never mutate `state` directly
- Subagent dispatch (self-review, auto-approve, task-review) is async and non-fatal: errors fall through to graceful degradation
- All pure helper functions live in separate modules; `index.ts` wires them together

## Code style
- TypeScript strict mode; explicit return types on exported functions
- `const x = (() => { ... })()` pattern for complex inline derivations
- Early returns for error/guard cases; main logic at the bottom of handler bodies
- Log with `log.info(...)` / `log.warn(...)` / `log.error(...)` — never `console.log`
- Comments explain *why*, not *what*

## State mutations
- Always read `state` snapshot before `store.update`; never re-read inside the updater
- Compute derived values (e.g. `effectiveAllowlist`) from the snapshot + args *before* `store.update`
- `store.update` is the single source of truth for persisted state

## Tool guard
- `WORKFLOW_TOOL_NAMES` and `PASSTHROUGH_TOOL_NAMES` are never blocked
- `getPhaseToolPolicy` is a pure switch on `phase`/`phaseState`/`mode`/`fileAllowlist`

## idle-handler
- Returns `IdleDecision` — pure function, no side effects
- Caller in `index.ts` applies the decision (prompt, escalate, or ignore)
- Current: USER_GATE always returns `ignore` — this must be conditioned on `activeAgent` for robot-artisan
