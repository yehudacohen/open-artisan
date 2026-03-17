# Implementation Plan: fix-forward-skip-and-auto-approve

## Scope
Four targeted bugfixes in the open-artisan plugin. No new features. No schema changes. No user-facing API changes.

**Files modified:**
- `.opencode/plugins/open-artisan/index.ts`
- `.opencode/plugins/open-artisan/fast-forward.ts`
- `.opencode/plugins/open-artisan/hooks/idle-handler.ts`

## Fix 1 — Forward-skip reads stale `fileAllowlist` before `store.update` (index.ts)

`computeForwardSkip` is called at line 2373 using `state.fileAllowlist`, but `fileAllowlist` is only populated from `args.approved_files` inside `store.update` at line 2437. At PLANNING approval time `state.fileAllowlist` is still `[]`, so the skip never fires.

**Change:** Compute `effectiveAllowlist` from `args.approved_files` (when at PLANNING/INCREMENTAL) before calling `computeForwardSkip`, then pass `effectiveAllowlist` instead of `state.fileAllowlist`.

## Fix 2 — `computeForwardSkip` treats `[]` as "not configured" (fast-forward.ts)

`fast-forward.ts:270`: `if (mode !== "INCREMENTAL" || fileAllowlist.length === 0) return null`

An explicitly empty allowlist means "no source files to change" — all phases (INTERFACES, TESTS, IMPL_PLAN) should be skipped. The guard conflates "allowlist not yet set" with "allowlist explicitly empty".

**Change:** Remove `|| fileAllowlist.length === 0` from the guard. An empty allowlist already causes `hasInterfaceFiles = false` and `hasTestFiles = false`, which correctly skips all three phases and lands at IMPLEMENTATION.

## Fix 3 — Auto-approver instructs the agent instead of executing inline (index.ts)

After `mark_satisfied` passes and the state enters USER_GATE, the auto-approver fires and returns: `"Call submit_feedback with feedback_type: 'approve'..."`. The agent must act on this in a *separate turn*. But the idle handler ignores USER_GATE (Fix 4), so if the agent goes idle, nothing re-prompts it — the session stalls.

**Change:** When auto-approval succeeds, execute the approval state transition directly inside `mark_satisfied`'s handler (inline), returning the final phase-advance message. The agent never needs to call `submit_feedback` in a follow-up turn.

Implementation: extract the core approval state mutation logic into a shared inline helper `executeInlineApproval(sessionId, state, store, sm, client, context, log)` called from both the auto-approve path in `mark_satisfied` and the normal approval path in `submit_feedback`. The helper performs: SM transition → forward-skip computation → git checkpoint → artifact hash recording → state mutation → return response message.

## Fix 4 — Idle handler ignores USER_GATE even in robot-artisan mode (idle-handler.ts)

`idle-handler.ts:32`: when `phaseState === "USER_GATE"`, always returns `{ action: "ignore" }`. This is correct for human sessions (waiting for user input). But in robot-artisan mode after auto-approval has fired and set `userGateMessageReceived = true`, the session should not be silent — if the agent goes idle without calling `submit_feedback`, the idle handler should re-prompt it.

**Change:** Add `activeAgent` to `handleIdle`'s input (extend `WorkflowState` parameter or pass separately). When `phaseState === "USER_GATE"` AND `activeAgent === "robot-artisan"` AND `userGateMessageReceived === true`, return `reprompt` instead of `ignore`.

Note: with Fix 3 (inline approval), Fix 4 becomes a belt-and-suspenders safety net rather than the primary recovery path. It still matters for cases where inline approval fails (auto-approver timeout, parse error) and the agent falls through to the normal USER_GATE message.

## Execution order
1. Fix 2 (fast-forward.ts) — simplest, self-contained
2. Fix 1 (index.ts forward-skip call site) — depends on understanding Fix 2
3. Fix 4 (idle-handler.ts) — self-contained
4. Fix 3 (index.ts inline auto-approve) — most complex, depends on understanding full approval path

## File allowlist
- `.opencode/plugins/open-artisan/index.ts`
- `.opencode/plugins/open-artisan/fast-forward.ts`
- `.opencode/plugins/open-artisan/hooks/idle-handler.ts`
