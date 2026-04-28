import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createSessionStateStore } from "#core/session-state"
import {
  createFileSystemRoadmapStateBackend,
  createFileSystemStateBackend,
} from "#core/state-backend-fs"
import { matchesRoadmapQuery, roadmapOk, type RoadmapDocument, type RoadmapSliceService } from "#core/types"

const NOW = "2026-04-16T00:00:00.000Z"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-artisan-roadmap-slice-"))
  tempDirs.push(dir)
  return dir
}

function makeRoadmapDocument(overrides: Partial<RoadmapDocument> = {}): RoadmapDocument {
  return {
    schemaVersion: 1,
    items: [
      {
        id: "item-1",
        kind: "feature",
        title: "Persistent roadmap DAG",
        status: "todo",
        priority: 10,
        featureName: "persistent-roadmap-dag",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-2",
        kind: "bug",
        title: "Protect workflow resume semantics",
        status: "blocked",
        priority: 9,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-3",
        kind: "debt",
        title: "Separate roadmap namespace",
        status: "todo",
        priority: 5,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-4",
        kind: "chore",
        title: "Document the bridge hook",
        status: "done",
        priority: 2,
        featureName: "docs-anchor",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    edges: [
      { from: "item-1", to: "item-2", kind: "depends-on" },
      { from: "item-2", to: "item-3", kind: "depends-on" },
      { from: "item-3", to: "item-4", kind: "depends-on" },
    ],
    ...overrides,
  }
}

async function loadRoadmapSliceService(stateDir: string): Promise<RoadmapSliceService> {
  const module = await import("#core/roadmap-slice-service") as {
    createRoadmapSliceService(
      roadmapBackend: ReturnType<typeof createFileSystemRoadmapStateBackend>,
      roadmapQuerySource: {
        queryRoadmapItems(query: Parameters<RoadmapSliceService["queryRoadmap"]>[0]): ReturnType<RoadmapSliceService["queryRoadmap"]>
      },
    ): RoadmapSliceService
  }
  const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
  return module.createRoadmapSliceService(roadmapBackend, {
    async queryRoadmapItems(query) {
      const document = await roadmapBackend.readRoadmap()
      if (!document.ok) return document
      if (document.value === null) return roadmapOk([])
      return roadmapOk(document.value.items.filter((item) => matchesRoadmapQuery(item, query)))
    },
  })
}

describe("roadmap slice service contracts", () => {
  it("queries roadmap items by ids, kinds, statuses, featureName, and minPriority, and returns all items for an empty query", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    const roadmap = makeRoadmapDocument()
    await roadmapBackend.createRoadmap(roadmap)

    const service = await loadRoadmapSliceService(stateDir)

    const filtered = await service.queryRoadmap({
      itemIds: ["item-1", "item-2", "item-4"],
      kinds: ["feature", "bug", "chore"],
      statuses: ["todo", "blocked"],
      featureName: "persistent-roadmap-dag",
      minPriority: 9,
    })
    expect(filtered).toEqual({ ok: true, value: [roadmap.items[0]!] })

    const allItems = await service.queryRoadmap({})
    expect(allItems).toEqual({ ok: true, value: roadmap.items })
  })

  it("returns empty results for unknown item ids or unmatched queries", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    const service = await loadRoadmapSliceService(stateDir)

    expect(await service.queryRoadmap({ itemIds: ["missing-item"] })).toEqual({ ok: true, value: [] })
    expect(await service.queryRoadmap({ featureName: "no-match", minPriority: 100 })).toEqual({ ok: true, value: [] })
  })

  it("returns structured roadmap errors when querying corrupt roadmap state", async () => {
    const stateDir = await makeTempStateDir()
    await mkdir(join(stateDir, "roadmap"), { recursive: true })
    await Bun.write(join(stateDir, "roadmap", "roadmap-state.json"), "{not-json")

    const service = await loadRoadmapSliceService(stateDir)
    const result = await service.queryRoadmap({})

    expect(result.ok).toBeFalse()
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-document")
      expect(result.error.retryable).toBeFalse()
    }
  })

  it("derives a dependency-preserving execution slice whose ids exactly match the selected roadmap items", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    const roadmap = makeRoadmapDocument()
    await roadmapBackend.createRoadmap(roadmap)

    const service = await loadRoadmapSliceService(stateDir)
    const result = await service.deriveExecutionSlice({
      roadmapItemIds: ["item-1", "item-2", "item-3"],
      featureName: "persistent-roadmap-dag",
    })

    expect(result.ok).toBeTrue()
    if (result.ok) {
      expect(result.value.roadmapItemIds).toEqual(["item-1", "item-2", "item-3"])
      expect(result.value.roadmapItems.map((item) => item.id)).toEqual(result.value.roadmapItemIds)
      expect(result.value.edges).toEqual([
        { from: "item-1", to: "item-2", kind: "depends-on" },
        { from: "item-2", to: "item-3", kind: "depends-on" },
      ])
      expect(result.value.featureName).toBe("persistent-roadmap-dag")
    }
  })

  it("rejects empty or unknown roadmap selections with invalid-slice", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    const service = await loadRoadmapSliceService(stateDir)

    const emptySlice = await service.deriveExecutionSlice({ roadmapItemIds: [] })
    expect(emptySlice.ok).toBeFalse()
    if (!emptySlice.ok) {
      expect(emptySlice.error.code).toBe("invalid-slice")
      expect(emptySlice.error.retryable).toBeFalse()
    }

    const unknownSlice = await service.deriveExecutionSlice({ roadmapItemIds: ["missing-item"] })
    expect(unknownSlice.ok).toBeFalse()
    if (!unknownSlice.ok) {
      expect(unknownSlice.error.code).toBe("invalid-slice")
      expect(unknownSlice.error.details).toEqual({ itemId: "missing-item" })
    }
  })

  it("leaves workflow execution state unchanged when derivation fails", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    await workflowStore.create("session-derive")
    await workflowStore.update("session-derive", (draft) => {
      draft.featureName = "existing-feature"
    })

    const before = JSON.parse(await readFile(join(stateDir, "existing-feature", "workflow-state.json"), "utf-8"))
    const service = await loadRoadmapSliceService(stateDir)
    const result = await service.deriveExecutionSlice({
      roadmapItemIds: ["item-1", "missing-item"],
      featureName: "persistent-roadmap-dag",
    })

    expect(result.ok).toBeFalse()
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-slice")
    }

    const after = JSON.parse(await readFile(join(stateDir, "existing-feature", "workflow-state.json"), "utf-8"))
    expect(after).toEqual(before)
  })
})
