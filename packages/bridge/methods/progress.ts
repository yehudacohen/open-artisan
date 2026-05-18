import { JSONRPCErrorException } from "json-rpc-2.0"

import type { MethodHandler } from "../server"
import type { ProgressEmitParams, ProgressEmitResult, ProgressListParams, ProgressListResult } from "../protocol"
import { INVALID_PARAMS, SESSION_NOT_FOUND } from "../protocol"
import type { DbWorkflowEvent } from "../../core/open-artisan-repository"
import {
  appendWorkflowProgressEvent,
  buildWorkflowProgressEvent,
  listWorkflowProgressEvents,
  validateWorkflowProgressEventInput,
  type BuildWorkflowProgressEventInput,
} from "../../core/workflow-progress"
import { workflowDbId } from "../../core/runtime-persistence"

function requireStateDir(ctxStateDir: string | null | undefined): string {
  if (!ctxStateDir) throw new JSONRPCErrorException("Bridge stateDir is unavailable", INVALID_PARAMS)
  return ctxStateDir
}

function progressInput(p: Partial<ProgressEmitParams> & { sessionId: string; kind: string; message: string }): BuildWorkflowProgressEventInput {
  return {
    sessionId: p.sessionId,
    kind: p.kind,
    status: p.status ?? "in-progress",
    message: p.message,
    ...(p.spanId !== undefined ? { spanId: p.spanId } : {}),
    ...(p.parentSpanId !== undefined ? { parentSpanId: p.parentSpanId } : {}),
    ...(p.parentEventId !== undefined ? { parentEventId: p.parentEventId } : {}),
    ...(p.taskId !== undefined ? { taskId: p.taskId } : {}),
    ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
  }
}

export const handleProgressEmit: MethodHandler = async (params, ctx) => {
  const p = params as Partial<ProgressEmitParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  const state = ctx.engine!.store.get(p.sessionId)
  if (!state) throw new JSONRPCErrorException(`Session "${p.sessionId}" not found`, SESSION_NOT_FOUND)
  const stateDir = requireStateDir(ctx.stateDir ?? ctx.runtimeBackendInfo.stateDir)

  const input = progressInput({ ...p, sessionId: p.sessionId, kind: p.kind ?? "", message: p.message ?? "" })
  const validationError = validateWorkflowProgressEventInput(input)
  if (validationError) throw new JSONRPCErrorException(validationError, INVALID_PARAMS)

  if (p.parentEventId) {
    const priorEvents = await listWorkflowProgressEvents(stateDir, {
      featureName: state.featureName ?? null,
      sessionId: p.sessionId,
    })
    if (!priorEvents.some((event) => event.id === p.parentEventId)) {
      throw new JSONRPCErrorException(`parentEventId "${p.parentEventId}" was not found`, INVALID_PARAMS)
    }
  }

  const event = buildWorkflowProgressEvent(input, state)

  await appendWorkflowProgressEvent(stateDir, event)

  if (ctx.openArtisanServices) {
    const dbEvent: DbWorkflowEvent = {
      ...event,
      workflowId: workflowDbId({ featureName: state.featureName ?? null, sessionId: p.sessionId }),
      reason: event.message,
      metadata: { source: "runtime", progress: event.metadata },
    }
    const dbResult = await ctx.openArtisanServices.workflow.appendEvent(dbEvent)
    if (!dbResult.ok) ctx.pinoLogger?.debug({ err: dbResult.error }, "Failed to mirror progress event to DB")
  }

  return { event } satisfies ProgressEmitResult
}

export const handleProgressList: MethodHandler = async (params, ctx) => {
  const p = params as Partial<ProgressListParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  const state = ctx.engine!.store.get(p.sessionId)
  if (!state) throw new JSONRPCErrorException(`Session "${p.sessionId}" not found`, SESSION_NOT_FOUND)
  const stateDir = requireStateDir(ctx.stateDir ?? ctx.runtimeBackendInfo.stateDir)
  const events = await listWorkflowProgressEvents(stateDir, {
    featureName: state.featureName ?? null,
    sessionId: p.sessionId,
    ...(p.sinceEventId !== undefined ? { sinceEventId: p.sinceEventId } : {}),
    ...(p.limit !== undefined ? { limit: p.limit } : {}),
  })
  return {
    events,
    nextCursor: events.at(-1)?.id ?? p.sinceEventId ?? null,
  } satisfies ProgressListResult
}
