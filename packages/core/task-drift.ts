/**
 * task-drift.ts --- Lightweight per-task alignment check (14.2).
 *
 * After a task passes per-task review, this module checks whether the
 * implementation has drifted from the plan in ways that affect downstream
 * tasks.  If drift is detected, downstream task descriptions in the DAG are
 * updated so the agent doesn't build on stale assumptions.
 *
 * This is the simplified equivalent of the original 40-state design's
 * `X_ALIGN -> O_ASSESS` path --- one of the most important structural
 * guarantees that was lost in the 30-state simplification.
 *
 * The check is:
 *   1. An LLM call comparing the task's planned description vs actual
 *      implementation summary.
 *   2. If drift is detected, the LLM proposes updated descriptions for
 *      directly-dependent tasks.
 *   3. The caller patches the DAG with the updated descriptions.
 *
 * Graceful degradation: if the check fails (timeout, LLM error, parse
 * failure), the caller accepts the task as-is.  The full implementation
 * review at `request_review` will catch issues.
 */

import type { TaskNode } from "./dag"
import type { SubagentDispatcher } from "./subagent-dispatcher"
import { withTimeout, extractJsonFromText } from "./utils"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for the drift-check LLM call.  Shorter than task review since
 *  this is a classification call, not a test-runner. */
const DRIFT_CHECK_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftCheckRequest {
  /** The task that was just completed */
  task: TaskNode
  /** What the agent says it implemented */
  implementationSummary: string
  /** All DAG tasks (for finding dependents) */
  dagTasks: TaskNode[]
  /** Parent session ID for TUI hierarchy */
  parentSessionId?: string
  /** Parent model (if available) for subagent session creation */
  parentModel?: string | { modelID: string; providerID?: string }
}

export interface DriftCheckResult {
  /** Whether the check succeeded (not whether drift was found) */
  success: true
  /** Whether plan drift was detected */
  driftDetected: boolean
  /** Updated descriptions for dependent tasks (taskId -> newDescription) */
  updatedDescriptions: Record<string, string>
  /** LLM's reasoning */
  reasoning: string
}

export interface DriftCheckError {
  success: false
  error: string
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const DRIFT_CHECK_SYSTEM_PROMPT = `You are a plan-alignment checker for a phased software development workflow.

After a developer completes a task, you compare what was PLANNED versus what was ACTUALLY implemented.
If the implementation deviated from the plan in ways that affect downstream tasks, you propose
updated descriptions for those downstream tasks.

Rules:
- Minor deviations (naming tweaks, extra helper functions, small API changes) are NOT drift.
- Drift means: the implementation changed the PUBLIC CONTRACT (types, APIs, data flow) in a way
  that downstream tasks' descriptions are now STALE or INCORRECT.
- Only flag drift that would cause a downstream task to build on WRONG assumptions.
- When in doubt, report NO drift.  False positives (unnecessary updates) waste time.

IMPORTANT: You MUST reply with ONLY a valid JSON object:
{
  "drift_detected": true | false,
  "updated_descriptions": { "<task_id>": "<new description incorporating the deviation>", ... },
  "reasoning": "<1-2 sentences>"
}
If no drift, updated_descriptions should be an empty object {}.`

// ---------------------------------------------------------------------------
// Ephemeral session helper
// ---------------------------------------------------------------------------

async function ephemeralDriftCheckPrompt(
  dispatcher: SubagentDispatcher,
  prompt: string,
  taskId: string,
  parentSessionId?: string,
  parentModel?: string | { modelID: string; providerID?: string },
): Promise<string> {
  const session = await dispatcher.createSession({
    title: `Drift check: ${taskId}`,
    agent: "workflow-orchestrator",
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
 * Dispatches a lightweight LLM call to check whether the completed task
 * drifted from the plan and whether downstream tasks need description updates.
 *
 * Returns DriftCheckError on any failure (never throws).
 */
export async function dispatchDriftCheck(
  dispatcher: SubagentDispatcher,
  request: DriftCheckRequest,
): Promise<DriftCheckResult | DriftCheckError> {
  try {
    // Find direct dependents (tasks that list this task in their dependencies).
    // Include "delegated" tasks — their sub-workflows may be building on stale assumptions.
    const dependents = request.dagTasks.filter(
      (t) => t.dependencies.includes(request.task.id) && (t.status === "pending" || t.status === "delegated"),
    )

    // No affected dependents -> no drift concern
    if (dependents.length === 0) {
      return {
        success: true,
        driftDetected: false,
        updatedDescriptions: {},
        reasoning: "No pending downstream tasks to affect.",
      }
    }

    const dependentsSummary = dependents
      .map((t) => `- ${t.id}: ${t.description}`)
      .join("\n")

    const promptText = [
      `## Completed Task`,
      `**ID:** ${request.task.id}`,
      `**Planned description:** ${request.task.description}`,
      `**Actual implementation summary:** ${request.implementationSummary}`,
      ``,
      `## Pending Downstream Tasks (direct dependents)`,
      dependentsSummary,
      ``,
      `Did the implementation drift from the plan in ways that make any of these`,
      `downstream task descriptions stale or incorrect?  If so, provide updated`,
      `descriptions for the affected downstream tasks.`,
    ].join("\n")

    const rawText = await withTimeout(
      ephemeralDriftCheckPrompt(
        dispatcher,
        `${DRIFT_CHECK_SYSTEM_PROMPT}\n\n---\n\n${promptText}`,
        request.task.id,
        request.parentSessionId,
        request.parentModel,
      ),
      DRIFT_CHECK_TIMEOUT_MS,
      "drift-check",
    )

    const text = extractJsonFromText(rawText)
    const parsed = JSON.parse(text) as {
      drift_detected: boolean
      updated_descriptions: Record<string, string>
      reasoning: string
    }

    // Validate: only accept updates for tasks that actually exist as dependents
    const validDependentIds = new Set(dependents.map((t) => t.id))
    const filteredDescriptions: Record<string, string> = {}
    for (const [taskId, desc] of Object.entries(parsed.updated_descriptions ?? {})) {
      if (validDependentIds.has(taskId) && typeof desc === "string" && desc.length > 0) {
        filteredDescriptions[taskId] = desc
      }
    }

    const driftDetected = parsed.drift_detected === true && Object.keys(filteredDescriptions).length > 0

    return {
      success: true,
      driftDetected,
      updatedDescriptions: filteredDescriptions,
      reasoning: parsed.reasoning ?? "",
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { success: false, error: errorMsg }
  }
}
