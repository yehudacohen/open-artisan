import { createImplDAG, type HumanGateInfo, type TaskNode } from "./dag"
import { markTaskAborted, nextSchedulerDecision } from "./scheduler"

function serializeDagNodes(nodes: Iterable<TaskNode>): TaskNode[] {
  return Array.from(nodes).map((task) => ({
    ...task,
    ...(task.humanGate ? { humanGate: { ...task.humanGate } } : {}),
  }))
}

export function activateHumanGateTasks(
  nodes: TaskNode[],
  taskId: string,
  humanGate: HumanGateInfo,
): TaskNode[] {
  return nodes.map((task) => {
    if (task.id !== taskId) return { ...task, ...(task.humanGate ? { humanGate: { ...task.humanGate } } : {}) }
    return {
      ...task,
      status: "human-gated",
      humanGate: { ...humanGate },
    }
  })
}

export type AwaitingHumanResolution =
  | { action: "none"; updatedNodes: TaskNode[] }
  | { action: "user-gate"; updatedNodes: TaskNode[]; humanGatedTasks: Array<{ id: string; whatIsNeeded: string; verificationSteps: string }> }
  | { action: "robot-abort"; updatedNodes: TaskNode[]; humanGatedCount: number; abortedIds: string[]; nextTask: TaskNode | null }

export function resolveAwaitingHumanState(
  nodes: TaskNode[],
  robotArtisan: boolean,
): AwaitingHumanResolution {
  const dag = createImplDAG(Array.from(nodes))
  const decision = nextSchedulerDecision(dag)
  if (decision.action !== "awaiting-human") {
    return { action: "none", updatedNodes: serializeDagNodes(dag.tasks) }
  }

  if (!robotArtisan) {
    return {
      action: "user-gate",
      updatedNodes: serializeDagNodes(dag.tasks),
      humanGatedTasks: decision.humanGatedTasks,
    }
  }

  const unresolvedHumanGates = Array.from(dag.tasks).filter(
    (task) => task.status === "human-gated" && (!task.humanGate || !task.humanGate.resolved),
  )
  const abortedIds = new Set<string>()
  for (const gate of unresolvedHumanGates) {
    for (const aborted of markTaskAborted(dag, gate.id)) {
      abortedIds.add(aborted.id)
    }
  }

  const postAbortDecision = nextSchedulerDecision(dag)
  return {
    action: "robot-abort",
    updatedNodes: serializeDagNodes(dag.tasks),
    humanGatedCount: unresolvedHumanGates.length,
    abortedIds: Array.from(abortedIds),
    nextTask: postAbortDecision.action === "dispatch" ? postAbortDecision.task : null,
  }
}
