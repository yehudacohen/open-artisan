# Current Runtime Reference

This document is the concise current-state reference for the runtime. Historical design rationale remains in `docs/structured-workflow-design.md`.

## Verification

Use `bun run verify:all` before merging substantial changes. It runs generated contract checks, TypeScript, whitespace checks, root/package/PGlite tests, and Hermes Python tests.

GitHub Actions runs the same command on pushes and pull requests via `.github/workflows/verify.yml`.

## Workflow State

Current workflow schema version: v24.

Default PGlite data directory: `.openartisan/workflow-db/`.

Filesystem compatibility state path: `.openartisan/<featureName>/workflow-state.json`.

Sub-workflow filesystem compatibility path: `.openartisan/<parentFeature>/sub/<childFeature>/workflow-state.json`.

Legacy single-file state is migrated on load. Future schema versions are rejected.

## Review Boundaries

Phase and task reviews are isolated-reviewer submissions. Bridge adapters request review context, receive a one-time `OPEN_ARTISAN_REVIEW_TOKEN`, spawn an isolated reviewer, and submit the reviewer result with `review_token`.

Author-facing Claude/Hermes tools must not call `mark_satisfied`, `submit_task_review`, or `submit_phase_review` directly. Bridge `tool.execute` structurally rejects reviewer submission tools outside isolated-reviewer invocation, and rejects `mark_satisfied` unless the bridge was explicitly initialized in `agent-only` review mode.

## Adapter Boundaries

OpenCode is the native plugin adapter and still owns some direct workflow handlers. Bridge clients use JSON-RPC `tool.execute` and shared handler implementations.

Claude Code uses a Unix socket bridge protected by `.openartisan/.bridge-token`; hooks fail closed for write-like tools when Open Artisan is enabled but the bridge guard is unavailable.

Hermes uses the bridge client and the same socket token when attaching to a shared Claude bridge.

Hermes author tools and the Hermes plugin manifest are generated from the canonical tool registry in `packages/core/tool-contracts.ts`. After changing author-facing contracts, run `bun run generate:hermes-tools` and `bun run check:generated`; the committed `packages/adapter-hermes/hermes_adapter/tool_contracts.json` and `packages/adapter-hermes/plugin.yaml` are both checked for alignment with that projection.

The stdio bridge rejects oversized JSON-RPC request lines and converts transport-loop failures into JSON-RPC errors instead of allowing unhandled rejections to terminate the process.

## Product Management Overlay

Roadmap state is long-lived product memory. Workflow state is a temporary execution slice over that product memory. Roadmap mutations do not approve artifacts, complete implementation tasks, grant allowlist scope, resolve human gates, or switch workflows.

The product-management tools are always-available author tools across bridge, MCP, OpenCode, and Hermes author surfaces:

- `product_management_assess_request` classifies whether a request should continue current work, queue product memory, revise/backtrack the active artifact, request allowlist expansion, switch workflows, or ask the user.
- `product_management_list_work` lists active, frozen, and abandoned roadmap/workflow candidates with safety diagnostics.
- `product_management_queue_item` queues bugs, issues, features, debt, chores, and follow-ups into roadmap product memory while preserving the active workflow phase, phase state, task state, and gates.

Queueing maps `issue` to roadmap `bug` and `follow-up` to roadmap `chore` for persistence compatibility while preserving the requested kind in product-management results. Queued roadmap descriptions include source workflow, feature, session, task, artifact, message, execution-slice, and discovered roadmap ids when supplied; tool results also return structured provenance entries. If repository-backed roadmap services are unavailable, assess/list return degraded-context diagnostics and fall back to current workflow plus attached roadmap context when available; queueing returns a typed storage-failure result because it cannot persist product memory safely.

USER_GATE chat routing distinguishes artifact decisions from product-management capture. Approval or artifact revision still routes through `submit_feedback`; casual requests such as "file this bug for later" or "later we need a feature" remain normal chat so agents can use product-management tools without approving or revising the gated artifact. Execution decisions at `USER_GATE` or `ESCAPE_HATCH`, including switching or continuing workflows, return ask-user/gate routing rather than silently invoking workflow transition tools.

Recovery paths stay structural. Use roadmap tools for roadmap graph edits, `request_allowlist_expansion` or current-task scope tools for file-scope changes, `propose_backtrack` for artifact backtracking, and `select_mode` only for explicit workflow switching. Do not repair product-memory issues by directly editing workflow state or marking roadmap work done as a proxy for task completion.

Runtime smoke evidence now covers the OpenCode driver plus bridge adapter guard/review paths. OpenCode's real `artisan` driver used `opencode run --agent artisan` and invoked `product_management_assess_request` through the plugin for `file a bug for runtime smoke coverage` with roadmap item `apm-1`; the call succeeded, returned decision `queue-roadmap-item`, suggested `product_management_queue_item`, and did not edit files or call phase-transition tools. Claude Code has a real socket-bridge Stop-hook smoke test with a fake isolated reviewer CLI that advances `PLANNING/REVIEW` to `PLANNING/USER_GATE`. Hermes has a real shared-bridge smoke test that uses registered Hermes author tools, guard wrappers, and fake isolated reviewer dispatch to block writes in `PLANNING/DRAFT` and advance review to `USER_GATE`.

### Current-State Review Ratings

Implementation review on 2026-05-21 rates the product-management overlay at **9.1/10 overall**. Strongest areas are workflow safety and gate preservation (9.5/10), schema/contract correctness (9.5/10), and test coverage (9.5/10). Core architecture, adapter parity, persistence, documentation alignment, security/privacy, and product vision fit are each at 9/10. Operational observability, scheduler/autonomy compatibility, and UX ergonomics are at 8.5/10 because the first iteration intentionally uses chat/tool surfaces, event-hook observability, and conservative keyword classification rather than a dedicated UI, telemetry backend, or semantic product-manager model.

Residual risks are explicit: request classification is heuristic for ambiguous language, adapter smoke tests use local fake reviewer commands rather than live external Claude/Hermes agents, full Hermes gateway/continuation dogfood proof is still tracked separately, and queued roadmap descriptions are product memory that may include user-supplied project data. These are accepted tradeoffs for this scoped iteration and do not weaken workflow gate guarantees.

## DB Runtime

PGlite is the default runtime backend unless filesystem persistence is explicitly requested.

Filesystem state files are legacy migration inputs and best-effort compatibility mirrors in default DB mode, not an alternate live fallback after DB read/write/lock failures. Recoverable DB failures surface as runtime errors rather than silently switching canonical state stores.

Filesystem compatibility writes use temporary files plus atomic rename so crashes do not leave partial `workflow-state.json` content behind. Non-ENOENT workflow-state read failures are surfaced instead of being treated as absent state.

Multi-table repository operations should run inside `repository.transaction()` or `withTransaction()` in `open-artisan-repository-pglite.ts`.

Relationship integrity is currently enforced in repository methods and regression tests rather than database foreign keys.
