import { JSONRPCErrorException } from "json-rpc-2.0"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import { createImplDAG } from "../../core/dag"
import type { WorkflowState } from "../../core/workflow-state-types"
import type { DbAgentLease } from "../../core/open-artisan-repository"
import type { OpenArtisanServices } from "../../core/open-artisan-services"
import { CheckPriorWorkflowToolSchema, ResetTaskToolSchema, ResolveHumanGateToolSchema } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import { applyDispatch, nextSchedulerDecision } from "../../core/scheduler"
import { activateHumanGateTasks, resolveAwaitingHumanState } from "../../core/human-gate-policy"
import { isRobotArtisanSession } from "../../core/autonomous-user-gate"
import { persistTaskDispatchClaims } from "../../core/runtime-persistence"
import type { ToolHandler } from "./tool-handler-types"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

function agentKindFromSession(agent: string | null | undefined): DbAgentLease["agentKind"] {
  if (agent === "hermes" || agent === "claude" || agent === "opencode") return agent
  if (agent === "artisan" || agent === "robot-artisan") return "opencode"
  return "other"
}

async function persistCurrentTaskClaim(
  services: OpenArtisanServices | null | undefined,
  state: WorkflowState | null | undefined,
  sessionId: string,
): Promise<void> {
  if (!state?.currentTaskId) return
  await persistTaskDispatchClaims(services, state, state.currentTaskId, sessionId, agentKindFromSession(state.activeAgent))
}

export const handleCheckPriorWorkflow: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const parsedArgs = parseToolArgs(CheckPriorWorkflowToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const featureName = parsedArgs.data.feature_name.trim()

  const priorState = await store.findPersistedByFeatureName(featureName)
  if (!priorState) {
    await store.update(toolCtx.sessionId, (draft) => {
      draft.priorWorkflowChecked = true
    })
    return `No prior workflow found for feature "${featureName}". Proceed with select_mode.`
  }

  await store.update(toolCtx.sessionId, (draft) => {
    draft.priorWorkflowChecked = true
    draft.cachedPriorState = {
      intentBaseline: priorState.intentBaseline,
      phase: priorState.phase,
      artifactDiskPaths: priorState.artifactDiskPaths as Record<string, string>,
      approvedArtifacts: priorState.approvedArtifacts as Record<string, string>,
    }
  })

  return `Prior workflow found for "${featureName}" at phase ${priorState.phase}. Call select_mode to continue or start fresh.`
}

export const handleResolveHumanGate: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "IMPLEMENTATION") {
    return `Error: resolve_human_gate can only be called during IMPLEMENTATION.`
  }

  const parsedArgs = parseToolArgs(ResolveHumanGateToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const taskId = parsedArgs.data.task_id

  if (!state.implDag) return "Error: No implementation DAG found."

  const task = state.implDag.find((candidate) => candidate.id === taskId)
  if (!task) return `Error: Task "${taskId}" not found in DAG.`

  if (task.status !== "pending" && task.status !== "human-gated") {
    return `Error: Task "${taskId}" must be pending or human-gated (current: ${task.status}).`
  }

  const activatedNodes = activateHumanGateTasks(state.implDag, taskId, {
    whatIsNeeded: parsedArgs.data.what_is_needed,
    why: parsedArgs.data.why || "Required for implementation.",
    verificationSteps: parsedArgs.data.verification_steps || "Verify the setup is complete.",
    resolved: false,
  })
  const resolution = resolveAwaitingHumanState(activatedNodes, isRobotArtisanSession(state))

  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = resolution.updatedNodes
    if (resolution.action === "robot-abort") {
      draft.currentTaskId = resolution.nextTask?.id ?? null
      return
    }
    if (resolution.action === "user-gate") {
      draft.phaseState = "HUMAN_GATE"
      draft.iterationCount = 0
      draft.retryCount = 0
      draft.userGateMessageReceived = false
      draft.currentTaskId = null
    }
  })
  await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

  if (resolution.action === "robot-abort") {
    return (
      `Human gate set for task "${taskId}".\n\n` +
      `**Robot-artisan mode:** Auto-aborted ${resolution.abortedIds.length} human-gated task(s) and dependents.\n` +
      `These tasks require human action that cannot be automated.\n\n` +
      (resolution.nextTask
        ? `**Next task ready:** ${resolution.nextTask.id} — ${resolution.nextTask.description}\nContinue with the next task.`
        : `Call \`request_review\` to submit the partial implementation for review.`)
    )
  }

  if (resolution.action === "user-gate") {
    const gateList = resolution.humanGatedTasks
      .map((gate) => `  - **${gate.id}:** ${gate.whatIsNeeded}`)
      .join("\n")
    return (
      `Human gate set for task "${taskId}".\n\n` +
      `**All remaining work is blocked behind human gates.** Auto-advancing to HUMAN_GATE for user resolution.\n\n` +
      `**Unresolved human gates:**\n${gateList}`
    )
  }

  const refreshedDecision = nextSchedulerDecision(createImplDAG(resolution.updatedNodes))
  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = resolution.updatedNodes
    draft.currentTaskId = refreshedDecision.action === "dispatch" ? refreshedDecision.task.id : null
    draft.phaseState = refreshedDecision.action === "dispatch" ? "DRAFT" : "SCHEDULING"
    if (refreshedDecision.action === "dispatch") {
      draft.implDag = applyDispatch(draft, refreshedDecision.task.id)
    }
  })
  await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

  return `Human gate set for task "${taskId}". Returning to IMPLEMENTATION/${refreshedDecision.action === "dispatch" ? "DRAFT" : "SCHEDULING"} for remaining work.`
}

export const handleResetTask: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "IMPLEMENTATION") {
    return `Error: reset_task can only be called during IMPLEMENTATION (current: ${state.phase}).`
  }
  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE" && state.phaseState !== "TASK_REVISE" && state.phaseState !== "SCHEDULING") {
    return `Error: reset_task can only be called in DRAFT, REVISE, TASK_REVISE, or SCHEDULING state (current: ${state.phaseState}).`
  }
  if (state.taskCompletionInProgress) {
    return `Error: Task "${state.taskCompletionInProgress}" is awaiting review. Call submit_task_review first.`
  }

  const parsedArgs = parseToolArgs(ResetTaskToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const taskIds = parsedArgs.data.task_ids
  const taskId = parsedArgs.data.task_id
  const ids = taskIds ?? (taskId ? [taskId] : [])

  if (ids.length === 0) {
    return "Error: task_id (string) or task_ids (array) is required."
  }
  if (!state.implDag) {
    return "Error: No implementation DAG found."
  }

  for (const id of ids) {
    if (!state.implDag.find((task) => task.id === id)) {
      return `Error: Task "${id}" not found in DAG.`
    }
  }

  const resetSet = new Set(ids)
  for (const node of state.implDag) {
    if (resetSet.has(node.id)) continue
    if (node.status === "complete" || node.status === "in-flight") {
      const dependsOnReset = node.dependencies.some((dependency) => resetSet.has(dependency))
      if (dependsOnReset) {
        return (
          `Error: Task "${node.id}" (${node.status}) depends on "${node.dependencies.find((dependency) => resetSet.has(dependency))}". ` +
          `Reset dependent tasks too, or reset them in dependency order.`
        )
      }
    }
  }

  await store.update(toolCtx.sessionId, (draft) => {
    for (const id of ids) {
      const task = draft.implDag?.find((candidate) => candidate.id === id)
      if (task) {
        task.status = "pending"
      }
    }
    const dagOrder = draft.implDag?.map((task) => task.id) ?? []
    const firstReset = dagOrder.find((id) => ids.includes(id))
    if (firstReset) {
      draft.currentTaskId = firstReset
      draft.implDag = applyDispatch(draft, firstReset)
      draft.phaseState = "DRAFT"
    }
    draft.taskReviewCount = 0
    draft.taskCompletionInProgress = null
  })
  await persistCurrentTaskClaim(ctx.openArtisanServices, store.get(toolCtx.sessionId), toolCtx.sessionId)

  const taskList = ids.join(", ")
  return `Reset ${ids.length} task(s) to pending: ${taskList}. Current task: ${ids[0]}.`
}

export const handleSpawnSubWorkflow: ToolHandler = async () => {
  return "Error: spawn_sub_workflow requires adapter-managed child session creation. Use the bridge context/review submission flow or an adapter that declares this capability."
}
