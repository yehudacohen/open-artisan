import { JSONRPCErrorException } from "json-rpc-2.0"

import { proposeDirectApplication } from "../../core/direct-application"
import { ProposeDirectApplicationSchema } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import type { WorkflowState } from "../../core/workflow-state-types"
import { SESSION_NOT_FOUND } from "../protocol"
import type { BridgeContext } from "../server"
import type { ToolHandler } from "./tool-handler-types"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

export const handleProposeDirectApplication: ToolHandler = async (args, toolCtx, ctx) => {
  const parsedArgs = parseToolArgs(ProposeDirectApplicationSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const state = requireState(ctx, toolCtx.sessionId)
  const result = await proposeDirectApplication({
    state,
    cwd: toolCtx.directory,
    summary: parsedArgs.data.summary,
    whySafe: parsedArgs.data.why_safe,
    affectedFiles: parsedArgs.data.affected_files,
    patch: parsedArgs.data.patch,
    ...(parsedArgs.data.verification_command ? { verificationCommand: parsedArgs.data.verification_command } : {}),
  })
  return JSON.stringify(result, null, 2)
}
