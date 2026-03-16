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
  | SchedulerAwaitingHuman
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

/**
 * All remaining dispatchable work is blocked behind unresolved human gates.
 * The system should auto-advance to request_review → USER_GATE so the human
 * can resolve the gates and unblock downstream tasks.
 */
export interface SchedulerAwaitingHuman {
  action: "awaiting-human"
  message: string
  /** Human-gated tasks that need user resolution */
  humanGatedTasks: Array<{
    id: string
    whatIsNeeded: string
    verificationSteps: string
  }>
  progress: TaskProgress
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
  humanGated: number
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
    humanGated: tasks.filter((t) => t.status === "human-gated").length,
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
 * 1. Auto-transition any ready human-gate tasks to "human-gated" status
 * 2. If all tasks are complete/aborted → SchedulerComplete
 * 3. If there are ready tasks (pending + all deps complete, non-human-gate) → SchedulerDispatch
 * 4. If all remaining work is blocked behind unresolved human gates → SchedulerAwaitingHuman
 * 5. If all remaining tasks are blocked for other reasons → SchedulerBlocked (DAG inconsistency)
 */
export function nextSchedulerDecision(dag: ImplDAG): SchedulerDecision {
  // Step 1: Auto-transition any ready human-gate tasks.
  // Human-gate tasks can't be dispatched to the agent — they need the user to
  // perform an action (provision infra, configure creds). When their dependencies
  // are all complete, we immediately set them to "human-gated" status so they
  // appear in the awaiting-human decision and at USER_GATE for resolution.
  const readyHumanGates = dag.getReadyHumanGates()
  for (const gate of readyHumanGates) {
    // Mutate in place (same pattern as markTaskComplete/markTaskInFlight)
    const task = Array.from(dag.tasks).find((t) => t.id === gate.id)
    if (task && task.status === "pending") {
      task.status = "human-gated"
      // Pre-populate humanGate metadata from the task description if not already set.
      // The actual metadata gets populated when the agent calls resolve_human_gate,
      // but we need the status set now so downstream tasks stay blocked.
      if (!task.humanGate) {
        task.humanGate = {
          whatIsNeeded: task.description,
          why: "This task requires human action before downstream work can proceed.",
          verificationSteps: "Verify the required setup is complete.",
          resolved: false,
        }
      }
    }
  }

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

  // Find the next ready task (excludes human-gate tasks)
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

  // Check if the blockage is due to unresolved human gates.
  // If all remaining work is blocked behind human-gated tasks, the system
  // should auto-advance to USER_GATE so the human can resolve them.
  if (dag.hasUnresolvedHumanGates()) {
    const humanGated = Array.from(dag.tasks).filter(
      (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
    )
    return {
      action: "awaiting-human",
      message:
        `All remaining tasks are blocked behind ${humanGated.length} unresolved human gate(s). ` +
        `The system will advance to USER_GATE so you can resolve them.`,
      humanGatedTasks: humanGated.map((t) => ({
        id: t.id,
        whatIsNeeded: t.humanGate?.whatIsNeeded ?? t.description,
        verificationSteps: t.humanGate?.verificationSteps ?? "Verify the required setup is complete.",
      })),
      progress,
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
  // Only in-flight, pending, or human-gated tasks can be marked complete.
  // Human-gated tasks are completed via resolveHumanGate(), but markTaskComplete
  // also accepts them for flexibility (e.g. if a gate is resolved during approval).
  if (task.status !== "in-flight" && task.status !== "pending" && task.status !== "human-gated") return null
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

  // Cascade: abort all downstream dependents (including human-gated tasks)
  const dependents = dag.getDependents(taskId)
  for (const dep of dependents) {
    if (dep.status === "pending" || dep.status === "in-flight" || dep.status === "human-gated") {
      dep.status = "aborted"
      delete dep.worktreeBranch
      delete dep.worktreePath
      aborted.push(dep)
    }
  }

  return aborted
}

/**
 * Resolves a human-gated task in the DAG (mutates in place).
 * Sets the task status to "complete" and marks humanGate.resolved = true.
 * Returns the task node that was updated, or null if not found / wrong status.
 *
 * Called when the user confirms they have completed the required action
 * (e.g. provisioned infrastructure, configured credentials).
 */
export function resolveHumanGate(dag: ImplDAG, taskId: string): TaskNode | null {
  const task = Array.from(dag.tasks).find((t) => t.id === taskId)
  if (!task) return null
  if (task.status !== "human-gated") return null
  task.status = "complete"
  if (task.humanGate) {
    task.humanGate.resolved = true
    task.humanGate.resolvedAt = new Date().toISOString()
  }
  return task
}
