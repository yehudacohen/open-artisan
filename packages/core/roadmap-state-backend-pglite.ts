/**
 * roadmap-state-backend-pglite.ts — standalone roadmap state backend backed by the PGlite repository.
 *
 * Keeps roadmap persistence separate from WorkflowState persistence while preserving the existing
 * RoadmapStateBackend result-union semantics expected by bridge-owned roadmap services.
 */

import { join } from "node:path"

import { acquireFileLock, type FileLockOptions } from "./state-backend-fs"
import { createPGliteRoadmapRepository } from "./roadmap-repository-pglite"
import { roadmapError, roadmapOk, type RoadmapPGliteRepositoryOptions, type RoadmapRepository, type RoadmapStateBackend } from "./roadmap-types"

const ROADMAP_NAMESPACE_DIR = "roadmap"

export interface PGliteRoadmapStateBackendOptions extends RoadmapPGliteRepositoryOptions {
  roadmapLockDir?: string
}

export function createPGliteRoadmapStateBackend(
  stateDir: string,
  options: PGliteRoadmapStateBackendOptions,
  repository: RoadmapRepository = createPGliteRoadmapRepository(options),
): RoadmapStateBackend {
  const roadmapLockDir = options.roadmapLockDir ?? join(stateDir, ROADMAP_NAMESPACE_DIR)

  return {
    async dispose() {
      await repository.dispose()
    },

    async createRoadmap(document) {
      return repository.createRoadmap(document)
    },

    async readRoadmap() {
      return repository.readRoadmap()
    },

    async updateRoadmap(document) {
      return repository.updateRoadmap(document)
    },

    async deleteRoadmap() {
      return repository.deleteRoadmap()
    },

    async lockRoadmap() {
      try {
        const lockOptions: FileLockOptions = {}
        const timeoutMs = options.lockTimeoutMs
        const pollMs = options.lockPollMs
        if (timeoutMs !== undefined) {
          lockOptions.timeoutMs = timeoutMs
        }
        if (pollMs !== undefined) {
          lockOptions.pollMs = pollMs
        }

        return roadmapOk(await acquireFileLock(roadmapLockDir, "roadmap namespace", lockOptions))
      } catch (error) {
        if (error instanceof Error && error.message.includes("Failed to acquire file lock")) {
          return roadmapError("lock-timeout", error.message, true)
        }

        return roadmapError(
          "storage-failure",
          error instanceof Error ? error.message : "Failed to acquire roadmap lock",
          true,
        )
      }
    },
  }
}
