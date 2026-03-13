/**
 * scheduler.ts — Sequential task scheduler for Layer 4 (Design doc §7.3).
 *
 * Reads the ImplDAG, finds the next ready task, and returns a scheduling
 * decision. The caller (index.ts IMPLEMENTATION phase handler) uses this
 * decision to dispatch the task and update the DAG state.
 *
 * Scope (Layer 4 foundations only):
 * - Sequential execution: one task at a time
 * - No worktrees, no parallel dispatch (deferred — requires OpenCode async task API)
 * - DAG state is serialized to WorkflowState.implDag (added in this layer)
 *
 * The scheduler is a pure function — it reads DAG state and returns a decision.
 * Mutations are applied by the caller after the decision is made.
 */

import type { TaskNode, ImplDAG } from "./dag"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchedulerDecision =
  | SchedulerDispatch
  | SchedulerComplete
  | SchedulerBlocked
  | SchedulerError

export interface SchedulerDispatch {
  action: "dispatch"
  /** The task to execute next */
  task: TaskNode
  /** Human-readable prompt to give the agent for this task */
  prompt: string
  /** Total tasks, complete count, and remaining count for progress reporting */
  progress: TaskProgress
}

export interface SchedulerComplete {
  action: "complete"
  /** All tasks are done — advance to DONE */
  message: string
}

export interface SchedulerBlocked {
  action: "blocked"
  /**
   * Every remaining pending task has at least one incomplete dependency.
   * This should not happen in a valid acyclic DAG — indicates a state
   * inconsistency that requires user intervention.
   */
  message: string
  blockedTasks: Array<{ id: string; waitingFor: string[] }>
}

export interface SchedulerError {
  action: "error"
  message: string
}

export interface TaskProgress {
  total: number
  complete: number
  inFlight: number
  pending: number
  aborted: number
}

// ---------------------------------------------------------------------------
// Progress helper
// ---------------------------------------------------------------------------

function computeProgress(dag: ImplDAG): TaskProgress {
  const tasks = Array.from(dag.tasks)
  return {
    total: tasks.length,
    complete: tasks.filter((t) => t.status === "complete").length,
    inFlight: tasks.filter((t) => t.status === "in-flight").length,
    pending: tasks.filter((t) => t.status === "pending").length,
    aborted: tasks.filter((t) => t.status === "aborted").length,
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildTaskPrompt(task: TaskNode, progress: TaskProgress): string {
  const lines: string[] = []

  lines.push(`## Implementation Task: ${task.id}`)
  lines.push(`**Progress:** ${progress.complete}/${progress.total} tasks complete`)
  lines.push("")
  lines.push(`**Task:** ${task.description}`)
  lines.push("")

  if (task.dependencies.length > 0) {
    lines.push(`**Completed prerequisites:** ${task.dependencies.join(", ")}`)
    lines.push("")
  }

  if (task.expectedTests.length > 0) {
    lines.push("**Tests this task must make pass:**")
    for (const t of task.expectedTests) {
      lines.push(`  - \`${t}\``)
    }
    lines.push("")
    lines.push("Run these tests after implementation to verify completion.")
    lines.push("All listed tests must pass before calling `mark_task_complete`.")
  } else {
    lines.push("No specific test files are listed for this task.")
    lines.push("Verify your implementation matches the approved interfaces and run the full test suite.")
  }

  lines.push("")
  lines.push(`**Complexity estimate:** ${task.estimatedComplexity}`)
  lines.push("")
  lines.push("When implementation is complete and tests pass, call `mark_task_complete`.")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns the next scheduling decision for the given DAG.
 *
 * Decision priority:
 * 1. If all tasks are complete/aborted → SchedulerComplete
 * 2. If there are ready tasks (pending + all deps complete) → SchedulerDispatch the first one
 * 3. If all remaining tasks are blocked → SchedulerBlocked (DAG state inconsistency)
 */
export function nextSchedulerDecision(dag: ImplDAG): SchedulerDecision {
  const progress = computeProgress(dag)

  // Terminal: all tasks done
  if (dag.isComplete()) {
    const abortedNote = progress.aborted > 0
      ? ` (${progress.aborted} task(s) aborted due to upstream revision)`
      : ""
    return {
      action: "complete",
      message:
        `All ${progress.complete} implementation tasks complete${abortedNote}. ` +
        `Advancing to final review gate.`,
    }
  }

  // Find the next ready task
  const ready = dag.getReady()
  if (ready.length > 0) {
    const task = ready[0]! // sequential: take the first ready task
    return {
      action: "dispatch",
      task,
      prompt: buildTaskPrompt(task, progress),
      progress,
    }
  }

  // No ready tasks — check if any are in-flight (someone else is working on them)
  if (progress.inFlight > 0) {
    return {
      action: "blocked",
      message:
        `Scheduler is waiting: ${progress.inFlight} task(s) are currently in-flight. ` +
        `Wait for them to complete before requesting the next task.`,
      blockedTasks: [],
    }
  }

  // All remaining tasks are blocked — DAG state inconsistency
  const pendingTasks = Array.from(dag.tasks).filter((t) => t.status === "pending")
  const completeIds = new Set(
    Array.from(dag.tasks).filter((t) => t.status === "complete").map((t) => t.id),
  )

  const blockedTasks = pendingTasks.map((t) => ({
    id: t.id,
    waitingFor: t.dependencies.filter((dep) => !completeIds.has(dep)),
  }))

  return {
    action: "blocked",
    message:
      "Scheduler is blocked: all remaining tasks have incomplete dependencies " +
      "and no tasks are in-flight. This indicates a DAG state inconsistency. " +
      "User intervention required.",
    blockedTasks,
  }
}

/**
 * Marks a task as complete in the DAG (mutates the task node in place).
 * Returns the task node that was updated, or null if not found.
 */
export function markTaskComplete(dag: ImplDAG, taskId: string): TaskNode | null {
  // ImplDAG.tasks is ReadonlyArray but TaskNode fields are mutable
  const task = Array.from(dag.tasks).find((t) => t.id === taskId)
  if (!task) return null
  // Only in-flight or pending tasks can be marked complete
  if (task.status !== "in-flight" && task.status !== "pending") return null
  task.status = "complete"
  return task
}

/**
 * Marks a task as in-flight in the DAG (mutates the task node in place).
 * Returns the task node that was updated, or null if not found.
 */
export function markTaskInFlight(dag: ImplDAG, taskId: string): TaskNode | null {
  const task = Array.from(dag.tasks).find((t) => t.id === taskId)
  if (!task) return null
  // Only pending tasks can be marked in-flight
  if (task.status !== "pending") return null
  task.status = "in-flight"
  return task
}

/**
 * Marks a task as aborted in the DAG (mutates in place), and cascades
 * the abort to all downstream dependents (tasks that depend on this one,
 * directly or transitively). This prevents downstream tasks from being
 * permanently stuck in "pending" with unresolvable dependencies.
 *
 * Returns the list of all aborted tasks (the original + cascaded).
 */
export function markTaskAborted(dag: ImplDAG, taskId: string): TaskNode[] {
  const task = Array.from(dag.tasks).find((t) => t.id === taskId)
  if (!task) return []
  task.status = "aborted"
  delete task.worktreeBranch
  delete task.worktreePath

  const aborted: TaskNode[] = [task]

  // Cascade: abort all downstream dependents
  const dependents = dag.getDependents(taskId)
  for (const dep of dependents) {
    if (dep.status === "pending" || dep.status === "in-flight") {
      dep.status = "aborted"
      delete dep.worktreeBranch
      delete dep.worktreePath
      aborted.push(dep)
    }
  }

  return aborted
}
