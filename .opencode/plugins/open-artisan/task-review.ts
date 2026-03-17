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
 *   - Does NOT use quality scoring ([Q] criteria) — pass/fail only
 *   - Does NOT have a rebuttal loop
 *   - Returns a simple pass/fail with issues list
 *
 * If the reviewer fails to dispatch (network error, timeout), the task review
 * falls back to passing (graceful degradation) — the full implementation review
 * at the end will catch issues. This ensures the task review is additive safety,
 * not a blocking dependency on subagent availability.
 */

import type { TaskNode, TaskCategory, TaskStatus } from "./dag"
import type { WorkflowMode } from "./types"
import type { PluginClient } from "./client-types"
import { withTimeout, extractTextFromPromptResult, extractEphemeralSessionId, extractJsonFromText } from "./utils"
import { TASK_REVIEW_TIMEOUT_MS } from "./constants"
import { createLogger } from "./logger"

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
  /** Conventions text for alignment checking (optional) */
  conventions?: string | null
  /** Approved artifact disk paths for reference */
  artifactDiskPaths?: Partial<Record<string, string>>
  /** Adjacent tasks (direct dependencies + direct dependents) for integration seam checking */
  adjacentTasks?: AdjacentTask[]
  /** State directory for persistent error logging (passed through from plugin init) */
  stateDir?: string
}

export interface TaskReviewSuccess {
  success: true
  passed: boolean
  /** Issues found (empty if passed) */
  issues: string[]
  /** Raw reviewer reasoning */
  reasoning: string
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

  // Determine if stubs are acceptable based on task category
  const taskCategory = req.task.category ?? "standalone"
  const stubsAcceptable = taskCategory === "scaffold"

  lines.push("## Review Instructions")
  lines.push("")
  lines.push("Perform the following checks:")
  lines.push("")
  lines.push("1. **Run the tests.** Find and run the project's test suite (check package.json, Makefile, or equivalent")
  lines.push("   for the test command). If specific expected tests are listed above, run those. Report the results.")
  lines.push("2. **Verify interface alignment.** Read the approved interfaces/types and verify the implementation")
  lines.push("   matches the signatures exactly — no missing methods, no extra methods, correct types.")
  lines.push("3. **Check for regressions.** Run the full test suite (not just this task's tests) and confirm")
  lines.push("   no previously-passing tests are now failing.")
  lines.push("4. **Check conventions alignment.** If conventions are available, verify the implementation follows")
  lines.push("   naming, error handling, and structural patterns.")

  // Check #5: Stub/placeholder detection (category-aware)
  lines.push("5. **Stub/placeholder detection.** Scan the implementation for:")
  lines.push("   - Functions that return hardcoded values (`return 0`, `return \"\"`, `return []`, `return ok({})`, `return { rowsCopied: 0 }`)")
  lines.push("   - Functions that only throw `\"not implemented\"`, `\"TODO\"`, or similar sentinel errors")
  lines.push("   - Placeholder credentials (`localhost:5432`, `test-bucket`, `dummy-api-key`, `xxx`, `changeme`)")
  lines.push("   - Comments indicating deferred work: `TODO`, `FIXME`, `HACK`, `in production we would...`, `placeholder`")
  lines.push("   - `console.log` / `print` statements standing in for real logging or error handling")
  lines.push("   - Empty catch blocks or catch-all error swallowing (`catch (e) {}`, `catch (_) { /* ignore */ }`)")
  lines.push("   - Conditional stubs: `if (process.env.NODE_ENV === 'test') return mockData`")
  if (stubsAcceptable) {
    lines.push("")
    lines.push(`   **This task has category "scaffold" — stubs ARE acceptable** for methods that will be`)
    lines.push("   implemented by a later integration task. However, the scaffold must still compile,")
    lines.push("   satisfy type signatures, and have the correct wiring/structure. Flag stubs only if")
    lines.push("   they are missing from the interface (unimplemented methods) or have incorrect signatures.")
  } else {
    lines.push("")
    lines.push(`   **This task has category "${taskCategory}" — stubs are NOT acceptable.**`)
    lines.push("   If ANY of the above patterns are found, the task FAILS. List every instance with file:line.")
    lines.push("   The implementation must contain real, functional logic — not placeholders.")
  }

  // Check #6: Integration seam verification (only when adjacent tasks are provided)
  if (req.adjacentTasks && req.adjacentTasks.length > 0) {
    lines.push("")
    lines.push("6. **Integration seam check.** Review the boundaries between this task and its adjacent tasks")
    lines.push("   (listed in the \"Adjacent Tasks\" section above). For each boundary, verify:")
    lines.push("   - **Shared resources are configured:** If this task produces or consumes a shared resource")
    lines.push("     (queue, database table, config entry, DI binding, environment variable), verify the resource")
    lines.push("     is actually created/configured — not just assumed to exist.")
    lines.push("   - **Data contracts match:** If this task passes data to/from an adjacent task, verify the")
    lines.push("     data shape (types, field names, serialization format) matches on both sides.")
    lines.push("   - **Error propagation is handled:** If an upstream task can fail, verify this task handles")
    lines.push("     that failure (not just the happy path). If this task can fail, verify downstream tasks")
    lines.push("     can detect and handle the failure.")
    lines.push("   - **No \"not my responsibility\" gaps:** If something needs to happen at the boundary and")
    lines.push("     neither this task nor the adjacent task clearly owns it, flag it as INTEGRATION_GAP.")
    lines.push("")
    lines.push("   Prefix integration issues with 'INTEGRATION_GAP:' and describe what is missing and which")
    lines.push("   task boundary is affected (e.g., 'INTEGRATION_GAP: T1→T2: queue config not created').")
  }

  const totalChecks = (req.adjacentTasks && req.adjacentTasks.length > 0) ? "six" : "five"

  lines.push("")
  lines.push("## Response Format")
  lines.push("")
  lines.push("Return ONLY a JSON object with no preamble:")
  lines.push("```json")
  lines.push(JSON.stringify({
    passed: false,
    issues: ["Test xyz.test.ts fails with error: ...", "Method foo() missing from BarService implementation", "STUB: src/stager.ts:42 returns hardcoded { rowsCopied: 0 }", "INTEGRATION_GAP: T1→T2: DI binding for FooService not registered"],
    reasoning: "Tests pass but stub detection found hardcoded return values in integration task...",
  }, null, 2))
  lines.push("```")
  lines.push("")
  lines.push(`Set \`passed\` to \`true\` ONLY if ALL ${totalChecks} checks pass. List specific issues in the \`issues\` array.`)
  lines.push("If tests fail, include the actual error output. If interfaces don't match, cite the specific mismatch.")
  lines.push("For stubs, prefix the issue with 'STUB:' and include the file path and line number.")
  lines.push("For integration gaps, prefix with 'INTEGRATION_GAP:' and identify the boundary.")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Result parser
// ---------------------------------------------------------------------------

export function parseTaskReviewResult(raw: string): TaskReviewResult {
  try {
    const json = extractJsonFromText(raw)
    const parsed = JSON.parse(json) as {
      passed: boolean
      issues: string[]
      reasoning: string
    }

    return {
      success: true,
      passed: parsed.passed === true,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i) => typeof i === "string") : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
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

async function ephemeralTaskReviewSession(
  client: PluginClient,
  prompt: string,
  parentSessionId?: string,
  title = "task-review",
): Promise<unknown> {
  if (!client.session) throw new Error("client.session is not available — cannot dispatch task review")
  const created = await client.session.create({
    body: {
      title,
      agent: "workflow-reviewer",
      ...(parentSessionId ? { parentID: parentSessionId } : {}),
    },
  })

  const sessionId = extractEphemeralSessionId(created, "task-review")

  try {
    return await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
      },
    })
  } finally {
    if (!parentSessionId) {
      try { await client.session.delete({ path: { id: sessionId } }) } catch { /* ignore */ }
    }
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
  client: PluginClient,
  req: TaskReviewRequest,
): Promise<TaskReviewResult> {
  try {
    const prompt = buildTaskReviewPrompt(req)
    const featureSlug = req.featureName ? ` (${req.featureName})` : ""
    const title = `Task Review: ${req.task.id}${featureSlug}`
    const raw = await withTimeout(
      ephemeralTaskReviewSession(client, prompt, req.parentSessionId, title),
      TASK_REVIEW_TIMEOUT_MS,
      "task-review",
    )
    const text = extractTextFromPromptResult(raw, "task-review")
    return parseTaskReviewResult(text)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    const log = createLogger(client, req.stateDir)
    log.warn("Task review dispatch failed", { detail: errorMsg })
    return {
      success: false,
      error: errorMsg,
    }
  }
}
