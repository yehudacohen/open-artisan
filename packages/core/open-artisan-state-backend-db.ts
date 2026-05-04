/**
 * open-artisan-state-backend-db.ts — StateBackend facade over OpenArtisanRepository.
 *
 * This lets the existing SessionStateStore runtime be pointed at the DB-backed
 * repository without changing its public contract. The DB stores canonical
 * workflow records; this backend exposes legacy JSON strings as a compatibility
 * projection for incremental runtime wiring.
 */

import { join } from "node:path"

import { acquireFileLock, type FileLockOptions } from "./state-backend-fs"
import type { OpenArtisanDbResult, OpenArtisanRepository } from "./open-artisan-repository"
import type { StateBackend, WorkflowState } from "./types"

export interface OpenArtisanDbStateBackendOptions {
  lockDir?: string
  lockTimeoutMs?: number
  lockPollMs?: number
  legacyFallback?: StateBackend
}

function assertOk<T>(result: OpenArtisanDbResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function effectiveFeatureName(state: WorkflowState): string {
  return state.featureName ?? state.sessionId
}

export function createOpenArtisanDbStateBackend(
  repository: OpenArtisanRepository,
  stateDir: string,
  options: OpenArtisanDbStateBackendOptions = {},
): StateBackend {
  const lockDir = options.lockDir ?? join(stateDir, "workflow-db-locks")

  async function importLegacyFallback(featureName: string): Promise<string | null> {
    if (!options.legacyFallback) return null
    const raw = await options.legacyFallback.read(featureName)
    if (!raw) return null
    let parsed: WorkflowState
    try {
      parsed = JSON.parse(raw) as WorkflowState
    } catch {
      return raw
    }
    if (effectiveFeatureName(parsed) !== featureName) return raw
    assertOk(await repository.importWorkflowState(parsed))
    return raw
  }

  return {
    async read(featureName: string) {
      const projection = assertOk(await repository.getWorkflowByFeature(featureName))
      if (!projection) return importLegacyFallback(featureName)
      const state = assertOk(await repository.exportWorkflowState(projection.workflow.id))
      return JSON.stringify(state)
    },

    async write(_featureName: string, data: string) {
      const parsed = JSON.parse(data) as WorkflowState
      if (effectiveFeatureName(parsed) !== _featureName) {
        throw new Error(
          `StateBackend feature mismatch: write key "${_featureName}" does not match state feature "${effectiveFeatureName(parsed)}"`,
        )
      }
      assertOk(await repository.importWorkflowState(parsed))
      if (options.legacyFallback) await options.legacyFallback.write(_featureName, data)
    },

    async remove(featureName: string) {
      const projection = assertOk(await repository.getWorkflowByFeature(featureName))
      if (projection) assertOk(await repository.deleteWorkflow(projection.workflow.id))
      if (options.legacyFallback) await options.legacyFallback.remove(featureName)
    },

    async list() {
      const features = new Set(assertOk(await repository.listWorkflows()).map((workflow) => workflow.featureName))
      if (options.legacyFallback) {
        for (const featureName of await options.legacyFallback.list()) features.add(featureName)
      }
      return [...features]
    },

    async lock(featureName: string) {
      const lockOptions: FileLockOptions = {}
      if (options.lockTimeoutMs !== undefined) lockOptions.timeoutMs = options.lockTimeoutMs
      if (options.lockPollMs !== undefined) lockOptions.pollMs = options.lockPollMs
      return acquireFileLock(lockDir, featureName, lockOptions)
    },
  }
}
