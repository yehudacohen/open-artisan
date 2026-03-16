/**
 * constants.ts — Named constants for magic numbers used across the codebase.
 *
 * Centralizes all numeric and string constants that were previously inline literals.
 * Modules import from here to ensure consistency and single-source-of-truth.
 */

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
