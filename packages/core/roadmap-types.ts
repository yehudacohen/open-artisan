/**
 * roadmap-types.ts — Roadmap domain contracts and validation helpers.
 */

import type { PGliteAccessQueue } from "./pglite-access-queue"

export type RoadmapItemKind = "feature" | "bug" | "debt" | "chore"

export type RoadmapItemStatus =
  | "todo"
  | "in-progress"
  | "blocked"
  | "done"
  | "dropped"

export type RoadmapEdgeKind = "depends-on"

export type RoadmapErrorCode =
  | "not-found"
  | "invalid-document"
  | "invalid-slice"
  | "schema-mismatch"
  | "lock-timeout"
  | "storage-failure"

export interface RoadmapError {
  code: RoadmapErrorCode
  message: string
  retryable: boolean
  details?: {
    itemId?: string
    edge?: { from: string; to: string }
    schemaVersion?: number
  }
}

export type RoadmapResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RoadmapError }

export function roadmapOk<T>(value: T): RoadmapResult<T> {
  return { ok: true, value }
}

export function roadmapError(
  code: RoadmapErrorCode,
  message: string,
  retryable: boolean,
  details?: RoadmapError["details"],
): RoadmapResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
  }
}

/**
 * A single roadmap node tracked by the standalone roadmap store.
 * featureName is optional because not every roadmap item maps 1:1 to a workflow feature.
 */
export interface RoadmapItem {
  id: string
  kind: RoadmapItemKind
  title: string
  description?: string
  status: RoadmapItemStatus
  priority: number
  featureName?: string
  createdAt: string
  updatedAt: string
}

/**
 * A typed dependency edge between two roadmap items.
 */
export interface RoadmapEdge {
  from: string
  to: string
  kind: RoadmapEdgeKind
}

/**
 * Full roadmap document persisted by filesystem or PGlite backends.
 */
export interface RoadmapDocument {
  schemaVersion: number
  items: RoadmapItem[]
  edges: RoadmapEdge[]
}

export type RoadmapPersistenceKind = "filesystem" | "pglite"

export interface RoadmapPGliteConnectionOptions {
  dataDir: string
  databaseFileName?: string
  debugName?: string
}

export interface RoadmapPGliteRepositoryOptions {
  connection: RoadmapPGliteConnectionOptions
  schemaName?: string
  lockTimeoutMs?: number
  lockPollMs?: number
  accessQueue?: PGliteAccessQueue
}

/**
 * Typed roadmap persistence/query boundary for Postgres-friendly adapters.
 * Bridge-owned services compose this repository rather than exposing it directly to callers.
 */
export interface RoadmapRepository {
  initialize(): Promise<RoadmapResult<null>>
  dispose(): Promise<void>
  createRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  readRoadmap(): Promise<RoadmapResult<RoadmapDocument | null>>
  updateRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  deleteRoadmap(): Promise<RoadmapResult<null>>
  queryRoadmapItems(query: RoadmapQuery): Promise<RoadmapResult<RoadmapItem[]>>
}

/**
 * Bridge-owned assembly input for roadmap services/backends.
 * Keeps roadmap backend selection/configuration separate from WorkflowState persistence.
 */
export interface RoadmapServiceFactoryOptions {
  stateDir: string
  persistence: {
    kind: RoadmapPersistenceKind
    pglite?: RoadmapPGliteRepositoryOptions
  }
}

/**
 * Standalone roadmap persistence. Separate from WorkflowState persistence.
 * Implementations must not store roadmap state in per-feature workflow-state files.
 */
export interface RoadmapStateBackend {
  dispose?(): Promise<void>
  createRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  readRoadmap(): Promise<RoadmapResult<RoadmapDocument | null>>
  updateRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  deleteRoadmap(): Promise<RoadmapResult<null>>
  lockRoadmap(): Promise<RoadmapResult<{ release(): Promise<void> }>>
}

export interface RoadmapQuery {
  itemIds?: string[]
  kinds?: RoadmapItemKind[]
  statuses?: RoadmapItemStatus[]
  featureName?: string
  minPriority?: number
}

export function matchesRoadmapQuery(item: RoadmapItem, query: RoadmapQuery): boolean {
  if (query.itemIds && !query.itemIds.includes(item.id)) return false
  if (query.kinds && !query.kinds.includes(item.kind)) return false
  if (query.statuses && !query.statuses.includes(item.status)) return false
  if (query.featureName !== undefined && item.featureName !== query.featureName) return false
  if (query.minPriority !== undefined && item.priority < query.minPriority) return false
  return true
}

export interface DerivedExecutionSlice {
  roadmapItemIds: string[]
  roadmapItems: RoadmapItem[]
  edges: RoadmapEdge[]
  featureName?: string
}

export interface RoadmapSliceService {
  queryRoadmap(query: RoadmapQuery): Promise<RoadmapResult<RoadmapItem[]>>
  deriveExecutionSlice(input: {
    roadmapItemIds: string[]
    featureName?: string
  }): Promise<RoadmapResult<DerivedExecutionSlice>>
}

export interface WorkflowRoadmapLink {
  featureName: string
  roadmapItemIds: string[]
}

/**
 * Validates that a RoadmapDocument is internally consistent.
 * Returns null if valid, or an error message describing the first violation found.
 */
export function validateRoadmapDocument(document: RoadmapDocument): string | null {
  if (!Number.isInteger(document.schemaVersion) || document.schemaVersion < 1) {
    return `RoadmapDocument.schemaVersion must be a positive integer, got ${document.schemaVersion}`
  }
  if (!Array.isArray(document.items)) {
    return `RoadmapDocument.items must be an array, got ${typeof document.items}`
  }
  if (!Array.isArray(document.edges)) {
    return `RoadmapDocument.edges must be an array, got ${typeof document.edges}`
  }

  const validKinds: RoadmapItemKind[] = ["feature", "bug", "debt", "chore"]
  const validStatuses: RoadmapItemStatus[] = ["todo", "in-progress", "blocked", "done", "dropped"]
  const itemIds = new Set<string>()

  for (let i = 0; i < document.items.length; i++) {
    const item = document.items[i]
    if (!item || typeof item !== "object") {
      return `RoadmapDocument.items[${i}] must be an object`
    }
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      return `RoadmapDocument.items[${i}].id must be a non-empty string`
    }
    if (itemIds.has(item.id)) {
      return `Duplicate RoadmapItem.id "${item.id}"`
    }
    itemIds.add(item.id)
    if (!validKinds.includes(item.kind)) {
      return `RoadmapDocument.items[${i}].kind must be one of ${validKinds.join(", ")}, got "${item.kind}"`
    }
    if (typeof item.title !== "string" || item.title.trim().length === 0) {
      return `RoadmapDocument.items[${i}].title must be a non-empty string`
    }
    if (item.description !== undefined && typeof item.description !== "string") {
      return `RoadmapDocument.items[${i}].description must be a string when provided`
    }
    if (!validStatuses.includes(item.status)) {
      return `RoadmapDocument.items[${i}].status must be one of ${validStatuses.join(", ")}, got "${item.status}"`
    }
    if (typeof item.priority !== "number" || !Number.isFinite(item.priority)) {
      return `RoadmapDocument.items[${i}].priority must be a finite number`
    }
    if (item.featureName !== undefined && (typeof item.featureName !== "string" || item.featureName.trim().length === 0)) {
      return `RoadmapDocument.items[${i}].featureName must be a non-empty string when provided`
    }
    if (typeof item.createdAt !== "string" || item.createdAt.length === 0) {
      return `RoadmapDocument.items[${i}].createdAt must be a non-empty string`
    }
    if (typeof item.updatedAt !== "string" || item.updatedAt.length === 0) {
      return `RoadmapDocument.items[${i}].updatedAt must be a non-empty string`
    }
  }

  const seenEdges = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const itemId of Array.from(itemIds)) {
    adjacency.set(itemId, [])
  }

  for (let i = 0; i < document.edges.length; i++) {
    const edge = document.edges[i]
    if (!edge || typeof edge !== "object") {
      return `RoadmapDocument.edges[${i}] must be an object`
    }
    if (typeof edge.from !== "string" || edge.from.trim().length === 0) {
      return `RoadmapDocument.edges[${i}].from must be a non-empty string`
    }
    if (typeof edge.to !== "string" || edge.to.trim().length === 0) {
      return `RoadmapDocument.edges[${i}].to must be a non-empty string`
    }
    if (edge.kind !== "depends-on") {
      return `RoadmapDocument.edges[${i}].kind must be "depends-on", got "${edge.kind}"`
    }
    if (!itemIds.has(edge.from)) {
      return `RoadmapDocument.edges[${i}].from references missing item "${edge.from}"`
    }
    if (!itemIds.has(edge.to)) {
      return `RoadmapDocument.edges[${i}].to references missing item "${edge.to}"`
    }
    if (edge.from === edge.to) {
      return `RoadmapDocument.edges[${i}] must not self-reference "${edge.from}"`
    }
    const edgeKey = `${edge.from}->${edge.to}:${edge.kind}`
    if (seenEdges.has(edgeKey)) {
      return `Duplicate RoadmapEdge "${edgeKey}"`
    }
    seenEdges.add(edgeKey)
    adjacency.get(edge.from)?.push(edge.to)
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const stack: string[] = []

  const findCycle = (node: string): string[] | null => {
    visiting.add(node)
    stack.push(node)

    for (const next of adjacency.get(node) ?? []) {
      if (visiting.has(next)) {
        const cycleStart = stack.indexOf(next)
        return [...stack.slice(cycleStart), next]
      }
      if (visited.has(next)) {
        continue
      }
      const cycle = findCycle(next)
      if (cycle) {
        return cycle
      }
    }

    stack.pop()
    visiting.delete(node)
    visited.add(node)
    return null
  }

  for (const itemId of Array.from(itemIds)) {
    if (visited.has(itemId)) {
      continue
    }
    const cycle = findCycle(itemId)
    if (cycle) {
      return `RoadmapDocument.edges must form a DAG; found cycle "${cycle.join("->")}"`
    }
  }

  return null
}
