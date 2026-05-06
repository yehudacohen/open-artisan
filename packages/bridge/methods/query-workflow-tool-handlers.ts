import { JSONRPCErrorException } from "json-rpc-2.0"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import { QueryChildWorkflowToolSchema } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import { processQueryParentWorkflow, processQueryChildWorkflow } from "../../core/tools/query-workflow"
import type { ToolHandler } from "./tool-handler-types"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

export const handleQueryParentWorkflow: ToolHandler = async (_args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parentState = state.parentWorkflow
    ? ctx.engine!.store.findByFeatureName(state.parentWorkflow.featureName)
    : null
  const result = processQueryParentWorkflow(state, parentState)
  if (result.error) return `Error: ${result.error}`
  return JSON.stringify(result, null, 2)
}

export const handleQueryChildWorkflow: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(QueryChildWorkflowToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const taskId = parsedArgs.data.task_id
  const childEntry = state.childWorkflows.find((child) => child.taskId === taskId)
  const childState = childEntry
    ? ctx.engine!.store.findByFeatureName(childEntry.featureName)
    : null
  const result = processQueryChildWorkflow(state, taskId, childState)
  if (result.error) return `Error: ${result.error}`
  return JSON.stringify(result, null, 2)
}
