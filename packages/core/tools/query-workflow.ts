/**
 * query-workflow.ts — Read-only cross-workflow inspection tools.
 *
 * query_parent_workflow: child reads parent's phase, artifacts, conventions.
 * query_child_workflow: parent reads child's phase, status, progress.
 *
 * Both are pure functions that read from WorkflowState. No mutations.
 */
import type { WorkflowState } from "../types"

// ---------------------------------------------------------------------------
// query_parent_workflow
// ---------------------------------------------------------------------------

export const QUERY_PARENT_WORKFLOW_DESCRIPTION = `
Read-only inspection of the parent workflow that spawned this sub-workflow.

Returns the parent's current phase, mode, conventions, approved artifacts,
and artifact file paths. Use this to align your work with the parent's
constraints and decisions.

Only callable from a sub-workflow session (one with parentWorkflow set).
No arguments required.
`.trim()

export interface QueryParentResult {
  error?: string
  parentFeatureName?: string
  phase?: string
  phaseState?: string
  mode?: string | null
  conventions?: string | null
  approvedArtifacts?: Record<string, string>
  artifactDiskPaths?: Record<string, string>
  intentBaseline?: string | null
}

/**
 * Read parent workflow state for a child sub-workflow.
 *
 * @param childState - The calling session's WorkflowState
 * @param parentState - The parent's WorkflowState (looked up by caller via findByFeatureName)
 */
export function processQueryParentWorkflow(
  childState: WorkflowState,
  parentState: WorkflowState | null,
): QueryParentResult {
  if (!childState.parentWorkflow) {
    return { error: "This session is not a sub-workflow — no parent workflow to query." }
  }

  if (!parentState) {
    return {
      error:
        `Parent workflow "${childState.parentWorkflow.featureName}" not found. ` +
        `The parent session may have been deleted.`,
    }
  }

  return {
    ...(parentState.featureName ? { parentFeatureName: parentState.featureName } : {}),
    phase: parentState.phase,
    phaseState: parentState.phaseState,
    mode: parentState.mode,
    conventions: parentState.conventions,
    approvedArtifacts: parentState.approvedArtifacts as Record<string, string>,
    artifactDiskPaths: parentState.artifactDiskPaths as Record<string, string>,
    intentBaseline: parentState.intentBaseline,
  }
}

// ---------------------------------------------------------------------------
// query_child_workflow
// ---------------------------------------------------------------------------

export const QUERY_CHILD_WORKFLOW_DESCRIPTION = `
Read-only inspection of a child sub-workflow spawned from this workflow.

Returns the child's current phase, phaseState, mode, and the parent DAG
task it was delegated from. Use this to check sub-workflow progress.

Arguments:
- task_id: The DAG task ID that was delegated (matches childWorkflows[i].taskId)
`.trim()

export interface QueryChildResult {
  error?: string
  taskId?: string
  childFeatureName?: string
  childStatus?: string
  phase?: string
  phaseState?: string
  mode?: string | null
  currentTaskId?: string | null
  implDagProgress?: { total: number; complete: number; delegated: number }
}

/**
 * Read child workflow state for a parent.
 *
 * @param parentState - The calling session's WorkflowState
 * @param taskId - The DAG task ID that was delegated
 * @param childState - The child's WorkflowState (looked up by caller via findByFeatureName)
 */
export function processQueryChildWorkflow(
  parentState: WorkflowState,
  taskId: string,
  childState: WorkflowState | null,
): QueryChildResult {
  const childEntry = parentState.childWorkflows.find((c) => c.taskId === taskId)
  if (!childEntry) {
    return {
      error:
        `No child workflow found for task "${taskId}". ` +
        `Valid delegated tasks: ${parentState.childWorkflows.map((c) => c.taskId).join(", ") || "(none)"}`,
    }
  }

  if (!childState) {
    // Child state not in memory — may not have started yet or was deleted
    return {
      taskId,
      childFeatureName: childEntry.featureName,
      childStatus: childEntry.status,
    }
  }

  // Compute DAG progress if the child has an implDag
  let implDagProgress: QueryChildResult["implDagProgress"]
  if (childState.implDag && childState.implDag.length > 0) {
    implDagProgress = {
      total: childState.implDag.length,
      complete: childState.implDag.filter((t) => t.status === "complete").length,
      delegated: childState.implDag.filter((t) => t.status === "delegated").length,
    }
  }

  return {
    taskId,
    childFeatureName: childEntry.featureName,
    childStatus: childEntry.status,
    phase: childState.phase,
    phaseState: childState.phaseState,
    mode: childState.mode,
    currentTaskId: childState.currentTaskId,
    ...(implDagProgress ? { implDagProgress } : {}),
  }
}
