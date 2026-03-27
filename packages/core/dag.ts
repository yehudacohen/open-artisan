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

export type TaskStatus = "pending" | "in-flight" | "complete" | "aborted" | "human-gated" | "delegated"

export type TaskComplexity = "small" | "medium" | "large"

/**
 * Task category — classifies what kind of work a task represents.
 * Used for stub detection (stubs allowed in "scaffold" but not "integration"/"standalone")
 * and human gate routing (only "human-gate" tasks can be resolved by the user).
 *
 * - scaffold: Contract-satisfying code structure without real integration logic. Stubs allowed.
 * - human-gate: Requires human action (provision infra, configure creds). No code.
 * - integration: Real implementation that connects to external services. No stubs.
 * - standalone: Self-contained logic (business rules, utilities). No stubs.
 */
export type TaskCategory = "scaffold" | "human-gate" | "integration" | "standalone"

/**
 * Metadata attached to a human-gated task describing what the human must do.
 * Set when the agent calls `resolve_human_gate`, read at USER_GATE for resolution.
 */
export interface HumanGateInfo {
  /** What the human needs to do (e.g. "Configure AWS S3 credentials in .env") */
  whatIsNeeded: string
  /** Why this is needed (e.g. "The real S3 stager needs bucket access") */
  why: string
  /** Steps the human can run to verify the gate is resolved (e.g. "Run `aws s3 ls`") */
  verificationSteps: string
  /** Whether the user has confirmed this gate is resolved */
  resolved: boolean
  /** ISO timestamp of when the gate was resolved (set by submit_feedback) */
  resolvedAt?: string
}

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
   * Task category — classifies what kind of work this task represents.
   * Optional for backward compatibility: defaults to "standalone" when absent.
   */
  category?: TaskCategory

  /**
   * Human gate metadata — only present on tasks with status "human-gated".
   * Describes what the human must do and whether they've confirmed completion.
   */
  humanGate?: HumanGateInfo

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
   * whose own status is "pending", and whose category is NOT "human-gate".
   * In topological order (approximate: sorted by number of dependencies).
   */
  getReady(): TaskNode[]

  /**
   * Returns human-gate tasks whose dependencies are all complete and whose
   * status is still "pending". These are ready to be auto-transitioned to
   * "human-gated" status by the scheduler.
   */
  getReadyHumanGates(): TaskNode[]

  /**
   * Returns true iff all tasks are in "complete" or "aborted" status.
   * Note: "human-gated" and "delegated" tasks are NOT considered complete —
   * the DAG is not done until all gates are resolved / sub-workflows finish
   * and downstream tasks complete.
   */
  isComplete(): boolean

  /**
   * Returns true if there are unresolved human-gated tasks that block
   * downstream progress. Used by the scheduler to detect "awaiting-human".
   */
  hasUnresolvedHumanGates(): boolean

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
    // Deep copy humanGate if present (nested object)
    ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
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
        // Human-gate tasks are not dispatchable to the agent — they are
        // auto-transitioned to "human-gated" by the scheduler and resolved
        // by the user at USER_GATE. Exclude them from ready dispatch.
        t.category !== "human-gate" &&
        t.dependencies.every((dep) => completeIds.has(dep)),
    )
    // Sort by number of dependencies ascending (simpler tasks tend to be less constrained)
    return ready.sort((a, b) => a.dependencies.length - b.dependencies.length)
  }

  /**
   * Returns human-gated tasks that are ready to be gated (all deps complete,
   * category is "human-gate", status is still "pending").
   * Used by the scheduler to transition these tasks to "human-gated" status
   * before checking for dispatchable work.
   */
  function getReadyHumanGates(): TaskNode[] {
    const completeIds = new Set(
      nodes.filter((t) => t.status === "complete").map((t) => t.id),
    )
    return nodes.filter(
      (t) =>
        t.status === "pending" &&
        t.category === "human-gate" &&
        t.dependencies.every((dep) => completeIds.has(dep)),
    )
  }

  function isComplete(): boolean {
    return nodes.every(
      (t) => t.status === "complete" || t.status === "aborted",
    )
  }

  /**
   * Returns true if there are unresolved human-gated tasks blocking progress.
   * Used by the scheduler to detect the "awaiting-human" state.
   */
  function hasUnresolvedHumanGates(): boolean {
    return nodes.some(
      (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
    )
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

  return { tasks: nodes, validate, getReady, getReadyHumanGates, isComplete, hasUnresolvedHumanGates, getDependents }
}
