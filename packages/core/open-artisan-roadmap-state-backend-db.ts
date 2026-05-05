/**
 * open-artisan-roadmap-state-backend-db.ts — RoadmapStateBackend facade over OpenArtisanRepository.
 */

import type { OpenArtisanRepository } from "./open-artisan-repository"
import { roadmapError, roadmapOk, type RoadmapErrorCode, type RoadmapStateBackend } from "./roadmap-types"

export interface OpenArtisanDbRoadmapStateBackendOptions {
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
  _stateDir: string,
  options: OpenArtisanDbRoadmapStateBackendOptions = {},
): RoadmapStateBackend {
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
        const result = await repository.lockRoadmap({
          ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
          ...(options.lockPollMs === undefined ? {} : { pollMs: options.lockPollMs }),
        })
        return result.ok ? roadmapOk(result.value) : roadmapError("lock-timeout", result.error.message, result.error.retryable)
      } catch (error) {
        return roadmapError("lock-timeout", error instanceof Error ? error.message : "Failed to lock roadmap", true)
      }
    },
  }
}
