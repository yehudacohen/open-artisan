import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createSessionStateStore } from "#core/session-state"
import {
  createFileSystemRoadmapStateBackend,
  createFileSystemStateBackend,
} from "#core/state-backend-fs"
import type { RoadmapDocument } from "#core/roadmap-types"

const NOW = "2026-04-16T00:00:00.000Z"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-artisan-roadmap-"))
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
        priority: 7,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    edges: [{ from: "item-1", to: "item-2", kind: "depends-on" }],
    ...overrides,
  }
}

describe("createFileSystemRoadmapStateBackend", () => {
  it("persists roadmap state in the roadmap namespace without touching workflow-state files", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    const workflow = await workflowStore.create("session-1")
    expect(workflow.featureName).toBeNull()

    await workflowStore.update("session-1", (draft) => {
      draft.featureName = "persistent-roadmap-dag"
    })

    const roadmap = makeRoadmapDocument()
    const createResult = await roadmapBackend.createRoadmap(roadmap)
    expect(createResult).toEqual({ ok: true, value: roadmap })

    const workflowStatePath = join(stateDir, "persistent-roadmap-dag", "workflow-state.json")
    const roadmapStatePath = join(stateDir, "roadmap", "roadmap-state.json")
    const roadmapLockPath = join(stateDir, "roadmap", ".lock")

    expect(JSON.parse(await readFile(workflowStatePath, "utf-8"))).toMatchObject({
      sessionId: "session-1",
      featureName: "persistent-roadmap-dag",
    })
    expect(JSON.parse(await readFile(roadmapStatePath, "utf-8"))).toEqual(roadmap)
    await expect(stat(roadmapLockPath)).rejects.toThrow()

    const readResult = await roadmapBackend.readRoadmap()
    expect(readResult).toEqual({ ok: true, value: roadmap })
  })

  it("returns null when roadmap state is absent", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)

    expect(await roadmapBackend.readRoadmap()).toEqual({ ok: true, value: null })
  })

  it("returns schema-mismatch for unsupported roadmap schema versions without breaking workflow resume", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)

    await workflowStore.create("session-2")
    await workflowStore.update("session-2", (draft) => {
      draft.featureName = "resume-target"
    })

    await mkdir(join(stateDir, "roadmap"), { recursive: true })
    await Bun.write(
      join(stateDir, "roadmap", "roadmap-state.json"),
      JSON.stringify({ ...makeRoadmapDocument(), schemaVersion: 999 }, null, 2),
    )

    const readResult = await roadmapBackend.readRoadmap()
    expect(readResult.ok).toBeFalse()
    if (!readResult.ok) {
      expect(readResult.error.code).toBe("schema-mismatch")
      expect(readResult.error.retryable).toBeFalse()
      expect(readResult.error.details).toEqual({ schemaVersion: 999 })
    }

    const resumed = await workflowStore.findPersistedByFeatureName("resume-target")
    expect(resumed).not.toBeNull()
    expect(resumed?.sessionId).toBe("session-2")
  })

  it("returns structured invalid-document errors for corrupt roadmap content while workflow resume still works", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)

    await workflowStore.create("session-3")
    await workflowStore.update("session-3", (draft) => {
      draft.featureName = "resume-target"
    })

    await mkdir(join(stateDir, "roadmap"), { recursive: true })
    await Bun.write(join(stateDir, "roadmap", "roadmap-state.json"), "{not-json")

    const readResult = await roadmapBackend.readRoadmap()
    expect(readResult.ok).toBeFalse()
    if (!readResult.ok) {
      expect(readResult.error.code).toBe("invalid-document")
      expect(readResult.error.retryable).toBeFalse()
    }

    const resumed = await workflowStore.findPersistedByFeatureName("resume-target")
    expect(resumed).not.toBeNull()
    expect(resumed?.sessionId).toBe("session-3")
  })

  it("updates valid roadmap state, rejects invalid updates, and keeps workflow persistence intact", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))

    await workflowStore.create("session-4")
    await workflowStore.update("session-4", (draft) => {
      draft.featureName = "existing-feature"
    })

    const original = makeRoadmapDocument()
    await roadmapBackend.createRoadmap(original)

    const updated = makeRoadmapDocument({
      items: original.items.map((item) =>
        item.id === "item-1"
          ? { ...item, status: "in-progress", updatedAt: "2026-04-17T00:00:00.000Z" }
          : item,
      ),
    })

    const updateResult = await roadmapBackend.updateRoadmap(updated)
    expect(updateResult).toEqual({ ok: true, value: updated })
    expect(await roadmapBackend.readRoadmap()).toEqual({ ok: true, value: updated })

    const invalidUpdate = await roadmapBackend.updateRoadmap({
      ...updated,
      edges: [{ from: "item-1", to: "missing-item", kind: "depends-on" }],
    })
    expect(invalidUpdate.ok).toBeFalse()
    if (!invalidUpdate.ok) {
      expect(invalidUpdate.error.code).toBe("invalid-document")
      expect(invalidUpdate.error.retryable).toBeFalse()
    }

    const workflowStatePath = join(stateDir, "existing-feature", "workflow-state.json")
    expect(JSON.parse(await readFile(workflowStatePath, "utf-8"))).toMatchObject({
      sessionId: "session-4",
      featureName: "existing-feature",
    })
  })

  it("deletes roadmap state without affecting workflow state, including repeated deletes when the roadmap is absent", async () => {
    const stateDir = await makeTempStateDir()
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir)
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))

    await workflowStore.create("session-5")
    await workflowStore.update("session-5", (draft) => {
      draft.featureName = "existing-feature"
    })

    const original = makeRoadmapDocument()
    await roadmapBackend.createRoadmap(original)

    const deleteResult = await roadmapBackend.deleteRoadmap()
    expect(deleteResult).toEqual({ ok: true, value: null })
    expect(await roadmapBackend.readRoadmap()).toEqual({ ok: true, value: null })
    expect(await roadmapBackend.deleteRoadmap()).toEqual({ ok: true, value: null })

    const workflowStatePath = join(stateDir, "existing-feature", "workflow-state.json")
    expect(JSON.parse(await readFile(workflowStatePath, "utf-8"))).toMatchObject({
      sessionId: "session-5",
      featureName: "existing-feature",
    })
  })

  it("uses a distinct roadmap lock and reports lock timeouts as structured errors without mutating workflow state", async () => {
    const stateDir = await makeTempStateDir()
    const workflowStore = createSessionStateStore(createFileSystemStateBackend(stateDir))
    const roadmapBackend = createFileSystemRoadmapStateBackend(stateDir, { lockTimeoutMs: 25, lockPollMs: 5 })
    const holderBackend = createFileSystemRoadmapStateBackend(stateDir, { lockTimeoutMs: 25, lockPollMs: 5 })

    await workflowStore.create("session-6")
    await workflowStore.update("session-6", (draft) => {
      draft.featureName = "lock-target"
    })

    const heldLock = await holderBackend.lockRoadmap()
    expect(heldLock.ok).toBeTrue()
    if (!heldLock.ok) {
      throw new Error("expected roadmap lock acquisition to succeed")
    }

    const timeout = await roadmapBackend.lockRoadmap()
    expect(timeout.ok).toBeFalse()
    if (!timeout.ok) {
      expect(timeout.error.code).toBe("lock-timeout")
      expect(timeout.error.retryable).toBeTrue()
    }

    const resumed = await workflowStore.findPersistedByFeatureName("lock-target")
    expect(resumed?.sessionId).toBe("session-6")

    await heldLock.value.release()

    const retry = await roadmapBackend.lockRoadmap()
    expect(retry.ok).toBeTrue()
    if (retry.ok) {
      await retry.value.release()
    }
  })

  it("returns structured storage failures when the roadmap namespace cannot be created", async () => {
    const stateRoot = await makeTempStateDir()
    const blockedStateDir = join(stateRoot, "blocked-state-root")
    await Bun.write(blockedStateDir, "not-a-directory")

    const roadmapBackend = createFileSystemRoadmapStateBackend(blockedStateDir)
    const document = makeRoadmapDocument()

    const createResult = await roadmapBackend.createRoadmap(document)
    expect(createResult.ok).toBeFalse()
    if (!createResult.ok) {
      expect(createResult.error.code).toBe("storage-failure")
    }

    const updateResult = await roadmapBackend.updateRoadmap(document)
    expect(updateResult.ok).toBeFalse()
    if (!updateResult.ok) {
      expect(updateResult.error.code).toBe("storage-failure")
    }

    const deleteResult = await roadmapBackend.deleteRoadmap()
    expect(deleteResult.ok).toBeFalse()
    if (!deleteResult.ok) {
      expect(deleteResult.error.code).toBe("storage-failure")
    }
  })
})
