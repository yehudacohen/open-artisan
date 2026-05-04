# Hermes Kickoff: Structural State-Machine Rigor

This document is the source of truth for the Hermes dogfood kickoff. Do not rely on Discord text snippets or pasted attachments for the instructions.

## Driver Setup

You are the Hermes driver for Open Artisan dogfooding.

Repository: `/Users/yehudac/workspace/open-artisan`

Feature name: `structural-state-machine-rigor`

If your current session is attached to a different repository, first call `oa_list_projects`, then `oa_select_project`, and bind the session to `/Users/yehudac/workspace/open-artisan` before using any other `oa_*` workflow tools.

Use Open Artisan for the real workflow, but do **not** blindly continue the old persisted implementation DAG. The existing `structural-state-machine-rigor` artifacts are now historical context and are known to be stale against the current repo state. Start by reconciling persisted workflow state, artifact content, and current code reality.

Known current state to reconcile:

- `.openartisan/structural-state-machine-rigor/workflow-state.json` reported `IMPLEMENTATION/HUMAN_GATE` with T1 human-gated and T2-T10 pending.
- `.openartisan/structural-state-machine-rigor/status.md` reported `IMPLEMENTATION/USER_GATE`, so status output and persisted state disagreed.
- The T1 human gate records that the user accepted worktree-cleanliness risk; resolve that structurally through Open Artisan if the workflow is still waiting on it.
- The approved `plan.md` says no new persistence systems/runtime dependencies, but the actual completed work includes DB/PGlite runtime, DB locks/queues/migrations/indexes, runtime fact persistence, patch suggestion execution, graph-native drift repair, adapter parity, and verification stabilization.
- The approved `impl-plan.md` no longer truthfully describes the current implementation boundary or remaining work.

The next dogfood task is therefore workflow reconciliation, not new source implementation. Prefer `report_drift`, `plan_drift_repair`, `apply_drift_repair`, `submit_feedback.resolved_human_gates`, and `propose_backtrack` as appropriate. If the approved planning artifacts materially understate current scope, backtrack/revise the artifacts through the normal workflow path instead of manually editing workflow state.

Continue autonomously until a truthful stop condition:

- A real `USER_GATE`
- An unresolved human gate
- An explicit safety stop
- A real runtime/framework failure

Do not stop merely because a phase artifact was drafted if the next Open Artisan tool call is available.

If the required workflow tool for the current persisted phase is not visible in the tool schema, stop immediately and report a framework/runtime tool-surface bug. Do not run no-op shell commands as a substitute for missing workflow tools.

## Dogfood Rules

- Exercise the Hermes + Open Artisan path honestly.
- Do not ask the supervisor to call bridge tools directly as a substitute for Hermes workflow progress.
- If a supervisor performs direct bridge, adapter, or filesystem recovery, classify it as supervisor recovery, not dogfood proof.
- If autonomous execution stops between runnable steps and requires repeated manual kicking, classify that as a framework/runtime defect.
- Preserve review evidence and persisted workflow state as auditable artifacts.
- At gates, report the files/artifacts the user should review.
- Before submitting each phase artifact, ensure the required review rubric/acceptance criteria were visible to the implementer.
- Before each implementation task, ensure the task-review rubric and final implementation phase rubric were visible.

## Problem Statement

Open Artisan currently has a pure table-driven FSM for the happy path, but several important workflow movements are implemented procedurally around it. Some of those are justified shortcuts, but they are not represented as explicit states or events. The goal is to make workflow rigor structural, not advisory.

The structural-rigor work should model justified bypasses as explicit state-machine concepts instead of ad hoc direct `draft.phase` or `draft.phaseState` mutations.

## Current Concerns To Investigate

When starting from a fresh feature, review the codebase and produce the normal Open Artisan discovery, plan, interfaces, tests, implementation plan, and implementation artifacts. When resuming `structural-state-machine-rigor`, reconcile the stale artifacts first and pay special attention to:

- Direct phase or phaseState mutation sites
- Fast-forward and forward-skip behavior
- Cascade auto-skip behavior
- Backtrack/propose-backtrack behavior
- Approval/checkpoint behavior
- Implementation DAG task scheduling, task review, task revision, human gates, and delegated tasks
- Resume validation and stale state recovery
- OpenCode and bridge adapter parity
- Tool guard bypasses, especially bash/write-shape enforcement
- Whether `DRAFT` and `USER_GATE` are overloaded with meanings that should be explicit

## Target Design Direction

Prefer explicit FSM states/events for meaningful workflow transitions. Candidate states include:

- `RESUME_CHECK`
- `CHECKPOINTING`
- `SKIP_CHECK`
- `CASCADE_CHECK`
- `BACKTRACK_REVIEW`
- `REDRAFT`
- `AUTO_APPROVE`
- `SCHEDULING`
- `TASK_REVIEW`
- `TASK_REVISE`
- `HUMAN_GATE`
- `DELEGATED_WAIT`

Candidate events include:

- `resume_check_requested`
- `checkpoint_started`
- `phase_skipped`
- `cascade_step_skipped`
- `backtrack_redraft_approved`
- `task_review_pass`
- `task_review_fail`
- `human_gate_resolved`
- `delegated_task_completed`

Do not blindly add every candidate. Use discovery to decide the smallest correct structural model.

The intended invariant is:

- Feedback events must not directly produce ordinary `DRAFT`.
- Only explicit backtrack-redraft approval may produce `REDRAFT`.
- Any justified skip, auto-approval, checkpoint, human gate, delegation wait, or task-review transition should be observable as an explicit state/event path.

## Suggested Milestones

Use Open Artisan phases to refine this, but treat the following as the initial roadmap:

- M1: Safety net and inventory. Add tests or assertions that expose direct mutation sites and current bypass behavior. Fix any known FSM `mode_selected` null issue if discovery confirms it.
- M2: Transition engine consolidation. Route phase/state movement through shared transition helpers instead of scattered mutation.
- M3: Approval, skip, and cascade states. Represent fast-forward, phase skip, cascade skip, checkpoint, and auto-approval behavior explicitly.
- M4: Backtrack semantics. Separate approved redrafting from ordinary drafting with explicit `BACKTRACK_REVIEW` and `REDRAFT` semantics if validated by discovery.
- M5: Implementation sub-FSM. Represent task scheduling, task review, task revision, human gates, and delegated waits structurally.
- M6: Adapter parity. Keep OpenCode and bridge/Hermes behavior aligned, with tests for both surfaces.

## Quality Bar

- Keep changes minimal and structural.
- Prefer table-driven enforcement over prompt-only guidance.
- Preserve existing workflow behavior unless the behavior is a bug or an unmodeled bypass that the plan explicitly replaces.
- Do not add backward compatibility unless there is a concrete persisted-state, shipped-behavior, or external-consumer need.
- Update tests before or alongside implementation so bypass regressions are observable.
- Update docs only after runtime behavior is true.

## Expected Verification

Use targeted tests during implementation. Use `bun run test` for the full repository suite; do not use raw `bun test` as the full-suite command because PGlite-heavy tests exceed Bun's default timeout under the unsplit runner. Likely targeted tests include:

- `bun test tests/state-machine.test.ts`
- `bun test tests/index-integration.test.ts`
- `bun test tests/bridge-tool-execute.test.ts`
- `bun test tests/idle-handler.test.ts`
- `bun test packages/core/tests/scheduler.parallel.test.ts`
- `bun test tests/system-transform.test.ts`

If changes touch Hermes adapter behavior, also run the targeted adapter tests from `packages/adapter-hermes`:

- `uv run pytest tests/test_shared_bridge.py tests/test_bridge_client.py tests/test_workflow_tools.py tests/test_prompt_hook.py`

Report any baseline failures separately from failures caused by this feature.

## Stop Reports

At each truthful stop, report:

- Stop classification: framework/runtime defect, correct workflow gate, artifact/spec quality gap, or external/environment blocker
- Current persisted phase/state
- Current task id, if any
- Files/artifacts the supervisor should inspect
- Tests run and results
- Any direct supervisor recovery performed, clearly marked as non-dogfood proof
