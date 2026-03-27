/**
 * spawn-sub-workflow.ts — The `spawn_sub_workflow` tool definition.
 *
 * Delegates a DAG task to an independent child sub-workflow session.
 * The child runs its own full workflow (MODE_SELECT → DONE) and the
 * parent's task is marked "delegated" until the child completes.
 *
 * This module contains pure validation and state-preparation logic.
 * The adapter handles session creation via SubagentDispatcher.
 */
import type { WorkflowState, SpawnSubWorkflowArgs } from "../types"
import type { TaskNode } from "../dag"
import { MAX_SUB_WORKFLOWS, MAX_SUB_WORKFLOW_DEPTH } from "../constants"

// Re-export for test convenience
export type { SpawnSubWorkflowArgs }

export const SPAWN_SUB_WORKFLOW_DESCRIPTION = `
Delegate a DAG implementation task to an independent child sub-workflow.

The child sub-workflow runs its own complete workflow cycle (MODE_SELECT → DONE)
in an isolated session. The parent's task is marked "delegated" and downstream
tasks wait until the child completes.

Use this when a task is large or complex enough to benefit from dedicated focus
in a separate session. The child inherits the parent's conventions and constraints.

Arguments:
- task_id: The DAG task ID to delegate (must be "pending")
- feature_name: Name for the child workflow (kebab-case, e.g. "billing-engine")

Constraints:
- Only callable during IMPLEMENTATION phase
- Maximum ${MAX_SUB_WORKFLOWS} active sub-workflows at a time
- The task must not already be delegated, complete, or aborted
`.trim()

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SpawnSubWorkflowError {
  error: string
}

export interface SpawnSubWorkflowSuccess {
  /** The validated task to delegate */
  task: TaskNode
  /** Feature name for the child workflow */
  childFeatureName: string
  /** Response message for the parent agent */
  responseMessage: string
}

export type SpawnSubWorkflowResult = SpawnSubWorkflowError | SpawnSubWorkflowSuccess

// ---------------------------------------------------------------------------
// Core logic (pure — no side effects)
// ---------------------------------------------------------------------------

/**
 * Validate spawn_sub_workflow args and prepare the result.
 *
 * Does NOT mutate state or create sessions. The caller (adapter) is responsible for:
 * 1. Creating the child session via SubagentDispatcher (to get the platform session ID)
 * 2. Creating the child WorkflowState with parentWorkflow set
 * 3. Setting the task status to "delegated" in the parent's implDag
 * 4. Adding a childWorkflows entry on the parent
 *
 * @param args - Tool arguments from the agent
 * @param parentState - Current parent WorkflowState (read-only)
 */
export function processSpawnSubWorkflow(
  args: SpawnSubWorkflowArgs,
  parentState: WorkflowState,
): SpawnSubWorkflowResult {
  // Phase check
  if (parentState.phase !== "IMPLEMENTATION") {
    return {
      error:
        `spawn_sub_workflow can only be called during IMPLEMENTATION phase. ` +
        `Current phase: ${parentState.phase}/${parentState.phaseState}.`,
    }
  }

  // DAG check
  if (!parentState.implDag || parentState.implDag.length === 0) {
    return {
      error: "Cannot spawn sub-workflow: no implementation DAG found. Complete IMPL_PLAN first.",
    }
  }

  // Task lookup
  const task = parentState.implDag.find((t) => t.id === args.task_id)
  if (!task) {
    const validIds = parentState.implDag.map((t) => t.id).join(", ")
    return {
      error: `Task "${args.task_id}" not found in the implementation DAG. Valid task IDs: ${validIds}`,
    }
  }

  // Task status check — only "pending" tasks can be delegated.
  // "in-flight" tasks are currently being executed by the agent and
  // delegating them would cause both agent and child to work on the same task.
  if (task.status === "in-flight") {
    return {
      error:
        `Task "${args.task_id}" is currently in-flight (being executed). ` +
        `Complete or abort it before delegating to a sub-workflow.`,
    }
  }
  if (task.status === "delegated") {
    return {
      error: `Task "${args.task_id}" is already delegated to a sub-workflow.`,
    }
  }
  if (task.status === "complete") {
    return {
      error: `Task "${args.task_id}" is already complete — no need to delegate.`,
    }
  }
  if (task.status === "aborted") {
    return {
      error: `Task "${args.task_id}" has been aborted and cannot be delegated.`,
    }
  }
  if (task.status === "human-gated") {
    return {
      error:
        `Task "${args.task_id}" is a human-gated task — it requires user action, ` +
        `not delegation to a sub-workflow.`,
    }
  }

  // Feature name validation (basic — full validation happens in validateWorkflowState)
  const featureName = args.feature_name.trim()
  if (!featureName) {
    return { error: "feature_name is required and must not be empty." }
  }
  if (/\.\./.test(featureName)) {
    return { error: `feature_name must not contain ".." (path traversal).` }
  }
  if (/[/\\]/.test(featureName)) {
    return { error: `feature_name must not contain path separators.` }
  }
  if (featureName === "sub") {
    return { error: `"sub" is a reserved name (used for sub-workflow directory nesting).` }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(featureName)) {
    return {
      error:
        `feature_name must start with alphanumeric and contain only alphanumeric, dots, hyphens, and underscores. ` +
        `Got: "${featureName}"`,
    }
  }

  // Sibling limit — count active (pending/running) child workflows
  const activeChildren = parentState.childWorkflows.filter(
    (c) => c.status === "pending" || c.status === "running",
  )
  if (activeChildren.length >= MAX_SUB_WORKFLOWS) {
    return {
      error:
        `Maximum ${MAX_SUB_WORKFLOWS} active sub-workflows allowed. ` +
        `Currently active: ${activeChildren.map((c) => c.featureName).join(", ")}. ` +
        `Wait for a sub-workflow to complete before spawning another.`,
    }
  }

  // Compute the nested featureName (matches the path the adapter will use)
  const parentFeatureName = parentState.featureName
  const nestedFeatureName = parentFeatureName
    ? `${parentFeatureName}/sub/${featureName}`
    : featureName

  // Nesting depth limit — count "/sub/" segments in parent's featureName.
  // Top-level = depth 0, child = depth 1, grandchild = depth 2, etc.
  const parentDepth = parentFeatureName
    ? (parentFeatureName.match(/\/sub\//g) || []).length
    : 0
  const childDepth = parentDepth + 1
  if (childDepth > MAX_SUB_WORKFLOW_DEPTH) {
    return {
      error:
        `Maximum sub-workflow nesting depth is ${MAX_SUB_WORKFLOW_DEPTH}. ` +
        `Current depth: ${parentDepth}. Cannot spawn further nested sub-workflows. ` +
        `Implement this task directly instead.`,
    }
  }

  // Feature name collision — check parent and existing child workflows
  if (featureName === parentFeatureName) {
    return {
      error: `Child feature name "${featureName}" cannot be the same as the parent's feature name.`,
    }
  }
  if (parentState.childWorkflows.some((c) => c.featureName === nestedFeatureName)) {
    return {
      error: `A child workflow with feature name "${featureName}" already exists.`,
    }
  }

  // Success — return the validated task and spawn instructions
  return {
    task,
    childFeatureName: nestedFeatureName,
    responseMessage:
      `Sub-workflow spawned for task "${args.task_id}" (${task.description}).\n\n` +
      `**Child workflow:** ${featureName}\n` +
      `**Task status:** delegated → waiting for child to complete\n\n` +
      `The child workflow will run independently. Use \`query_child_workflow\` ` +
      `to check its progress. Downstream tasks that depend on "${args.task_id}" ` +
      `will unblock when the child completes.\n\n` +
      `Continue working on other tasks in the meantime.`,
  }
}
