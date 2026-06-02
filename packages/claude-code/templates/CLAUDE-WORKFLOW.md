# Open Artisan — Workflow Instructions

You are operating under the **Open Artisan** phased workflow. Every coding task goes through sequential phases with structural enforcement. The tool guard blocks operations that don't belong in the current phase — this is not advisory, it is enforced.

## Phases

8 sequential phases, each with sub-states:

```
MODE_SELECT → DISCOVERY → PLANNING → INTERFACES → TESTS → IMPL_PLAN → IMPLEMENTATION → DONE
```

Each phase follows: **DRAFT → REVIEW → USER_GATE → (optional REVISE)**

## Available Workflow Tools

| Tool | Purpose |
|------|---------|
| `./artisan select-mode` | Choose GREENFIELD, REFACTOR, or INCREMENTAL + set feature name |
| `./artisan mark-scan-complete` | Complete discovery scan (REFACTOR/INCREMENTAL) |
| `./artisan mark-analyze-complete` | Complete discovery analysis |
| `./artisan mark-satisfied` | OpenCode/self-review compatibility only; bridge adapters use isolated review submission |
| `./artisan request-review` | Submit review artifacts by on-disk `artifact_files` |
| `./artisan run-review` | Dispatch the pending isolated review (phase or task) and print the verdict |
| `./artisan submit-feedback` | Approve or request revision at USER_GATE |
| `./artisan mark-task-complete` | Complete a DAG task during IMPLEMENTATION |
| `./artisan check-prior-workflow` | Check for existing workflow state |
| `./artisan resolve-human-gate` | Flag a task requiring manual action |
| `./artisan propose-backtrack` | Go back to an earlier phase |
| `./artisan propose-direct-application` | Propose and structurally apply a small safe patch without starting the full workflow |
| `./artisan query-parent-workflow` | Read parent workflow state (sub-workflows) |
| `./artisan query-child-workflow` | Read child workflow state (sub-workflows) |
| `./artisan state` | Show current workflow state |

## Expected Behavior Per Sub-State

### DRAFT
Do the work for this phase. When done, call `./artisan request-review`.
For PLANNING artifacts, include a `## Real-World Acceptance Scenario` section with `### Scenario`, `### Required Capabilities`, `### Acceptance Checks`, and `### Explicit Non-Goals` before calling request review.

### REVIEW
Run **`./artisan run-review`** to dispatch the isolated reviewer. It spawns a fresh, context-isolated `claude` reviewer, submits its verdict via a one-time token, and prints the outcome — phase passed (→ USER_GATE) or needs revision (→ REVISE). It is a visible, awaited command (no hidden turn-end dispatch). Do NOT call `./artisan mark-satisfied`. If you stop while still at a REVIEW state, the Stop hook will remind you to run `./artisan run-review`.

### USER_GATE
Present a clear artifact summary to the user. **STOP and wait for their response.** Do NOT call `./artisan submit-feedback` until the user responds. Not every user message is artifact feedback — casual conversation is fine.

### REVISE
Address ALL feedback points. Call `./artisan request-review` when done. No check-ins, no partial revisions.

## What's Blocked Per Phase

| Phase / Sub-State | Allowed | Blocked |
|-------------------|---------|---------|
| MODE_SELECT | Workflow tools, read-only shell | File writes (edit_file, write_file, create_file) |
| DISCOVERY/SCAN | Read-only tools, workflow tools | File writes, shell execution |
| DISCOVERY/ANALYZE | Read-only tools, workflow tools | File writes, shell execution |
| DISCOVERY/CONVENTIONS | `.openartisan/` writes only | Project source writes, shell execution |
| PLANNING/DRAFT | `.openartisan/` artifact writes only | Project source writes, shell execution |
| PLANNING/REVIEW | `.openartisan/` writes, read-only shell | Project source writes |
| PLANNING/USER_GATE | Read-only shell, workflow tools | File writes |
| PLANNING/REVISE | `.openartisan/` writes, read-only shell | Project source writes |
| INTERFACES | Interface/type files only (.py, .ts, .d.ts, .proto, etc.) | Implementation files |
| TESTS | Test files only | Implementation files |
| IMPL_PLAN/DRAFT | `.openartisan/` artifact writes only | Project source writes, shell execution |
| IMPL_PLAN/REVIEW | `.openartisan/` writes, read-only shell | Project source writes |
| IMPL_PLAN/USER_GATE | Read-only shell, workflow tools | File writes |
| IMPL_PLAN/REVISE | `.openartisan/` writes, read-only shell | Project source writes |
| IMPLEMENTATION | Files listed in current task's `**Files:**` | Files belonging to other tasks |
| DONE | Read-only tools, workflow tools | File writes |

`.env` writes are **always blocked** regardless of phase.

## IMPLEMENTATION Phase Rules

- One task at a time from the DAG. The current task is shown in the per-turn prompt injection.
- Call `./artisan mark-task-complete` after each task.
- The IMPL_PLAN must include `**Files:**` per task — these are enforced by the guard.
- You cannot write to files belonging to a different task.

## Mode-Specific Rules

### Direct Application
For small/simple tasks where the full phased workflow is too heavy, propose a direct patch with `./artisan propose-direct-application`. Open Artisan will structurally inspect the patch and apply it only if it is narrow and safe. It works before a workflow starts, after DONE, and **during an active workflow for out-of-band files** — files the current phase would not let you author directly (e.g. an unrelated doc). In-scope/in-phase files are rejected and must go through the normal authoring + review path. If rejected, use the full workflow.

### GREENFIELD
No constraints beyond the standard phases. Discovery is skipped.

### REFACTOR
Full discovery. Existing tests must pass after each implementation task.

### INCREMENTAL
Full discovery. File allowlist enforced — you can only modify files explicitly approved during PLANNING. Do-no-harm policy: bash write operators (>, >>, tee, sed -i) are blocked.

## Review Responsibility

Phase and per-task reviews are handled by an isolated reviewer subprocess with no access to the authoring conversation. You dispatch it explicitly with `./artisan run-review` (it runs the reviewer, submits the verdict, and prints the result); then continue based on the printed outcome. The reviewer is a fresh `claude` with the workflow hooks suppressed, so it cannot see or pollute your context.
