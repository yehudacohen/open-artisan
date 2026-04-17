import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { handleInit, handleSessionCreated } from "#bridge/methods/lifecycle"
import { handleToolExecute } from "#bridge/methods/tool-execute"
import type { BridgeContext } from "#bridge/server"
import type { EngineContext } from "#core/engine-context"
import { createPGliteRoadmapStateBackend } from "#core/roadmap-state-backend-pglite"
import type { RoadmapDocument } from "#core/types"

const NOW = "2026-04-16T00:00:00.000Z"

let tmpDir: string
let ctx: BridgeContext

function makeBridgeContext(): BridgeContext {
  let engine: EngineContext | null = null
  let policyVersion = 0
  return {
    get engine() { return engine },
    get policyVersion() { return policyVersion },
    bumpPolicyVersion() { policyVersion++ },
    setEngine(e: EngineContext) { engine = e },
    stateDir: null,
    projectDir: null,
    capabilities: { selfReview: "agent-only", orchestrator: false, discoveryFleet: false },
    pinoLogger: null,
    shuttingDown: false,
  }
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
    ],
    edges: [{ from: "item-1", to: "item-2", kind: "depends-on" }],
    ...overrides,
  }
}

function createBridgeRoadmapBackend(stateDir: string) {
  return createPGliteRoadmapStateBackend(stateDir, {
    connection: {
      dataDir: join(stateDir, "roadmap", "bridge-pglite-db"),
      debugName: "bridge-roadmap-test",
    },
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-roadmap-"))
  ctx = makeBridgeContext()
  await handleInit({ projectDir: tmpDir }, ctx)
  await handleSessionCreated({ sessionId: "s1", agent: "hermes" }, ctx)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("bridge roadmap tool execution", () => {
  it("reads roadmap state through tool.execute using roadmap-specific result shapes", async () => {
    const roadmapBackend = createBridgeRoadmapBackend(ctx.stateDir!)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    const response = await handleToolExecute({
      name: "roadmap_read",
      args: {},
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    expect(JSON.parse(response as string)).toEqual({
      ok: true,
      value: makeRoadmapDocument(),
    })
  })

  it("reads roadmap state from the bridge state directory instead of the request working directory", async () => {
    const roadmapBackend = createBridgeRoadmapBackend(ctx.stateDir!)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    const unrelatedDir = join(tmpDir, "nested", "workspace")
    await mkdir(unrelatedDir, { recursive: true })

    const response = await handleToolExecute({
      name: "roadmap_read",
      args: {},
      context: { sessionId: "s1", directory: unrelatedDir },
    }, ctx)

    expect(JSON.parse(response as string)).toEqual({
      ok: true,
      value: makeRoadmapDocument(),
    })
  })

  it("queries roadmap state through tool.execute and returns roadmap-specific collections", async () => {
    const roadmapBackend = createBridgeRoadmapBackend(ctx.stateDir!)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    const response = await handleToolExecute({
      name: "roadmap_query",
      args: { query: { itemIds: ["item-1"], minPriority: 9 } },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    expect(JSON.parse(response as string)).toEqual({
      ok: true,
      value: [makeRoadmapDocument().items[0]],
    })
  })

  it("derives an execution slice through tool.execute without bypassing the existing execution DAG path", async () => {
    const roadmapBackend = createBridgeRoadmapBackend(ctx.stateDir!)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    await ctx.engine!.store.update("s1", (draft) => {
      draft.mode = "INCREMENTAL"
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.currentTaskId = "T1"
      draft.implDag = [
        {
          id: "T1",
          description: "Existing execution task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "in-flight",
        },
      ]
    })

    const before = JSON.parse(JSON.stringify(ctx.engine!.store.get("s1")))
    const response = await handleToolExecute({
      name: "roadmap_derive_execution_slice",
      args: { roadmap_item_ids: ["item-1", "item-2"], feature_name: "persistent-roadmap-dag" },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    expect(JSON.parse(response as string)).toEqual({
      ok: true,
      value: {
        roadmapItemIds: ["item-1", "item-2"],
        roadmapItems: makeRoadmapDocument().items,
        edges: makeRoadmapDocument().edges,
        featureName: "persistent-roadmap-dag",
      },
    })

    const after = ctx.engine!.store.get("s1")
    expect(after?.currentTaskId).toBe(before?.currentTaskId)
    expect(after?.implDag).toEqual(before?.implDag)
  })

  it("requires a bridge-owned stateDir for roadmap tool execution", async () => {
    await ctx.engine!.store.update("s1", (draft) => {
      draft.mode = "INCREMENTAL"
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.currentTaskId = "T1"
      draft.implDag = [
        {
          id: "T1",
          description: "Existing execution task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "in-flight",
        },
      ]
    })

    const before = JSON.parse(JSON.stringify(ctx.engine!.store.get("s1")))
    const originalStateDir = ctx.stateDir
    ctx.stateDir = null

    try {
      const response = await handleToolExecute({
        name: "roadmap_read",
        args: {},
        context: { sessionId: "s1", directory: tmpDir },
      }, ctx)
      expect(JSON.parse(response as string)).toEqual({
        ok: false,
        error: {
          code: "storage-failure",
          message: "Bridge stateDir is required for roadmap tools",
          retryable: false,
        },
      })

      const after = ctx.engine!.store.get("s1")
      expect(after?.currentTaskId).toBe(before?.currentTaskId)
      expect(after?.implDag).toEqual(before?.implDag)
      expect(after?.phase).toBe(before?.phase)
      expect(after?.phaseState).toBe(before?.phaseState)
    } finally {
      ctx.stateDir = originalStateDir
    }
  })

  it("surfaces roadmap_read and roadmap_query storage failures without corrupting workflow runtime state", async () => {
    await ctx.engine!.store.update("s1", (draft) => {
      draft.mode = "INCREMENTAL"
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.currentTaskId = "T1"
      draft.implDag = [
        {
          id: "T1",
          description: "Existing execution task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "in-flight",
        },
      ]
    })

    const before = JSON.parse(JSON.stringify(ctx.engine!.store.get("s1")))
    const originalStateDir = ctx.stateDir!
    const blockedStateDir = join(tmpDir, "state-dir-blocker")
    await Bun.write(blockedStateDir, "not-a-directory")
    ctx.stateDir = blockedStateDir

    try {
      const readResponse = await handleToolExecute({
        name: "roadmap_read",
        args: {},
        context: { sessionId: "s1", directory: tmpDir },
      }, ctx)
      expect(JSON.parse(readResponse as string)).toEqual({
        ok: false,
        error: {
          code: "storage-failure",
          message: expect.any(String),
          retryable: true,
        },
      })

      const afterRead = ctx.engine!.store.get("s1")
      expect(afterRead?.currentTaskId).toBe(before?.currentTaskId)
      expect(afterRead?.implDag).toEqual(before?.implDag)

      const queryResponse = await handleToolExecute({
        name: "roadmap_query",
        args: { query: { minPriority: 1 } },
        context: { sessionId: "s1", directory: tmpDir },
      }, ctx)
      expect(JSON.parse(queryResponse as string)).toEqual({
        ok: false,
        error: {
          code: "storage-failure",
          message: expect.any(String),
          retryable: true,
        },
      })

      const afterQuery = ctx.engine!.store.get("s1")
      expect(afterQuery?.currentTaskId).toBe(before?.currentTaskId)
      expect(afterQuery?.implDag).toEqual(before?.implDag)
    } finally {
      ctx.stateDir = originalStateDir
    }
  })

  it("surfaces roadmap_derive_execution_slice failures without corrupting workflow runtime state", async () => {
    const roadmapBackend = createBridgeRoadmapBackend(ctx.stateDir!)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    await ctx.engine!.store.update("s1", (draft) => {
      draft.mode = "INCREMENTAL"
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.currentTaskId = "T1"
      draft.implDag = [
        {
          id: "T1",
          description: "Existing execution task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "in-flight",
        },
      ]
    })

    const before = JSON.parse(JSON.stringify(ctx.engine!.store.get("s1")))
    const response = await handleToolExecute({
      name: "roadmap_derive_execution_slice",
      args: { roadmap_item_ids: ["missing-item"], feature_name: "persistent-roadmap-dag" },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    expect(JSON.parse(response as string)).toEqual({
      ok: false,
      error: {
        code: "invalid-slice",
        message: expect.any(String),
        retryable: false,
        details: { itemId: "missing-item" },
      },
    })

    const after = ctx.engine!.store.get("s1")
    expect(after?.currentTaskId).toBe(before?.currentTaskId)
    expect(after?.implDag).toEqual(before?.implDag)
    expect(after?.phase).toBe(before?.phase)
    expect(after?.phaseState).toBe(before?.phaseState)
  })

  it("derives roadmap results through bridge-owned tools from the PGlite backend without mutating execution state", async () => {
    const roadmapBackend = createBridgeRoadmapBackend(ctx.stateDir!)
    await roadmapBackend.createRoadmap(makeRoadmapDocument())

    await ctx.engine!.store.update("s1", (draft) => {
      draft.mode = "INCREMENTAL"
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.currentTaskId = "T1"
      draft.implDag = [
        {
          id: "T1",
          description: "Existing execution task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "in-flight",
        },
      ]
    })

    const before = JSON.parse(JSON.stringify(ctx.engine!.store.get("s1")))
    const queryResponse = await handleToolExecute({
      name: "roadmap_query",
      args: { query: { featureName: "persistent-roadmap-dag", minPriority: 9 } },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)
    expect(JSON.parse(queryResponse as string)).toEqual({
      ok: true,
      value: [makeRoadmapDocument().items[0]],
    })

    const deriveResponse = await handleToolExecute({
      name: "roadmap_derive_execution_slice",
      args: { roadmap_item_ids: ["item-1", "item-2"], feature_name: "persistent-roadmap-dag" },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)
    expect(JSON.parse(deriveResponse as string)).toEqual({
      ok: true,
      value: {
        roadmapItemIds: ["item-1", "item-2"],
        roadmapItems: makeRoadmapDocument().items.slice(0, 2),
        edges: makeRoadmapDocument().edges,
        featureName: "persistent-roadmap-dag",
      },
    })

    const after = ctx.engine!.store.get("s1")
    expect(after?.currentTaskId).toBe(before?.currentTaskId)
    expect(after?.implDag).toEqual(before?.implDag)
  })

  it("allows normal workflow execution behavior when roadmap state is absent", async () => {
    const roadmapResponse = await handleToolExecute({
      name: "roadmap_read",
      args: {},
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)
    expect(JSON.parse(roadmapResponse as string)).toEqual({ ok: true, value: null })

    const selectModeResponse = await handleToolExecute({
      name: "select_mode",
      args: { mode: "INCREMENTAL", feature_name: "persistent-roadmap-dag" },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    expect(selectModeResponse).toContain("Mode set to INCREMENTAL")
  })
})
