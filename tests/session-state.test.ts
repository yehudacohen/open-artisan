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
    expect(state.featureName).toBeNull()
  })

  it("creates state with v6 fields (currentTaskId, feedbackHistory)", async () => {
    const state = await store.create("session-v6")
    expect(state.currentTaskId).toBeNull()
    expect(state.feedbackHistory).toEqual([])
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

describe("SessionStateStore — invariant validation (G4)", () => {
  it("throws when mutation produces invalid phaseState for phase", async () => {
    await store.create("session-inv")
    // PLANNING phase cannot have SCAN phaseState
    await expect(
      store.update("session-inv", (d) => {
        d.phase = "PLANNING"
        d.phaseState = "SCAN" as any // type cast to bypass TS — tests runtime validation
      }),
    ).rejects.toThrow(/Invalid phaseState/)
  })

  it("throws when mutation produces negative iterationCount", async () => {
    await store.create("session-neg")
    await expect(
      store.update("session-neg", (d) => {
        d.iterationCount = -1
      }),
    ).rejects.toThrow(/iterationCount/)
  })

  it("throws when mutation produces negative retryCount", async () => {
    await store.create("session-neg-retry")
    await expect(
      store.update("session-neg-retry", (d) => {
        d.retryCount = -5
      }),
    ).rejects.toThrow(/retryCount/)
  })

  it("throws when INCREMENTAL mode has non-absolute path in fileAllowlist", async () => {
    await store.create("session-rel")
    await expect(
      store.update("session-rel", (d) => {
        d.mode = "INCREMENTAL"
        d.fileAllowlist = ["relative/path/foo.ts"] // must start with /
      }),
    ).rejects.toThrow(/absolute path/)
  })

  it("accepts valid state mutation without throwing", async () => {
    await store.create("session-valid")
    const result = await store.update("session-valid", (d) => {
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.mode = "GREENFIELD"
    })
    expect(result.phase).toBe("PLANNING")
  })

  it("accepts INCREMENTAL mode with absolute paths in fileAllowlist", async () => {
    await store.create("session-abs")
    const result = await store.update("session-abs", (d) => {
      d.mode = "INCREMENTAL"
      d.fileAllowlist = ["/project/src/foo.ts", "/project/src/bar.ts"]
    })
    expect(result.fileAllowlist).toHaveLength(2)
  })
})

describe("SessionStateStore — load clears memory (G5)", () => {
  it("calling load() on the same store clears previously-created sessions not on disk", async () => {
    // Start with a fresh store with no disk file
    const store2 = createSessionStateStore(tmpDir)
    await store2.load() // no file → clean state

    // Manually create a session in memory only (without persisting to disk)
    // We do this by creating and then deleting the disk file
    await store2.create("session-stale-g5")
    // Verify it's in memory
    expect(store2.get("session-stale-g5")).not.toBeNull()

    // Corrupt the disk file to have no sessions (simulating out-of-sync state)
    await Bun.write(
      require("node:path").join(tmpDir, "workflow-state.json"),
      JSON.stringify({}),
    )

    // Now reload — should clear in-memory state and load from disk (empty)
    await store2.load()

    // The stale in-memory session should be gone after reload
    expect(store2.get("session-stale-g5")).toBeNull()
  })

  it("calling load() twice does not double-populate sessions", async () => {
    await store.create("session-dbl")
    const store2 = createSessionStateStore(tmpDir)
    await store2.load()
    const before = store2.get("session-dbl")
    await store2.load()
    const after = store2.get("session-dbl")
    // Both loads should see the same session — not duplicated
    expect(before?.sessionId).toBe("session-dbl")
    expect(after?.sessionId).toBe("session-dbl")
  })
})

describe("SessionStateStore — concurrent update serialization (G22)", () => {
  it("serializes concurrent updates — last-write-wins but no data loss between chained updates", async () => {
    await store.create("session-conc")
    // Fire two updates simultaneously without awaiting in sequence
    const p1 = store.update("session-conc", (d) => { d.iterationCount = 1 })
    const p2 = store.update("session-conc", (d) => { d.retryCount = 5 })
    await Promise.all([p1, p2])
    const final = store.get("session-conc")
    // Both mutations should have been applied (serialized, not lost)
    expect(final?.iterationCount).toBe(1)
    expect(final?.retryCount).toBe(5)
  })

  it("concurrent updates do not corrupt state", async () => {
    await store.create("session-safe")
    const updates = Array.from({ length: 5 }, (_, i) =>
      store.update("session-safe", (d) => { d.approvalCount = i + 1 }),
    )
    await Promise.all(updates)
    const final = store.get("session-safe")
    // approvalCount should be one of 1-5 (all are valid; no NaN or corruption)
    expect(final?.approvalCount).toBeGreaterThanOrEqual(1)
    expect(final?.approvalCount).toBeLessThanOrEqual(5)
    expect(typeof final?.approvalCount).toBe("number")
  })
})

describe("SessionStateStore — global write lock (M4)", () => {
  it("concurrent updates to DIFFERENT sessions do not lose writes", async () => {
    // M4 fix: without the globalWriteLock, concurrent updates to different sessions
    // could interleave writeAll() calls, causing one session's changes to be lost.
    await store.create("session-a")
    await store.create("session-b")

    // Fire updates to two different sessions concurrently
    const pa = store.update("session-a", (d) => {
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.mode = "GREENFIELD"
    })
    const pb = store.update("session-b", (d) => {
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
      d.mode = "REFACTOR"
    })
    await Promise.all([pa, pb])

    // Both sessions should reflect their respective updates
    expect(store.get("session-a")?.phase).toBe("PLANNING")
    expect(store.get("session-b")?.phase).toBe("INTERFACES")

    // Verify persistence: reload from disk and check both survived
    const store2 = createSessionStateStore(tmpDir)
    await store2.load()
    expect(store2.get("session-a")?.phase).toBe("PLANNING")
    expect(store2.get("session-b")?.phase).toBe("INTERFACES")
  })

  it("rapid fire updates across 3 sessions all persist correctly", async () => {
    await store.create("rapid-1")
    await store.create("rapid-2")
    await store.create("rapid-3")

    const updates = [
      store.update("rapid-1", (d) => { d.approvalCount = 10 }),
      store.update("rapid-2", (d) => { d.approvalCount = 20 }),
      store.update("rapid-3", (d) => { d.approvalCount = 30 }),
      store.update("rapid-1", (d) => { d.iterationCount = 1 }),
      store.update("rapid-2", (d) => { d.iterationCount = 2 }),
      store.update("rapid-3", (d) => { d.iterationCount = 3 }),
    ]
    await Promise.all(updates)

    const store2 = createSessionStateStore(tmpDir)
    await store2.load()
    expect(store2.get("rapid-1")?.approvalCount).toBe(10)
    expect(store2.get("rapid-2")?.approvalCount).toBe(20)
    expect(store2.get("rapid-3")?.approvalCount).toBe(30)
    expect(store2.get("rapid-1")?.iterationCount).toBe(1)
    expect(store2.get("rapid-2")?.iterationCount).toBe(2)
    expect(store2.get("rapid-3")?.iterationCount).toBe(3)
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

  it("migrates v5 state (missing currentTaskId and feedbackHistory) to v6", async () => {
    // Write a v5 state that lacks currentTaskId and feedbackHistory
    const v5State = {
      schemaVersion: 5,
      sessionId: "v5-session",
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
      modeDetectionNote: null,
      discoveryReport: null,
      implDag: null,
      escapePending: false,
      pendingRevisionSteps: null,
      // Note: no currentTaskId, feedbackHistory, or userGateMessageReceived
      // — these are v6/v8 fields that get migrated in
    }
    await Bun.write(
      join(tmpDir, "workflow-state.json"),
      JSON.stringify({ "v5-session": v5State }),
    )
    const store2 = createSessionStateStore(tmpDir)
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("v5-session")
    expect(loaded).not.toBeNull()
    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded?.currentTaskId).toBeNull()
    expect(loaded?.feedbackHistory).toEqual([])
    expect(loaded?.userGateMessageReceived).toBe(false)
    expect(loaded?.featureName).toBeNull()
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
      modeDetectionNote: null,
      discoveryReport: null,
      implDag: null,
      phaseApprovalCounts: {},
      escapePending: false,
      pendingRevisionSteps: null,
      currentTaskId: null,
      feedbackHistory: [],
      userGateMessageReceived: false,
      artifactDiskPaths: {},
      featureName: null,
      revisionBaseline: null,
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
