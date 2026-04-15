# Full Execution Plan

## Operating Model

Use Hermes + Open Artisan as the primary workflow driver and dogfood path.

Execution rules:

1. Implement one step at a time.
2. Use Hermes + Open Artisan to drive each major step.
3. Treat Hermes dogfooding as explicit only when the runtime/adapter contract reports Hermes provenance; documentation alone does not establish dogfooded state.
4. Non-Hermes or unlabeled paths do not implicitly qualify as Hermes-dogfooded.
5. When Hermes dogfooding exposes workflow/framework/runtime bugs, the bug loop is required before normal planned feature work resumes.
6. Return to Hermes and continue the planned task.
7. Commit progress as meaningful slices land.

## Quality Standard

Be uncompromising on:

- correctness
- cross-client consistency
- workflow/gate behavior
- parser/runtime integrity
- test realism
- docs for user-visible behavior
- technical debt that slows future work

Be token-efficient by:

- revising artifacts in place
- reviewing by file/reference instead of regenerating whole artifacts
- avoiding naming churn and cosmetic rewrites
- avoiding abstraction for one-off stable code unless it clearly improves architecture

## Execution Order

1. Harness quality improvements
2. Shared bridge completion and dogfooding
3. Roadmap DAG layer + durable local backend
4. Hermes user-gate / integration-channel support
5. Parallel DAG execution, explicitly driven and dogfooded through Hermes
6. Studio/control-plane evolution later

---

## Numbered Execution Backlog

Status update:

- Completed: `harness-quality-hardening`
- Completed: `cross-client-shared-bridge-e2e`
- In progress: `post-feature-cleanup-quality-pass`
- Landed commits from that slice:
  - `d2e61e3` `fix: handle Hermes shared bridge socket RPC`
  - `c4bb86c` `fix: resume workflows from persisted feature state`
  - `a026d84` `fix: harden bridge review and impl-plan parsing`
  - `7f19a02` `fix: harden shared bridge workflow parity`
  - `39c0779` `test: cover shared bridge lifecycle end to end`
  - `840eafb` `fix: restore bridge impl-plan approval parity`
- Historical-state policy: do not backfill already-completed persisted workflow-state files just to mirror parser/runtime fixes discovered after completion unless a concrete runtime/product need requires migration.

### 1. Tighten artifact revision discipline

**Goal:** revise artifacts in place, by reference, not full-regenerate.

**Work**

1. Prefer patching existing artifact files over regenerating full documents.
2. Make review prompts operate on artifact paths first.
3. Track whether a submission is:
   - in-place revision
   - regenerated artifact
   - unchanged resubmission

**Acceptance criteria**

1. Revised artifacts are usually patched, not rewritten wholesale.
2. Review loops compare current artifact vs prior review issues.
3. Large artifact rewrites are exceptional.

### 2. Strengthen review gates for substantive quality

**Goal:** block partial integrations, weak tests, and debugging debt.

**Work**

1. Add blocking criteria for:
   - no placeholder tests for claimed-complete scope
   - no helper-only implementations without runtime call sites
   - no partial client integration for shared infrastructure
   - docs required for user-visible runtime behavior
   - no duplicated policy logic without justification
2. Add criteria for debt that affects future debugging.
3. Keep cosmetic/style-only concerns non-blocking.

**Acceptance criteria**

1. Features cannot pass with half-integrated client paths.
2. Features cannot pass with TODO tests covering current scope.
3. Review clearly separates substantive debt from stylistic noise.

### 3. Strengthen IMPL_PLAN parsing and validation

**Goal:** no malformed DAGs reach implementation.

**Work**

1. Validate task parsing before implementation starts.
2. Validate:
   - task headers
   - multiline `Files:`
   - multiline `Expected tests:`
   - dependencies
   - missing/empty metadata where required
3. Add realistic parser regression tests.
4. Block malformed DAGs before implementation.

**Acceptance criteria**

1. Normal section headings never become tasks.
2. Real task metadata parses correctly.
3. Malformed DAGs are blocked before implementation.

### 4. Harden workflow session and feature continuity

**Goal:** eliminate drift, stale resurrection, and accidental feature confusion.

**Work**

1. Tighten:
   - resume-by-feature
   - parked workflow behavior
   - detach/resume semantics
   - foreground/background session rules
2. Add tests for:
   - same-session feature switching
   - resume parked feature
   - bridge-backed session continuity
   - no accidental feature slug drift

**Acceptance criteria**

1. Resumed sessions reattach to intended features reliably.
2. Restarts do not silently reset or drift workflows.
3. Feature switching preserves old workflow state safely.

### 5. Harden USER_GATE routing and approval logic

**Goal:** reliable approval/revise behavior across OpenCode, Claude, and Hermes.

**Work**

1. Keep deterministic/hybrid approval parsing.
2. Expand safe approval phrase coverage.
3. Reject mixed approval-plus-revision text safely.
4. Verify actual user text propagation in all clients.

**Acceptance criteria**

1. Common clear approval phrases route correctly.
2. Mixed approval + concerns routes to revise.
3. Gate routing is consistent across all clients.

### 6. Add cross-client E2E shared-bridge tests

**Goal:** test real coexistence and lifecycle, not just helpers.

**Work**

1. Add scenarios for:
   - one bridge, two clients attach
   - Claude + Hermes share one bridge
   - one client exits, bridge stays alive
   - stale metadata recovery
   - restart/resume continuity
   - blocked shutdown while clients remain

**Acceptance criteria**

1. Shared-bridge scenarios are proven by real tests.
2. Multi-client bridge lifetime is exercised directly.
3. Dogfooding scenarios are reproducible in tests where feasible.

### 7. Add a post-feature cleanup/quality pass

**Goal:** catch what passes gates but is not yet excellent.

**Work**

1. Add a final review pass focused on:
   - duplication
   - dead helper APIs
   - incomplete integration
   - docs/runtime mismatch
   - avoidable complexity

**Acceptance criteria**

1. No obvious partial integrations remain at feature completion.
2. Dead/speculative helper APIs are flagged.
3. Runtime/docs coherence is checked explicitly.

### 8. Harden Hermes adapter/runtime behavior

**Goal:** Hermes is reliable enough to drive workflows continuously.

**Work**

1. Review and stabilize:
   - hook signatures
   - tool signatures
   - resumed sessions
   - bridge lifecycle
   - approval/user-gate flow
2. Expand Hermes smoke tests.

**Acceptance criteria**

1. Hermes can reliably drive workflows across resumes.
2. Hermes/Open Artisan interaction no longer depends on ad hoc rescue.
3. Hermes Python suite remains green.

### 9. Make Hermes dogfooding an explicit rule

**Goal:** every important harness feature is validated through Hermes.

**Work**

1. Use Hermes to drive:
   - shared bridge
   - roadmap DAG
   - parallel DAG
2. Feed discovered issues into the bug loop immediately.

**Acceptance criteria**

1. Shared infrastructure features are dogfooded through Hermes.
2. Bugs found during dogfooding are fixed before moving on.

### 10. Use Hermes to implement parallel DAG execution explicitly

**Goal:** Hermes is not just a test client; it is the implementation driver.

**Acceptance criteria**

1. Parallel DAG tasks are implemented while actively using Hermes/Open Artisan.
2. Dogfooding feedback continuously improves the harness.

### 11. Introduce a persistent roadmap DAG above workflows

**Goal:** move from isolated per-feature workflows to a continuous project roadmap graph.

**Core model**

1. **Roadmap DAG**
   - long-lived
   - features, bugs, debt, chores, blocked items
2. **Execution DAG**
   - selected slice/subgraph for current implementation
3. **Workflow state**
   - phase/gate/review state for the current execution slice

**Acceptance criteria**

1. Roadmap DAG exists independently of any single workflow.
2. Workflows can execute slices of the roadmap rather than only freeform features.
3. Bugs/issues/debt can live in the same roadmap graph.

### 12. Add a durable local backend owned by the bridge

**Goal:** make roadmap and shared state queryable and persistent.

**Recommendation**

- local-first database
- SQLite
- Drizzle or Kysely-style access layer
- bridge as authoritative local state/query surface

**Work**

1. Define schema for roadmap items, edges, priorities, status, provenance, timestamps.
2. Add migrations.
3. Add bridge-owned persistence/query layer.

**Acceptance criteria**

1. Roadmap state is stored in a real local database.
2. State is queryable and traversable efficiently.
3. Bridge owns access to that state.

### 13. Add roadmap query and mutation APIs through the bridge

**Goal:** make the roadmap usable by local clients and future UI/control plane.

**Work**

1. Add APIs to:
   - create item
   - update item
   - add bug/issue
   - reprioritize
   - add/remove dependency
   - mark done
   - mark blocked
   - split/merge items
   - derive execution slice

**Acceptance criteria**

1. The roadmap can be queried and mutated through bridge APIs.
2. New requirements can be placed into the DAG without manual file editing.
3. Bugs/issues can be inserted and tracked in the same graph.

### 14. Add grooming and orchestration semantics

**Goal:** allow continuous planning rather than one-shot planning.

**Work**

1. New requirement arrives:
   - place it in DAG
   - infer dependencies
   - determine whether it reprioritizes current work
   - determine whether downstream work is invalidated
2. Add grooming operations:
   - split
   - merge
   - defer
   - obsolete
   - reprioritize

**Acceptance criteria**

1. The orchestrator can place new work into the roadmap DAG.
2. The system can identify next-ready/high-priority work.
3. Reprioritization and grooming are first-class operations.

### 15. Keep it Studio-compatible without implementing Studio yet

**Goal:** the roadmap backend should later support UI/control-plane access.

**Work**

1. Keep roadmap state bridge-accessible.
2. Ensure it is queryable by:
   - local adapters now
   - future UI/control plane later
3. Do not build Studio sync/cloud behavior yet.

**Acceptance criteria**

1. The local backend is bridge-owned and queryable.
2. It can later be surfaced to Studio without redesigning the model.
3. We do not overbuild remote orchestration yet.

### 16. Add Hermes user-gate forwarding to integration channels

**Goal:** Hermes can forward gates to channels like Discord/email.

**Work**

1. Forward user gates with:
   - feature
   - phase/sub-state
   - artifact context
   - required user action
2. Route replies back into workflow state.

**Acceptance criteria**

1. User gates can be emitted to integration channels.
2. Replies can be mapped back into the workflow safely.

### 17. Add Hermes question-routing to integration channels

**Goal:** Hermes can ask users questions outside the local session.

**Acceptance criteria**

1. Clarifying questions can be sent via channel integrations.
2. Responses can be reintroduced into the workflow as user input.
3. Channel replies are normalized and auditable.

### 18. Define channel-policy rules

**Goal:** distinguish what can be offloaded safely.

**Acceptance criteria**

1. User gates can be forwarded.
2. Clarifying questions can be forwarded.
3. Ambiguous/sensitive replies do not silently trigger risky actions.

### 19. Adopt the bug loop as a formal process

**Loop**

1. detect
2. root-cause
3. plan tests for fix
4. plan fix
5. implement tests for fix
6. implement fix
7. ensure fixed
8. review fix
9. return to previous work

**Acceptance criteria**

1. Non-trivial bugs follow this loop.
2. Fixes are not left half-verified.
3. Returning to interrupted work is explicit.

### 20. Finish shared-bridge completeness across all clients

**Goal:** shared bridge is truly complete across core + Claude + Hermes.

**Acceptance criteria**

1. Core bridge lifecycle is complete.
2. Claude runtime actually uses the shared-bridge path.
3. Hermes runtime actually uses the shared-bridge path.
4. Avoidable duplicated bridge policy logic is removed.

### 21. Improve shared-bridge observability

**Goal:** enough logs/state to debug real issues without overbuilding monitoring.

**Acceptance criteria**

1. attach vs start decisions are logged
2. stale vs incompatible state is logged
3. lease changes and shutdown blocking are logged
4. metadata/state is inspectable and useful

### 22. Documentation alignment pass

**Goal:** docs match actual runtime behavior.

**Acceptance criteria**

1. Shared bridge behavior is documented for Claude/Hermes.
2. Failure/recovery procedures are documented.
3. Docs match runtime, not aspiration.

### 23. Dogfood shared bridge again after the initial pass

**Goal:** make one stabilizing pass before parallelism.

**Acceptance criteria**

1. Shared bridge feels stable enough to support the next major feature.
2. No known major session/bridge/gate regressions remain.

### 24. Start Phase 6 on top of the improved harness

**Goal:** build parallel DAG on stable bridge + roadmap + workflow quality.

### 25. Implement parallel DAG with Hermes actively driving

**Core slices**

1. scheduler batching
2. concurrency config
3. parallel task lifecycle
4. merge/conflict behavior
5. worktree management
6. dogfooding through Hermes throughout

**Acceptance criteria**

1. Parallel DAG is built on stable shared bridge + roadmap infrastructure.
2. Hermes actively drives and dogfoods the work.
3. Bugs are fed through the standard bug loop immediately.

---

## Short Recommendation for the Next Session

1. Read this file.
2. Confirm recent commits and worktree state.
3. Start or resume a Hermes-driven workflow for the next harness-quality slice.
4. Continue using Hermes as the main execution driver.
5. Fix framework issues directly in the repo when Hermes exposes them.
6. Return to Hermes after each fix.
