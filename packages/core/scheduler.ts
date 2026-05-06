/**
 * scheduler.ts — Sequential task scheduler for Layer 4 (Design doc §7.3).
 *
 * Reads the ImplDAG, finds the next ready task, and returns a scheduling
 * decision. The caller (index.ts IMPLEMENTATION phase handler) uses this
 * decision to dispatch the task and update the DAG state.
 *
 * Scope:
 * - Sequential execution is always available.
 * - Parallel-safe task sets are acknowledged and deterministically drained through
 *   the sequential lane unless an adapter provides a richer batch executor.
 * - DAG state is serialized to WorkflowState.implDag.
 *
 * The scheduler is a pure function — it reads DAG state and returns a decision.
 * Mutations are applied by the caller after the decision is made.
 */

import { createImplDAG, type TaskIsolation, type TaskNode, type ImplDAG } from "./dag"
import { buildTaskImplementationRubricPreview } from "./rubrics"
import type { WorkflowState } from "./workflow-state-types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchedulerDecision =
  | SchedulerDispatch
  | SchedulerDispatchBatch
  | SchedulerComplete
  | SchedulerBlocked
  | SchedulerAwaitingHuman
  | SchedulerError

export type SchedulerIssueCode =
  | "in-flight"
  | "delegated"
  | "deps-unresolved"
  | "no-slots"
  | "isolation-missing"
  | "dag-inconsistent"

export interface SchedulerIssue {
  code: SchedulerIssueCode
  taskId?: string
  detail: string
}

export interface SchedulerSlots {
  maxParallelTasks: number
  activeTasks: number
  availableSlots: number
  readyTasks: number
  dispatchableNow: number
}

export interface SchedulerEvaluateInput {
  dag: ImplDAG
  maxParallelTasks: number
}

export interface SchedulerEvaluateResult {
  decision: SchedulerDecision
  slots: SchedulerSlots
}

export interface SchedulerDispatch {
  action: "dispatch"
  /** The task to execute next */
  task: TaskNode
  /** Human-readable prompt to give the agent for this task */
  prompt: string
  /** Total tasks, complete count, and remaining count for progress reporting */
  progress: TaskProgress
}

export interface SchedulerDispatchBatch {
  action: "dispatch-batch"
  tasks: TaskNode[]
  prompts: Array<{ taskId: string; prompt: string }>
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
   * No tasks are ready to dispatch. Three causes:
   * 1. In-flight tasks — work is happening, wait for completion. blockedTasks is [].
   * 2. Delegated sub-workflows — child workflows are running. blockedTasks is [].
   * 3. DAG inconsistency — unresolvable deps. blockedTasks lists the stuck tasks.
   * Callers should check blockedTasks.length to distinguish waiting (1,2) from error (3).
   */
  message: string
  reason?: SchedulerIssueCode
  issues?: SchedulerIssue[]
  retryable?: true
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
  delegated: number
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
    delegated: tasks.filter((t) => t.status === "delegated").length,
  }
}

function computeSlots(progress: TaskProgress, readyTasks: number, dispatchableNow: number, maxParallelTasks: number): SchedulerSlots {
  const activeTasks = progress.inFlight + progress.delegated
  return {
    maxParallelTasks,
    activeTasks,
    availableSlots: Math.max(maxParallelTasks - activeTasks, 0),
    readyTasks,
    dispatchableNow,
  }
}

function isIsolationDispatchable(isolation: TaskIsolation | undefined): boolean {
  if (!isolation) return false
  return (
    isolation.safeForParallelDispatch &&
    isolation.ownershipKey.trim().length > 0 &&
    isolation.writablePaths.length > 0
  )
}

function hasOverlappingWritablePaths(tasks: TaskNode[]): boolean {
  const seen = new Set<string>()
  for (const task of tasks) {
    for (const rawPath of task.isolation?.writablePaths ?? []) {
      const normalized = rawPath.trim()
      if (!normalized) continue
      if (seen.has(normalized)) return true
      seen.add(normalized)
    }
  }
  return false
}

function buildParallelDecision(input: SchedulerEvaluateInput): SchedulerEvaluateResult | null {
  const ready = input.dag.getReady()
  if (input.maxParallelTasks <= 1 || ready.length === 0) return null

  const progress = computeProgress(input.dag)
  const availableSlots = Math.max(input.maxParallelTasks - (progress.inFlight + progress.delegated), 0)
  const parallelReady = ready.filter((task) => isIsolationDispatchable(task.isolation))
  const slots = computeSlots(progress, ready.length, Math.min(parallelReady.length, availableSlots), input.maxParallelTasks)

  if (availableSlots === 0) {
    return {
      decision: {
        action: "blocked",
        message: "Scheduler is blocked: no parallel execution slots are currently available.",
        reason: "no-slots",
        issues: [{ code: "no-slots", detail: "All configured parallel slots are already occupied." }],
        retryable: true,
        blockedTasks: [],
      },
      slots,
    }
  }

  if (parallelReady.length >= 2) {
    if (hasOverlappingWritablePaths(parallelReady)) {
      return {
        decision: {
          action: "blocked",
          message: "Scheduler is blocked: parallel-ready tasks have overlapping writable ownership.",
          reason: "isolation-missing",
          issues: parallelReady.map((task) => ({
            code: "isolation-missing",
            taskId: task.id,
            detail: "Parallel-ready task overlaps writable ownership with another ready task.",
          })),
          retryable: true,
          blockedTasks: parallelReady.map((task) => ({ id: task.id, waitingFor: [] })),
        },
        slots,
      }
    }

    const [task] = parallelReady
    return {
      decision: {
        action: "dispatch",
        task: task!,
        prompt:
          "Multiple parallel-safe tasks are ready; dispatching deterministically through the sequential lane for this adapter.\n\n" +
          buildTaskPrompt(task!, progress),
        progress,
      },
      slots,
    }
  }

  return null
}

function withSequentialEnvelope(input: SchedulerEvaluateInput, decision: SchedulerDecision): SchedulerEvaluateResult {
  const ready = input.dag.getReady()
  const progress = computeProgress(input.dag)
  return {
    decision,
    slots: computeSlots(progress, ready.length, decision.action === "dispatch" ? 1 : 0, input.maxParallelTasks),
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

  if (task.expectedFiles && task.expectedFiles.length > 0) {
    lines.push("**Files you must create/modify for this task:**")
    for (const f of task.expectedFiles) {
      lines.push(`  - \`${f}\``)
    }
    lines.push("")
    lines.push("You may ONLY write to these files for this task. If you need to write to additional files,")
    lines.push("note them in the `implementation_summary` when calling `mark_task_complete`.")
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
  lines.push(buildTaskImplementationRubricPreview())
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

  // Check if the blockage is due to delegated tasks (sub-workflows in progress)
  if (progress.delegated > 0) {
    return {
      action: "blocked",
      message:
        `Scheduler is waiting: ${progress.delegated} task(s) are delegated to sub-workflows. ` +
        `Use \`query_child_workflow\` to check their progress. ` +
        `Downstream tasks will unblock when delegated tasks complete.`,
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

export function readDecisionInput(state: Pick<WorkflowState, "implDag" | "concurrency">): SchedulerEvaluateInput {
  return {
    dag: createImplDAG(state.implDag ?? []),
    maxParallelTasks: state.concurrency.maxParallelTasks,
  }
}

export function nextSchedulerDecisionForInput(input: SchedulerEvaluateInput): SchedulerEvaluateResult {
  const parallelDecision = buildParallelDecision(input)
  if (parallelDecision) return parallelDecision
  return withSequentialEnvelope(input, nextSchedulerDecision(input.dag))
}

export function applyDispatch(state: Pick<WorkflowState, "implDag">, taskId: string): WorkflowState["implDag"] {
  if (!state.implDag) return null
  return state.implDag.map((task) => ({
    ...task,
    ...(task.isolation ? { isolation: { ...task.isolation, writablePaths: [...task.isolation.writablePaths] } } : {}),
    status: task.id === taskId ? "in-flight" : task.status,
  }))
}

export function applyDispatchBatch(state: Pick<WorkflowState, "implDag">, taskIds: string[]): WorkflowState["implDag"] {
  if (!state.implDag) return null
  const ids = new Set(taskIds)
  return state.implDag.map((task) => ({
    ...task,
    ...(task.isolation ? { isolation: { ...task.isolation, writablePaths: [...task.isolation.writablePaths] } } : {}),
    status: ids.has(task.id) ? "in-flight" : task.status,
  }))
}

export function applyFallback(state: Pick<WorkflowState, "implDag">, _fallback: "sequential" | "block"): WorkflowState["implDag"] {
  if (!state.implDag) return null
  return state.implDag.map((task) => ({
    ...task,
    ...(task.isolation ? { isolation: { ...task.isolation, writablePaths: [...task.isolation.writablePaths] } } : {}),
  }))
}

/**
 * Marks a task as complete in the DAG (mutates the task node in place).
 * Returns the task node that was updated, or null if not found.
 */
export function markTaskComplete(dag: ImplDAG, taskId: string): TaskNode | null {
  // ImplDAG.tasks is ReadonlyArray but TaskNode fields are mutable
  const task = Array.from(dag.tasks).find((t) => t.id === taskId)
  if (!task) return null
  // The low-level scheduler helper accepts pending/in-flight/human-gated nodes
  // so pure DAG tests and internal graph repair can model transitions directly.
  // Public workflow tools add stricter dispatched-task validation before calling.
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
    if (dep.status === "pending" || dep.status === "in-flight" || dep.status === "human-gated" || dep.status === "delegated") {
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

/**
 * Marks a delegated task as complete in the DAG (mutates in place).
 * Called when a child sub-workflow reaches DONE and the parent needs to
 * mark the delegated task as finished so downstream tasks can proceed.
 *
 * Returns the task node if successfully transitioned, null if not found
 * or not in "delegated" status.
 */
export function markDelegatedComplete(dag: ImplDAG, taskId: string): TaskNode | null {
  const task = Array.from(dag.tasks).find((t) => t.id === taskId)
  if (!task) return null
  if (task.status !== "delegated") return null
  task.status = "complete"
  return task
}
