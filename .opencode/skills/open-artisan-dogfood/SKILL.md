---
name: open-artisan-dogfood
description: Coordinate Open Artisan dogfooding with a selected driver, load driver-specific guidance, and turn observed workflow gaps into Open Artisan improvements.
compatibility: opencode
metadata:
  workflow: dogfooding
  scope: meta
---

# Open Artisan Dogfooding

Use this skill when the user wants to dogfood Open Artisan while implementing a real feature.

The current session is the **supervisor**. The selected driver is the client/plugin/runtime that must exercise Open Artisan honestly.

## Required Input

The user should provide a driver when possible:

- `driver=opencode`
- `driver=hermes`
- `driver=claude`

If the driver is omitted, ask one short clarifying question before launching or resuming a run.

## Load Driver Guidance

Load the matching driver subskill before making runtime-specific decisions:

- `driver=opencode`: load `open-artisan-dogfood-opencode`
- `driver=hermes`: load `open-artisan-dogfood-hermes`
- `driver=claude`: load `open-artisan-dogfood-claude`

If no subskill is available, stop and explain that the driver-specific dogfood path is not installed.

## Core Rule

Dogfooding is an operational loop, not a synthetic runtime contract.

- The driver exercises the real workflow.
- The supervisor monitors the run, investigates quality, fixes Open Artisan defects, verifies fixes, and returns the driver to the interrupted work.
- Do not invent dogfooding-only bridge/runtime state just to track process.
- Do not let supervisor habits mask a driver/runtime defect.
- Any state mutation performed directly by the supervisor is a recovery action, not dogfood evidence. Label it as such and return to the driver before claiming the driver succeeded.

## Reference Material

When the feature has a design document, RFP, issue, spec, ADR, or similar source of requirements, use it as evaluation input.

When no design document or RFP exists, evaluate against the user request, repository conventions, discovered architecture, tests, and any artifacts the workflow has already approved.

During discovery and planning, require the driver to identify applicable references rather than assuming every dogfood run has a formal RFP.

## Supervisor Loop

1. Confirm the driver and intended feature.
2. Start or resume through the driver's native continuation-capable surface.
3. Let the driver progress one coherent slice at a time.
4. At every pause, classify the stop.
5. Inspect state, artifacts, logs, and worktree before approving or nudging.
6. If a defect is found, switch to the bug loop and fix Open Artisan now.
7. Resume the driver only after verifying state and runtime freshness.

Do not approve a workflow gate from the supervisor session unless the driver has already reached the same persisted `USER_GATE` through its native runtime and the supervisor is intentionally replying to that gate. If the supervisor had to call workflow tools directly to reach or pass the gate, classify the slice as manual recovery and do not count it as autonomous driver proof.

## Pause Classification

Classify every stop as exactly one of:

1. framework/runtime defect
2. correct workflow gate
3. artifact/spec quality gap
4. external/environment blocker

If a driver/plugin/runtime path claims autonomous execution but stops between runnable non-gated states and requires repeated supervisor kicks, classify that as a framework/runtime defect.

## User-Gate Investigation

At every Open Artisan `USER_GATE`, do not approve based only on the driver's summary. Investigate and report:

1. **Requirements fit:** If a design doc, RFP, issue, or spec applies, compare the artifact/work to it. If none applies, compare to the user request and discovered repo constraints.
2. **Artifact quality:** Judge whether the artifact is concrete, technically grounded, actionable, and specific to the target repository.
3. **Driver adherence:** Check whether the driver followed phase rules, used tools legally, preserved scope, and avoided inventing unsupported facts.
4. **Implementation quality:** When code exists, inspect whether it is minimal, tested, consistent with repo architecture, and safe to continue building on.
5. **Open Artisan improvement signal:** Identify whether weak output came from prompt gaps, review-criteria gaps, state/tool enforcement gaps, runtime defects, or normal model judgment.

Use this investigation to decide whether to approve, request revision, or pause feature progress for an Open Artisan fix.

## Bug Loop

When the driver exposes a real Open Artisan issue:

1. Stop feature progress at a safe boundary.
2. State expected vs actual behavior.
3. Reproduce or confirm from logs, artifacts, state, or code.
4. Add or identify targeted tests where feasible.
5. Implement the smallest structural fix in Open Artisan.
6. Run targeted verification.
7. Confirm workflow state and runtime freshness.
8. Resume the driver from the interrupted point.

Do not defer Open Artisan defects if they are actively blocking or degrading the dogfood run.

## Required Inspections

At natural boundaries inspect:

- `.opencode/openartisan-errors.log` when present
- `.openartisan/<feature>/workflow-state.json` when present
- current phase artifacts under `.openartisan/<feature>/` when present
- current worktree state
- recent relevant commits when checkpointing matters

Driver subskills may add runtime-specific logs and freshness checks.

## End-of-Slice Summary

For each meaningful slice, summarize:

1. driver and feature step attempted
2. stop classification
3. requirements/design/RFP reference used, if any
4. gate decision or defect found
5. Open Artisan improvement candidates
6. fixes applied, if any
7. tests run
8. exact remaining workflow state

## Success Criteria

Dogfooding is succeeding when:

- The driver makes real forward progress through Open Artisan phases.
- User gates receive substantive, evidence-backed review.
- Weak artifacts trigger revisions or Open Artisan improvements, not rubber-stamp approvals.
- Runtime defects are fixed close to discovery.
- The same bug class does not require repeated manual recovery.
- The driver uses its native continuation model rather than supervisor-only reinvocation.
