import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { Kysely } from "kysely"
import { PGliteDialect } from "kysely-pglite-dialect"

import { createSessionStateStore } from "#core/session-state"
import { createFileSystemStateBackend } from "#core/state-backend-fs"
import { createPGliteRoadmapRepository } from "#core/roadmap-repository-pglite"
import type { DatabaseOperationQueue } from "#core/open-artisan-db"
import type { RoadmapDocument, RoadmapPGliteRepositoryOptions, RoadmapRepository } from "#core/types"

const NOW = "2026-04-16T00:00:00.000Z"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-artisan-roadmap-pglite-repo-"))
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
        priority: 8,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-3",
        kind: "debt",
        title: "Keep roadmap persistence separate",
        status: "done",
        priority: 4,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    edges: [{ from: "item-1", to: "item-2", kind: "depends-on" }],
    ...overrides,
  }
}

function makeRepositoryOptions(stateDir: string): RoadmapPGliteRepositoryOptions {
  return {
    connection: {
      dataDir: join(stateDir, "roadmap", "pglite-db"),
      debugName: "roadmap-repository-test",
    },
    schemaName: "roadmap",
    lockTimeoutMs: 25,
    lockPollMs: 5,
  }
}

function makeRepository(stateDir: string): RoadmapRepository {
  return createPGliteRoadmapRepository(makeRepositoryOptions(stateDir))
}

describe("createPGliteRoadmapRepository", () => {
  it("records ordered schema migrations", async () => {
    const stateDir = await makeTempStateDir()
    const repository = makeRepository(stateDir)
    expect(await repository.initialize()).toEqual({ ok: true, value: null })

    const dbPath = join(makeRepositoryOptions(stateDir).connection.dataDir, "roadmap.pg")
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite(dbPath)) })
    const rows = await db.withSchema("roadmap").selectFrom("schema_migrations").select("version").orderBy("version").execute()
    await db.destroy()

    expect(rows.map((row: { version: number }) => row.version)).toEqual([1])
  })

  it("uses injectable operation queues and exposes explicit disposal", async () => {
    const stateDir = await makeTempStateDir()
    const scopes: string[] = []
    const queue: DatabaseOperationQueue = {
      run: async (scope, run) => {
        scopes.push(scope)
        return run()
      },
    }
    const repository = createPGliteRoadmapRepository({ ...makeRepositoryOptions(stateDir), operationQueue: queue })

    expect(await repository.initialize()).toEqual({ ok: true, value: null })
    await repository.dispose()

    expect(scopes).toContain(join(makeRepositoryOptions(stateDir).connection.dataDir, "roadmap.pg"))
  })

  it("serializes concurrent repository instances that share one PGlite database", async () => {
    const stateDir = await makeTempStateDir()
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const repository = makeRepository(stateDir)
      return repository.updateRoadmap(makeRoadmapDocument({
        items: [{ ...makeRoadmapDocument().items[0]!, id: `item-${index}`, title: `Item ${index}` }],
        edges: [],
      }))
    }))

    expect(results.every((result) => result.ok)).toBe(true)
    const read = await makeRepository(stateDir).readRoadmap()
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.value?.items).toHaveLength(1)
  })

  it("initializes durable roadmap storage and keeps workflow-state persistence separate", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const repository = makeRepository(stateDir)

    await workflowStore.create("session-1")
    await workflowStore.update("session-1", (draft) => {
      draft.featureName = "persistent-roadmap-dag"
    })

    expect(await repository.initialize()).toEqual({ ok: true, value: null })
    expect(await repository.readRoadmap()).toEqual({ ok: true, value: null })

    const roadmap = makeRoadmapDocument()
    expect(await repository.createRoadmap(roadmap)).toEqual({ ok: true, value: roadmap })
    expect(await repository.readRoadmap()).toEqual({ ok: true, value: roadmap })
    expect(await repository.queryRoadmapItems({ featureName: "persistent-roadmap-dag", minPriority: 9 })).toEqual({
      ok: true,
      value: [roadmap.items[0]!],
    })

    const workflowStatePath = join(stateDir, "persistent-roadmap-dag", "workflow-state.json")
    expect(JSON.parse(await readFile(workflowStatePath, "utf-8"))).toMatchObject({
      sessionId: "session-1",
      featureName: "persistent-roadmap-dag",
    })
    await expect(stat(makeRepositoryOptions(stateDir).connection.dataDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
  })

  it("supports typed query, update, and delete cycles without exposing direct bridge access", async () => {
    const stateDir = await makeTempStateDir()
    const repository = makeRepository(stateDir)
    const original = makeRoadmapDocument()

    await repository.initialize()
    await repository.createRoadmap(original)

    expect(await repository.queryRoadmapItems({ statuses: ["todo", "blocked"], minPriority: 8 })).toEqual({
      ok: true,
      value: [original.items[0]!, original.items[1]!],
    })

    const updated = makeRoadmapDocument({
      items: original.items.map((item) =>
        item.id === "item-1"
          ? { ...item, status: "in-progress", updatedAt: "2026-04-17T00:00:00.000Z" }
          : item,
      ),
    })
    expect(await repository.updateRoadmap(updated)).toEqual({ ok: true, value: updated })
    expect(await repository.queryRoadmapItems({ statuses: ["in-progress"] })).toEqual({
      ok: true,
      value: [updated.items[0]!],
    })

    expect(await repository.deleteRoadmap()).toEqual({ ok: true, value: null })
    expect(await repository.readRoadmap()).toEqual({ ok: true, value: null })
  })

  it("rejects invalid roadmap documents while workflow resume data remains readable", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const repository = makeRepository(stateDir)

    await workflowStore.create("session-2")
    await workflowStore.update("session-2", (draft) => {
      draft.featureName = "resume-target"
    })

    const invalid = makeRoadmapDocument({
      items: [makeRoadmapDocument().items[0]!, { ...makeRoadmapDocument().items[0]!, title: "Duplicate id" }],
      edges: [],
    })

    await repository.initialize()
    const createResult = await repository.createRoadmap(invalid)
    expect(createResult.ok).toBeFalse()
    if (!createResult.ok) {
      expect(createResult.error.code).toBe("invalid-document")
      expect(createResult.error.retryable).toBeFalse()
    }

    const resumed = await workflowStore.findPersistedByFeatureName("resume-target")
    expect(resumed).not.toBeNull()
    expect(resumed?.sessionId).toBe("session-2")
    expect(await repository.readRoadmap()).toEqual({ ok: true, value: null })
  })
})
