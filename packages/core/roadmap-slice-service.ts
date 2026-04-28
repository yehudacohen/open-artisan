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
  RoadmapRepository,
  RoadmapResult,
  RoadmapSliceService,
  RoadmapStateBackend,
} from "./types"
import { roadmapError, roadmapOk } from "./types"

type RoadmapQuerySource = Pick<RoadmapRepository, "queryRoadmapItems">

function deriveSlice(
  document: RoadmapDocument,
  roadmapItemIds: string[],
  featureName?: string,
): RoadmapResult<DerivedExecutionSlice> {
  if (roadmapItemIds.length === 0) {
    return roadmapError("invalid-slice", "deriveExecutionSlice requires at least one roadmap item id", false)
  }

  const itemsById = new Map(document.items.map((item) => [item.id, item]))
  const roadmapItems: RoadmapItem[] = []

  for (const itemId of roadmapItemIds) {
    const item = itemsById.get(itemId)
    if (!item) {
      return roadmapError("invalid-slice", `Unknown roadmap item id: ${itemId}`, false, { itemId })
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
    return roadmapError("not-found", "No roadmap document exists", false)
  }
  return roadmapOk(result.value)
}

export function createRoadmapSliceService(
  roadmapBackend: RoadmapStateBackend,
  roadmapQuerySource: RoadmapQuerySource,
): RoadmapSliceService {
  return {
    async queryRoadmap(query: RoadmapQuery): Promise<RoadmapResult<RoadmapItem[]>> {
      return roadmapQuerySource.queryRoadmapItems(query)
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
