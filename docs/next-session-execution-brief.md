# Next Session Execution Brief

## Objective

Resume the long-range execution plan for Open Artisan using Hermes as the primary workflow driver and dogfood path.

The operating model is:

1. Implement one step at a time.
2. Use Hermes + Open Artisan to drive each major step.
3. When Hermes exposes workflow/framework/runtime bugs, fix them immediately in the repo.
4. Return to Hermes and continue the planned task.
5. Commit progress as meaningful slices land.

## Current Status

- Shared bridge feature workflow was completed successfully in Hermes.
- Shared bridge implementation landed in multiple commits and reached `DONE`.
- `harness-quality-hardening` was completed successfully in Hermes and reached `DONE`.
- Hermes dogfooding exposed and fixed multiple framework issues:
  - approval routing at `USER_GATE`
  - Hermes hook/tool API mismatches
  - lazy bridge restart/session recreation
  - `request_review` parity for `DISCOVERY/CONVENTIONS`
  - bridge session persistence on `sessionDeleted`
  - Hermes session identity continuity
  - IMPL_PLAN parser bogus-heading bug
  - Hermes shared-bridge socket RPC for attached bridges
  - persisted feature resume lookup across long-lived bridge processes
  - bridge review invalidation / REVIEW-state resubmission parity
  - IMPL_PLAN parser support for multiline bullet-list `Files:` / `Expected tests:` fields

Recent commits of note:

- `6c4998c` `fix: harden workflow adapters and session handling`
- `ec9b09f` `fix: preserve hermes session identity across hooks`
- `1661cb3` `feat: add shared bridge discovery primitives`
- `01a00f3` `feat: add shared bridge lease lifecycle`
- `a2ac928` `test: force bridge shutdown in integration teardown`
- `86352c3` `feat: add claude shared bridge attach path`
- `4188cef` `feat: add hermes shared bridge attach path`
- `8b26f78` workflow implementation checkpoint
- `d2e61e3` `fix: handle Hermes shared bridge socket RPC`
- `c4bb86c` `fix: resume workflows from persisted feature state`
- `a026d84` `fix: harden bridge review and impl-plan parsing`

## Completed Harness-Quality Slice

Completed workflow:

- `harness-quality-hardening`

What landed in that slice:

1. Review/revision parity hardening across OpenCode/plugin, bridge, and Hermes paths.
2. Persisted feature resume correctness across long-lived bridge/Hermes sessions.
3. Hermes shared-bridge continuity fixes for attached socket RPC.
4. IMPL_PLAN parser/runtime hardening for real multiline task metadata.

Policy note from that run:

- Do not backfill already-completed persisted workflow-state files solely to reflect parser/runtime fixes discovered after the fact.
- Treat those finished state files as historical artifacts of the old runtime behavior unless a real product/runtime need requires migration or repair.
- Prefer fixing the runtime, adding regression tests, and documenting the policy over mutating completed workflow history.

## Agreed Strategy

### Execution order

1. Harness quality improvements
2. Shared bridge completion and dogfooding
3. Roadmap DAG layer + durable local backend
4. Hermes user-gate / integration-channel support
5. Parallel DAG execution, explicitly driven and dogfooded through Hermes
6. Studio/control-plane evolution later

### Quality standard

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

## High-Priority Backlog (next execution wave)

### A. Harness quality first

1. Tighten artifact revision discipline
2. Strengthen review gates for substantive quality
3. Strengthen IMPL_PLAN parsing and validation
4. Harden workflow session and feature continuity
5. Harden USER_GATE routing and approval logic
6. Add cross-client E2E shared-bridge tests
7. Add a post-feature cleanup/quality pass

### B. Hermes as first-class dogfood driver

8. Harden Hermes adapter/runtime behavior further
9. Make Hermes dogfooding an explicit rule
10. Use Hermes to implement parallel DAG execution explicitly

### C. Roadmap DAG + durable backend

11. Introduce a persistent roadmap DAG above workflows
12. Add a durable local backend owned by the bridge
13. Add roadmap query and mutation APIs through the bridge
14. Add grooming/orchestration semantics
15. Keep it Studio-compatible without implementing Studio yet

### D. Hermes user-gate / integration channels

16. Add Hermes user-gate forwarding to integration channels
17. Add Hermes question-routing to integration channels
18. Define channel-policy rules

### E. Standard bug loop

19. Formalize the bug loop:
   - detect
   - root-cause
   - plan tests for fix
   - plan fix
   - implement tests for fix
   - implement fix
   - ensure fixed
   - review fix
   - return to prior work

### F. Return to parallel DAG execution

20. Start Phase 6 only after the above initial pass
21. Implement parallel DAG with Hermes actively driving

## Recommendation for the Next Session

Start a new Hermes-driven workflow for the next planned backlog item rather than broadening `harness-quality-hardening` further.

Recommended next feature/workflow name:

- `cross-client-shared-bridge-e2e`

Recommended scope inside that workflow:

1. Add cross-client E2E shared-bridge tests
2. Dogfood real multi-client bridge behavior through Hermes
3. Fix any bridge/client/runtime defects immediately and return to Hermes

## Instruction for the Next Session

At the start of the next session:

1. Read this file.
2. Confirm recent commits/worktree state.
3. Start or resume a Hermes-driven workflow for `cross-client-shared-bridge-e2e`.
4. Continue using Hermes as the main execution driver.
5. Fix framework issues directly in the repo when Hermes exposes them.
6. Return to Hermes after each fix.
