/**
 * open-artisan-state-backend-db.ts — StateBackend facade over OpenArtisanRepository.
 *
 * This lets the existing SessionStateStore runtime be pointed at the DB-backed
 * repository without changing its public contract. The DB stores canonical
 * workflow records; this backend exposes legacy JSON strings as a compatibility
 * projection for incremental runtime wiring.
 */

import type { OpenArtisanDbResult, OpenArtisanRepository } from "./open-artisan-repository"
import type { WorkflowState } from "./workflow-state-types"
import type { StateBackend } from "./state-backend-types"
import { exportLegacyWorkflowState, importLegacyWorkflowState } from "./open-artisan-json-compat"
import { parseAndMigrateWorkflowStateJson } from "./session-state"

export interface OpenArtisanDbStateBackendOptions {
  lockTimeoutMs?: number
  lockPollMs?: number
  allowSameProcessLockReclaim?: boolean
  legacyFallback?: StateBackend
}

function assertOk<T>(result: OpenArtisanDbResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function isRecoverableDbStateFailure(result: OpenArtisanDbResult<unknown>): boolean {
  return !result.ok && (result.error.retryable || result.error.code === "lock-timeout" || result.error.code === "storage-failure")
}

function effectiveFeatureName(state: WorkflowState): string {
  return state.featureName ?? state.sessionId
}

export function createOpenArtisanDbStateBackend(
  repository: OpenArtisanRepository,
  _stateDir: string,
  options: OpenArtisanDbStateBackendOptions = {},
): StateBackend {
  async function importLegacyFallback(featureName: string): Promise<string | null> {
    if (!options.legacyFallback) return null
    const raw = await options.legacyFallback.read(featureName)
    if (!raw) return null
    const { state, changed } = parseAndMigrateWorkflowStateJson(raw)
    if (!state) return raw
    if (effectiveFeatureName(state) !== featureName) return raw
    const importResult = await importLegacyWorkflowState(repository, state, { bestEffort: true })
    if (!importResult.ok && !isRecoverableDbStateFailure(importResult)) {
      throw new Error(importResult.error.message)
    }
    const migratedRaw = changed ? JSON.stringify(state) : raw
    if (changed) {
      try {
        await options.legacyFallback.write(featureName, migratedRaw)
      } catch {
        // Compatibility mirror writes are best-effort; the DB import above is canonical.
      }
    }
    return migratedRaw
  }

  return {
    dispose() {
      return repository.dispose()
    },

    async read(featureName: string) {
      const projectionResult = await repository.getWorkflowByFeature(featureName)
      if (!projectionResult.ok) throw new Error(projectionResult.error.message)
      const projection = assertOk(projectionResult)
      if (!projection) return importLegacyFallback(featureName)
      const stateResult = await exportLegacyWorkflowState(repository, projection.workflow.id)
      if (!stateResult.ok) throw new Error(stateResult.error.message)
      const state = assertOk(stateResult)
      return JSON.stringify(state)
    },

    async write(_featureName: string, data: string) {
      const { state } = parseAndMigrateWorkflowStateJson(data)
      if (!state) {
        throw new Error(`StateBackend write for "${_featureName}" is not a valid workflow state`)
      }
      if (effectiveFeatureName(state) !== _featureName) {
        throw new Error(
          `StateBackend feature mismatch: write key "${_featureName}" does not match state feature "${effectiveFeatureName(state)}"`,
        )
      }
      const importResult = await importLegacyWorkflowState(repository, state, { bestEffort: true })
      if (!importResult.ok) {
        throw new Error(importResult.error.message)
      }
      if (options.legacyFallback) {
        try {
          await options.legacyFallback.write(_featureName, JSON.stringify(state))
        } catch {
          // Do not report failure after the canonical DB write has committed.
        }
      }
    },

    async remove(featureName: string) {
      const projectionResult = await repository.getWorkflowByFeature(featureName)
      if (projectionResult.ok) {
        const projection = projectionResult.value
        if (projection) assertOk(await repository.deleteWorkflow(projection.workflow.id))
      } else if (!options.legacyFallback || !isRecoverableDbStateFailure(projectionResult)) {
        throw new Error(projectionResult.error.message)
      }
      if (options.legacyFallback) await options.legacyFallback.remove(featureName)
    },

    async list() {
      const listResult = await repository.listWorkflows()
      const features = new Set(listResult.ok ? listResult.value.map((workflow) => workflow.featureName) : [])
      if (!listResult.ok) {
        throw new Error(listResult.error.message)
      }
      if (options.legacyFallback) {
        for (const featureName of await options.legacyFallback.list()) features.add(featureName)
      }
      return [...features]
    },

    async lock(featureName: string) {
      const lockResult = await repository.lockWorkflowState(featureName, {
        ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
        ...(options.lockPollMs === undefined ? {} : { pollMs: options.lockPollMs }),
        ...(options.allowSameProcessLockReclaim === undefined ? {} : { allowSameProcessReclaim: options.allowSameProcessLockReclaim }),
      })
      if (lockResult.ok) return lockResult.value
      throw new Error(lockResult.error.message)
    },
  }
}
