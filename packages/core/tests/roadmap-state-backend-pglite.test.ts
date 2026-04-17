import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPGliteRoadmapStateBackend } from "#core/roadmap-state-backend-pglite"
import { createSessionStateStore } from "#core/session-state"
import { createFileSystemStateBackend } from "#core/state-backend-fs"
import type { RoadmapDocument } from "#core/types"

const NOW = "2026-04-16T00:00:00.000Z"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-artisan-roadmap-pglite-backend-"))
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
        status: "done",
        priority: 6,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    edges: [{ from: "item-1", to: "item-2", kind: "depends-on" }],
    ...overrides,
  }
}

function makeBackend(stateDir: string, overrides: Record<string, unknown> = {}) {
  return createPGliteRoadmapStateBackend(stateDir, {
    connection: {
      dataDir: join(stateDir, "roadmap", "pglite-backend-db"),
      debugName: "roadmap-backend-test",
    },
    lockTimeoutMs: 25,
    lockPollMs: 5,
    ...overrides,
  })
}

describe("createPGliteRoadmapStateBackend", () => {
  it("persists roadmap state in PGlite without touching workflow-state persistence", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const roadmapBackend = makeBackend(stateDir)

    await workflowStore.create("session-1")
    await workflowStore.update("session-1", (draft) => {
      draft.featureName = "persistent-roadmap-dag"
    })

    const roadmap = makeRoadmapDocument()
    expect(await roadmapBackend.createRoadmap(roadmap)).toEqual({ ok: true, value: roadmap })
    expect(await roadmapBackend.readRoadmap()).toEqual({ ok: true, value: roadmap })

    const workflowStatePath = join(stateDir, "persistent-roadmap-dag", "workflow-state.json")
    expect(JSON.parse(await readFile(workflowStatePath, "utf-8"))).toMatchObject({
      sessionId: "session-1",
      featureName: "persistent-roadmap-dag",
    })
  })

  it("returns null when roadmap state is absent and allows repeated deletes", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = makeBackend(stateDir)

    expect(await roadmapBackend.readRoadmap()).toEqual({ ok: true, value: null })
    expect(await roadmapBackend.deleteRoadmap()).toEqual({ ok: true, value: null })
    expect(await roadmapBackend.deleteRoadmap()).toEqual({ ok: true, value: null })
  })

  it("rejects invalid updates and leaves workflow resume semantics intact", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const roadmapBackend = makeBackend(stateDir)

    await workflowStore.create("session-2")
    await workflowStore.update("session-2", (draft) => {
      draft.featureName = "resume-target"
    })

    const roadmap = makeRoadmapDocument()
    await roadmapBackend.createRoadmap(roadmap)

    const invalidUpdate = await roadmapBackend.updateRoadmap({
      ...roadmap,
      edges: [{ from: "item-1", to: "missing-item", kind: "depends-on" }],
    })
    expect(invalidUpdate.ok).toBeFalse()
    if (!invalidUpdate.ok) {
      expect(invalidUpdate.error.code).toBe("invalid-document")
      expect(invalidUpdate.error.retryable).toBeFalse()
    }

    const resumed = await workflowStore.findPersistedByFeatureName("resume-target")
    expect(resumed?.sessionId).toBe("session-2")
    expect(await roadmapBackend.readRoadmap()).toEqual({ ok: true, value: roadmap })
  })

  it("uses a roadmap-specific lock and reports timeout errors as retryable", async () => {
    const stateDir = await makeTempStateDir()
    const holderBackend = makeBackend(stateDir)
    const contenderBackend = makeBackend(stateDir)

    const heldLock = await holderBackend.lockRoadmap()
    expect(heldLock.ok).toBeTrue()
    if (!heldLock.ok) {
      throw new Error("expected initial roadmap lock acquisition to succeed")
    }

    const contended = await contenderBackend.lockRoadmap()
    expect(contended.ok).toBeFalse()
    if (!contended.ok) {
      expect(contended.error.code).toBe("lock-timeout")
      expect(contended.error.retryable).toBeTrue()
    }

    await heldLock.value.release()

    const retry = await contenderBackend.lockRoadmap()
    expect(retry.ok).toBeTrue()
    if (retry.ok) {
      await retry.value.release()
    }
  })
})
