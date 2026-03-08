/**
 * Tests for SessionStateStore — persistence and mutation semantics.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createSessionStateStore } from "#plugin/session-state"
import { SCHEMA_VERSION } from "#plugin/types"
import type { SessionStateStore, WorkflowState } from "#plugin/types"

let store: SessionStateStore
let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sw-test-"))
  store = createSessionStateStore(tmpDir)
  await store.load()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("SessionStateStore — create", () => {
  it("creates a fresh state with correct defaults", async () => {
    const state = await store.create("session-1")
    expect(state.sessionId).toBe("session-1")
    expect(state.schemaVersion).toBe(SCHEMA_VERSION)
    expect(state.phase).toBe("MODE_SELECT")
    expect(state.phaseState).toBe("DRAFT")
    expect(state.mode).toBeNull()
    expect(state.iterationCount).toBe(0)
    expect(state.retryCount).toBe(0)
    expect(state.approvalCount).toBe(0)
    expect(state.fileAllowlist).toEqual([])
    expect(state.conventions).toBeNull()
    expect(state.approvedArtifacts).toEqual({})
    expect(state.orchestratorSessionId).toBeNull()
    expect(state.lastCheckpointTag).toBeNull()
    expect(state.intentBaseline).toBeNull()
  })

  it("throws if session already exists", async () => {
    await store.create("session-dup")
    await expect(store.create("session-dup")).rejects.toThrow()
  })

  it("persists to disk — survives a reload", async () => {
    await store.create("session-persist")
    // create fresh store from same dir
    const store2 = createSessionStateStore(tmpDir)
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("session-persist")
    expect(loaded).not.toBeNull()
    expect(loaded?.sessionId).toBe("session-persist")
  })
})

describe("SessionStateStore — get", () => {
  it("returns null for unknown session", async () => {
    expect(store.get("nonexistent")).toBeNull()
  })

  it("returns existing state", async () => {
    await store.create("session-get")
    expect(store.get("session-get")).not.toBeNull()
  })
})

describe("SessionStateStore — update", () => {
  it("applies mutator and returns new state", async () => {
    await store.create("session-upd")
    const updated = await store.update("session-upd", (draft) => {
      draft.phase = "PLANNING"
      draft.phaseState = "DRAFT"
      draft.mode = "GREENFIELD"
    })
    expect(updated.phase).toBe("PLANNING")
    expect(updated.mode).toBe("GREENFIELD")
  })

  it("in-memory state reflects update immediately", async () => {
    await store.create("session-mem")
    await store.update("session-mem", (d) => { d.phase = "INTERFACES" })
    expect(store.get("session-mem")?.phase).toBe("INTERFACES")
  })

  it("persists update to disk", async () => {
    await store.create("session-disk")
    await store.update("session-disk", (d) => {
      d.phase = "TESTS"
      d.approvalCount = 3
    })
    const store2 = createSessionStateStore(tmpDir)
    await store2.load()
    const s = store2.get("session-disk")
    expect(s?.phase).toBe("TESTS")
    expect(s?.approvalCount).toBe(3)
  })

  it("throws for unknown session", async () => {
    await expect(store.update("ghost", () => {})).rejects.toThrow()
  })

  it("does not mutate original reference — update returns new object", async () => {
    await store.create("session-imm")
    const before = store.get("session-imm")
    const after = await store.update("session-imm", (d) => { d.phase = "PLANNING" })
    expect(before?.phase).toBe("MODE_SELECT")
    expect(after.phase).toBe("PLANNING")
  })
})

describe("SessionStateStore — delete", () => {
  it("removes from memory", async () => {
    await store.create("session-del")
    await store.delete("session-del")
    expect(store.get("session-del")).toBeNull()
  })

  it("no-op for nonexistent session", async () => {
    await expect(store.delete("ghost")).resolves.toBeUndefined()
  })

  it("removes from disk", async () => {
    await store.create("session-del-disk")
    await store.delete("session-del-disk")
    const store2 = createSessionStateStore(tmpDir)
    await store2.load()
    expect(store2.get("session-del-disk")).toBeNull()
  })
})

describe("SessionStateStore — load", () => {
  it("discards states with wrong schemaVersion", async () => {
    // Manually write a bad state file
    const badState = {
      schemaVersion: 999,
      sessionId: "bad-session",
      phase: "PLANNING",
    }
    await Bun.write(
      join(tmpDir, "workflow-state.json"),
      JSON.stringify({ "bad-session": badState }),
    )
    const store2 = createSessionStateStore(tmpDir)
    const result = await store2.load()
    expect(result.success).toBe(true)
    expect(store2.get("bad-session")).toBeNull()
  })

  it("reports count of successfully loaded sessions", async () => {
    // Write two valid sessions directly
    const s1: WorkflowState = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: "s1",
      mode: null,
      phase: "MODE_SELECT",
      phaseState: "DRAFT",
      iterationCount: 0,
      retryCount: 0,
      approvedArtifacts: {},
      conventions: null,
      fileAllowlist: [],
      lastCheckpointTag: null,
      approvalCount: 0,
      orchestratorSessionId: null,
      intentBaseline: null,
    }
    const s2: WorkflowState = { ...s1, sessionId: "s2" }
    await Bun.write(
      join(tmpDir, "workflow-state.json"),
      JSON.stringify({ s1, s2 }),
    )
    const store2 = createSessionStateStore(tmpDir)
    const result = await store2.load()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(2)
  })
})
