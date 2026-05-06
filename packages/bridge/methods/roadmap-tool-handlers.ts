import type { BridgeContext } from "../server"
import { RoadmapDeriveExecutionSliceToolSchema, RoadmapQueryToolSchema } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import type { RoadmapQuery } from "../../core/roadmap-types"
import type { ToolHandler } from "./tool-handler-types"

function createRoadmapServices(ctx: BridgeContext):
  | { ok: true; roadmapBackend: NonNullable<BridgeContext["roadmapBackend"]>; roadmapService: NonNullable<BridgeContext["roadmapService"]> }
  | { ok: false; message: string } {
  if (ctx.roadmapBackend && ctx.roadmapService) {
    return { ok: true, roadmapBackend: ctx.roadmapBackend, roadmapService: ctx.roadmapService }
  }
  return { ok: false, message: "Roadmap backend was not initialized at lifecycle.init" }
}

function roadmapStorageFailure(message: string, retryable: boolean) {
  return JSON.stringify({
    ok: false,
    error: {
      code: "storage-failure",
      message,
      retryable,
    },
  })
}

export const handleRoadmapRead: ToolHandler = async (_args, _toolCtx, ctx) => {
  if (!ctx.stateDir) {
    return roadmapStorageFailure("Bridge stateDir is required for roadmap tools", false)
  }
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const { roadmapBackend } = services
  return JSON.stringify(await roadmapBackend.readRoadmap())
}

export const handleRoadmapQuery: ToolHandler = async (args, _toolCtx, ctx) => {
  if (!ctx.stateDir) {
    return roadmapStorageFailure("Bridge stateDir is required for roadmap tools", false)
  }
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const { roadmapService } = services
  const parsedArgs = parseToolArgs(RoadmapQueryToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const query = (parsedArgs.data.query ?? {}) as RoadmapQuery
  return JSON.stringify(await roadmapService.queryRoadmap(query))
}

export const handleRoadmapDeriveExecutionSlice: ToolHandler = async (args, _toolCtx, ctx) => {
  if (!ctx.stateDir) {
    return roadmapStorageFailure("Bridge stateDir is required for roadmap tools", false)
  }
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const { roadmapService } = services
  const parsedArgs = parseToolArgs(RoadmapDeriveExecutionSliceToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const roadmapItemIds = parsedArgs.data.roadmap_item_ids ?? parsedArgs.data.roadmapItemIds ?? []
  const featureName = parsedArgs.data.feature_name ?? parsedArgs.data.featureName
  const input = featureName === undefined ? { roadmapItemIds } : { roadmapItemIds, featureName }

  return JSON.stringify(await roadmapService.deriveExecutionSlice(input))
}
