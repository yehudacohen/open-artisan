/**
 * roadmap-slice-service.ts — Minimal roadmap query/derive behavior for the first roadmap slice.
 *
 * Reads durable roadmap state through the standalone RoadmapStateBackend and exposes
 * additive query/derive operations without mutating workflow execution state.
 */

import type {
  DerivedExecutionSlice,
  RoadmapDocument,
  RoadmapEdge,
  RoadmapItem,
  RoadmapQuery,
  RoadmapResult,
  RoadmapSliceService,
  RoadmapStateBackend,
} from "./types"

function roadmapOk<T>(value: T): RoadmapResult<T> {
  return { ok: true, value }
}

function roadmapError(
  message: string,
  details?: { itemId?: string },
): RoadmapResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid-slice",
      message,
      retryable: false,
      ...(details ? { details } : {}),
    },
  }
}

function matchesQuery(item: RoadmapItem, query: RoadmapQuery): boolean {
  if (query.itemIds && !query.itemIds.includes(item.id)) return false
  if (query.kinds && !query.kinds.includes(item.kind)) return false
  if (query.statuses && !query.statuses.includes(item.status)) return false
  if (query.featureName !== undefined && item.featureName !== query.featureName) return false
  if (query.minPriority !== undefined && item.priority < query.minPriority) return false
  return true
}

function deriveSlice(
  document: RoadmapDocument,
  roadmapItemIds: string[],
  featureName?: string,
): RoadmapResult<DerivedExecutionSlice> {
  if (roadmapItemIds.length === 0) {
    return roadmapError("deriveExecutionSlice requires at least one roadmap item id")
  }

  const itemsById = new Map(document.items.map((item) => [item.id, item]))
  const roadmapItems: RoadmapItem[] = []

  for (const itemId of roadmapItemIds) {
    const item = itemsById.get(itemId)
    if (!item) {
      return roadmapError(`Unknown roadmap item id: ${itemId}`, { itemId })
    }
    roadmapItems.push(item)
  }

  const selectedIds = new Set(roadmapItemIds)
  const edges: RoadmapEdge[] = document.edges.filter(
    (edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to),
  )

  return roadmapOk({
    roadmapItemIds: [...roadmapItemIds],
    roadmapItems,
    edges,
    ...(featureName !== undefined ? { featureName } : {}),
  })
}

async function loadRoadmapDocument(
  roadmapBackend: RoadmapStateBackend,
): Promise<RoadmapResult<RoadmapDocument>> {
  const result = await roadmapBackend.readRoadmap()
  if (!result.ok) return result
  if (result.value === null) {
    return {
      ok: false,
      error: {
        code: "not-found",
        message: "No roadmap document exists",
        retryable: false,
      },
    }
  }
  return roadmapOk(result.value)
}

export function createRoadmapSliceService(roadmapBackend: RoadmapStateBackend): RoadmapSliceService {
  return {
    async queryRoadmap(query: RoadmapQuery): Promise<RoadmapResult<RoadmapItem[]>> {
      const document = await loadRoadmapDocument(roadmapBackend)
      if (!document.ok) return document
      return roadmapOk(document.value.items.filter((item) => matchesQuery(item, query)))
    },

    async deriveExecutionSlice(input: {
      roadmapItemIds: string[]
      featureName?: string
    }): Promise<RoadmapResult<DerivedExecutionSlice>> {
      const document = await loadRoadmapDocument(roadmapBackend)
      if (!document.ok) return document
      return deriveSlice(document.value, input.roadmapItemIds, input.featureName)
    },
  }
}
