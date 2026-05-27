import { createProductManagementService } from "../../core/product-management-service"
import { createRoadmapStateBackendMutationService, type RoadmapService } from "../../core/open-artisan-services"
import { openArtisanDbError, openArtisanDbOk, type OpenArtisanDbResult } from "../../core/open-artisan-repository"
import type { ProductManagementAssessRequestInput, ProductManagementListWorkInput, ProductManagementQueueItemInput, ProductManagementWorkflowSummary } from "../../core/product-management-types"
import type { RoadmapItem, RoadmapResult } from "../../core/roadmap-types"
import {
  formatZodError,
  ProductManagementAssessRequestToolSchema,
  ProductManagementAssessRequestResultSchema,
  ProductManagementListWorkToolSchema,
  ProductManagementListWorkResultSchema,
  ProductManagementQueueItemToolSchema,
  ProductManagementQueueItemResultSchema,
} from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import type { WorkflowState } from "../../core/workflow-state-types"
import type { BridgeContext } from "../server"
import type { ToolHandler } from "./tool-handler-types"

function invalidInput(message: string): string {
  return JSON.stringify({ ok: false, error: { code: "invalid-input", message, retryable: false } })
}

function validationFailure(message: string): string {
  return JSON.stringify({ ok: false, error: { code: "storage-failure", message, retryable: false } })
}

function stringifyValidatedResult(result: unknown, schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: Parameters<typeof formatZodError>[0] } }, label: string): string {
  const parsed = schema.safeParse(result)
  if (parsed.success) return JSON.stringify(parsed.data)
  return validationFailure(`${label} returned an invalid product-management result: ${formatZodError(parsed.error)}`)
}

function dbResultFromRoadmap<T>(result: RoadmapResult<T>): OpenArtisanDbResult<T> {
  if (result.ok) return openArtisanDbOk(result.value)
  const code = result.error.code === "not-found" || result.error.code === "invalid-document" || result.error.code === "lock-timeout" || result.error.code === "storage-failure"
    ? result.error.code
    : "invalid-input"
  return openArtisanDbError(code, result.error.message, result.error.retryable, result.error.details)
}

function createFallbackRoadmapService(ctx: BridgeContext): RoadmapService | undefined {
  if (ctx.openArtisanServices?.roadmap) return ctx.openArtisanServices.roadmap
  if (!ctx.roadmapBackend || !ctx.roadmapService) return undefined
  const mutations = createRoadmapStateBackendMutationService(ctx.roadmapBackend, ctx.roadmapService)
  return {
    replaceRoadmap: async (document) => dbResultFromRoadmap(await ctx.roadmapBackend!.updateRoadmap(document)),
    readRoadmap: async () => dbResultFromRoadmap(await ctx.roadmapBackend!.readRoadmap()),
    deleteRoadmap: async () => dbResultFromRoadmap(await ctx.roadmapBackend!.deleteRoadmap()),
    async createItem(item) {
      const result = await mutations.upsertItem({ item })
      if (!result.ok) return dbResultFromRoadmap(result)
      return openArtisanDbOk((result.value.item ?? item) as RoadmapItem)
    },
    async listItems(query) {
      const roadmapQuery = {
        ...(query?.featureName ? { featureName: query.featureName } : {}),
        ...(query?.status ? { statuses: [query.status] } : {}),
      }
      const result = await ctx.roadmapService!.queryRoadmap(roadmapQuery)
      return dbResultFromRoadmap(result)
    },
    async upsertEdge(edge) {
      return dbResultFromRoadmap(await mutations.upsertEdge({ edge: { from: edge.fromItemId, to: edge.toItemId, kind: edge.kind } }))
    },
    async listEdges(itemId) {
      const result = await ctx.roadmapBackend!.readRoadmap()
      if (!result.ok) return dbResultFromRoadmap(result)
      const edges = result.value?.edges ?? []
      return openArtisanDbOk(
        (itemId ? edges.filter((edge) => edge.from === itemId || edge.to === itemId) : edges)
          .map((edge) => ({ fromItemId: edge.from, toItemId: edge.to, kind: edge.kind })),
      )
    },
  }
}

function currentWorkflowSummary(state: WorkflowState | null | undefined): ProductManagementWorkflowSummary | undefined {
  if (!state) return undefined
  const currentTask = state.currentTaskId && state.implDag
    ? state.implDag.find((task) => task.id === state.currentTaskId) ?? null
    : null
  const activeFileClaims = currentTask?.status === "in-flight" ? currentTask.expectedFiles : []
  const unresolvedHumanGateCount = (state.implDag ?? []).filter((task) => task.status === "human-gated" && !task.humanGate?.resolved).length
  const blockedReasons: string[] = []
  if (state.phaseState === "USER_GATE") blockedReasons.push("workflow is waiting at a user gate")
  if (state.phaseState === "ESCAPE_HATCH") blockedReasons.push("workflow is waiting at an escape hatch")
  if (state.phaseState === "TASK_REVIEW") blockedReasons.push("implementation task review is in progress")
  if (state.phaseState === "HUMAN_GATE") blockedReasons.push("workflow has unresolved human-gated tasks")
  if (activeFileClaims.length > 0) blockedReasons.push("current implementation task owns active file claims")

  return {
    ...(state.featureName ? { workflowId: state.featureName, featureName: state.featureName } : { featureName: "unselected" }),
    ...(state.roadmapContext ? {
      executionSlice: {
        ...(state.roadmapContext.executionSliceId ? { executionSliceId: state.roadmapContext.executionSliceId } : {}),
        ...(state.featureName ? { workflowId: state.featureName, featureName: state.featureName } : {}),
        roadmapItemIds: state.roadmapContext.roadmapItemIds,
      },
    } : {}),
    ...(state.mode ? { mode: state.mode } : {}),
    phase: state.phase,
    phaseState: state.phaseState,
    roadmapItemIds: state.roadmapContext?.roadmapItemIds ?? [],
    ...(state.currentTaskId ? { currentTaskId: state.currentTaskId } : {}),
    unresolvedHumanGateCount,
    pendingPatchSuggestionCount: 0,
    activeFileClaims,
    safeToSwitch: blockedReasons.length === 0,
    blockedReasons,
  }
}

function createService(ctx: BridgeContext, state: WorkflowState | null | undefined) {
  const services = ctx.openArtisanServices
  const currentWorkflow = currentWorkflowSummary(state)
  const roadmap = createFallbackRoadmapService(ctx)
  return createProductManagementService({
    ...(roadmap ? { roadmap } : {}),
    ...(services?.workflow ? { workflow: services.workflow } : {}),
    ...(services?.humanGates ? { humanGates: services.humanGates } : {}),
    ...(services?.patchSuggestions ? { patchSuggestions: services.patchSuggestions } : {}),
    ...(services?.agentLeases ? { agentLeases: services.agentLeases } : {}),
    ...(currentWorkflow ? { currentWorkflow } : {}),
  })
}

export const handleProductManagementAssessRequest: ToolHandler = async (args, toolCtx, ctx) => {
  const parsed = parseToolArgs(ProductManagementAssessRequestToolSchema, args)
  if (!parsed.success) return invalidInput(parsed.error)
  const state = ctx.engine?.store.get(toolCtx.sessionId) ?? null
  const service = createService(ctx, state)
  const input: ProductManagementAssessRequestInput = { request: parsed.data.request }
  const roadmapItemIds = parsed.data.roadmap_item_ids ?? parsed.data.roadmapItemIds
  const featureName = parsed.data.feature_name ?? parsed.data.featureName
  const includeWorkflowCandidates = parsed.data.include_workflow_candidates ?? parsed.data.includeWorkflowCandidates
  if (roadmapItemIds !== undefined) input.roadmapItemIds = roadmapItemIds
  if (featureName !== undefined) input.featureName = featureName
  if (includeWorkflowCandidates !== undefined) input.includeWorkflowCandidates = includeWorkflowCandidates
  return stringifyValidatedResult(await service.assessRequest(input), ProductManagementAssessRequestResultSchema, "product_management_assess_request")
}

export const handleProductManagementListWork: ToolHandler = async (args, toolCtx, ctx) => {
  const parsed = parseToolArgs(ProductManagementListWorkToolSchema, args)
  if (!parsed.success) return invalidInput(parsed.error)
  const state = ctx.engine?.store.get(toolCtx.sessionId) ?? null
  const input: ProductManagementListWorkInput = {}
  const roadmapItemIds = parsed.data.roadmap_item_ids ?? parsed.data.roadmapItemIds
  const featureName = parsed.data.feature_name ?? parsed.data.featureName
  const minPriority = parsed.data.min_priority ?? parsed.data.minPriority
  const maxCandidates = parsed.data.max_candidates ?? parsed.data.maxCandidates
  if (roadmapItemIds !== undefined) input.roadmapItemIds = roadmapItemIds
  if (parsed.data.lifecycles !== undefined) input.lifecycles = parsed.data.lifecycles
  if (parsed.data.statuses !== undefined) input.statuses = parsed.data.statuses
  if (featureName !== undefined) input.featureName = featureName
  if (minPriority !== undefined) input.minPriority = minPriority
  if (maxCandidates !== undefined) input.maxCandidates = maxCandidates
  const service = createService(ctx, state)
  return stringifyValidatedResult(await service.listWork(input), ProductManagementListWorkResultSchema, "product_management_list_work")
}

function normalizeQueueItemSource(source: NonNullable<typeof ProductManagementQueueItemToolSchema._output.source>): NonNullable<ProductManagementQueueItemInput["source"]> {
  const normalized: NonNullable<ProductManagementQueueItemInput["source"]> = {}
  if (source.workflowId !== undefined) normalized.workflowId = source.workflowId
  if (source.featureName !== undefined) normalized.featureName = source.featureName
  if (source.sessionId !== undefined) normalized.sessionId = source.sessionId
  if (source.taskId !== undefined) normalized.taskId = source.taskId
  if (source.artifactKey !== undefined) normalized.artifactKey = source.artifactKey
  if (source.artifactPath !== undefined) normalized.artifactPath = source.artifactPath
  if (source.messageId !== undefined) normalized.messageId = source.messageId
  return normalized
}

function normalizeRequestContext(context: NonNullable<typeof ProductManagementQueueItemToolSchema._output.discovered_while>): NonNullable<ProductManagementQueueItemInput["discoveredWhile"]> {
  const normalized: NonNullable<ProductManagementQueueItemInput["discoveredWhile"]> = { request: context.request }
  if (context.currentFeatureName !== undefined) normalized.currentFeatureName = context.currentFeatureName
  if (context.currentPhase !== undefined) normalized.currentPhase = context.currentPhase
  if (context.currentPhaseState !== undefined) normalized.currentPhaseState = context.currentPhaseState
  if (context.currentMode !== undefined) normalized.currentMode = context.currentMode
  if (context.currentTaskId !== undefined) normalized.currentTaskId = context.currentTaskId
  if (context.roadmapItemIds !== undefined) normalized.roadmapItemIds = context.roadmapItemIds
  if (context.executionSliceId !== undefined) normalized.executionSliceId = context.executionSliceId
  return normalized
}

export const handleProductManagementQueueItem: ToolHandler = async (args, toolCtx, ctx) => {
  const parsed = parseToolArgs(ProductManagementQueueItemToolSchema, args)
  if (!parsed.success) return invalidInput(parsed.error)
  const state = ctx.engine?.store.get(toolCtx.sessionId) ?? null
  const input: ProductManagementQueueItemInput = {
    title: parsed.data.title,
    description: parsed.data.description,
    kind: parsed.data.kind,
  }
  const discoveredWhile = parsed.data.discovered_while ?? parsed.data.discoveredWhile
  const suggestedEdges = parsed.data.suggested_edges ?? parsed.data.suggestedEdges
  if (parsed.data.priority !== undefined) input.priority = parsed.data.priority
  if (parsed.data.source !== undefined) input.source = normalizeQueueItemSource(parsed.data.source)
  if (discoveredWhile !== undefined) input.discoveredWhile = normalizeRequestContext(discoveredWhile)
  if (suggestedEdges !== undefined) input.suggestedEdges = suggestedEdges
  const service = createService(ctx, state)
  return stringifyValidatedResult(await service.queueItem(input), ProductManagementQueueItemResultSchema, "product_management_queue_item")
}
