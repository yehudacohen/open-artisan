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
| `./artisan request-review` | Submit review artifacts (`artifact_files`, or markdown via `artifact_markdown`) |
| `./artisan submit-feedback` | Approve or request revision at USER_GATE |
| `./artisan mark-task-complete` | Complete a DAG task during IMPLEMENTATION |
| `./artisan check-prior-workflow` | Check for existing workflow state |
| `./artisan resolve-human-gate` | Flag a task requiring manual action |
| `./artisan propose-backtrack` | Go back to an earlier phase |
| `./artisan spawn-sub-workflow` | Delegate a DAG task to a child workflow |
| `./artisan query-parent-workflow` | Read parent workflow state (sub-workflows) |
| `./artisan query-child-workflow` | Read child workflow state (sub-workflows) |
| `./artisan state` | Show current workflow state |

## Expected Behavior Per Sub-State

### DRAFT
Do the work for this phase. When done, call `./artisan request-review`.

### REVIEW
Stop authoring and let the adapter dispatch an isolated reviewer. Do NOT call `./artisan mark-satisfied`; bridge adapters submit isolated reviews through adapter-only review submission.

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

### GREENFIELD
No constraints beyond the standard phases. Discovery is skipped.

### REFACTOR
Full discovery. Existing tests must pass after each implementation task.

### INCREMENTAL
Full discovery. File allowlist enforced — you can only modify files explicitly approved during PLANNING. Do-no-harm policy: bash write operators (>, >>, tee, sed -i) are blocked.

## Review Responsibility

Phase review is handled by an isolated reviewer subprocess with no access to the authoring conversation. Wait for the adapter hook to submit the review result, then continue according to the next prompt.
