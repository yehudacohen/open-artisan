import type { BridgeContext } from "../server"
import {
  RoadmapDeleteEdgeToolSchema,
  RoadmapDeleteItemToolSchema,
  RoadmapDeriveExecutionSliceToolSchema,
  RoadmapQueryToolSchema,
  RoadmapReplaceToolSchema,
  RoadmapUpdateItemStatusToolSchema,
  RoadmapUpsertEdgeToolSchema,
  RoadmapUpsertItemToolSchema,
} from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import type { RoadmapDocument, RoadmapItem, RoadmapQuery } from "../../core/roadmap-types"
import { createRoadmapStateBackendMutationService } from "../../core/open-artisan-services"
import type { ToolHandler } from "./tool-handler-types"

type ParsedRoadmapItem = Omit<RoadmapItem, "description" | "featureName"> & {
  description?: string | undefined
  featureName?: string | undefined
}

function normalizeRoadmapItem(item: ParsedRoadmapItem): RoadmapItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ...(item.description === undefined ? {} : { description: item.description }),
    status: item.status,
    priority: item.priority,
    ...(item.featureName === undefined ? {} : { featureName: item.featureName }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

function normalizeRoadmapDocument(document: Omit<RoadmapDocument, "items"> & { items: ParsedRoadmapItem[] }): RoadmapDocument {
  return {
    schemaVersion: document.schemaVersion,
    items: document.items.map(normalizeRoadmapItem),
    edges: document.edges,
  }
}

function createRoadmapServices(ctx: BridgeContext):
  | {
      ok: true
      roadmapBackend: NonNullable<BridgeContext["roadmapBackend"]>
      roadmapService: NonNullable<BridgeContext["roadmapService"]>
      roadmapMutations: NonNullable<BridgeContext["openArtisanServices"]>["roadmapMutations"]
      executionSlices: NonNullable<BridgeContext["openArtisanServices"]>["executionSlices"] | null
    }
  | { ok: false; message: string } {
  if (ctx.roadmapBackend && ctx.roadmapService) {
    return {
      ok: true,
      roadmapBackend: ctx.roadmapBackend,
      roadmapService: ctx.roadmapService,
      roadmapMutations: ctx.openArtisanServices?.roadmapMutations ?? createRoadmapStateBackendMutationService(ctx.roadmapBackend, ctx.roadmapService),
      executionSlices: ctx.openArtisanServices?.executionSlices ?? null,
    }
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

function roadmapInvalidInputFailure(message: string) {
  return JSON.stringify({
    ok: false,
    error: {
      code: "invalid-input",
      message,
      retryable: false,
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
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  const query = (parsedArgs.data.query ?? {}) as RoadmapQuery
  return JSON.stringify(await roadmapService.queryRoadmap(query))
}

export const handleRoadmapDeriveExecutionSlice: ToolHandler = async (args, _toolCtx, ctx) => {
  if (!ctx.stateDir) {
    return roadmapStorageFailure("Bridge stateDir is required for roadmap tools", false)
  }
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const { executionSlices, roadmapService } = services
  const parsedArgs = parseToolArgs(RoadmapDeriveExecutionSliceToolSchema, args)
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  let roadmapItemIds = parsedArgs.data.roadmap_item_ids ?? parsedArgs.data.roadmapItemIds ?? []
  const featureName = parsedArgs.data.feature_name ?? parsedArgs.data.featureName
  const executionSliceId = parsedArgs.data.execution_slice_id ?? parsedArgs.data.executionSliceId
  if (roadmapItemIds.length === 0 && executionSliceId) {
    if (!executionSlices) return roadmapStorageFailure("Execution slice service was not initialized at lifecycle.init", false)
    const slice = await executionSlices.getSlice(executionSliceId)
    if (!slice.ok) return JSON.stringify({ ok: false, error: slice.error })
    if (!slice.value) {
      return JSON.stringify({ ok: false, error: { code: "not-found", message: `Unknown execution_slice_id: ${executionSliceId}`, retryable: false } })
    }
    roadmapItemIds = slice.value.itemIds
  }
  const input = {
    roadmapItemIds,
    ...(featureName === undefined ? {} : { featureName }),
    ...(executionSliceId === undefined ? {} : { executionSliceId }),
  }

  return JSON.stringify(await roadmapService.deriveExecutionSlice(input))
}

export const handleRoadmapUpsertItem: ToolHandler = async (args, _toolCtx, ctx) => {
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const parsedArgs = parseToolArgs(RoadmapUpsertItemToolSchema, args)
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  return JSON.stringify(await services.roadmapMutations.upsertItem({ item: normalizeRoadmapItem(parsedArgs.data.item) }))
}

export const handleRoadmapUpdateItemStatus: ToolHandler = async (args, _toolCtx, ctx) => {
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const parsedArgs = parseToolArgs(RoadmapUpdateItemStatusToolSchema, args)
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  const itemId = parsedArgs.data.item_id ?? parsedArgs.data.itemId!
  const updatedAt = parsedArgs.data.updated_at ?? parsedArgs.data.updatedAt
  return JSON.stringify(await services.roadmapMutations.updateItemStatus({
    itemId,
    status: parsedArgs.data.status,
    ...(updatedAt ? { updatedAt } : {}),
  }))
}

export const handleRoadmapDeleteItem: ToolHandler = async (args, _toolCtx, ctx) => {
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const parsedArgs = parseToolArgs(RoadmapDeleteItemToolSchema, args)
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  return JSON.stringify(await services.roadmapMutations.deleteItem({ itemId: parsedArgs.data.item_id ?? parsedArgs.data.itemId! }))
}

export const handleRoadmapUpsertEdge: ToolHandler = async (args, _toolCtx, ctx) => {
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const parsedArgs = parseToolArgs(RoadmapUpsertEdgeToolSchema, args)
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  return JSON.stringify(await services.roadmapMutations.upsertEdge({ edge: parsedArgs.data.edge }))
}

export const handleRoadmapDeleteEdge: ToolHandler = async (args, _toolCtx, ctx) => {
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const parsedArgs = parseToolArgs(RoadmapDeleteEdgeToolSchema, args)
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  return JSON.stringify(await services.roadmapMutations.deleteEdge({ edge: parsedArgs.data.edge }))
}

export const handleRoadmapReplace: ToolHandler = async (args, _toolCtx, ctx) => {
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  const parsedArgs = parseToolArgs(RoadmapReplaceToolSchema, args)
  if (!parsedArgs.success) return roadmapInvalidInputFailure(parsedArgs.error)
  return JSON.stringify(await services.roadmapMutations.replaceRoadmap({ document: normalizeRoadmapDocument(parsedArgs.data.document) }))
}

export const handleRoadmapDelete: ToolHandler = async (_args, _toolCtx, ctx) => {
  const services = createRoadmapServices(ctx)
  if (!services.ok) return roadmapStorageFailure(services.message, false)
  return JSON.stringify(await services.roadmapMutations.deleteRoadmap())
}
