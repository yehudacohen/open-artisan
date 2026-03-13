/**
 * dag.ts — Layer 4 DAG data structures and validator (Design doc §7.1).
 *
 * Defines TaskNode and ImplDAG — the typed representation of the approved
 * implementation plan. The ImplDAG is parsed from the free-text IMPL_PLAN
 * artifact by impl-plan-parser.ts, validated here, and consumed by the
 * sequential scheduler in scheduler.ts.
 *
 * Scope note: Layer 4 full parallel execution (worktrees, async dispatch)
 * is deferred pending the OpenCode async task dispatch API contribution.
 * This module provides the foundations for sequential scheduling only.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in-flight" | "complete" | "aborted"

export type TaskComplexity = "small" | "medium" | "large"

export interface TaskNode {
  /** Unique identifier within this DAG — e.g. "T1", "T2", "auth-service" */
  id: string

  /** Human-readable description of what this task implements */
  description: string

  /** IDs of predecessor tasks that must complete before this task can start */
  dependencies: string[]

  /**
   * Test file paths (relative to project root) that should become green
   * after this task completes. Used by the sequential scheduler to verify
   * task completion before advancing.
   */
  expectedTests: string[]

  /** Rough complexity estimate — used for scheduling prioritization */
  estimatedComplexity: TaskComplexity

  /** Current execution state */
  status: TaskStatus

  /**
   * Git branch name when in-flight (populated by scheduler in Layer 4 full).
   * Not used by the sequential scheduler — reserved for parallel execution.
   */
  worktreeBranch?: string

  /**
   * Filesystem path to git worktree when in-flight.
   * Not used by the sequential scheduler — reserved for parallel execution.
   */
  worktreePath?: string
}

// ---------------------------------------------------------------------------
// DAG interface
// ---------------------------------------------------------------------------

export interface DAGValidationResult {
  valid: boolean
  errors: string[]
}

export interface ImplDAG {
  readonly tasks: ReadonlyArray<TaskNode>

  /**
   * Validates the DAG for structural correctness:
   * - No duplicate task IDs
   * - All dependency references resolve to existing task IDs
   * - No circular dependencies (cycle detection via DFS)
   * - At least one task exists
   */
  validate(): DAGValidationResult

  /**
   * Returns tasks whose dependencies are all in "complete" status,
   * and whose own status is "pending".
   * In topological order (approximate: sorted by number of dependencies).
   */
  getReady(): TaskNode[]

  /**
   * Returns true iff all tasks are in "complete" or "aborted" status.
   * (Aborted tasks are not re-run by the sequential scheduler — they
   * represent tasks that were invalidated by an upstream revision.)
   */
  isComplete(): boolean

  /**
   * Returns the subset of tasks reachable from the given task ID
   * (i.e. all tasks that depend on it, directly or transitively).
   * Used by the parallel abort system to identify cascading cancellations.
   */
  getDependents(taskId: string): TaskNode[]
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an ImplDAG from a flat array of TaskNode objects.
 * The returned object is the validated + queryable DAG handle.
 *
 * Caller is responsible for calling validate() before scheduling.
 */
export function createImplDAG(tasks: TaskNode[]): ImplDAG {
  // Defensive deep copy — we own the array and its nested arrays
  const nodes = tasks.map((t) => ({
    ...t,
    dependencies: [...t.dependencies],
    expectedTests: [...t.expectedTests],
  }))

  function validate(): DAGValidationResult {
    const errors: string[] = []

    if (nodes.length === 0) {
      errors.push("DAG has no tasks")
      return { valid: false, errors }
    }

    // Duplicate ID check
    const ids = new Set<string>()
    for (const t of nodes) {
      if (!t.id || typeof t.id !== "string") {
        errors.push(`Task has invalid id: "${t.id}"`)
        continue
      }
      if (ids.has(t.id)) {
        errors.push(`Duplicate task ID: "${t.id}"`)
      }
      ids.add(t.id)
    }

    // Dependency reference check
    for (const t of nodes) {
      for (const dep of t.dependencies) {
        if (!ids.has(dep)) {
          errors.push(`Task "${t.id}" has unknown dependency "${dep}"`)
        }
      }
    }

    // Cycle detection via DFS (only run if no reference errors to avoid false alarms)
    if (errors.length === 0) {
      const WHITE = 0, GRAY = 1, BLACK = 2
      const color = new Map<string, number>()
      for (const t of nodes) color.set(t.id, WHITE)

      const adj = new Map<string, string[]>()
      for (const t of nodes) adj.set(t.id, t.dependencies)

      function dfs(id: string): boolean {
        color.set(id, GRAY)
        for (const dep of (adj.get(id) ?? [])) {
          const c = color.get(dep) ?? WHITE
          if (c === GRAY) return true // back-edge = cycle
          if (c === WHITE && dfs(dep)) return true
        }
        color.set(id, BLACK)
        return false
      }

      for (const t of nodes) {
        if ((color.get(t.id) ?? WHITE) === WHITE) {
          if (dfs(t.id)) {
            errors.push(`Circular dependency detected involving task "${t.id}"`)
            break
          }
        }
      }
    }

    return { valid: errors.length === 0, errors }
  }

  function getReady(): TaskNode[] {
    const completeIds = new Set(
      nodes.filter((t) => t.status === "complete").map((t) => t.id),
    )
    const ready = nodes.filter(
      (t) =>
        t.status === "pending" &&
        t.dependencies.every((dep) => completeIds.has(dep)),
    )
    // Sort by number of dependencies ascending (simpler tasks tend to be less constrained)
    return ready.sort((a, b) => a.dependencies.length - b.dependencies.length)
  }

  function isComplete(): boolean {
    return nodes.every((t) => t.status === "complete" || t.status === "aborted")
  }

  function getDependents(taskId: string): TaskNode[] {
    const visited = new Set<string>()
    const queue = [taskId]
    const result: TaskNode[] = []

    while (queue.length > 0) {
      const current = queue.shift()!
      for (const t of nodes) {
        if (t.id !== taskId && !visited.has(t.id) && t.dependencies.includes(current)) {
          visited.add(t.id)
          result.push(t)
          queue.push(t.id)
        }
      }
    }

    return result
  }

  return { tasks: nodes, validate, getReady, isComplete, getDependents }
}
