/**
 * mark-task-complete.ts — Tool handler for mark_task_complete.
 *
 * Closes the IMPLEMENTATION phase DAG feedback loop (Layer 4 foundations).
 *
 * The agent calls this tool after completing a DAG task and verifying that
 * the expected tests pass. The tool:
 *   1. Validates the task ID exists in the DAG
 *   2. Marks it "complete" in the serialized TaskNode[]
 *   3. Persists the updated implDag back to state
 *   4. Returns the next scheduler decision (dispatch next task or "all done")
 *
 * The scheduler's nextSchedulerDecision() reads the updated DAG on the next
 * IMPLEMENTATION/DRAFT system prompt injection, so the agent always sees
 * the current task — no stale "next task" re-dispatch.
 */

import type { TaskNode } from "../dag"
import { createImplDAG } from "../dag"
import { markTaskComplete, nextSchedulerDecision } from "../scheduler"
import type { WorkflowState } from "../types"

export interface MarkTaskCompleteArgs {
  /** The DAG task ID that was just completed (e.g. "T1", "auth-service") */
  task_id: string
  /**
   * Brief description of what was implemented (for audit trail).
   * Not stored in state but included in the tool response for context.
   */
  implementation_summary: string
  /**
   * Whether the expected tests for this task are passing.
   * If false, the tool returns an error asking the agent to fix tests first.
   */
  tests_passing: boolean
}

export interface MarkTaskCompleteResult {
  /** Updated TaskNode[] for persisting back to state.implDag */
  updatedNodes: TaskNode[]
  /** Human-readable response message for the agent */
  responseMessage: string
  /** The next dispatched task ID (null if all complete or blocked) — caller should persist to currentTaskId */
  nextTaskId: string | null
  /** When true, all remaining tasks are blocked behind human gates — caller should auto-advance to request_review */
  awaitingHuman: boolean
  /**
   * The completed task's expectedFiles — caller should accumulate these into
   * state.reviewArtifactFiles for the reviewer. Empty array if the task had
   * no expected files declared in the IMPL_PLAN.
   */
  completedTaskFiles: string[]
}

export function validateMarkTaskCompletePhase(
  state: Pick<WorkflowState, "phase" | "phaseState">,
  options: { allowScheduling?: boolean } = {},
): string | null {
  if (state.phase !== "IMPLEMENTATION") {
    return `mark_task_complete can only be called during IMPLEMENTATION (current: ${state.phase}).`
  }
  const allowed = options.allowScheduling ? ["DRAFT", "REVISE", "SCHEDULING"] : ["DRAFT", "REVISE"]
  if (!allowed.includes(state.phaseState)) {
    const allowedText = allowed.length === 2 ? `${allowed[0]} or ${allowed[1]}` : `${allowed.slice(0, -1).join(", ")}, or ${allowed.at(-1)}`
    return `mark_task_complete can only be called in ${allowedText} state (current: ${state.phase}/${state.phaseState}).`
  }
  return null
}

/**
 * Processes a mark_task_complete call.
 *
 * @param args - Tool arguments
 * @param currentNodes - Current state.implDag (null = no DAG)
 * @param currentTaskId - The currently dispatched task ID (M9: guard against non-dispatched completion)
 * @returns Result with updated nodes and response message, or error string
 */
export function processMarkTaskComplete(
  args: MarkTaskCompleteArgs,
  currentNodes: TaskNode[] | null,
  currentTaskId?: string | null,
): MarkTaskCompleteResult | { error: string } {
  if (args.tests_passing !== true) {
    return {
      error:
        `Cannot mark task "${args.task_id}" complete — tests are not passing. ` +
        `Fix the failing tests first, then call mark_task_complete again.`,
    }
  }

  // M9: Guard against completing a task that was not dispatched by the scheduler.
  // currentTaskId is set by the scheduler when it dispatches a task.
  if (currentTaskId !== undefined && currentTaskId !== null && args.task_id !== currentTaskId) {
    return {
      error:
        `Task "${args.task_id}" is not the currently dispatched task. ` +
        `The scheduler dispatched "${currentTaskId}". Complete that task first, ` +
        `or if the DAG was re-ordered, the scheduler will re-dispatch after the current task completes.`,
    }
  }

  if (!currentNodes || currentNodes.length === 0) {
    return {
      error:
        "No implementation DAG found in state. " +
        "The IMPL_PLAN phase must be approved with an on-disk implementation plan before calling mark_task_complete.",
    }
  }

  const dag = createImplDAG(currentNodes)

  // Validate task ID
  const task = Array.from(dag.tasks).find((t) => t.id === args.task_id)
  if (!task) {
    const ids = Array.from(dag.tasks).map((t) => t.id).join(", ")
    return {
      error: `Task ID "${args.task_id}" not found in DAG. Valid IDs: ${ids}`,
    }
  }

  if (task.status === "complete") {
    return {
      error: `Task "${args.task_id}" is already marked complete.`,
    }
  }

  if (task.status === "aborted") {
    return {
      error:
        `Task "${args.task_id}" was aborted due to an upstream revision. ` +
        `Re-implement it as part of the current revision cycle and re-call mark_task_complete.`,
    }
  }

  if (task.status === "human-gated") {
    return {
      error:
        `Task "${args.task_id}" is human-gated — it requires the user to perform an action ` +
        `(${task.humanGate?.whatIsNeeded ?? "see task description"}). ` +
        `This task will be resolved by the user at USER_GATE, not by the agent via mark_task_complete.`,
    }
  }

  if (task.status === "delegated") {
    return {
      error:
        `Task "${args.task_id}" is delegated to a sub-workflow. ` +
        `It will be marked complete when the sub-workflow finishes. ` +
        `Use \`query_child_workflow\` to check its progress.`,
    }
  }

  // Mark complete using the canonical scheduler helper (validates valid source states)
  const marked = markTaskComplete(dag, args.task_id)
  if (!marked) {
    return {
      error: `Task "${args.task_id}" could not be marked complete — invalid current status "${task.status}".`,
    }
  }

  // Snapshot the updated nodes for persistence
  const updatedNodes = Array.from(dag.tasks).map((t) => ({ ...t }))

  // Determine what comes next
  const decision = nextSchedulerDecision(dag)
  let nextMsg: string
  let awaitingHuman = false

  if (decision.action === "complete") {
    nextMsg =
      `\n\n**All DAG tasks complete!** ${decision.message}\n` +
      `Call \`request_review\` to advance to the final IMPLEMENTATION review gate.`
  } else if (decision.action === "dispatch") {
    nextMsg =
      `\n\n**Next task ready:**\n${decision.prompt}\n\n` +
      `Progress: ${decision.progress.complete}/${decision.progress.total} tasks complete.`
  } else if (decision.action === "awaiting-human") {
    awaitingHuman = true
    const gateList = decision.humanGatedTasks
      .map((g) => `  - **${g.id}:** ${g.whatIsNeeded}`)
      .join("\n")
    nextMsg =
      `\n\n**Awaiting human action.** All remaining tasks are blocked behind unresolved human gates:\n\n` +
      `${gateList}\n\n` +
      `Progress: ${decision.progress.complete}/${decision.progress.total} tasks complete, ` +
      `${decision.progress.humanGated} human-gated.\n\n` +
      `The system will auto-advance to USER_GATE so the user can resolve these gates. ` +
      `Call \`request_review\` to proceed.`
  } else if (decision.action === "blocked") {
    if (decision.blockedTasks.length > 0) {
      // DAG state inconsistency — tasks have unresolvable dependencies
      nextMsg =
        `\n\n**DAG BLOCKED:** All remaining tasks have incomplete dependencies — ` +
        `this indicates a DAG state inconsistency. Call \`submit_feedback\` to alert the user.`
    } else {
      // Waiting for active work (in-flight tasks or delegated sub-workflows)
      nextMsg = `\n\n**Waiting:** ${decision.message}`
    }
  } else {
    nextMsg = `\n\nScheduler error: ${(decision as { message: string }).message}`
  }

  // Re-snapshot after scheduler may have auto-transitioned human-gate tasks
  const finalNodes = Array.from(dag.tasks).map((t) => ({
    ...t,
    // Deep copy humanGate if present
    ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
  }))

  // Determine the next dispatched task ID for the caller to persist
  const nextTaskId = decision.action === "dispatch" ? decision.task.id : null

  const responseMessage =
    `Task "${args.task_id}" marked complete.\n` +
    `Summary: ${args.implementation_summary}` +
    nextMsg

  return { updatedNodes: finalNodes, responseMessage, nextTaskId, awaitingHuman, completedTaskFiles: task.expectedFiles ?? [] }
}
