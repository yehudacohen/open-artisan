# Database-Backed Workflow Runtime Plan

## Context

Hermes dogfooding exposed repeated Open Artisan framework friction around human-gate resolution, task-review boundaries, implementation-plan churn, dirty worktree handling, and adapter parity. The current JSON workflow-state blob makes targeted task ownership changes and parallel-agent coordination difficult because every decision is reconstructed from large artifacts and mutable state snapshots.

We will release this as a major-version runtime change. Existing workflows do not need perfect transparent compatibility. They can be imported into the new database by agents/tools using best-effort migration and repair.

## Goal

Make the local database the canonical workflow coordination layer before resuming dogfooding. The database must support roadmap planning, workflow execution, task DAG ownership, review observations, patch suggestions, agent leases, fast-forward provenance, and human gates from one coherent transactional model.

## Core Decisions

- Use PGlite as the canonical local workflow database.
- Keep JSON workflow files as import/export/debug projections, not the primary store.
- Model roadmap items separately from workflow implementation tasks.
- Route reviewer feedback through structured observations and patch suggestions instead of forcing pass/fail-only task review.
- Let the orchestrator coordinate patch suggestions against task ownership, approved allowlists, roadmap scope, and active agent leases.
- Preserve backtracking for real scope/contract/design changes, but allow patch-only fast-forward when upstream semantics are unchanged.
- Treat human gates as real external/manual prerequisites only.
- Treat unrelated dirty worktree state as ambient observation, not an automatic task-review blocker.

## Conceptual Layers

| Layer | Purpose |
| --- | --- |
| Roadmap | Durable product/work planning across many features. |
| Execution slice | Selected roadmap subset being executed now. |
| Workflow | One Open Artisan run for a feature or roadmap slice. |
| Artifact | Phase outputs and approvals. |
| Implementation DAG | Workflow-local executable tasks and dependencies. |
| Review / patches | Review observations, patch suggestions, and application provenance. |
| Coordination | Agent leases, file claims, dirty worktree observations, and conflict routing. |

Roadmap items are durable planning units. Implementation tasks are workflow-local execution units. A roadmap item may map to many workflow tasks, and one workflow task may contribute to multiple roadmap items.

## Initial Schema Areas

| Area | Tables / records |
| --- | --- |
| Roadmap | `roadmap_items`, `roadmap_edges` |
| Execution slices | `execution_slices`, `execution_slice_items` |
| Workflows | `workflows`, `workflow_events`, `workflow_roadmap_links` |
| Artifacts | `artifacts`, `artifact_versions`, `artifact_approvals`, `artifact_roadmap_links` |
| Tasks | `tasks`, `task_dependencies`, `task_owned_files`, `task_expected_tests`, `task_roadmap_links` |
| Reviews | `task_reviews`, `phase_reviews`, `review_observations` |
| Patch suggestions | `patch_suggestions`, `patch_applications` |
| Coordination | `agent_leases`, `file_claims`, `worktree_observations` |
| Human gates | `human_gates` |
| Fast-forward | `fast_forward_records` |

## Repository Shape

Introduce `OpenArtisanRepository` as the transactional boundary. Higher-level services should compose it rather than reimplement persistence:

- `RoadmapService`
- `WorkflowService`
- `TaskGraphService`
- `ReviewService`
- `PatchSuggestionService`
- `AgentLeaseService`
- `WorktreeObservationService`

Existing `SessionStateStore` and `RoadmapStateBackend` become compatibility facades over repository projections during migration.

## Human Gates

Human gates represent external/manual prerequisites only. They are not for accepted risk, dirty worktree decisions, or task-boundary uncertainty.

Required fixes:

- Add `resolved_human_gates` to Hermes `oa_submit_feedback`.
- Process `resolved_human_gates` before rejecting `HUMAN_GATE` approval.
- Rename or clearly document `resolve_human_gate` as declaration semantics.
- Prevent non-human-gate tasks from becoming human-gated by accident.

## Review And Patch Suggestions

Task review should emit structured findings:

```json
{
  "recommendation": "pass | pass_with_suggestions | needs_orchestrator | fail",
  "blocking_issues": [],
  "patch_suggestions": [],
  "ownership_observations": [],
  "ambient_worktree_observations": [],
  "parallel_agent_observations": [],
  "scores": {}
}
```

The orchestrator decides whether a patch suggestion is applied to the current task, moved through a boundary update, deferred to another task, escalated to backtrack, or sent to a user gate.

## Boundary Changes

Expose `analyze_task_boundary_change` and `apply_task_boundary_change` across OpenCode, bridge, Hermes, and Claude where relevant. Boundary changes inside approved allowlists should not force PLANNING backtrack.

## Fast-Forward

Patch-only changes may fast-forward through gates when:

- only reviewer/orchestrator patch suggestions were applied,
- touched files are already approved,
- user intent and roadmap scope are unchanged,
- public contracts are unchanged,
- downstream tasks are not invalidated,
- isolated review passes.

User gates remain required for allowlist expansion, public contract changes, roadmap scope changes, material DAG changes, or unresolved parallel-agent conflicts.

## Dirty Worktree Policy

Dirty worktree observations are classified:

- task-owned changed files: reviewed normally,
- approved artifact files: reviewed normally,
- generated/cache artifacts: ignored or low-priority observation,
- unrelated human-authored files: ambient observation,
- parallel-agent claimed files: coordination observation,
- unowned files overlapping current task: orchestrator/boundary issue.

Generated examples include `__pycache__/`, `*.egg-info/`, build outputs, temp files, and tool caches.

## Idempotency

Late or duplicate calls should be state-aware no-ops with useful guidance:

- `mark_satisfied` after reviewer already advanced,
- duplicate `request_review`,
- duplicate `submit_task_review`,
- stale `submit_feedback`.

## Implementation Sequence

1. Add DB repository interfaces and domain types.
2. Add PGlite repository stub with schema ownership and migration hooks.
3. Add JSON import/export compatibility stubs.
4. Add roadmap-aware workflow/task schema projections.
5. Fix human-gate semantics and Hermes schema.
6. Add review observation and patch suggestion model.
7. Add orchestrator patch routing.
8. Expose boundary tools across adapters.
9. Add patch-only fast-forward provenance.
10. Add dirty-worktree observation policy.
11. Add idempotent review/tool handling.
12. Resume Hermes dogfooding only after the foundation is stable.

## Acceptance Criteria

- Hermes can resolve human gates from Discord.
- Non-human choices never create human-gated tasks.
- Task review can surface unrelated dirty files without failing the task.
- Reviewer patch suggestions are persisted and routed by orchestrator.
- Boundary changes inside approved scope do not require PLANNING backtrack.
- Patch-only corrections can fast-forward with recorded provenance.
- Roadmap items, workflows, and implementation tasks are queryable separately.
- Agents can query targeted context instead of rereading entire artifact histories.
- JSON export remains available for debugging and migration.

## Implementation Checkpoints

### 2026-05-01: Human Gate Runtime Slice

- Hermes `oa_submit_feedback` exposes `resolved_human_gates`.
- Bridge and OpenCode `submit_feedback` process explicit human-gate resolution from `IMPLEMENTATION/HUMAN_GATE` instead of treating `HUMAN_GATE` as a normal approval surface.
- Resolving a human gate returns to `IMPLEMENTATION/SCHEDULING` so the runtime can either dispatch unblocked downstream work or request final implementation review.
- Focused bridge, OpenCode, Hermes adapter, and TypeScript checks passed for this slice.

### 2026-05-01: Next DB Repository Slice

- Replace the PGlite repository placeholder with a schema-backed implementation for initialization, workflow creation/query, workflow events, task graph replacement, task status updates, human gates, reviews, patch suggestions, leases, worktree observations, fast-forward records, and best-effort JSON import/export projections.
- Keep runtime wiring out of this slice; callers can exercise the repository directly while the existing JSON runtime remains active.

### 2026-05-01: Repository Surface Completion

- Added repository read/link surfaces for roadmap items/edges, execution slices, workflow events, workflow-roadmap links, artifacts, artifact versions/approvals, artifact-roadmap links, task graphs, reviews, observations, patch suggestions/applications, human gates, agent leases, file claims, worktree observations, and fast-forward records.
- Wired legacy JSON compatibility helpers to the repository import/export methods.
- Tightened human-gate declaration so only planned `human-gate` tasks can become human-gated.
- Export now projects current DB task/human-gate state instead of returning stale imported snapshots unchanged.

### 2026-05-01: Ready-To-Wire Foundation Closure

- Added repository-backed `StateBackend` and `RoadmapStateBackend` compatibility facades so existing runtime stores can be pointed at the DB repository in a later wiring slice.
- Added workflow list/delete operations and tightened legacy import cleanup so re-import does not leave stale workflow-owned records.
- Replaced repository-level mutable transaction state with async-local transaction context to avoid cross-call transaction leakage.
- Hardened artifact version recording to reject dangling artifact versions.
- Exposed task-boundary analysis/application tools through Hermes schemas and plugin manifest for adapter parity.

### 2026-05-01: Pre-Wiring Finding Closure

- Human-gate declaration now rejects missing tasks before writing any gate rows.
- DB `StateBackend` rejects feature-key/state mismatches during compatibility writes.
- DB `RoadmapStateBackend` preserves repository error categories instead of flattening all failures into storage failures.
- Added thin service seams (`RoadmapService`, `WorkflowService`, `ArtifactService`, `TaskGraphService`, `ReviewService`, `PatchSuggestionService`, `AgentLeaseService`, `WorktreeObservationService`, `FastForwardService`) over the repository so runtime wiring has explicit service targets.
- Expanded tests for missing-task human gates, dangling artifact versions, state backend feature mismatch, service seams, repository facades, and adapter tool registration.

### 2026-05-01: Final Pre-Implementation Surface Closure

- Expanded service seams to cover the full repository surface, including execution slices, workflow phase/delete/link operations, artifact approval/link operations, roadmap edge listing, and human gates.
- Added targeted Hermes boundary-tool registration/schema tests for `oa_analyze_task_boundary_change` and `oa_apply_task_boundary_change`.
- Expanded service tests to exercise the newly covered operations.

### 2026-05-03: Compatibility Projection Preservation

- Compatibility `WorkflowState` imports no longer wipe DB-owned workflow events, artifact records/versions/approvals, agent leases, or file claims.
- Artifact version recording now updates the canonical artifact record with `currentVersionId`.
- Compatibility JSON export overlays DB-derived artifact disk paths and approved artifact hashes, keeping JSON output a debug/export projection rather than the artifact source of truth.
- Added PGlite regression coverage for preserving canonical runtime facts across repeated compatibility state writes.
