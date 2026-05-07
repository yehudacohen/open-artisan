/**
 * complete-sub-workflow.ts — Propagates child workflow completion to the parent.
 *
 * Called when a child sub-workflow reaches DONE phase. Updates the parent's
 * DAG task from "delegated" to "complete" and the childWorkflows entry
 * from "running" to "complete".
 *
 * This is NOT a user-facing tool — it's called automatically by the adapter
 * when the submit_feedback approve handler transitions a sub-workflow to DONE.
 */
import type { WorkflowState } from "../workflow-state-types"
import { createImplDAG } from "../dag"
import { markDelegatedComplete, markTaskAborted } from "../scheduler"
import { SUB_WORKFLOW_TIMEOUT_MS } from "../constants"

/**
 * Apply child completion to a parent's draft state.
 *
 * Mutates the draft in place (designed to be called inside store.update()).
 * Returns a descriptive message or null if no update was needed.
 *
 * @param parentDraft - Mutable parent WorkflowState draft
 * @param childFeatureName - The child's featureName (nested path)
 * @param childTaskId - The task ID in the parent's DAG that was delegated
 */
export function applyChildCompletion(
  parentDraft: WorkflowState,
  childFeatureName: string,
  childTaskId: string,
): string | null {
  // Update childWorkflows entry
  const childEntry = parentDraft.childWorkflows.find(
    (c) => c.featureName === childFeatureName && c.taskId === childTaskId,
  )
  if (!childEntry) return null
  childEntry.status = "complete"

  // Update DAG task from "delegated" to "complete".
  // createImplDAG deep-copies, so we write the mutated nodes back.
  if (parentDraft.implDag) {
    const dag = createImplDAG(parentDraft.implDag)
    const marked = markDelegatedComplete(dag, childTaskId)
    if (marked) {
      parentDraft.implDag = Array.from(dag.tasks).map((t) => ({
        ...t,
        ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
      }))
      if (parentDraft.currentTaskId === childTaskId) {
        parentDraft.currentTaskId = null
      }
      return `Child workflow "${childFeatureName}" completed task "${childTaskId}".`
    }
  }

  return `Child workflow "${childFeatureName}" completed but task "${childTaskId}" was not in "delegated" status.`
}

// ---------------------------------------------------------------------------
// Timeout detection
// ---------------------------------------------------------------------------

export interface TimedOutChild {
  taskId: string
  featureName: string
  delegatedAt: string
  elapsedMs: number
}

/**
 * Check for timed-out sub-workflow delegations.
 *
 * Returns entries from childWorkflows that are "running" and have exceeded
 * SUB_WORKFLOW_TIMEOUT_MS since delegatedAt. Pure function — does not mutate.
 *
 * @param state - Current WorkflowState (read-only)
 * @param now - Current timestamp (ms). Defaults to Date.now() for testability.
 */
export function findTimedOutChildren(
  state: WorkflowState,
  now: number = Date.now(),
): TimedOutChild[] {
  const timedOut: TimedOutChild[] = []
  for (const child of state.childWorkflows) {
    if (child.status !== "running") continue
    const delegatedAt = new Date(child.delegatedAt).getTime()
    if (isNaN(delegatedAt)) continue
    const elapsed = now - delegatedAt
    if (elapsed > SUB_WORKFLOW_TIMEOUT_MS) {
      timedOut.push({
        taskId: child.taskId,
        featureName: child.featureName,
        delegatedAt: child.delegatedAt,
        elapsedMs: elapsed,
      })
    }
  }
  return timedOut
}

/**
 * Sync childWorkflows entries with the current DAG state.
 *
 * Marks "running" or "pending" childWorkflows entries as "failed" if:
 * - The implDag is null (DAG was cleared, e.g., during backtrack)
 * - The corresponding DAG task is "aborted" (e.g., cascade abort)
 *
 * Mutates the draft in place. Returns the list of child featureNames
 * that were marked failed (for logging).
 */
export function syncChildWorkflowsWithDag(parentDraft: WorkflowState): string[] {
  const failed: string[] = []
  for (const child of parentDraft.childWorkflows) {
    if (child.status !== "running" && child.status !== "pending") continue

    if (!parentDraft.implDag) {
      // DAG cleared — all active children are orphaned
      child.status = "failed"
      failed.push(child.featureName)
      continue
    }

    const dagTask = parentDraft.implDag.find((t) => t.id === child.taskId)
    if (!dagTask || dagTask.status === "aborted") {
      // Task missing or aborted — child is invalidated
      child.status = "failed"
      failed.push(child.featureName)
    }
  }
  return failed
}

/**
 * Abort a timed-out delegation in the parent's draft state.
 *
 * Mutates the draft in place (designed to be called inside store.update()).
 * Marks the child entry as "failed" and aborts the DAG task + dependents.
 *
 * @returns List of aborted task IDs (the delegated task + cascade)
 */
export function applyDelegationTimeout(
  parentDraft: WorkflowState,
  taskId: string,
): string[] {
  // Update childWorkflows entry
  const childEntry = parentDraft.childWorkflows.find((c) => c.taskId === taskId)
  if (childEntry) childEntry.status = "failed"

  // Abort the DAG task and cascade to dependents.
  // createImplDAG deep-copies, so we need to write the mutated nodes back.
  if (parentDraft.implDag) {
    const dag = createImplDAG(parentDraft.implDag)
    const aborted = markTaskAborted(dag, taskId)
    // Write mutated DAG nodes back to the draft
    parentDraft.implDag = Array.from(dag.tasks).map((t) => ({
        ...t,
        ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
      }))
    return aborted.map((t) => t.id)
  }
  return [taskId]
}
