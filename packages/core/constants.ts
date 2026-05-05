/**
 * constants.ts — Named constants for magic numbers used across the codebase.
 *
 * Centralizes all numeric and string constants that were previously inline literals.
 * Modules import from here to ensure consistency and single-source-of-truth.
 */

import { WORKFLOW_TOOL_NAME_LIST } from "./tool-contracts"

// ---------------------------------------------------------------------------
// Text truncation limits
// ---------------------------------------------------------------------------

/**
 * Maximum characters for conventions document injection into system prompts.
 * ~3000 tokens at ~4 chars/token.
 */
export const MAX_CONVENTIONS_CHARS = 12_000

/**
 * Maximum characters for discovery report injection into system prompts.
 * ~4000 tokens at ~4 chars/token.
 */
export const MAX_REPORT_CHARS = 16_000

/**
 * Maximum characters for intent baseline capture from user messages.
 * Truncated at storage time to prevent state bloat.
 */
export const MAX_INTENT_BASELINE_CHARS = 2_000

/**
 * Maximum characters for feedback text stored in feedbackHistory.
 * Truncated at storage time to prevent state bloat.
 */
export const MAX_FEEDBACK_CHARS = 2_000

/**
 * Maximum characters for tool summary fields (scan_summary, analysis_summary, etc.).
 * Truncated in tool response messages to prevent prompt bloat.
 */
export const MAX_SUMMARY_CHARS = 500

/**
 * Maximum characters for artifact content passed inline to the self-review subagent.
 * Prevents extreme prompt sizes when artifacts are passed as text rather than file paths.
 */
export const MAX_ARTIFACT_CONTENT_CHARS = 10_000

/**
 * Maximum characters for feedback text in escape hatch presentation.
 */
export const MAX_ESCAPE_FEEDBACK_CHARS = 500

/**
 * Maximum characters for DAG task descriptions in compaction context.
 */
export const MAX_TASK_DESCRIPTION_CHARS = 100

/**
 * Maximum characters for escape hatch pending step instructions in compaction context.
 */
export const MAX_STEP_INSTRUCTION_CHARS = 100

// ---------------------------------------------------------------------------
// Numeric limits
// ---------------------------------------------------------------------------

/**
 * Maximum number of artifact file paths returned by resolveArtifactPaths.
 * Caps the number of paths sent to the self-review prompt to prevent bloat.
 */
export const MAX_ARTIFACT_PATHS = 20

/**
 * Maximum length (chars) of a short/ambiguous response in escape hatch classification.
 * Responses shorter than this that don't match a keyword are flagged as ambiguous.
 */
export const MAX_AMBIGUOUS_RESPONSE_LENGTH = 15

/**
 * Maximum number of self-review iterations before escalating to USER_GATE.
 * Prevents the agent from spinning indefinitely in REVIEW.
 * Set to 10 to give the agent enough room to iterate on reviewer feedback
 * before escalating to the user.
 */
export const MAX_REVIEW_ITERATIONS = 10

/**
 * Maximum idle re-prompt retries before escalating to the user.
 */
export const MAX_IDLE_RETRIES = 3

/**
 * Idle re-prompt cooldown in milliseconds.
 * Prevents cascading re-prompts when the user interrupts tool calls.
 */
export const IDLE_COOLDOWN_MS = 10_000

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/**
 * Maximum wall-clock time for a self-review subagent session (ms).
 * Set to 5 minutes — the reviewer evaluates 14+ criteria with quality scores.
 */
export const SELF_REVIEW_TIMEOUT_MS = 300_000

/**
 * Maximum wall-clock time for a per-task review subagent session (ms).
 * Set to 3 minutes — the task reviewer runs tests and checks 4 criteria.
 * Shorter than full self-review since scope is a single DAG task.
 */
export const TASK_REVIEW_TIMEOUT_MS = 180_000

/**
 * Maximum number of times the agent can call mark_task_complete for the same
 * task before per-task review is bypassed. Prevents infinite review loops when
 * the task reviewer keeps finding issues that the agent cannot resolve.
 * After this cap, the task is accepted and the full implementation review
 * at request_review will catch outstanding issues.
 */
export const MAX_TASK_REVIEW_ITERATIONS = 10

/**
 * Maximum wall-clock time per discovery scanner subagent session (ms).
 * Set to 3 minutes per scanner.
 */
export const SCANNER_TIMEOUT_MS = 180_000

/**
 * Minimum number of discovery scanners that must succeed for the report
 * to be considered reliable.
 */
export const MIN_SCANNERS_THRESHOLD = 3

// ---------------------------------------------------------------------------
// Source file extensions — single source of truth for language detection
// ---------------------------------------------------------------------------

/**
 * File extensions recognized as source code files.
 * Used by mode-detect.ts (project heuristics), artifact-paths.ts (implementation
 * file scanning), and tool-guard.ts (interface/test file classification).
 *
 * Adding a language here means:
 *   - mode-detect will count files with this extension as source files
 *   - artifact-paths will include them when scanning for implementation files
 *   - tool-guard already handles a subset via isInterfaceFile/isTestFile
 */
export const SOURCE_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  // Python
  ".py",
  // Ruby
  ".rb",
  // Go
  ".go",
  // Rust
  ".rs",
  // JVM
  ".java", ".kt", ".scala", ".clj",
  // .NET
  ".cs",
  // C/C++
  ".cpp", ".c", ".h",
  // Apple
  ".swift",
  // Elixir
  ".ex", ".exs",
])

// ---------------------------------------------------------------------------
// Intent comparison limits (for check_prior_workflow and select_mode)
// ---------------------------------------------------------------------------

/**
 * Maximum characters for displaying user intent in tool responses.
 * Truncated for readability in multi-line messages.
 */
export const MAX_INTENT_DISPLAY_CHARS = 200

/**
 * Maximum characters for prior intent sent to LLM comparison prompt.
 * Balances context richness with prompt size.
 */
export const MAX_PRIOR_INTENT_CHARS = 500

/**
 * Maximum characters for displaying scope/plan content in tool responses.
 */
export const MAX_SCOPE_DISPLAY_CHARS = 1000

/**
 * Maximum characters for prior scope sent to LLM comparison prompt.
 */
export const MAX_SCOPE_CONTEXT_CHARS = 1500

/**
 * Minimum number of approved artifacts required to consider a workflow "complete".
 * Represents: conventions, plan, interfaces, impl_plan, tests (or subset for GREENFIELD).
 */
export const MIN_COMPLETE_ARTIFACTS = 5

// ---------------------------------------------------------------------------
// File-level locking
// ---------------------------------------------------------------------------

/**
 * Timeout for acquiring a file-level lock (ms).
 * If the lock can't be acquired within this time, the operation fails.
 */
export const LOCK_TIMEOUT_MS = 10_000

/**
 * Polling interval while waiting for a file lock to be released (ms).
 */
export const LOCK_POLL_MS = 50

/**
 * Timeout for acquiring a DB operation lease (ms).
 * Keeps multi-worker runtimes from waiting indefinitely behind a wedged writer.
 */
export const DB_OPERATION_LEASE_TIMEOUT_MS = 30_000

/**
 * Polling interval while waiting for a DB operation lease (ms).
 */
export const DB_OPERATION_LEASE_POLL_MS = 50

/**
 * Lease duration for DB operation locks (ms).
 * Long enough for normal repository operations; stale leases can be taken over.
 */
export const DB_OPERATION_LEASE_MS = 300_000

/**
 * Renew DB operation leases halfway through their configured duration.
 */
export const DB_OPERATION_LEASE_RENEWAL_DIVISOR = 2

/**
 * Minimum DB lease renewal interval; keeps very short test leases renewable.
 */
export const DB_OPERATION_LEASE_MIN_RENEWAL_MS = 1

// ---------------------------------------------------------------------------
// Sub-workflows
// ---------------------------------------------------------------------------

/**
 * Maximum number of active child sub-workflows per parent.
 * Prevents sub-workflow explosion at a single level.
 */
export const MAX_SUB_WORKFLOWS = 2

/**
 * Maximum nesting depth for sub-workflows.
 * A top-level workflow has depth 0. Its children are depth 1. Grandchildren are depth 2.
 * Prevents unbounded recursive delegation.
 */
export const MAX_SUB_WORKFLOW_DEPTH = 3

/**
 * Timeout for a delegated sub-workflow before it's considered stuck (ms).
 * 30 minutes — long enough for substantial work, short enough to detect stalls.
 */
export const SUB_WORKFLOW_TIMEOUT_MS = 1_800_000

// ---------------------------------------------------------------------------
// Phase ordering — single source of truth
// ---------------------------------------------------------------------------

/**
 * Canonical ordering of workflow phases. Used by propose_backtrack to validate
 * that the target phase is earlier than the current, and by the scheduler to
 * determine phase progression.
 *
 * Imported by: state-machine.ts (implicit), propose-backtrack.ts, transitions.ts
 */
export const PHASE_ORDER: import("./types").Phase[] = [
  "MODE_SELECT", "DISCOVERY", "PLANNING", "INTERFACES",
  "TESTS", "IMPL_PLAN", "IMPLEMENTATION", "DONE",
]

// ---------------------------------------------------------------------------
// Workflow tool names — single source of truth
// ---------------------------------------------------------------------------

/**
 * Names of all custom workflow control tools.
 * The tool guard must never block these regardless of phase — they are the
 * mechanism by which the agent signals state transitions.
 *
 * Both the adapter and the bridge import this set. Adding a tool here
 * ensures it's recognized in both contexts.
 */
export const WORKFLOW_TOOL_NAMES = new Set(WORKFLOW_TOOL_NAME_LIST)

export const DB_TASK_LEASE_TTL_MS = 60 * 60 * 1000
