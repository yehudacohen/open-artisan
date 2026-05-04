/**
 * open-artisan-roadmap-state-backend-db.ts — RoadmapStateBackend facade over OpenArtisanRepository.
 */

import { join } from "node:path"

import { acquireFileLock, type FileLockOptions } from "./state-backend-fs"
import type { OpenArtisanRepository } from "./open-artisan-repository"
import { roadmapError, roadmapOk, type RoadmapErrorCode, type RoadmapStateBackend } from "./types"

export interface OpenArtisanDbRoadmapStateBackendOptions {
  lockDir?: string
  lockTimeoutMs?: number
  lockPollMs?: number
}

function toRoadmapErrorCode(code: string): RoadmapErrorCode {
  switch (code) {
    case "not-found":
      return "not-found"
    case "invalid-input":
    case "invalid-state":
      return "invalid-document"
    case "schema-mismatch":
      return "schema-mismatch"
    default:
      return "storage-failure"
  }
}

function toRoadmapError(result: { error: { code: string; message: string; retryable: boolean } }) {
  return roadmapError(toRoadmapErrorCode(result.error.code), result.error.message, result.error.retryable)
}

export function createOpenArtisanDbRoadmapStateBackend(
  repository: OpenArtisanRepository,
  stateDir: string,
  options: OpenArtisanDbRoadmapStateBackendOptions = {},
): RoadmapStateBackend {
  const lockDir = options.lockDir ?? join(stateDir, "roadmap-db-locks")

  return {
    async createRoadmap(document) {
      const result = await repository.replaceRoadmap(document)
      return result.ok ? roadmapOk(result.value) : toRoadmapError(result)
    },

    async readRoadmap() {
      const result = await repository.readRoadmap()
      return result.ok ? roadmapOk(result.value) : toRoadmapError(result)
    },

    async updateRoadmap(document) {
      const result = await repository.replaceRoadmap(document)
      return result.ok ? roadmapOk(result.value) : toRoadmapError(result)
    },

    async deleteRoadmap() {
      const result = await repository.deleteRoadmap()
      return result.ok ? roadmapOk(null) : toRoadmapError(result)
    },

    async lockRoadmap() {
      try {
        const lockOptions: FileLockOptions = {}
        if (options.lockTimeoutMs !== undefined) lockOptions.timeoutMs = options.lockTimeoutMs
        if (options.lockPollMs !== undefined) lockOptions.pollMs = options.lockPollMs
        return roadmapOk(await acquireFileLock(lockDir, "roadmap namespace", lockOptions))
      } catch (error) {
        return roadmapError("lock-timeout", error instanceof Error ? error.message : "Failed to lock roadmap", true)
      }
    },
  }
}
