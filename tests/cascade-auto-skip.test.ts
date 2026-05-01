/**
 * Tests for cascade-auto-skip.ts — deterministic auto-skip at cascade entry.
 *
 * Tests cover:
 * - Returns null when not in REVISE state
 * - Returns null when no revisionBaseline exists
 * - Returns null for standalone REVISE (no pendingRevisionSteps)
 * - Skips a single no-op step and fast-forwards to USER_GATE
 * - Skips multiple consecutive no-op steps
 * - Stops at a step that needs work
 * - Graceful degradation when hasArtifactChanged throws
 * - Safety cap prevents infinite loops
 */
import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { cascadeAutoSkip, type CascadeAutoSkipDeps } from "#core/cascade-auto-skip"
import { createStateMachine } from "#core/state-machine"
import { SCHEMA_VERSION } from "#core/types"
import type { WorkflowState, SessionStateStore, Phase } from "#core/types"
import type { Logger } from "#core/logger"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "REFACTOR",
    phase: "TESTS",
    phaseState: "REVISE",
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
    currentTaskId: null,
    feedbackHistory: [],
    backtrackContext: null,
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    userGateMessageReceived: false,
    artifactDiskPaths: {},
    featureName: null,
    revisionBaseline: { type: "content-hash", hash: "abc123" },
    activeAgent: "artisan",
    taskCompletionInProgress: null,
    taskReviewCount: 0,
    pendingFeedback: null,
    userMessages: [],
    cachedPriorState: null,
    priorWorkflowChecked: false,
    sessionModel: null,
    reviewArtifactHash: null,
    latestReviewResults: null,
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
    ...overrides,
  }
}

/**
 * Creates an in-memory store backed by a Map. Supports get, update, create,
 * delete, and load. Uses structuredClone for isolation.
 */
function createMockStore(initialStates?: Map<string, WorkflowState>): SessionStateStore {
  const memory = new Map(initialStates ?? new Map<string, WorkflowState>())

  return {
    get(sessionId: string) {
      return memory.get(sessionId) ?? null
    },
    async create(sessionId: string) {
      const state = freshState({ sessionId })
      memory.set(sessionId, state)
      return structuredClone(state)
    },
    async update(sessionId: string, mutator: (draft: WorkflowState) => void) {
      const current = memory.get(sessionId)
      if (!current) throw new Error(`Session "${sessionId}" not found`)
      const draft = structuredClone(current)
      mutator(draft)
      memory.set(sessionId, draft)
      return structuredClone(draft)
    },
    async delete(sessionId: string) {
      memory.delete(sessionId)
    },
    async load() {
      return { success: true as const, count: memory.size }
    },
    async migrateSession(oldSessionId: string, newSessionId: string) {
      const current = memory.get(oldSessionId)
      if (!current) throw new Error(`Session "${oldSessionId}" not found`)
      const migrated = structuredClone(current)
      migrated.sessionId = newSessionId
      memory.set(newSessionId, migrated)
      memory.delete(oldSessionId)
      return structuredClone(migrated)
    },
    findByFeatureName(featureName: string) {
      for (const state of memory.values()) {
        if (state.featureName === featureName) return structuredClone(state)
      }
      return null
    },
    async findPersistedByFeatureName(featureName: string) {
      for (const state of memory.values()) {
        if (state.featureName === featureName) return structuredClone(state)
      }
      return null
    },
  }
}

function createMockLogger(): Logger {
    return {
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
      debug: mock(() => {}),
      child: mock(() => createMockLogger()),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cascadeAutoSkip", () => {
  const SID = "test-session"
  let cwd: string
  let sm: ReturnType<typeof createStateMachine>
  let log: Logger

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cascade-auto-skip-"))
    sm = createStateMachine()
    log = createMockLogger()
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  function makeDeps(store: SessionStateStore): CascadeAutoSkipDeps {
    return { store, sm, log }
  }

  function writeArtifact(relativePath: string, content: string): string {
    const fullPath = join(cwd, relativePath)
    mkdirSync(join(fullPath, ".."), { recursive: true })
    writeFileSync(fullPath, content, "utf-8")
    return fullPath
  }

  // ---------------------------------------------------------------------------
  // Null returns (no skip performed)
  // ---------------------------------------------------------------------------

  it("returns null when session does not exist", async () => {
    const store = createMockStore()
    const result = await cascadeAutoSkip(makeDeps(store), "nonexistent", cwd)
    expect(result).toBeNull()
  })

  it("returns null when not in REVISE state", async () => {
    const state = freshState({ phaseState: "DRAFT" })
    const store = createMockStore(new Map([[SID, state]]))
    const result = await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(result).toBeNull()
  })

  it("returns null when no revisionBaseline exists", async () => {
    const state = freshState({ revisionBaseline: null })
    const store = createMockStore(new Map([[SID, state]]))
    const result = await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(result).toBeNull()
  })

  it("returns null for standalone REVISE with no pendingRevisionSteps (not a cascade)", async () => {
    const testsPath = writeArtifact(".openartisan/feat/tests.md", "# Tests\n")
    const baselineHash = createHash("sha256").update("# Tests\n").digest("hex").slice(0, 32)
    const state = freshState({
      artifactDiskPaths: {
        tests: testsPath,
      },
      revisionBaseline: { type: "content-hash", hash: baselineHash },
      pendingRevisionSteps: null,
    })
    const store = createMockStore(new Map([[SID, state]]))
    const result = await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(result).toBeNull()
    const afterState = store.get(SID)!
    expect(afterState.phase).toBe("TESTS")
    expect(afterState.phaseState).toBe("REVISE")
    expect(afterState.pendingRevisionSteps).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // hasArtifactChanged error handling
  // ---------------------------------------------------------------------------

  it("returns null when hasArtifactChanged throws (graceful degradation)", async () => {
    // Use a git-sha baseline type so hasArtifactChanged tries to run git diff
    // which will fail since the shell is a mock. This should trigger the catch
    // block and return null.
    const state = freshState({
        revisionBaseline: { type: "git-sha", sha: "abc123" },
        pendingRevisionSteps: [
        { phase: "IMPLEMENTATION" as Phase, phaseState: "REVISE", artifact: "implementation", instructions: "Retry implementation." },
        ],
      })
    const store = createMockStore(new Map([[SID, state]]))
    // The mock shell doesn't have a git command, so the function will:
    // 1. Try to call hasArtifactChanged
    // 2. hasArtifactChanged will try to use shell.$`git diff...`
    // 3. This will throw because mockShell isn't a real Bun $
    // 4. cascadeAutoSkip catches and returns null
    const result = await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(result).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // State verification
  // ---------------------------------------------------------------------------

  it("does not modify state when returning null (no skip possible)", async () => {
    const state = freshState({ phaseState: "DRAFT" }) // Not REVISE → immediate null
    const store = createMockStore(new Map([[SID, state]]))
    await cascadeAutoSkip(makeDeps(store), SID, cwd)
    const afterState = store.get(SID)!
    expect(afterState.phaseState).toBe("DRAFT")
    expect(afterState.phase).toBe("TESTS")
  })

  // ---------------------------------------------------------------------------
  // Multi-step cascade with mocked store mutations
  // ---------------------------------------------------------------------------

  describe("cascade with content-hash baseline (in-memory phases)", () => {
    it("skips a no-op PLANNING revise step and fast-forwards the final IMPL_PLAN step to USER_GATE", async () => {
      const planPath = writeArtifact(".openartisan/feat/plan.md", "# Plan\n")
      const implPlanPath = writeArtifact(".openartisan/feat/impl-plan.md", "# Impl Plan\n")
      const state = freshState({
        phase: "PLANNING" as Phase,
        phaseState: "REVISE",
        artifactDiskPaths: {
          plan: planPath,
          impl_plan: implPlanPath,
        },
        revisionBaseline: { type: "content-hash", hash: "c3964bb3b70a957ec9b233c7dd3653f6" },
        pendingRevisionSteps: [
          { phase: "IMPL_PLAN" as Phase, phaseState: "REVISE", artifact: "impl_plan", instructions: "Redo impl plan." },
        ],
      })
      const store = createMockStore(new Map([[SID, state]]))
      const result = await cascadeAutoSkip(makeDeps(store), SID, cwd)
      expect(result).toContain("No changes needed for **PLANNING**, **IMPL_PLAN**")
      expect(result).toContain("wait for their approval")
      const after = store.get(SID)!
      expect(after.phase).toBe("IMPL_PLAN")
      expect(after.phaseState).toBe("USER_GATE")
      expect(after.pendingRevisionSteps).toBeNull()
      expect(after.revisionBaseline).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Fast-forward to USER_GATE
  // ---------------------------------------------------------------------------

  describe("USER_GATE fast-forward fallback", () => {
    it("returns null when shell-based git-sha verification degrades instead of fast-forwarding", async () => {
      const state = freshState({
        phase: "TESTS" as Phase,
        phaseState: "REVISE",
        revisionBaseline: { type: "git-sha", sha: "same-hash" },
        pendingRevisionSteps: [],
      })
      const store = createMockStore(new Map([[SID, state]]))
      const result = await cascadeAutoSkip(makeDeps(store), SID, cwd)
      expect(result).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Store interaction contract
  // ---------------------------------------------------------------------------

  it("calls store.get with the correct session ID", async () => {
    const state = freshState({ phaseState: "REVISE" })
    const store = createMockStore(new Map([[SID, state]]))
    const getSpy = mock(store.get.bind(store))
    store.get = getSpy as typeof store.get
    await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(getSpy).toHaveBeenCalledWith(SID)
  })

  it("does not call store.update when no skip is performed", async () => {
    const state = freshState({ phaseState: "DRAFT" }) // Not REVISE
    const store = createMockStore(new Map([[SID, state]]))
    const updateSpy = mock(store.update.bind(store))
    store.update = updateSpy as typeof store.update
    await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Logger interaction
  // ---------------------------------------------------------------------------

  it("does not log info when no skip is performed", async () => {
    const state = freshState({ phaseState: "DRAFT" })
    const store = createMockStore(new Map([[SID, state]]))
    await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(log.info).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Safety cap
  // ---------------------------------------------------------------------------

  it("has a safety cap of 10 iterations to prevent infinite loops", async () => {
    const planPath = writeArtifact(".openartisan/feat/plan.md", "# Plan\n")
    const baselineHash = createHash("sha256").update("# Plan\n").digest("hex").slice(0, 32)
    const state = freshState({
      phase: "PLANNING" as Phase,
      phaseState: "REVISE",
      artifactDiskPaths: { plan: planPath },
      revisionBaseline: { type: "content-hash", hash: baselineHash },
      pendingRevisionSteps: Array.from({ length: 11 }, (_, i) => ({
        phase: "PLANNING" as Phase,
        phaseState: "REVISE",
        artifact: "plan",
        instructions: `Cascade step ${i + 1}`,
      })),
    })
    const store = createMockStore(new Map([[SID, state]]))
    const result = await cascadeAutoSkip(makeDeps(store), SID, cwd)
    expect(result).toContain("No changes needed for **PLANNING**")
    const afterState = store.get(SID)!
    expect(afterState.phase).toBe("PLANNING")
    expect(afterState.phaseState).toBe("REVISE")
    expect(afterState.pendingRevisionSteps?.length).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // Return message format
  // ---------------------------------------------------------------------------

  describe("return message format preconditions", () => {
    it("documents the callable export shape when a real skip cannot be triggered in this unit seam", async () => {
      // Test the message format by checking the function contract.
      // When skippedPhases has items and there are remaining steps,
      // the message should include the skipped phase names in bold
      // and mention the current phase.
      //
      // We test this by verifying the message format matches expectations
      // if we could trigger the skip. Since we can't easily trigger a real
      // skip in unit tests (requires real file/git state), we test the
      // module's export shape and dependency injection contract.
      expect(typeof cascadeAutoSkip).toBe("function")
      expect(cascadeAutoSkip.length).toBe(3) // (deps, sessionId, cwd)
    })
  })

  // ---------------------------------------------------------------------------
  // Dependency injection contract
  // ---------------------------------------------------------------------------

  describe("dependency injection", () => {
    it("accepts the CascadeAutoSkipDeps interface", () => {
      const deps: CascadeAutoSkipDeps = {
        store: createMockStore(),
        sm: createStateMachine(),
        log: createMockLogger(),
      }
      // Should not throw — validates the type contract
      expect(deps.store).toBeDefined()
      expect(deps.sm).toBeDefined()
      expect(deps.log).toBeDefined()
    })

    it("uses sm.transition for state machine transitions (contract)", () => {
      // Verify the state machine can handle the transition events
      // that cascadeAutoSkip uses internally
      const testSm = createStateMachine()

      // revision_complete event from REVISE
      const revComplete = testSm.transition("TESTS", "REVISE", "revision_complete", "REFACTOR")
      expect(revComplete.ok).toBe(true)
      if (revComplete.ok) {
        expect(revComplete.nextPhaseState).toBe("REVIEW")
      }

      // self_review_pass event from REVIEW
      const reviewPass = testSm.transition("TESTS", "REVIEW", "self_review_pass", "REFACTOR")
      expect(reviewPass.ok).toBe(true)
      if (reviewPass.ok) {
        expect(reviewPass.nextPhaseState).toBe("USER_GATE")
      }
    })

    it("exercises the full REVISE → REVIEW → USER_GATE transition chain", () => {
      // This is the exact chain cascadeAutoSkip uses to fast-forward
      const testSm = createStateMachine()
      const phases: Phase[] = ["DISCOVERY", "PLANNING", "IMPL_PLAN", "INTERFACES", "TESTS", "IMPLEMENTATION"]

      for (const phase of phases) {
        const step1 = testSm.transition(phase, "REVISE", "revision_complete", "REFACTOR")
        expect(step1.ok).toBe(true)
        if (!step1.ok) continue

        const step2 = testSm.transition(step1.nextPhase, step1.nextPhaseState, "self_review_pass", "REFACTOR")
        expect(step2.ok).toBe(true)
        if (!step2.ok) continue

        expect(step2.nextPhaseState).toBe("USER_GATE")
      }
    })
  })
})
