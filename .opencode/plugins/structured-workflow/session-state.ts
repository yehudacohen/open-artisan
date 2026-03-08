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
    escapePending: false,
    pendingRevisionSteps: null,
  }
}

function cloneState(s: WorkflowState): WorkflowState {
  return JSON.parse(JSON.stringify(s)) as WorkflowState
}

function isValidState(s: unknown): s is WorkflowState {
  if (!s || typeof s !== "object") return false
  const obj = s as Record<string, unknown>
  return obj["schemaVersion"] === SCHEMA_VERSION && typeof obj["sessionId"] === "string"
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
        await writeAll(stateFile, memory)
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
        await writeAll(stateFile, memory)
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
          const migrated = value as Record<string, unknown>
          migrated["escapePending"] ??= false
          migrated["pendingRevisionSteps"] ??= null
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
      await writeAll(stateFile, memory)
    },
  }
}
