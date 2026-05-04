/**
 * task-review.ts — Lightweight per-task review via isolated subagent (Layer 4).
 *
 * After the agent calls mark_task_complete, this module dispatches a lightweight
 * isolated reviewer to verify the task was implemented correctly BEFORE marking
 * it complete in the DAG and dispatching the next task.
 *
 * The task reviewer evaluates:
 *   1. Do the relevant tests pass? (reviewer runs them)
 *   2. Does the implementation match the approved interfaces?
 *   3. Are there any regressions in previously-passing tests?
 *   4. Does the code align with the conventions and plan?
 *   5. Stub/placeholder detection (category-aware: stubs OK for scaffold, not others)
 *   6. Integration seam check (conditional: only when adjacent tasks are provided)
 *      — verifies shared resources, data contracts, error propagation at task boundaries
 *
 * Unlike the full phase review (mark_satisfied + dispatchSelfReview), the task
 * review is:
 *   - Scoped to a single DAG task (not the whole implementation)
 *   - Has a shorter, focused criteria list (5-6 items, not 12+)
 *   - Uses [Q] quality scoring (code_quality, error_handling) with minimum threshold of 8/10
 *   - Does NOT have a rebuttal loop
 *   - Returns a simple pass/fail with issues list
 *
 * If the reviewer fails to dispatch (network error, timeout), the task review
 * falls back to passing (graceful degradation) — the full implementation review
 * at the end will catch issues. This ensures the task review is additive safety,
 * not a blocking dependency on subagent availability.
 */

import type { TaskNode, TaskCategory, TaskStatus } from "./dag"
import type { DbWorktreeObservation } from "./open-artisan-repository"
import type { WorkflowMode } from "./types"
import type { SubagentDispatcher } from "./subagent-dispatcher"
import { withTimeout, extractJsonFromText } from "./utils"
import { TASK_REVIEW_TIMEOUT_MS } from "./constants"
import { buildTaskReviewRubric, getTaskReviewCheckCountLabel } from "./rubrics"
import { TaskReviewOutputSchema, formatZodError } from "./schemas"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdjacentTask {
  id: string
  description: string
  category?: TaskCategory
  status: TaskStatus
  /** "upstream" = this task depends on the adjacent task; "downstream" = the adjacent task depends on this one */
  direction: "upstream" | "downstream"
}

export interface TaskReviewRequest {
  /** The task being reviewed */
  task: TaskNode
  /** Implementation summary provided by the agent */
  implementationSummary: string
  /** Workflow mode for context */
  mode: WorkflowMode | null
  /** Project directory for file resolution */
  cwd: string
  /** Parent session ID for TUI visibility */
  parentSessionId?: string
  /** Feature name for session title context */
  featureName?: string | null
  /** Parent model (if available) for subagent session creation */
  parentModel?: string | { modelID: string; providerID?: string }
  /** Conventions text for alignment checking (optional) */
  conventions?: string | null
  /** Approved artifact disk paths for reference */
  artifactDiskPaths?: Partial<Record<string, string>>
  /** Adjacent tasks (direct dependencies + direct dependents) for integration seam checking */
  adjacentTasks?: AdjacentTask[]
  /** State directory for persistent error logging (passed through from plugin init) */
  stateDir?: string
  /** Dirty worktree observations classified before review. Informational unless task-owned. */
  worktreeObservations?: DbWorktreeObservation[]
}

export interface TaskReviewScores {
  code_quality: number
  error_handling: number
}

export interface TaskReviewPatchSuggestion {
  targetPath: string
  summary: string
  suggestedPatch: string
}

export interface TaskReviewSuccess {
  success: true
  passed: boolean
  /** Issues found (empty if passed) */
  issues: string[]
  /** Quality scores (1-10 per dimension, minimum 8 to pass) */
  scores: TaskReviewScores | null
  /** Raw reviewer reasoning */
  reasoning: string
  /** Optional structured patch suggestions proposed by the reviewer. */
  patchSuggestions?: TaskReviewPatchSuggestion[]
}

export interface TaskReviewError {
  success: false
  error: string
}

export type TaskReviewResult = TaskReviewSuccess | TaskReviewError

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildTaskReviewPrompt(req: TaskReviewRequest): string {
  const lines: string[] = []

  lines.push(`You are reviewing a single implementation task for completeness and correctness.`)
  lines.push("")
  lines.push("## Task Details")
  lines.push(`**Task ID:** ${req.task.id}`)
  lines.push(`**Description:** ${req.task.description}`)
  lines.push(`**Complexity:** ${req.task.estimatedComplexity}`)
  if (req.task.dependencies.length > 0) {
    lines.push(`**Dependencies (completed):** ${req.task.dependencies.join(", ")}`)
  }
  lines.push("")
  lines.push("## Agent's Implementation Summary")
  lines.push(req.implementationSummary)
  lines.push("")

  if (req.task.expectedTests.length > 0) {
    lines.push("## Expected Tests")
    lines.push("The following tests should pass after this task is complete:")
    for (const t of req.task.expectedTests) {
      lines.push(`  - \`${t}\``)
    }
    lines.push("")
  }

  // Reference approved artifacts so the reviewer can check alignment
  if (req.artifactDiskPaths) {
    const relevantPaths = Object.entries(req.artifactDiskPaths).filter(([, v]) => v)
    if (relevantPaths.length > 0) {
      lines.push("## Approved Artifacts (for reference)")
      lines.push("Check the implementation against these approved artifacts:")
      for (const [key, path] of relevantPaths) {
        lines.push(`  - **${key}:** \`${path}\``)
      }
      lines.push("")
    }
  }

  if (req.conventions) {
    const conventionsPath = req.artifactDiskPaths?.["conventions"]
    if (conventionsPath) {
      lines.push("## Conventions")
      lines.push(`Read the conventions document at \`${conventionsPath}\` and verify the implementation follows them.`)
      lines.push("")
    }
  }

  // Adjacent tasks — for integration seam checking
  if (req.adjacentTasks && req.adjacentTasks.length > 0) {
    lines.push("## Adjacent Tasks (for integration seam checking)")
    lines.push("")
    lines.push("These are the tasks directly connected to this task in the DAG.")
    lines.push("Use them to verify that integration boundaries are properly handled.")
    lines.push("")
    const upstream = req.adjacentTasks.filter((t) => t.direction === "upstream")
    const downstream = req.adjacentTasks.filter((t) => t.direction === "downstream")
    if (upstream.length > 0) {
      lines.push("**Upstream (this task depends on):**")
      for (const t of upstream) {
        lines.push(`  - \`${t.id}\` [${t.category ?? "standalone"}] (${t.status}): ${t.description}`)
      }
      lines.push("")
    }
    if (downstream.length > 0) {
      lines.push("**Downstream (depends on this task):**")
      for (const t of downstream) {
        lines.push(`  - \`${t.id}\` [${t.category ?? "standalone"}] (${t.status}): ${t.description}`)
      }
      lines.push("")
    }
  }

  if (req.worktreeObservations && req.worktreeObservations.length > 0) {
    lines.push("## Worktree Observations")
    lines.push("")
    lines.push("The current worktree contains these classified changes. Use them for context, but do not fail this task solely because generated, artifact, ambient, or parallel-claimed files are dirty unless they directly break this task's tests or contracts.")
    lines.push("")
    for (const observation of req.worktreeObservations) {
      lines.push(`  - [${observation.classification}] ${observation.status}: \`${observation.path}\``)
    }
    lines.push("")
  }

  // Determine if stubs are acceptable based on task category
  const taskCategory = req.task.category ?? "standalone"
  const hasAdjacentTasks = req.adjacentTasks && req.adjacentTasks.length > 0
  const totalChecks = getTaskReviewCheckCountLabel(Boolean(hasAdjacentTasks))
  lines.push(buildTaskReviewRubric({ taskCategory, hasAdjacentTasks: Boolean(hasAdjacentTasks) }))

  lines.push("")
  lines.push("## Response Format")
  lines.push("")
  lines.push("Return ONLY a JSON object with no preamble:")
  lines.push("```json")
  lines.push(JSON.stringify({
    passed: false,
    issues: ["Test xyz.test.ts fails with error: ...", "STUB: src/stager.ts:42 returns hardcoded { rowsCopied: 0 }", "INTEGRATION_GAP: T1→T2: DI binding for FooService not registered"],
    scores: { code_quality: 7, error_handling: 9 },
    patch_suggestions: [{ target_path: "src/example.ts", summary: "Use injected service", suggested_patch: "diff --git ..." }],
    reasoning: "Tests pass but code quality score below threshold due to unclear naming in...",
  }, null, 2))
  lines.push("```")
  lines.push("")
  lines.push(`Set \`passed\` to \`true\` ONLY if ALL ${totalChecks} checks pass AND all quality scores are ≥ 8.`)
  lines.push("List specific issues in the \`issues\` array.")
  lines.push("If tests fail, include the actual error output. If interfaces don't match, cite the specific mismatch.")
  lines.push("For stubs, prefix the issue with 'STUB:' and include the file path and line number.")
  lines.push("For integration gaps, prefix with 'INTEGRATION_GAP:' and identify the boundary.")
  lines.push("For quality scores below 8, explain what needs improvement with file:line references.")
  lines.push("When a concrete localized fix is obvious, include it in `patch_suggestions`; otherwise use an empty array.")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Result parser
// ---------------------------------------------------------------------------

const MIN_QUALITY_SCORE = 8

export function parseTaskReviewResult(raw: string): TaskReviewResult {
  try {
    const json = extractJsonFromText(raw)
    const parsedJson = JSON.parse(json)
    const schemaResult = TaskReviewOutputSchema.safeParse(parsedJson)
    if (!schemaResult.success) {
      return {
        success: false,
        error: `Task review output does not match schema: ${formatZodError(schemaResult.error)}`,
      }
    }
    const parsed = schemaResult.data

    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i) => typeof i === "string") : []

    // Parse quality scores
    let scores: TaskReviewScores | null = null
    if (parsed.scores && typeof parsed.scores === "object") {
      scores = {
        code_quality: typeof parsed.scores.code_quality === "number" ? parsed.scores.code_quality : 0,
        error_handling: typeof parsed.scores.error_handling === "number" ? parsed.scores.error_handling : 0,
      }
      // Quality scores below minimum fail the review even if passed=true
      if (scores.code_quality < MIN_QUALITY_SCORE) {
        issues.push(`[Q] Code quality score ${scores.code_quality}/10 is below minimum ${MIN_QUALITY_SCORE}/10`)
      }
      if (scores.error_handling < MIN_QUALITY_SCORE) {
        issues.push(`[Q] Error handling score ${scores.error_handling}/10 is below minimum ${MIN_QUALITY_SCORE}/10`)
      }
    }

    // Override passed=true if quality scores are below threshold
    const qualityFailed = scores !== null && (
      scores.code_quality < MIN_QUALITY_SCORE || scores.error_handling < MIN_QUALITY_SCORE
    )
    const passed = parsed.passed === true && !qualityFailed
    const patchSuggestions = parsed.patch_suggestions.map((patch) => ({
      targetPath: patch.target_path,
      summary: patch.summary,
      suggestedPatch: patch.suggested_patch,
    }))

    return {
      success: true,
      passed,
      issues,
      scores,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      patchSuggestions,
    }
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse task review result: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Ephemeral session helper
// ---------------------------------------------------------------------------

async function ephemeralTaskReviewPrompt(
  dispatcher: SubagentDispatcher,
  prompt: string,
  parentSessionId?: string,
  parentModel?: string | { modelID: string; providerID?: string },
  title = "task-review",
): Promise<string> {
  const session = await dispatcher.createSession({
    title,
    agent: "workflow-reviewer",
    ...(parentSessionId ? { parentId: parentSessionId } : {}),
    ...(parentModel ? { model: parentModel } : {}),
  })
  try {
    return await session.prompt(prompt)
  } finally {
    await session.destroy()
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Dispatches a lightweight task review subagent for a single DAG task.
 *
 * Returns TaskReviewSuccess with pass/fail and issues, or TaskReviewError
 * if the session lifecycle fails.
 *
 * On failure, the caller should fall back to passing (graceful degradation) —
 * the full implementation review at the end will catch issues.
 */
export async function dispatchTaskReview(
  dispatcher: SubagentDispatcher,
  req: TaskReviewRequest,
): Promise<TaskReviewResult> {
  try {
    const prompt = buildTaskReviewPrompt(req)
    const featureSlug = req.featureName ? ` (${req.featureName})` : ""
    const title = `Task Review: ${req.task.id}${featureSlug}`
    const text = await withTimeout(
      ephemeralTaskReviewPrompt(dispatcher, prompt, req.parentSessionId, req.parentModel, title),
      TASK_REVIEW_TIMEOUT_MS,
      "task-review",
    )
    return parseTaskReviewResult(text)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: errorMsg,
    }
  }
}
