import { JSONRPCErrorException } from "json-rpc-2.0"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import type { AnalyzeTaskBoundaryChangeArgs, ApplyTaskBoundaryChangeArgs } from "../../core/tool-types"
import { AnalyzeTaskBoundaryChangeSchema, ApplyTaskBoundaryChangeSchema, type z } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import { analyzeTaskBoundaryChange, applyTaskBoundaryChange } from "../../core/tools/transitions"
import type { ToolHandler } from "./tool-handler-types"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

function toAnalyzeTaskBoundaryChangeArgs(args: z.output<typeof AnalyzeTaskBoundaryChangeSchema>): AnalyzeTaskBoundaryChangeArgs {
  return args as AnalyzeTaskBoundaryChangeArgs
}

function toApplyTaskBoundaryChangeArgs(args: z.output<typeof ApplyTaskBoundaryChangeSchema>): ApplyTaskBoundaryChangeArgs {
  return args as ApplyTaskBoundaryChangeArgs
}

export const handleAnalyzeTaskBoundaryChange: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(AnalyzeTaskBoundaryChangeSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = analyzeTaskBoundaryChange(toAnalyzeTaskBoundaryChangeArgs(parsedArgs.data), state)
  if (!result.success) return `Error: ${result.error}`
  return JSON.stringify(result.analysis, null, 2)
}

export const handleApplyTaskBoundaryChange: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)
  const parsedArgs = parseToolArgs(ApplyTaskBoundaryChangeSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const result = applyTaskBoundaryChange(toApplyTaskBoundaryChangeArgs(parsedArgs.data), state)
  if (!result.success) return `Error: ${result.error}`
  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = result.updatedNodes
  })
  return result.message
}
