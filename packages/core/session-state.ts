/**
 * session-state.ts — In-memory store with pluggable persistence backend.
 * All mutation goes through update() so invariants can be validated before write.
 *
 * The store handles: in-memory caching, schema migration, validation,
 * in-process serialization (promise chains), and post-update hooks.
 *
 * The StateBackend handles: I/O and cross-process locking.
 * See state-backend-fs.ts for the filesystem implementation.
 *
 * Fixes:
 * - G4: update() validates invariants via validateWorkflowState() before persisting
 * - G5: load() clears in-memory store before populating to avoid resurrection of stale sessions
 */
import {
  SCHEMA_VERSION,
  validateWorkflowState,
  type WorkflowState,
  type SessionStateStore,
  type StateBackend,
  type StoreLoadResult,
  type StoreLoadError,
} from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(sessionId: string): WorkflowState {
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
    currentTaskId: null,
    feedbackHistory: [],
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
    artifactDiskPaths: {},
    featureName: null,
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
  }
}

function cloneState(s: WorkflowState): WorkflowState {
  return structuredClone(s)
}

/**
 * Accepts states at the current schema version OR at any previous version
 * that the migration block below can bring up to date.
 * A state with an unknown future schemaVersion is rejected.
 */
function isValidState(s: unknown): s is WorkflowState {
  if (!s || typeof s !== "object") return false
  const obj = s as Record<string, unknown>
  const v = obj["schemaVersion"] as number | undefined
  return typeof v === "number" && v >= 1 && v <= SCHEMA_VERSION && typeof obj["sessionId"] === "string"
}

/**
 * Apply schema migrations to a raw state object.
 * Fills in fields added in later schema versions with safe defaults.
 * Mutates the object in place.
 */
function migrateState(migrated: Record<string, unknown>): void {
  // v1 → v2: add orchestratorSessionId, intentBaseline, escapePending, pendingRevisionSteps
  migrated["orchestratorSessionId"] ??= null
  migrated["intentBaseline"] ??= null
  migrated["escapePending"] ??= false
  migrated["pendingRevisionSteps"] ??= null
  // v2 → v3: add modeDetectionNote
  migrated["modeDetectionNote"] ??= null
  // v3 → v4: add discoveryReport
  migrated["discoveryReport"] ??= null
  // v4 → v5: add implDag
  migrated["implDag"] ??= null
  // v5 → v6: add currentTaskId, feedbackHistory
  migrated["currentTaskId"] ??= null
  migrated["feedbackHistory"] ??= []
  // v6 → v7: add phaseApprovalCounts
  migrated["phaseApprovalCounts"] ??= {}
  // v7 → v8: add userGateMessageReceived
  migrated["userGateMessageReceived"] ??= false
  // v8 → v9: add artifactDiskPaths
  migrated["artifactDiskPaths"] ??= {}
  // v9 → v10: add featureName
  migrated["featureName"] ??= null
  // v10 → v11: add revisionBaseline
  migrated["revisionBaseline"] ??= null
  // v11 → v12: add TaskCategory/HumanGateInfo on implDag nodes (no top-level field — node fields are optional)
  // v12 → v13: add activeAgent
  migrated["activeAgent"] ??= null
  // v13 → v14: add taskCompletionInProgress (transient lock — always clear on load)
  migrated["taskCompletionInProgress"] = null
  // v14 → v15: add taskReviewCount, pendingFeedback
  migrated["taskReviewCount"] ??= 0
  // pendingFeedback is transient (crash-safe store for in-flight orchestrator calls).
  // Always clear on load — if the process crashed mid-orchestrator, the feedback is
  // lost and the user will need to re-submit. This is preferable to silently replaying
  // a stale feedback text through a potentially different orchestrator classification.
  migrated["pendingFeedback"] = null
  // v15 → v16: add userMessages
  migrated["userMessages"] ??= []
  // v16 → v17: add cachedPriorState
  migrated["cachedPriorState"] = null // Always clear on load - transient cache
  // v17 → v18: add priorWorkflowChecked + sessionModel
  migrated["priorWorkflowChecked"] = false
  migrated["sessionModel"] ??= null
  // v18 → v19: add reviewArtifactHash + latestReviewResults
  migrated["reviewArtifactHash"] ??= null
  migrated["latestReviewResults"] ??= null
  // v19 → v20: storage format change only (per-feature files). No new fields to migrate.
  // v20 → v21: add parentWorkflow, childWorkflows, concurrency (sub-workflows)
  migrated["parentWorkflow"] ??= null
  migrated["childWorkflows"] ??= []
  // Backfill delegatedAt on childWorkflows entries that lack it (pre-3d states)
  const cws = migrated["childWorkflows"]
  if (Array.isArray(cws)) {
    for (const cw of cws) {
      if (cw && typeof cw === "object" && !("delegatedAt" in cw)) {
        (cw as Record<string, unknown>)["delegatedAt"] = new Date().toISOString()
      }
    }
  }
  if (!migrated["concurrency"] || typeof migrated["concurrency"] !== "object") {
    migrated["concurrency"] = { maxParallelTasks: 1 }
  }
  // retryCount is transient — reset on load so the idle handler starts fresh.
  // If the agent was stuck before a restart, it deserves a clean retry budget.
  migrated["retryCount"] = 0
  // Defensive: strip relative paths from fileAllowlist. Pre-normalization-fix
  // sessions may have persisted relative paths. At load time we don't have the
  // project directory to resolve them, so we remove them. The `select_mode`
  // handler will re-normalize with the correct cwd if needed.
  const fa = migrated["fileAllowlist"]
  if (Array.isArray(fa)) {
    migrated["fileAllowlist"] = fa.filter((p: unknown) => typeof p === "string" && p.startsWith("/"))
  }
  // Always stamp with current schema version after migration
  migrated["schemaVersion"] = SCHEMA_VERSION
}

/**
 * Validate and migrate a raw state value. Returns the state if valid, null otherwise.
 */
function validateAndMigrate(value: unknown): WorkflowState | null {
  if (!isValidState(value)) return null
  migrateState(value as unknown as Record<string, unknown>)
  const validationError = validateWorkflowState(value)
  if (validationError) return null
  return value
}

/**
 * Parse and validate a raw JSON string into a WorkflowState.
 * Applies schema migrations. Returns null if invalid.
 */
function parseAndMigrate(json: string): WorkflowState | null {
  try {
    return validateAndMigrate(JSON.parse(json) as unknown)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Optional callback invoked after every successful state mutation.
 * Used by the status-writer to update the status file on every transition.
 */
export type PostUpdateCallback = (state: WorkflowState, projectDir: string) => void

/** Project directory, set by the plugin entry point. Used by the post-update hook. */
let _projectDir: string | null = null
/** Post-update callback, set by the plugin entry point. */
let _postUpdateCallback: PostUpdateCallback | null = null

export function setPostUpdateHook(callback: PostUpdateCallback, projectDir: string): void {
  _postUpdateCallback = callback
  _projectDir = projectDir
}

/**
 * Create a session state store backed by a StateBackend.
 *
 * The store manages in-memory state, schema migration, validation,
 * and in-process serialization. The backend handles persistence I/O
 * and cross-process locking.
 *
 * Sessions without a featureName (pre-MODE_SELECT) are held in memory only.
 * Once featureName is set, state is persisted through the backend.
 *
 * @param backend - The persistence backend (e.g., FileSystemStateBackend).
 */
export function createSessionStateStore(backend: StateBackend): SessionStateStore {
  const memory = new Map<string, WorkflowState>()

  // Per-feature in-process write locks — serialise concurrent update() calls.
  // Keyed by featureName for persisted sessions, sessionId for memory-only sessions.
  // Each key maps to a promise chain; new operations are chained on top.
  const locks = new Map<string, Promise<unknown>>()

  /** Returns the lock key for a session: featureName if persisted, sessionId if memory-only. */
  function lockKeyFor(sessionId: string): string {
    const state = memory.get(sessionId)
    return state?.featureName ?? sessionId
  }

  function acquireInProcessLock(key: string, work: () => Promise<unknown>): Promise<unknown> {
    const current = locks.get(key) ?? Promise.resolve()
    const next = current.then(work, work) // always proceed even if previous rejected
    locks.set(key, next)
    return next
  }

  /**
   * Persist a session's state via the backend.
   * No-op if featureName is null (memory-only session).
   * Acquires a backend lock for cross-process safety.
   */
  async function persistState(state: WorkflowState): Promise<void> {
    if (state.featureName) {
      const { release } = await backend.lock(state.featureName)
      try {
        await backend.write(state.featureName, JSON.stringify(state, null, 2))
      } finally {
        await release()
      }
    }
  }

  return {
    get(sessionId: string): WorkflowState | null {
      return memory.get(sessionId) ?? null
    },

    findByFeatureName(featureName: string): WorkflowState | null {
      for (const state of memory.values()) {
        if (state.featureName === featureName) {
          return cloneState(state)
        }
      }
      return null
    },

    async create(sessionId: string): Promise<WorkflowState> {
      if (memory.has(sessionId)) {
        throw new Error(`Session "${sessionId}" already exists`)
      }
      // N1 fix: route through in-process lock so concurrent create+update calls are serialised.
      // New sessions have no featureName yet, so lock by sessionId.
      return acquireInProcessLock(sessionId, async () => {
        if (memory.has(sessionId)) {
          throw new Error(`Session "${sessionId}" already exists`)
        }
        const state = freshState(sessionId)
        memory.set(sessionId, state)
        // Memory-only — no disk write. Sessions start without featureName,
        // so there's no per-feature directory to write to yet.
        return cloneState(state)
      }) as Promise<WorkflowState>
    },

    async update(
      sessionId: string,
      mutator: (draft: WorkflowState) => void,
    ): Promise<WorkflowState> {
      // Serialise through the per-feature in-process lock chain.
      // The lock key is featureName if set (all writes to the same file serialize),
      // or sessionId for memory-only sessions.
      return acquireInProcessLock(lockKeyFor(sessionId), async () => {
        const current = memory.get(sessionId)
        if (!current) {
          throw new Error(`Session "${sessionId}" not found`)
        }
        // Apply mutation to a clone — never mutate in place
        const draft = cloneState(current)
        mutator(draft)

        // G4: Validate invariants before persisting
        const validationError = validateWorkflowState(draft)
        if (validationError) {
          throw new Error(`State mutation produced invalid state for session "${sessionId}": ${validationError}`)
        }

        // Replace in memory, then persist via backend if featureName is set.
        memory.set(sessionId, draft)
        await persistState(draft)
        // Fire post-update hook (status file writer) — non-fatal
        if (_postUpdateCallback && _projectDir) {
          try { _postUpdateCallback(draft, _projectDir) } catch { /* non-fatal */ }
        }
        return cloneState(draft)
      }) as Promise<WorkflowState>
    },

    async load(): Promise<StoreLoadResult | StoreLoadError> {
      try {
        // G5: Clear in-memory store before populating — prevents stale session resurrection
        memory.clear()
        locks.clear()

        // Load all persisted states from the backend
        const features = await backend.list()
        for (const featureName of features) {
          const raw = await backend.read(featureName)
          if (!raw) continue
          const state = parseAndMigrate(raw)
          // Guard: state.featureName must match the backend key. If it doesn't,
          // the data is inconsistent and loading it would cause writes to go to
          // a different location, orphaning this entry.
          if (state && state.featureName === featureName) {
            memory.set(state.sessionId, state)
          }
        }

        return { success: true, count: memory.size }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async delete(sessionId: string): Promise<void> {
      const lockKey = lockKeyFor(sessionId)
      // Serialise through the in-process lock to prevent races with concurrent update().
      await acquireInProcessLock(lockKey, async () => {
        const state = memory.get(sessionId)
        memory.delete(sessionId)
        // Remove persisted state via backend
        if (state?.featureName) {
          const { release } = await backend.lock(state.featureName)
          try {
            await backend.remove(state.featureName)
          } finally {
            await release()
          }
        }
      })
      // Clean up the lock chain AFTER the lock's work completes.
      locks.delete(lockKey)
    },
  }
}
