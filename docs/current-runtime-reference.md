# Current Runtime Reference

This document is the concise current-state reference for the runtime. Historical design rationale remains in `docs/structured-workflow-design.md`.

## Verification

Use `bun run verify:all` before merging substantial changes. It runs generated contract checks, TypeScript, whitespace checks, root/package/PGlite tests, and Hermes Python tests.

GitHub Actions runs the same command on pushes and pull requests via `.github/workflows/verify.yml`.

## Workflow State

Current workflow schema version: v24.

Default DB path: `.openartisan/workflow-db/open-artisan.pg`.

Filesystem compatibility state path: `.openartisan/<featureName>/workflow-state.json`.

Sub-workflow filesystem compatibility path: `.openartisan/<parentFeature>/sub/<childFeature>/workflow-state.json`.

Legacy single-file state is migrated on load. Future schema versions are rejected.

## Review Boundaries

Phase and task reviews are isolated-reviewer submissions. Bridge adapters request review context, receive a one-time `OPEN_ARTISAN_REVIEW_TOKEN`, spawn an isolated reviewer, and submit the reviewer result with `review_token`.

Author-facing Claude/Hermes tools must not call `mark_satisfied`, `submit_task_review`, or `submit_phase_review` directly.

## Adapter Boundaries

OpenCode is the native plugin adapter and still owns some direct workflow handlers. Bridge clients use JSON-RPC `tool.execute` and shared handler implementations.

Claude Code uses a Unix socket bridge protected by `.openartisan/.bridge-token`; hooks fail closed for write-like tools when Open Artisan is enabled but the bridge guard is unavailable.

Hermes uses the bridge client and the same socket token when attaching to a shared Claude bridge.

## DB Runtime

PGlite is the default runtime backend unless filesystem persistence is explicitly requested.

The filesystem state files are compatibility projections/fallbacks, not the primary runtime store in default mode.

Multi-table repository operations should run inside `repository.transaction()` or `withTransaction()` in `open-artisan-repository-pglite.ts`.

Relationship integrity is currently enforced in repository methods and regression tests rather than database foreign keys.
