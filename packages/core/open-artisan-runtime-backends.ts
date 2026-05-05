/**
 * open-artisan-runtime-backends.ts — Runtime backend selection for workflow state.
 */

import { join } from "node:path"

import { createFileSystemStateBackend } from "./state-backend-fs"
import {
  createOpenArtisanDbStateBackend,
} from "./open-artisan-state-backend-db"
import {
  createPGliteOpenArtisanRepository,
} from "./open-artisan-repository-pglite"
import { createOpenArtisanDbRoadmapStateBackend } from "./open-artisan-roadmap-state-backend-db"
import { createOpenArtisanServices, type OpenArtisanServices } from "./open-artisan-services"
import type { OpenArtisanRepository } from "./open-artisan-repository"
import type { PGliteAccessQueue } from "./pglite-access-queue"
import type { RoadmapStateBackend } from "./roadmap-types"
import type { StateBackend } from "./state-backend-types"

export type OpenArtisanStateBackendKind = "filesystem" | "db"

export interface OpenArtisanRuntimeBackendOptions {
  kind?: OpenArtisanStateBackendKind | "pglite"
  provider?: "pglite"
  pglite?: {
    connection?: {
      dataDir?: string
      databaseFileName?: string
      debugName?: string
    }
    schemaName?: string
    accessQueue?: PGliteAccessQueue
  }
}

export interface OpenArtisanRuntimeBackendBundle {
  kind: OpenArtisanStateBackendKind
  stateBackend: StateBackend
  roadmapBackend?: RoadmapStateBackend
  repository?: OpenArtisanRepository
  services?: OpenArtisanServices
  dispose(): Promise<void>
}

export function resolveRuntimeBackendKind(kind?: string | null): OpenArtisanStateBackendKind {
  const value = kind ?? process.env["OPENARTISAN_STATE_BACKEND"] ?? process.env["OPENARTISAN_PERSISTENCE"]
  return value === "filesystem" || value === "fs" ? "filesystem" : "db"
}

export function createOpenArtisanRuntimeBackend(
  stateDir: string,
  options: OpenArtisanRuntimeBackendOptions = {},
): OpenArtisanRuntimeBackendBundle {
  const kind = resolveRuntimeBackendKind(options.kind)
  if (kind === "filesystem") {
    const stateBackend = createFileSystemStateBackend(stateDir)
    return { kind, stateBackend, dispose: () => stateBackend.dispose?.() ?? Promise.resolve() }
  }

  const provider = options.provider ?? "pglite"
  if (provider !== "pglite") {
    throw new Error(`Unsupported Open Artisan DB provider: ${provider}`)
  }

  const connection: { dataDir: string; databaseFileName?: string; debugName?: string } = {
    dataDir: options.pglite?.connection?.dataDir ?? join(stateDir, "workflow-db"),
  }
  if (options.pglite?.connection?.databaseFileName) {
    connection.databaseFileName = options.pglite.connection.databaseFileName
  }
  connection.debugName = options.pglite?.connection?.debugName ?? "open-artisan-workflow"

  const repositoryOptions: Parameters<typeof createPGliteOpenArtisanRepository>[0] = { connection }
  if (options.pglite?.schemaName) repositoryOptions.schemaName = options.pglite.schemaName
  if (options.pglite?.accessQueue) repositoryOptions.accessQueue = options.pglite.accessQueue
  const repository = createPGliteOpenArtisanRepository(repositoryOptions)
  return {
    kind,
    stateBackend: createOpenArtisanDbStateBackend(repository, stateDir, {
      legacyFallback: createFileSystemStateBackend(stateDir),
    }),
    roadmapBackend: createOpenArtisanDbRoadmapStateBackend(repository, stateDir),
    repository,
    services: createOpenArtisanServices(repository),
    dispose: () => repository.dispose(),
  }
}
