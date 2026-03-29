# Open Artisan — Workflow Instructions

You are operating under the Open Artisan phased workflow. This enforces a structured engineering discipline: plan before code, review before approval, one task at a time.

## How the workflow works

The workflow has 8 sequential phases. You advance by calling `artisan` commands via Bash. The tool guard blocks file operations that don't belong in the current phase.

**Phases:**
1. **MODE_SELECT** — Choose GREENFIELD, REFACTOR, or INCREMENTAL
2. **DISCOVERY** — (REFACTOR/INCREMENTAL only) Analyze the existing codebase, produce conventions document
3. **PLANNING** — Produce a detailed plan document
4. **INTERFACES** — Define all types, interfaces, and data models (no implementation)
5. **TESTS** — Write a comprehensive failing test suite
6. **IMPL_PLAN** — Produce a DAG of implementation tasks with expected files per task
7. **IMPLEMENTATION** — Implement one task at a time from the DAG
8. **DONE** — All phases approved

Each phase follows: **DRAFT → REVIEW → USER_GATE → (optional REVISE)**

- **DRAFT**: Do the work, then call `./artisanrequest-review`
- **REVIEW**: Self-evaluate against acceptance criteria, then call `./artisanmark-satisfied`
- **USER_GATE**: Present the artifact to the user. Wait for their response.
- **REVISE**: Address feedback, then call `./artisanrequest-review` again

## Commands

All workflow commands go through the `artisan` CLI via Bash. Simple commands use flags; complex commands accept JSON on stdin.

### Phase progression
```bash
# Select mode and feature name
./artisan select-mode --mode GREENFIELD --feature-name my-feature

# Submit artifact for review (text artifacts via stdin)
echo '{"summary":"Plan ready","artifact_description":"The plan","artifact_content":"# Plan\n..."}' | ./artisanrequest-review

# Submit artifact for review (file artifacts — list the files you created)
echo '{"summary":"Interfaces done","artifact_description":"Type definitions","artifact_files":["src/types.ts","src/api.ts"]}' | ./artisanrequest-review

# Self-review against acceptance criteria
echo '{"criteria_met":[{"criterion":"All requirements addressed","met":true,"evidence":"Verified each requirement","severity":"blocking"}]}' | ./artisanmark-satisfied

# User approval/revision (after the user responds at USER_GATE)
echo '{"feedback_type":"approve","feedback_text":"Looks good"}' | ./artisansubmit-feedback
echo '{"feedback_type":"revise","feedback_text":"Add error handling for the API calls"}' | ./artisansubmit-feedback
```

### IMPLEMENTATION phase (DAG tasks)
```bash
# Complete a task (after implementing and running tests)
echo '{"task_id":"T1","implementation_summary":"Built auth module","tests_passing":true}' | ./artisanmark-task-complete

# Propose going back to an earlier phase
echo '{"target_phase":"PLANNING","reason":"The plan is missing critical requirements discovered during implementation"}' | ./artisanpropose-backtrack
```

### Discovery (REFACTOR/INCREMENTAL only)
```bash
./artisan mark-scan-complete --scan-summary "Found 42 source files, 3 test frameworks"
echo '{"analysis_summary":"Architecture follows MVC pattern with clean separation"}' | ./artisanmark-analyze-complete
```

### Status and control
```bash
./artisan state         # Show current phase, mode, task, approved artifacts
./artisan ping          # Check if server is running
./artisan enable        # Enable workflow enforcement
./artisan disable       # Disable workflow enforcement
```

## Rules

1. **You must use `artisan` commands to advance through phases.** There is no shortcut. The tool guard blocks file operations that don't belong in the current phase.

2. **One task at a time during IMPLEMENTATION.** The DAG scheduler assigns you one task. Complete it, call `./artisanmark-task-complete`, get the next task. You cannot write to files that belong to a different task.

3. **IMPL_PLAN must include a `Files:` field per task.** This tells the workflow which files each task will create. Example:
   ```markdown
   ## Task T1: Build auth module
   **Dependencies:** none
   **Expected tests:** tests/auth.test.ts
   **Files:** src/auth.ts, src/auth-types.ts
   **Complexity:** medium
   ```

4. **For INTERFACES and TESTS phases**, pass `artifact_files` in `request-review` listing every file you created. The reviewer needs to know which files to evaluate.

5. **At USER_GATE, wait for the user.** Present a clear summary of what was built. Do not call `submit-feedback` until the user responds. You can have casual conversation with the user at USER_GATE — not every message needs to be routed through `submit-feedback`.

6. **If the reviewer rejects your work**, you'll enter REVISE state. Address the feedback, then call `./artisanrequest-review` again. If you discover a fundamental problem with an earlier phase, call `./artisanpropose-backtrack`.

7. **Self-review is your responsibility.** In this mode, `mark-satisfied` evaluates YOUR criteria assessment. Be honest and thorough — the user reviews at USER_GATE.

## What's blocked per phase

| Phase | Sub-state | Blocked | Allowed writes |
|-------|-----------|---------|---------------|
| MODE_SELECT | * | write, edit | nothing |
| DISCOVERY | SCAN, ANALYZE | write, edit, bash | nothing |
| DISCOVERY | CONVENTIONS | bash | .openartisan/ only |
| DISCOVERY | REVIEW, REVISE | — | .openartisan/ only |
| PLANNING, IMPL_PLAN | DRAFT | write, edit, bash | nothing (text-only) |
| PLANNING, IMPL_PLAN | REVIEW, REVISE | — | .openartisan/ only |
| INTERFACES | DRAFT | bash | interface/type/schema files only |
| INTERFACES | REVIEW, REVISE | — | interface/type/schema files only |
| TESTS | DRAFT | bash | test files only |
| TESTS | REVIEW, REVISE | — | test files only |
| IMPLEMENTATION | * | — | current task's files only (per DAG) |
| DONE | * | write, edit | nothing |

**.env files are always blocked** in all phases. The `./artisan` command is always allowed, even when bash is blocked. During REVIEW/REVISE/USER_GATE, writes are allowed to .openartisan/ for artifact fixes.
