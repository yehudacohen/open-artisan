# Known Issues

Tracked issues discovered during Phase 1 refactoring.

## Resolved

### 1. intent-comparison.ts had no timeout on LLM call
**Fixed in:** Phase 1 cleanup commit
**Resolution:** Added `INTENT_COMPARISON_TIMEOUT_MS = 60_000` constant and wrapped the session prompt in `withTimeout()`, consistent with all other subagent modules.

### 2. intent-comparison.ts used inline session management
**Fixed in:** Phase 1 cleanup commit
**Resolution:** Extracted `ephemeralIntentCheckPrompt()` helper following the same create→try→prompt→finally→destroy pattern as self-review, task-review, auto-approve, task-drift, orchestrator, and discovery.

### 3. mode-detect.ts functions were async but only used execSync
**Fixed in:** Phase 1 cleanup commit
**Resolution:** Made `hasGitCommits()`, `countSourceFiles()`, and `detectMode()` synchronous. Callers that `await` the result continue to work (await on a non-Promise passes the value through).

## Open

(none)
