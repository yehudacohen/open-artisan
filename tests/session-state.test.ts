/**
 * Tests for SessionStateStore — persistence and mutation semantics.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { createSessionStateStore } from "#core/session-state"
import { createFileSystemStateBackend, migrateLegacyStateFile } from "#core/state-backend-fs"
import { SCHEMA_VERSION, type SessionStateStore, type WorkflowState } from "#core/workflow-state-types"

/** Build a minimal valid WorkflowState for test fixtures. */
function makeState(sessionId: string, featureName: string | null, overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
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
    backtrackContext: null,
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
    artifactDiskPaths: {},
    featureName,
    revisionBaseline: null,
    activeAgent: null,
    taskCompletionInProgress: null,
    taskReviewCount: 0,
    pendingFeedback: null,
    userMessages: [],
    cachedPriorState: null,
    priorWorkflowChecked: false,
    sessionModel: null,
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
    ...overrides,
  }
}

/** Write a per-feature state file to disk. */
function writePerFeatureState(baseDir: string, featureName: string, state: WorkflowState): void {
  const dir = join(baseDir, featureName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(state, null, 2), "utf-8")
}

/** Write a legacy single-file state to disk (Record<sessionId, WorkflowState>). */
function writeLegacyState(filePath: string, states: Record<string, unknown>): void {
  writeFileSync(filePath, JSON.stringify(states), "utf-8")
}

let store: SessionStateStore
let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sw-test-"))
  store = createSessionStateStore(createFileSystemStateBackend(tmpDir))
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

  it("creates state with v21 sub-workflow fields", async () => {
    const state = await store.create("session-v21")
    expect(state.parentWorkflow).toBeNull()
    expect(state.childWorkflows).toEqual([])
    expect(state.concurrency).toEqual({ maxParallelTasks: 1 })
  })

  it("throws if session already exists", async () => {
    await store.create("session-dup")
    await expect(store.create("session-dup")).rejects.toThrow()
  })

  it("persists to disk — survives a reload (requires featureName)", async () => {
    await store.create("session-persist")
    await store.update("session-persist", (d) => {
      d.featureName = "persist-test"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    // create fresh store from same dir
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
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

  it("persists update to disk (requires featureName)", async () => {
    await store.create("session-disk")
    await store.update("session-disk", (d) => {
      d.featureName = "disk-test"
      d.mode = "GREENFIELD"
      d.phase = "TESTS"
      d.phaseState = "DRAFT"
      d.approvalCount = 3
    })
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
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
    await store.update("session-del-disk", (d) => {
      d.featureName = "del-test"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    await store.delete("session-del-disk")
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
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

  it("throws when parentWorkflow has empty sessionId", async () => {
    await store.create("session-pw")
    await expect(
      store.update("session-pw", (d) => {
        d.parentWorkflow = { sessionId: "", featureName: "x", taskId: "T1" } as any
      }),
    ).rejects.toThrow(/parentWorkflow\.sessionId/)
  })

  it("throws when childWorkflows entry has invalid status", async () => {
    await store.create("session-cw")
    await expect(
      store.update("session-cw", (d) => {
        d.childWorkflows = [{ taskId: "T1", featureName: "child", sessionId: null, status: "bogus" as any, delegatedAt: new Date().toISOString() }]
      }),
    ).rejects.toThrow(/childWorkflows\[0\]\.status/)
  })

  it("throws when concurrency.maxParallelTasks is zero", async () => {
    await store.create("session-conc")
    await expect(
      store.update("session-conc", (d) => {
        d.concurrency = { maxParallelTasks: 0 }
      }),
    ).rejects.toThrow(/maxParallelTasks/)
  })

  it("throws when concurrency.maxParallelTasks is negative", async () => {
    await store.create("session-conc-neg")
    await expect(
      store.update("session-conc-neg", (d) => {
        d.concurrency = { maxParallelTasks: -1 }
      }),
    ).rejects.toThrow(/maxParallelTasks/)
  })

  it("throws when childWorkflows entry has empty delegatedAt", async () => {
    await store.create("session-delegatedAt")
    await expect(
      store.update("session-delegatedAt", (d) => {
        d.phase = "IMPLEMENTATION"
        d.phaseState = "DRAFT"
        d.mode = "GREENFIELD"
        d.implDag = [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "delegated" }]
        d.childWorkflows = [{ taskId: "T1", featureName: "child", sessionId: "s1", status: "running", delegatedAt: "" }]
      }),
    ).rejects.toThrow(/delegatedAt/)
  })

  it("throws when running childWorkflow references non-delegated DAG task", async () => {
    await store.create("session-xfield")
    // Set up IMPLEMENTATION with a DAG task that's "pending" (not "delegated")
    // but a childWorkflows entry claims it's running
    await expect(
      store.update("session-xfield", (d) => {
        d.phase = "IMPLEMENTATION"
        d.phaseState = "DRAFT"
        d.mode = "GREENFIELD"
        d.implDag = [{ id: "T1", description: "task", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" }]
        d.childWorkflows = [{ taskId: "T1", featureName: "child", sessionId: "s1", status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" }]
      }),
    ).rejects.toThrow(/childWorkflows.*delegated/)
  })

  it("throws when featureName is reserved 'sub'", async () => {
    await store.create("session-sub")
    await expect(
      store.update("session-sub", (d) => {
        d.featureName = "sub"
      }),
    ).rejects.toThrow(/reserved/)
  })

  it("accepts valid parentWorkflow", async () => {
    await store.create("session-pw-ok")
    const result = await store.update("session-pw-ok", (d) => {
      d.parentWorkflow = { sessionId: "parent-1", featureName: "parent-feat", taskId: "T3" }
    })
    expect(result.parentWorkflow).toEqual({ sessionId: "parent-1", featureName: "parent-feat", taskId: "T3" })
  })

  it("accepts valid childWorkflows", async () => {
    await store.create("session-cw-ok")
    const result = await store.update("session-cw-ok", (d) => {
      d.childWorkflows = [{ taskId: "T1", featureName: "child-feat", sessionId: "child-1", status: "running", delegatedAt: "2026-01-01T00:00:00.000Z" }]
    })
    expect(result.childWorkflows).toHaveLength(1)
    expect(result.childWorkflows[0]?.status).toBe("running")
  })

  it("accepts valid concurrency", async () => {
    await store.create("session-conc-ok")
    const result = await store.update("session-conc-ok", (d) => {
      d.concurrency = { maxParallelTasks: 4 }
    })
    expect(result.concurrency.maxParallelTasks).toBe(4)
  })
})

describe("SessionStateStore — load clears memory (G5)", () => {
  it("calling load() on the same store clears previously-created sessions not on disk", async () => {
    // Start with a fresh store with no disk file
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load() // no files → clean state

    // Create a session in memory only (no featureName → no disk write)
    await store2.create("session-stale-g5")
    // Verify it's in memory
    expect(store2.get("session-stale-g5")).not.toBeNull()

    // Now reload — should clear in-memory state and load from disk (empty)
    await store2.load()

    // The stale in-memory session should be gone after reload
    expect(store2.get("session-stale-g5")).toBeNull()
  })

  it("calling load() twice does not double-populate sessions", async () => {
    await store.create("session-dbl")
    await store.update("session-dbl", (d) => {
      d.featureName = "dbl-test"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
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

describe("SessionStateStore — per-feature write isolation (M4)", () => {
  it("concurrent updates to DIFFERENT sessions do not lose writes", async () => {
    // Per-feature files eliminate the old single-file race condition entirely.
    // Each feature writes to its own file, so no interleaving is possible.
    await store.create("session-a")
    await store.create("session-b")

    // Fire updates to two different sessions concurrently (set featureName for persistence)
    const pa = store.update("session-a", (d) => {
      d.featureName = "feat-a"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.mode = "GREENFIELD"
    })
    const pb = store.update("session-b", (d) => {
      d.featureName = "feat-b"
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
      d.mode = "REFACTOR"
    })
    await Promise.all([pa, pb])

    // Both sessions should reflect their respective updates
    expect(store.get("session-a")?.phase).toBe("PLANNING")
    expect(store.get("session-b")?.phase).toBe("INTERFACES")

    // Verify persistence: reload from disk and check both survived
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    expect(store2.get("session-a")?.phase).toBe("PLANNING")
    expect(store2.get("session-b")?.phase).toBe("INTERFACES")
  })

  it("rapid fire updates across 3 sessions all persist correctly", async () => {
    await store.create("rapid-1")
    await store.create("rapid-2")
    await store.create("rapid-3")

    // Set featureName first so updates persist to per-feature files
    await store.update("rapid-1", (d) => { d.featureName = "rapid-feat-1"; d.mode = "GREENFIELD"; d.phase = "PLANNING"; d.phaseState = "DRAFT" })
    await store.update("rapid-2", (d) => { d.featureName = "rapid-feat-2"; d.mode = "GREENFIELD"; d.phase = "PLANNING"; d.phaseState = "DRAFT" })
    await store.update("rapid-3", (d) => { d.featureName = "rapid-feat-3"; d.mode = "GREENFIELD"; d.phase = "PLANNING"; d.phaseState = "DRAFT" })

    const updates = [
      store.update("rapid-1", (d) => { d.approvalCount = 10 }),
      store.update("rapid-2", (d) => { d.approvalCount = 20 }),
      store.update("rapid-3", (d) => { d.approvalCount = 30 }),
      store.update("rapid-1", (d) => { d.iterationCount = 1 }),
      store.update("rapid-2", (d) => { d.iterationCount = 2 }),
      store.update("rapid-3", (d) => { d.iterationCount = 3 }),
    ]
    await Promise.all(updates)

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    expect(store2.get("rapid-1")?.approvalCount).toBe(10)
    expect(store2.get("rapid-2")?.approvalCount).toBe(20)
    expect(store2.get("rapid-3")?.approvalCount).toBe(30)
    expect(store2.get("rapid-1")?.iterationCount).toBe(1)
    expect(store2.get("rapid-2")?.iterationCount).toBe(2)
    expect(store2.get("rapid-3")?.iterationCount).toBe(3)
  })
})

describe("SessionStateStore — transient field cleanup on load", () => {
  it("clears taskCompletionInProgress on reload (transient lock)", async () => {
    await store.create("session-transient-1")
    await store.update("session-transient-1", (d) => {
      d.featureName = "transient-1"
      d.mode = "GREENFIELD"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [{ id: "task-3", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" }]
      d.currentTaskId = "task-3"
      d.taskCompletionInProgress = "task-3"
    })
    // Verify it was set
    expect(store.get("session-transient-1")?.taskCompletionInProgress).toBe("task-3")
    // Reload from disk
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    const loaded = store2.get("session-transient-1")
    expect(loaded).not.toBeNull()
    expect(loaded?.taskCompletionInProgress).toBeNull()
  })

  it("clears pendingFeedback on reload (transient state)", async () => {
    await store.create("session-transient-2")
    await store.update("session-transient-2", (d) => {
      d.featureName = "transient-2"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.pendingFeedback = "some feedback text"
    })
    // Verify it was set
    expect(store.get("session-transient-2")?.pendingFeedback).toBe("some feedback text")
    // Reload from disk
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    const loaded = store2.get("session-transient-2")
    expect(loaded).not.toBeNull()
    expect(loaded?.pendingFeedback).toBeNull()
  })

  it("preserves taskReviewCount on reload (NOT transient)", async () => {
    await store.create("session-transient-3")
    await store.update("session-transient-3", (d) => {
      d.featureName = "transient-3"
      d.mode = "GREENFIELD"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [{ id: "T1", description: "d", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" }]
      d.currentTaskId = "T1"
      d.taskReviewCount = 5
    })
    // Reload from disk
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    const loaded = store2.get("session-transient-3")
    expect(loaded).not.toBeNull()
    expect(loaded?.taskReviewCount).toBe(5)
  })

  it("fresh state defaults: taskCompletionInProgress=null, pendingFeedback=null, taskReviewCount=0 after reload", async () => {
    await store.create("session-transient-4")
    await store.update("session-transient-4", (d) => {
      d.featureName = "transient-4"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    // Persist with defaults, reload
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    const loaded = store2.get("session-transient-4")
    expect(loaded).not.toBeNull()
    expect(loaded?.taskCompletionInProgress).toBeNull()
    expect(loaded?.pendingFeedback).toBeNull()
    expect(loaded?.taskReviewCount).toBe(0)
  })
})

describe("SessionStateStore — load", () => {
  it("discards per-feature state with wrong schemaVersion", async () => {
    // Manually write a bad per-feature state file
    const dir = join(tmpDir, "bad-feature")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({ schemaVersion: 999, sessionId: "bad-session", phase: "PLANNING" }),
    )
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    expect(store2.get("bad-session")).toBeNull()
  })

  it("migrates v5 per-feature state (missing currentTaskId and feedbackHistory) to current", async () => {
    // Write a v5 state as a per-feature file
    const dir = join(tmpDir, "v5-feature")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({
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
        featureName: "v5-feature",
      }),
    )
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("v5-session")
    expect(loaded).not.toBeNull()
    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded?.currentTaskId).toBeNull()
    expect(loaded?.feedbackHistory).toEqual([])
    expect(loaded?.userGateMessageReceived).toBe(false)
    expect(loaded?.featureName).toBe("v5-feature")
  })

  it("migrates v20 per-feature state (missing sub-workflow fields) to v21", async () => {
    // Write a v20 state that lacks parentWorkflow, childWorkflows, concurrency
    const dir = join(tmpDir, "v20-feature")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 20,
        sessionId: "v20-session",
        mode: "GREENFIELD",
        phase: "PLANNING",
        phaseState: "DRAFT",
        iterationCount: 0,
        retryCount: 0,
        approvedArtifacts: {},
        conventions: null,
        fileAllowlist: [],
        lastCheckpointTag: null,
        approvalCount: 1,
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
        reviewArtifactHash: null,
        latestReviewResults: null,
        artifactDiskPaths: {},
        featureName: "v20-feature",
        revisionBaseline: null,
        activeAgent: null,
        taskCompletionInProgress: null,
        taskReviewCount: 0,
        pendingFeedback: null,
        userMessages: [],
        cachedPriorState: null,
        priorWorkflowChecked: false,
        sessionModel: null,
        // Note: no parentWorkflow, childWorkflows, concurrency — v21 fields
      }),
    )
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("v20-session")
    expect(loaded).not.toBeNull()
    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded?.parentWorkflow).toBeNull()
    expect(loaded?.childWorkflows).toEqual([])
    expect(loaded?.concurrency).toEqual({ maxParallelTasks: 1 })
    expect(loaded?.approvalCount).toBe(1) // preserved from v20
  })

  it("migrates v21 state (missing reviewArtifactFiles, missing expectedFiles on DAG) to v22", async () => {
    const dir = join(tmpDir, "v21-feature")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 21,
        sessionId: "v21-session",
        mode: "GREENFIELD",
        phase: "IMPLEMENTATION",
        phaseState: "DRAFT",
        iterationCount: 0,
        retryCount: 0,
        approvedArtifacts: {},
        conventions: null,
        fileAllowlist: [],
        lastCheckpointTag: null,
        approvalCount: 2,
        orchestratorSessionId: null,
        intentBaseline: null,
        modeDetectionNote: null,
        discoveryReport: null,
        implDag: [
          { id: "T1", description: "Build page", dependencies: [], expectedTests: ["tests/page.test.ts"], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
          { id: "T2", description: "Build nav", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium", status: "pending" },
        ],
        phaseApprovalCounts: {},
        escapePending: false,
        pendingRevisionSteps: null,
        currentTaskId: "T2",
        feedbackHistory: [],
        userGateMessageReceived: false,
        reviewArtifactHash: null,
        latestReviewResults: null,
        artifactDiskPaths: {},
        featureName: "v21-feature",
        revisionBaseline: null,
        activeAgent: null,
        taskCompletionInProgress: null,
        taskReviewCount: 0,
        pendingFeedback: null,
        userMessages: [],
        cachedPriorState: null,
        priorWorkflowChecked: false,
        sessionModel: null,
        parentWorkflow: null,
        childWorkflows: [],
        concurrency: { maxParallelTasks: 1 },
        // Note: no reviewArtifactFiles — v22 field
        // Note: implDag nodes lack expectedFiles — v22 field
      }),
    )
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("v21-session")
    expect(loaded).not.toBeNull()
    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION)
    // v22: reviewArtifactFiles backfilled to []
    expect(loaded?.reviewArtifactFiles).toEqual([])
    // v22: expectedFiles backfilled on DAG nodes
    expect(loaded?.implDag).not.toBeNull()
    expect(loaded?.implDag?.[0]?.expectedFiles).toEqual([])
    expect(loaded?.implDag?.[1]?.expectedFiles).toEqual([])
    // Existing fields preserved
    expect(loaded?.approvalCount).toBe(2)
    expect(loaded?.currentTaskId).toBe("T2")
    expect(loaded?.implDag?.[0]?.status).toBe("complete")
  })

  it("migrates v22 state missing backtrackContext to current schema", async () => {
    const dir = join(tmpDir, "v22-feature")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 22,
        sessionId: "v22-session",
        mode: "INCREMENTAL",
        phase: "INTERFACES",
        phaseState: "REVISE",
        iterationCount: 1,
        retryCount: 0,
        approvedArtifacts: { plan: "abc123" },
        conventions: null,
        fileAllowlist: ["/tmp/project/packages/core/workflow-state-types.ts"],
        lastCheckpointTag: null,
        approvalCount: 2,
        orchestratorSessionId: null,
        intentBaseline: null,
        modeDetectionNote: null,
        discoveryReport: null,
        implDag: null,
        phaseApprovalCounts: { PLANNING: 1 },
        escapePending: false,
        pendingRevisionSteps: null,
        currentTaskId: null,
        feedbackHistory: [],
        userGateMessageReceived: false,
        reviewArtifactHash: null,
        latestReviewResults: [],
        artifactDiskPaths: {},
        featureName: "v22-feature",
        revisionBaseline: null,
        activeAgent: null,
        taskCompletionInProgress: null,
        taskReviewCount: 0,
        pendingFeedback: null,
        userMessages: [],
        cachedPriorState: null,
        priorWorkflowChecked: false,
        sessionModel: null,
        parentWorkflow: null,
        childWorkflows: [],
        concurrency: { maxParallelTasks: 1 },
        reviewArtifactFiles: ["/tmp/project/packages/core/workflow-state-types.ts"],
        // Note: no backtrackContext — v23 field
      }),
    )

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("v22-session")
    expect(loaded).not.toBeNull()
    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded?.backtrackContext).toBeNull()
    expect(loaded?.phase).toBe("INTERFACES")
    expect(loaded?.phaseState).toBe("REVISE")
  })

  it("rejects backtrackContext outside REDRAFT during update", async () => {
    await store.create("backtrack-invalid")
    await expect(store.update("backtrack-invalid", (draft) => {
      draft.featureName = "backtrack-invalid"
      draft.mode = "INCREMENTAL"
      draft.phase = "PLANNING"
      draft.phaseState = "DRAFT"
      draft.backtrackContext = {
        sourcePhase: "INTERFACES",
        targetPhase: "PLANNING",
        reason: "Planner regression requires a structural rewind.",
      }
    })).rejects.toThrow("backtrackContext may only be present")
  })

  it("accepts backtrackContext during REDRAFT update", async () => {
    await store.create("backtrack-valid")
    const updated = await store.update("backtrack-valid", (draft) => {
      draft.featureName = "backtrack-valid"
      draft.mode = "INCREMENTAL"
      draft.phase = "PLANNING"
      draft.phaseState = "REDRAFT"
      draft.backtrackContext = {
        sourcePhase: "INTERFACES",
        targetPhase: "PLANNING",
        reason: "Planner regression requires a structural rewind.",
      }
    })
    expect(updated.backtrackContext?.targetPhase).toBe("PLANNING")
    expect(updated.phaseState).toBe("REDRAFT")
  })

  it("accepts the approved structural phase states only in their intended phases", async () => {
    const cases: Array<{ sessionId: string; phase: WorkflowState["phase"]; phaseState: WorkflowState["phaseState"] }> = [
      { sessionId: "planning-redraft", phase: "PLANNING", phaseState: "REDRAFT" },
      { sessionId: "interfaces-skip", phase: "INTERFACES", phaseState: "SKIP_CHECK" },
      { sessionId: "tests-cascade", phase: "TESTS", phaseState: "CASCADE_CHECK" },
      { sessionId: "impl-plan-skip", phase: "IMPL_PLAN", phaseState: "SKIP_CHECK" },
      { sessionId: "impl-scheduling", phase: "IMPLEMENTATION", phaseState: "SCHEDULING" },
      { sessionId: "impl-task-review", phase: "IMPLEMENTATION", phaseState: "TASK_REVIEW" },
      { sessionId: "impl-task-revise", phase: "IMPLEMENTATION", phaseState: "TASK_REVISE" },
      { sessionId: "impl-human-gate", phase: "IMPLEMENTATION", phaseState: "HUMAN_GATE" },
      { sessionId: "impl-delegated-wait", phase: "IMPLEMENTATION", phaseState: "DELEGATED_WAIT" },
    ]

    for (const testCase of cases) {
      await store.create(testCase.sessionId)
      const updated = await store.update(testCase.sessionId, (draft) => {
        draft.featureName = testCase.sessionId
        draft.mode = "INCREMENTAL"
        draft.phase = testCase.phase
        draft.phaseState = testCase.phaseState
      })
      expect(updated.phase).toBe(testCase.phase)
      expect(updated.phaseState).toBe(testCase.phaseState)
    }
  })

  it("rejects structural phase states when they are attached to the wrong phase", async () => {
    await store.create("wrong-structural-phase")
    await expect(store.update("wrong-structural-phase", (draft) => {
      draft.featureName = "wrong-structural-phase"
      draft.mode = "INCREMENTAL"
      draft.phase = "INTERFACES"
      draft.phaseState = "TASK_REVIEW" as WorkflowState["phaseState"]
    })).rejects.toThrow(/Invalid phaseState/)
  })

  it("reports count of successfully loaded sessions", async () => {
    // Write two valid sessions as per-feature files
    writePerFeatureState(tmpDir, "feat-1", makeState("s1", "feat-1"))
    writePerFeatureState(tmpDir, "feat-2", makeState("s2", "feat-2"))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(2)
  })

  it("strips relative paths from fileAllowlist at load time (pre-fix migration)", async () => {
    writePerFeatureState(tmpDir, "test-feature", makeState("stale-allowlist", "test-feature", {
      mode: "INCREMENTAL",
      phase: "INTERFACES",
      phaseState: "DRAFT",
      approvalCount: 1,
      fileAllowlist: ["/absolute/path/ok.ts", "relative/path/bad.ts", "also/bad.ts"] as any,
    }))
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("stale-allowlist")
    expect(loaded).not.toBeNull()
    // Only the absolute path should survive
    expect(loaded!.fileAllowlist).toEqual(["/absolute/path/ok.ts"])
  })

  it("preserves all absolute paths in fileAllowlist at load time", async () => {
    writePerFeatureState(tmpDir, "test-feature", makeState("good-allowlist", "test-feature", {
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      approvalCount: 2,
      fileAllowlist: ["/project/src/foo.ts", "/project/src/bar.ts"],
    }))
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("good-allowlist")
    expect(loaded).not.toBeNull()
    expect(loaded!.fileAllowlist).toEqual(["/project/src/foo.ts", "/project/src/bar.ts"])
  })

  it("repairs invalid currentTaskId on load by recomputing the next ready task", async () => {
    writePerFeatureState(tmpDir, "repair-current-task", makeState("repair-session", "repair-current-task", {
      mode: "GREENFIELD",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [
        { id: "T1", description: "done", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "next", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ],
      currentTaskId: "T99",
    }))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("repair-session")
    expect(loaded?.currentTaskId).toBe("T2")
  })

  it("reopens DONE with unfinished DAG work on load", async () => {
    writePerFeatureState(tmpDir, "repair-done", makeState("repair-done-session", "repair-done", {
      mode: "GREENFIELD",
      phase: "DONE",
      phaseState: "DRAFT",
      implDag: [
        { id: "T1", description: "unfinished", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ],
    }))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("repair-done-session")
    expect(loaded?.phase).toBe("IMPLEMENTATION")
    expect(loaded?.phaseState).toBe("DRAFT")
    expect(loaded?.currentTaskId).toBe("T1")
  })

  it("reverts a completed current task to pending when a review attempt was lost on load", async () => {
    writePerFeatureState(tmpDir, "repair-lost-review", makeState("repair-lost-review-session", "repair-lost-review", {
      mode: "GREENFIELD",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [
        { id: "T1", description: "completed", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "next", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ],
      currentTaskId: "T1",
      taskReviewCount: 1,
    }))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("repair-lost-review-session")
    expect(loaded?.currentTaskId).toBe("T1")
    expect(loaded?.taskReviewCount).toBe(0)
    expect(loaded?.implDag?.find((task) => task.id === "T1")?.status).toBe("pending")
  })

  it("advances past a completed current task on load when no review retry is pending", async () => {
    writePerFeatureState(tmpDir, "repair-terminal-pointer", makeState("repair-terminal-pointer-session", "repair-terminal-pointer", {
      mode: "GREENFIELD",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [
        { id: "T1", description: "completed", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "next", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ],
      currentTaskId: "T1",
      taskReviewCount: 0,
    }))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("repair-terminal-pointer-session")
    expect(loaded?.currentTaskId).toBe("T2")
    expect(loaded?.implDag?.find((task) => task.id === "T1")?.status).toBe("complete")
  })

  it("repairs malformed markdown-derived incremental allowlists from the approved plan on load", async () => {
    const featureName = "repair-allowlist-from-plan"
    const featureDir = join(tmpDir, ".openartisan", featureName)
    mkdirSync(featureDir, { recursive: true })
    const planPath = join(featureDir, "plan.md")
    writeFileSync(
      planPath,
      "# Plan\n\n## Narrow allowlist\n- `src/a.ts`\n- Existing DAG/state model files already used by workflow execution:\n  - `src/b.ts`\n",
      "utf-8",
    )

    writePerFeatureState(tmpDir, featureName, makeState("repair-allowlist-session", featureName, {
      mode: "INCREMENTAL",
      phase: "INTERFACES",
      phaseState: "USER_GATE",
      artifactDiskPaths: { plan: planPath },
      fileAllowlist: [
        "/repo/`src/a.ts`",
        "/repo/Existing DAG/state model files already used by workflow execution:",
        "/repo/`src/b.ts`",
      ],
    }))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("repair-allowlist-session")
    expect(loaded?.fileAllowlist).toEqual([
      join(tmpDir, "src/a.ts"),
      join(tmpDir, "src/b.ts"),
    ])
  })

  it("reopens implementation at HUMAN_GATE when only unresolved human gates remain", async () => {
    writePerFeatureState(tmpDir, "repair-awaiting-human", makeState("repair-awaiting-human-session", "repair-awaiting-human", {
      mode: "GREENFIELD",
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      implDag: [
        {
          id: "T1",
          description: "Needs human input",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "human-gated",
          category: "human-gate",
          humanGate: { whatIsNeeded: "Approve", why: "Needed", verificationSteps: "Verify", resolved: false },
        },
      ],
      currentTaskId: null,
      taskCompletionInProgress: null,
    }))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("repair-awaiting-human-session")
    expect(loaded?.phase).toBe("IMPLEMENTATION")
    expect(loaded?.phaseState).toBe("HUMAN_GATE")
    expect(loaded?.currentTaskId).toBeNull()
    expect(loaded?.userGateMessageReceived).toBe(false)

    const persisted = JSON.parse(readFileSync(join(tmpDir, "repair-awaiting-human", "workflow-state.json"), "utf-8"))
    expect(persisted.phaseState).toBe("HUMAN_GATE")
  })
})

// ---------------------------------------------------------------------------
// Per-feature file storage (Phase 2a)
// ---------------------------------------------------------------------------

describe("SessionStateStore — per-feature file storage", () => {
  it("create() does not write to disk (memory-only)", async () => {
    await store.create("ephemeral-1")
    // baseDir should have no subdirectories
    const entries = readdirSync(tmpDir)
    expect(entries).toEqual([])
  })

  it("update() with featureName writes to <baseDir>/<featureName>/workflow-state.json", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "billing-engine"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    const filePath = join(tmpDir, "billing-engine", "workflow-state.json")
    expect(existsSync(filePath)).toBe(true)
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as WorkflowState
    expect(content.sessionId).toBe("s1")
    expect(content.featureName).toBe("billing-engine")
    expect(content.phase).toBe("PLANNING")
  })

  it("update() without featureName does not write to disk", async () => {
    await store.create("no-feature")
    await store.update("no-feature", (d) => {
      d.iterationCount = 5
    })
    const entries = readdirSync(tmpDir)
    expect(entries).toEqual([])
  })

  it("subsequent updates overwrite the same per-feature file", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "my-feat"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    await store.update("s1", (d) => {
      d.approvalCount = 42
    })
    const filePath = join(tmpDir, "my-feat", "workflow-state.json")
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as WorkflowState
    expect(content.approvalCount).toBe(42)
    // Only one feature directory
    const entries = readdirSync(tmpDir)
    expect(entries).toEqual(["my-feat"])
  })

  it("per-feature state survives a reload", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "my-feat"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.approvalCount = 7
    })
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    const loaded = store2.get("s1")
    expect(loaded).not.toBeNull()
    expect(loaded?.featureName).toBe("my-feat")
    expect(loaded?.approvalCount).toBe(7)
  })

  it("session without featureName does NOT survive reload", async () => {
    await store.create("ephemeral")
    await store.update("ephemeral", (d) => {
      d.iterationCount = 3
    })
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    expect(store2.get("ephemeral")).toBeNull()
  })

  it("load() reads multiple per-feature state files", async () => {
    writePerFeatureState(tmpDir, "billing", makeState("s1", "billing"))
    writePerFeatureState(tmpDir, "auth", makeState("s2", "auth"))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(2)
    expect(store2.get("s1")?.featureName).toBe("billing")
    expect(store2.get("s2")?.featureName).toBe("auth")
  })

  it("load() ignores subdirectories without workflow-state.json", async () => {
    writePerFeatureState(tmpDir, "billing", makeState("s1", "billing"))
    mkdirSync(join(tmpDir, "empty-dir"), { recursive: true })
    mkdirSync(join(tmpDir, "no-state-dir"), { recursive: true })
    writeFileSync(join(tmpDir, "no-state-dir", "other-file.txt"), "hello", "utf-8")

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(1)
  })

  it("load() discards per-feature state with wrong schemaVersion", async () => {
    const dir = join(tmpDir, "bad-feature")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({ schemaVersion: 999, sessionId: "bad", featureName: "bad-feature" }),
    )

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    expect(store2.get("bad")).toBeNull()
  })

  it("load() skips corrupt per-feature JSON without failing", async () => {
    // Write a valid state alongside a corrupt one
    writePerFeatureState(tmpDir, "good-feat", makeState("s-good", "good-feat"))
    const corruptDir = join(tmpDir, "corrupt-feat")
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, "workflow-state.json"), "{{not json!!", "utf-8")

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    if (!result.success) return
    // Good state loaded, corrupt one skipped
    expect(result.count).toBe(1)
    expect(store2.get("s-good")).not.toBeNull()
  })

  it("load() skips per-feature file whose featureName doesn't match directory", async () => {
    // Directory is "billing" but state says featureName is "auth" — inconsistent
    writePerFeatureState(tmpDir, "billing", makeState("s-mismatch", "auth"))
    // Also write a valid one for comparison
    writePerFeatureState(tmpDir, "good-feat", makeState("s-good", "good-feat"))

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(1)
    expect(store2.get("s-good")).not.toBeNull()
    expect(store2.get("s-mismatch")).toBeNull()
  })

  it("load() returns StoreLoadError when backend.list() throws", async () => {
    // Create a backend whose list() always throws
    const failingBackend = {
      async read() { return null },
      async write() {},
      async remove() {},
      async list(): Promise<string[]> { throw new Error("disk on fire") },
      async lock() { return { async release() {} } },
    }
    const store2 = createSessionStateStore(failingBackend)
    const result = await store2.load()
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("disk on fire")
  })

  it("load() applies field migrations to per-feature files", async () => {
    // Write a v5 state as a per-feature file
    const dir = join(tmpDir, "old-feature")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 5,
        sessionId: "v5-pf",
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
        featureName: "old-feature",
      }),
    )

    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const result = await store2.load()
    expect(result.success).toBe(true)
    const loaded = store2.get("v5-pf")
    expect(loaded).not.toBeNull()
    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded?.currentTaskId).toBeNull()
    expect(loaded?.feedbackHistory).toEqual([])
    expect(loaded?.userGateMessageReceived).toBe(false)
  })

  it("delete() removes per-feature state file but preserves directory", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "doomed"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    expect(existsSync(join(tmpDir, "doomed", "workflow-state.json"))).toBe(true)
    await store.delete("s1")
    expect(store.get("s1")).toBeNull()
    // State file removed
    expect(existsSync(join(tmpDir, "doomed", "workflow-state.json"))).toBe(false)
    // Directory preserved (may contain artifacts)
    expect(existsSync(join(tmpDir, "doomed"))).toBe(true)
  })

  it("delete() for session without featureName only removes from memory", async () => {
    await store.create("mem-only")
    await store.delete("mem-only")
    expect(store.get("mem-only")).toBeNull()
    // No files or directories created
    const entries = readdirSync(tmpDir)
    expect(entries).toEqual([])
  })

  it("concurrent updates to different features write independent files", async () => {
    await store.create("s1")
    await store.create("s2")
    await store.update("s1", (d) => {
      d.featureName = "feat-a"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    await store.update("s2", (d) => {
      d.featureName = "feat-b"
      d.mode = "REFACTOR"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })

    // Fire concurrent updates to different features
    const pa = store.update("s1", (d) => { d.approvalCount = 10 })
    const pb = store.update("s2", (d) => { d.approvalCount = 20 })
    await Promise.all([pa, pb])

    // Both should persist independently
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    expect(store2.get("s1")?.approvalCount).toBe(10)
    expect(store2.get("s2")?.approvalCount).toBe(20)
  })

  it("findByFeatureName works with per-feature storage", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "find-me"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    const found = store.findByFeatureName("find-me")
    expect(found).not.toBeNull()
    expect(found?.sessionId).toBe("s1")
    expect(store.findByFeatureName("nonexistent")).toBeNull()
  })

  it("findPersistedByFeatureName reads persisted state not loaded in memory", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "persisted-find-me"
      d.mode = "GREENFIELD"
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
    })

    const freshStore = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    const found = await freshStore.findPersistedByFeatureName("persisted-find-me")

    expect(found).not.toBeNull()
    expect(found?.sessionId).toBe("s1")
    expect(found?.phase).toBe("INTERFACES")
    expect(await freshStore.findPersistedByFeatureName("missing-feature")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Legacy single-file migration (Phase 2a)
// ---------------------------------------------------------------------------

describe("SessionStateStore — legacy migration", () => {
  let legacyFile: string
  let baseDir: string

  beforeEach(() => {
    legacyFile = join(tmpDir, "legacy", "workflow-state.json")
    baseDir = join(tmpDir, "openartisan")
    mkdirSync(join(tmpDir, "legacy"), { recursive: true })
    mkdirSync(baseDir, { recursive: true })
  })

  it("migrates legacy single-file sessions with featureName to per-feature files", async () => {
    const s1 = makeState("s1", "billing")
    const s2 = makeState("s2", "auth")
    writeLegacyState(legacyFile, { s1, s2 })

    const backend = createFileSystemStateBackend(baseDir)
    await migrateLegacyStateFile(backend, legacyFile)
    const migStore = createSessionStateStore(backend)
    const result = await migStore.load()

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(2)
    expect(migStore.get("s1")?.featureName).toBe("billing")
    expect(migStore.get("s2")?.featureName).toBe("auth")

    // Per-feature files created
    expect(existsSync(join(baseDir, "billing", "workflow-state.json"))).toBe(true)
    expect(existsSync(join(baseDir, "auth", "workflow-state.json"))).toBe(true)

    // Legacy file deleted
    expect(existsSync(legacyFile)).toBe(false)
  })

  it("legacy sessions without featureName are returned as memoryOnly", async () => {
    const s1 = makeState("s1", "billing")
    const s2 = makeState("s2", null) // no featureName
    writeLegacyState(legacyFile, { s1, s2 })

    const backend = createFileSystemStateBackend(baseDir)
    const migration = await migrateLegacyStateFile(backend, legacyFile)

    // s1 migrated to backend, s2 returned as memoryOnly
    expect(migration.migrated).toEqual(["billing"])
    expect(migration.memoryOnly).toHaveLength(1)
    expect(migration.memoryOnly[0]?.id).toBe("s2")

    // Only s1 has a per-feature file
    expect(existsSync(join(baseDir, "billing", "workflow-state.json"))).toBe(true)
    const entries = readdirSync(baseDir)
    expect(entries).toEqual(["billing"])
  })

  it("handles missing legacy file gracefully", async () => {
    const backend = createFileSystemStateBackend(baseDir)
    const migration = await migrateLegacyStateFile(backend, "/nonexistent/file.json")
    expect(migration.migrated).toEqual([])
    expect(migration.memoryOnly).toEqual([])
  })

  it("handles corrupt legacy file gracefully", async () => {
    writeFileSync(legacyFile, "{{not valid json!!", "utf-8")
    const backend = createFileSystemStateBackend(baseDir)
    const migration = await migrateLegacyStateFile(backend, legacyFile)
    expect(migration.migrated).toEqual([])
    expect(migration.memoryOnly).toEqual([])
  })

  it("applies field migrations during legacy migration + load", async () => {
    const v5State = {
      schemaVersion: 5,
      sessionId: "v5-leg",
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
      featureName: "legacy-feat",
    }
    writeLegacyState(legacyFile, { "v5-leg": v5State })

    const backend = createFileSystemStateBackend(baseDir)
    await migrateLegacyStateFile(backend, legacyFile)
    const migStore = createSessionStateStore(backend)
    const result = await migStore.load()
    expect(result.success).toBe(true)
    const loaded = migStore.get("v5-leg")
    expect(loaded).not.toBeNull()
    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded?.currentTaskId).toBeNull()
    expect(loaded?.feedbackHistory).toEqual([])
    expect(loaded?.featureName).toBe("legacy-feat")
  })

  it("does not re-migrate if legacy file already gone", async () => {
    // First migration
    const s1 = makeState("s1", "billing")
    writeLegacyState(legacyFile, { s1 })
    const backend = createFileSystemStateBackend(baseDir)
    await migrateLegacyStateFile(backend, legacyFile)
    expect(existsSync(legacyFile)).toBe(false)

    // Second migration — legacy file gone, no-op
    const migration2 = await migrateLegacyStateFile(backend, legacyFile)
    expect(migration2.migrated).toEqual([])

    // Store still loads the per-feature file
    const migStore = createSessionStateStore(backend)
    const result = await migStore.load()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(1)
    expect(migStore.get("s1")?.featureName).toBe("billing")
  })

  it("per-feature files take precedence over legacy file for same feature", async () => {
    // Write a per-feature file with approvalCount=10
    writePerFeatureState(baseDir, "billing", makeState("s1", "billing", { approvalCount: 10 }))
    // Write a legacy file with same session but approvalCount=0
    writeLegacyState(legacyFile, { s1: makeState("s1", "billing", { approvalCount: 0 }) })

    const backend = createFileSystemStateBackend(baseDir)
    await migrateLegacyStateFile(backend, legacyFile)
    const migStore = createSessionStateStore(backend)
    const result = await migStore.load()
    expect(result.success).toBe(true)
    // The per-feature file should win (migration skips existing features)
    expect(migStore.get("s1")?.approvalCount).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// File-level locking (Phase 2b)
// ---------------------------------------------------------------------------

describe("SessionStateStore — file-level locking", () => {
  it("creates and cleans up .lock file during update", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "lock-test"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    // After update completes, lock file should be cleaned up
    expect(existsSync(join(tmpDir, "lock-test", ".lock"))).toBe(false)
    // State file should exist
    expect(existsSync(join(tmpDir, "lock-test", "workflow-state.json"))).toBe(true)
  })

  it("creates and cleans up .lock file during delete", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "del-lock"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })
    await store.delete("s1")
    // Lock file should be cleaned up
    expect(existsSync(join(tmpDir, "del-lock", ".lock"))).toBe(false)
  })

  it("concurrent updates to same feature are serialized via file lock", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "contended"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })

    // Fire many concurrent updates to the same feature
    const updates = Array.from({ length: 10 }, (_, i) =>
      store.update("s1", (d) => { d.approvalCount = i + 1 }),
    )
    await Promise.all(updates)

    // All should have applied without corruption
    const final = store.get("s1")
    expect(final?.approvalCount).toBeGreaterThanOrEqual(1)
    expect(final?.approvalCount).toBeLessThanOrEqual(10)

    // Verify disk state matches memory
    const store2 = createSessionStateStore(createFileSystemStateBackend(tmpDir))
    await store2.load()
    expect(store2.get("s1")?.approvalCount).toBe(final?.approvalCount)
  })

  it("stale lock from dead PID is cleaned up automatically", async () => {
    await store.create("s1")
    await store.update("s1", (d) => {
      d.featureName = "stale-lock"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })

    // Simulate a stale lock left by a dead process
    const lockPath = join(tmpDir, "stale-lock", ".lock")
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }), "utf-8")
    expect(existsSync(lockPath)).toBe(true)

    // Update should succeed — stale lock is auto-cleaned
    await store.update("s1", (d) => { d.approvalCount = 42 })
    expect(store.get("s1")?.approvalCount).toBe(42)
    // Lock file cleaned up after update
    expect(existsSync(lockPath)).toBe(false)
  })

  it("lock is not created for memory-only sessions (no featureName)", async () => {
    await store.create("mem-only")
    await store.update("mem-only", (d) => { d.iterationCount = 5 })
    // No directories or lock files created
    const entries = readdirSync(tmpDir)
    expect(entries).toEqual([])
  })
})
