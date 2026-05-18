# Workflow Hardening Friction Points

These are the workflow UX and correctness issues identified while dogfooding Open Artisan.

1. Per-task review required full-suite success before downstream tasks were allowed to run, creating a deadlock when pending downstream tests were expected to fail.
2. Current-task write guard overrode the approved global allowlist, blocking files that were approved globally and in the DAG but not owned by the current task.
3. Task boundary repair misreported approved files as outside the incremental allowlist by showing current-task files as if they were the global allowlist.
4. `propose_change` failed internally and did not provide actionable routing, including raw JSON parse failures and partial reviewer metadata.
5. Backtrack routing was inconsistent: tactical fixes were recommended while guards blocked them, and later the same issue was accepted as an IMPL_PLAN backtrack.
6. `request_review` could not surface an implementation blocker because it refused review while DAG tasks were incomplete.
7. Delegated child workflows did not auto-start useful work and stayed at `MODE_SELECT/DRAFT`.
8. Subagents could not use `guarded_patch`, making delegated guarded implementation ineffective.
9. Drift repair generated a phase-invalid `submit_feedback` action while in `IMPLEMENTATION/DRAFT`.
10. `mark_satisfied` criteria parsing was brittle around score formats such as `pass` or `9/10`, leading to confusing blocking-count and `NaN` behavior.
11. Reviewer JSON failures recurred, with Markdown prose sometimes causing confusing `REVISE`/`REVIEW` transitions.
12. Approval validation parsed shell commands in IMPL_PLAN expected tests as file paths.
13. Workflow gate prompt routed a non-artifact/meta question as immediate `submit_feedback` artifact feedback.
14. Idle reprompt wording caused loops by repeatedly telling the agent to continue invalid transitions instead of diagnosing guard deadlocks.
15. Error messages did not identify the actual source of truth being enforced: phase allowlist, global allowlist, current task files, or artifact metadata.
16. There was no clean way to mark a task locally complete but blocked by downstream full-suite checks.
17. Child workflow status required manual polling and did not integrate cleanly with parent scheduling.
18. Artifact approval failure for schema metadata required user-driven revision instead of returning exact repair guidance or an auto-routed metadata-only repair.

Priority follow-up: backtrack/cascade auto-skip must not auto-skip when a scope change is detected.
