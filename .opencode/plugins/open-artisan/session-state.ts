/**
 * session-state.ts — In-memory store with JSON persistence.
 * All mutation goes through update() so invariants can be validated before write.
 *
 * Fixes:
 * - G4: update() now validates invariants via validateWorkflowState() before persisting
 * - G5: load() clears in-memory store before populating to avoid resurrection of stale sessions
 * - G22: update() serializes concurrent calls via a per-session promise chain (write lock)
 */
import { join } from "node:path"
import {
  SCHEMA_VERSION,
  validateWorkflowState,
  type WorkflowState,
  type SessionStateStore,
  type StoreLoadResult,
  type StoreLoadError,
} from "./types"

const STATE_FILE = "workflow-state.json"

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

async function writeAll(stateFile: string, map: Map<string, WorkflowState>): Promise<void> {
  const obj: Record<string, WorkflowState> = {}
  for (const [id, state] of map) {
    obj[id] = state
  }
  await Bun.write(stateFile, JSON.stringify(obj, null, 2))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionStateStore(dir: string): SessionStateStore {
  const stateFile = join(dir, STATE_FILE)
  const memory = new Map<string, WorkflowState>()

  // G22: Per-session write locks — serialise concurrent update() calls.
  // Each session ID maps to a promise chain; new updates are chained on top.
  const locks = new Map<string, Promise<unknown>>()

  // Global write lock — serialises all writeAll() calls across sessions.
  // Without this, concurrent updates to different sessions could interleave
  // writeAll() calls, causing one session's persisted changes to be lost.
  let globalWriteLock = Promise.resolve()

  async function serializedWrite(): Promise<void> {
    const work = async () => { await writeAll(stateFile, memory) }
    globalWriteLock = globalWriteLock.then(work, work)
    return globalWriteLock
  }

  function acquireLock(sessionId: string, work: () => Promise<unknown>): Promise<unknown> {
    const current = locks.get(sessionId) ?? Promise.resolve()
    const next = current.then(work, work) // always proceed even if previous rejected
    locks.set(sessionId, next)
    return next
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
      // N1 fix: route through acquireLock so concurrent create+update calls are serialised
      return acquireLock(sessionId, async () => {
        if (memory.has(sessionId)) {
          throw new Error(`Session "${sessionId}" already exists`)
        }
        const state = freshState(sessionId)
        memory.set(sessionId, state)
        await serializedWrite()
        return cloneState(state)
      }) as Promise<WorkflowState>
    },

    async update(
      sessionId: string,
      mutator: (draft: WorkflowState) => void,
    ): Promise<WorkflowState> {
      // G22: Serialise through the per-session lock chain
      return acquireLock(sessionId, async () => {
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

        // Persist the mutated draft, then replace in memory
        memory.set(sessionId, draft)
        await serializedWrite()
        return cloneState(draft)
      }) as Promise<WorkflowState>
    },

    async load(): Promise<StoreLoadResult | StoreLoadError> {
      try {
        const file = Bun.file(stateFile)
        const exists = await file.exists()

        // G5: Clear in-memory store before populating — prevents stale session resurrection
        memory.clear()
        locks.clear()

        if (!exists) return { success: true, count: 0 }

        const raw = await file.json() as Record<string, unknown>
        let count = 0
        for (const [id, value] of Object.entries(raw)) {
          // First gate: schema version + sessionId type check
          if (!isValidState(value)) continue
          // Migration: fill in fields added in later schema versions with safe defaults.
          // This allows states written before these fields existed to load correctly.
          const migrated = value as unknown as Record<string, unknown>
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
          // Second gate: full invariant validation (phase/phaseState combos, counts, etc.)
          const validationError = validateWorkflowState(value)
          if (validationError) continue // silently discard states that fail invariants
          memory.set(id, value)
          count++
        }
        return { success: true, count }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async delete(sessionId: string): Promise<void> {
      memory.delete(sessionId)
      locks.delete(sessionId)
      await serializedWrite()
    },
  }
}
