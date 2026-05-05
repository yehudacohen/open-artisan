/**
 * roadmap-repository-pglite.ts — PGlite-backed roadmap repository with a Postgres-friendly Kysely layer.
 *
 * This repository owns roadmap persistence and typed item queries. It stores roadmap data in a
 * dedicated roadmap schema/namespace and does not interact with per-feature WorkflowState storage.
 */

import { join } from "node:path"

import { Kysely, type Selectable } from "kysely"

import { acquireDatabaseOperationLease, asDatabaseOperationLeaseDb, createDatabaseOperationLeaseOwner } from "./database-operation-lease"
import { createPGliteDatabaseHandle } from "./pglite-connection-manager"
import { ensureRoadmapSchema, ROADMAP_SCHEMA_VERSION, type RoadmapDatabase } from "./roadmap-repository-migrations"
import {
  roadmapError,
  roadmapOk,
  validateRoadmapDocument,
  type RoadmapDocument,
  type RoadmapItem,
  type RoadmapPGliteRepositoryOptions,
  type RoadmapQuery,
  type RoadmapRepository,
  type RoadmapResult,
} from "./roadmap-types"

const DEFAULT_SCHEMA_NAME = "roadmap"
const DEFAULT_DOCUMENT_ID = "default"
const DEFAULT_DATABASE_FILE_NAME = "roadmap.pg"

function validatePersistableRoadmapDocument(document: RoadmapDocument): RoadmapResult<RoadmapDocument> {
  if (document.schemaVersion !== ROADMAP_SCHEMA_VERSION) {
    return roadmapError(
      "schema-mismatch",
      `Unsupported roadmap schema version ${document.schemaVersion}; expected ${ROADMAP_SCHEMA_VERSION}`,
      false,
      { schemaVersion: document.schemaVersion },
    )
  }

  const validationError = validateRoadmapDocument(document)
  if (validationError) {
    return roadmapError("invalid-document", validationError, false, { schemaVersion: document.schemaVersion })
  }

  return roadmapOk(document)
}

function cloneDocument(document: RoadmapDocument): RoadmapDocument {
  return {
    schemaVersion: document.schemaVersion,
    items: document.items.map((item) => ({ ...item })),
    edges: document.edges.map((edge) => ({ ...edge })),
  }
}

function mapRowToRoadmapItem(row: Selectable<RoadmapDatabase["roadmap_items"]>): RoadmapItem {
  return {
    id: row.item_id,
    kind: row.kind,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    status: row.status,
    priority: row.priority,
    ...(row.feature_name ? { featureName: row.feature_name } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createPGliteRoadmapRepository(
  options: RoadmapPGliteRepositoryOptions,
): RoadmapRepository {
  const schemaName = options.schemaName ?? DEFAULT_SCHEMA_NAME
  const dbPath = options.connection.databaseFileName
    ? join(options.connection.dataDir, options.connection.databaseFileName)
    : join(options.connection.dataDir, DEFAULT_DATABASE_FILE_NAME)
  const leaseOwnerId = createDatabaseOperationLeaseOwner("roadmap-repository")
  const dbHandle = createPGliteDatabaseHandle<RoadmapDatabase>({
    databasePath: dbPath,
    ...(options.accessQueue ? { accessQueue: options.accessQueue } : {}),
  })
  let initializedPromise: Promise<RoadmapResult<null>> | null = null

  async function withDb<T>(label: string, run: (db: Kysely<RoadmapDatabase>) => Promise<T>): Promise<T> {
    return dbHandle.run(run, label)
  }

  async function initializeSchema(): Promise<RoadmapResult<null>> {
    try {
      await withDb("roadmap.initializeSchema", async (db) => {
        await ensureRoadmapSchema({ db, dataDir: options.connection.dataDir, databasePath: dbPath, schemaName })
      })
      return roadmapOk(null)
    } catch (error) {
      return roadmapError(
        "storage-failure",
        error instanceof Error ? error.message : "Failed to initialize roadmap repository",
        true,
      )
    }
  }

  async function persistRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>> {
    const validation = validatePersistableRoadmapDocument(document)
    if (!validation.ok) return validation

    initializedPromise ??= initializeSchema()
    const initialized = await initializedPromise
    if (!initialized.ok) return initialized

    try {
      const persistedDocument = cloneDocument(document)
      await withDb("roadmap.persist", async (db) => {
        const lease = await acquireDatabaseOperationLease(asDatabaseOperationLeaseDb(db), schemaName, {
          leaseKey: "roadmap:repository-operation",
          ownerId: leaseOwnerId,
        })
        try {
          const schemaDb = db.withSchema(schemaName)
          await schemaDb.transaction().execute(async (tx) => {
            await tx.deleteFrom("roadmap_edges").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
            await tx.deleteFrom("roadmap_items").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
            await tx.deleteFrom("roadmap_documents").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()

            await tx
              .insertInto("roadmap_documents")
              .values({
                document_id: DEFAULT_DOCUMENT_ID,
                schema_version: persistedDocument.schemaVersion,
                document: persistedDocument,
              })
              .execute()

            if (persistedDocument.items.length > 0) {
              await tx
                .insertInto("roadmap_items")
                .values(
                  persistedDocument.items.map((item) => ({
                    document_id: DEFAULT_DOCUMENT_ID,
                    item_id: item.id,
                    kind: item.kind,
                    title: item.title,
                    description: item.description ?? null,
                    status: item.status,
                    priority: item.priority,
                    feature_name: item.featureName ?? null,
                    created_at: item.createdAt,
                    updated_at: item.updatedAt,
                  })),
                )
                .execute()
            }

            if (persistedDocument.edges.length > 0) {
              await tx
                .insertInto("roadmap_edges")
                .values(
                  persistedDocument.edges.map((edge) => ({
                    document_id: DEFAULT_DOCUMENT_ID,
                    edge_key: `${edge.from}->${edge.to}:${edge.kind}`,
                    from_item_id: edge.from,
                    to_item_id: edge.to,
                    kind: edge.kind,
                  })),
                )
                .execute()
            }
          })
        } finally {
          await lease.release()
        }
      })

      return roadmapOk(persistedDocument)
    } catch (error) {
      return roadmapError(
        "storage-failure",
        error instanceof Error ? error.message : "Failed to persist roadmap document",
        true,
      )
    }
  }

  async function readPersistedRoadmap(): Promise<RoadmapResult<RoadmapDocument | null>> {
    initializedPromise ??= initializeSchema()
    const initialized = await initializedPromise
    if (!initialized.ok) return initialized

    try {
      return await withDb("roadmap.read", async (db) => {
        const lease = await acquireDatabaseOperationLease(asDatabaseOperationLeaseDb(db), schemaName, {
          leaseKey: "roadmap:repository-operation",
          ownerId: leaseOwnerId,
        })
        try {
          const row = await db
            .withSchema(schemaName)
            .selectFrom("roadmap_documents")
            .select(["document"])
            .where("document_id", "=", DEFAULT_DOCUMENT_ID)
            .executeTakeFirst()

          if (!row) return roadmapOk(null)

          const validation = validatePersistableRoadmapDocument(row.document)
          if (!validation.ok) return validation
          return roadmapOk(cloneDocument(row.document))
        } finally {
          await lease.release()
        }
      })
    } catch (error) {
      return roadmapError(
        "storage-failure",
        error instanceof Error ? error.message : "Failed to read roadmap document",
        true,
      )
    }
  }

  return {
    async initialize(): Promise<RoadmapResult<null>> {
      initializedPromise ??= initializeSchema()
      return initializedPromise
    },

    async dispose(): Promise<void> {
      initializedPromise = null
      await dbHandle.dispose()
    },

    async createRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>> {
      return persistRoadmap(document)
    },

    async readRoadmap(): Promise<RoadmapResult<RoadmapDocument | null>> {
      return readPersistedRoadmap()
    },

    async updateRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>> {
      return persistRoadmap(document)
    },

    async deleteRoadmap(): Promise<RoadmapResult<null>> {
      initializedPromise ??= initializeSchema()
      const initialized = await initializedPromise
      if (!initialized.ok) return initialized

      try {
        await withDb("roadmap.delete", async (db) => {
          const lease = await acquireDatabaseOperationLease(asDatabaseOperationLeaseDb(db), schemaName, {
            leaseKey: "roadmap:repository-operation",
            ownerId: leaseOwnerId,
          })
          try {
            const schemaDb = db.withSchema(schemaName)
            await schemaDb.transaction().execute(async (tx) => {
              await tx.deleteFrom("roadmap_edges").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
              await tx.deleteFrom("roadmap_items").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
              await tx.deleteFrom("roadmap_documents").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
            })
          } finally {
            await lease.release()
          }
        })
        return roadmapOk(null)
      } catch (error) {
        return roadmapError(
          "storage-failure",
          error instanceof Error ? error.message : "Failed to delete roadmap document",
          true,
        )
      }
    },

    async queryRoadmapItems(query: RoadmapQuery): Promise<RoadmapResult<RoadmapItem[]>> {
      initializedPromise ??= initializeSchema()
      const initialized = await initializedPromise
      if (!initialized.ok) return initialized

      try {
        return await withDb("roadmap.query", async (db) => {
          const lease = await acquireDatabaseOperationLease(asDatabaseOperationLeaseDb(db), schemaName, {
            leaseKey: "roadmap:repository-operation",
            ownerId: leaseOwnerId,
          })
          try {
            let builder = db
              .withSchema(schemaName)
              .selectFrom("roadmap_items")
              .selectAll()
              .where("document_id", "=", DEFAULT_DOCUMENT_ID)

            if (query.itemIds && query.itemIds.length > 0) {
              builder = builder.where("item_id", "in", query.itemIds)
            }

            if (query.kinds && query.kinds.length > 0) {
              builder = builder.where("kind", "in", query.kinds)
            }

            if (query.statuses && query.statuses.length > 0) {
              builder = builder.where("status", "in", query.statuses)
            }

            if (query.featureName !== undefined) {
              builder = query.featureName === null
                ? builder.where("feature_name", "is", null)
                : builder.where("feature_name", "=", query.featureName)
            }

            if (query.minPriority !== undefined) {
              builder = builder.where("priority", ">=", query.minPriority)
            }

            const rows = await builder.orderBy("priority", "desc").orderBy("created_at").orderBy("item_id").execute()
            return roadmapOk(rows.map((row) => mapRowToRoadmapItem(row)))
          } finally {
            await lease.release()
          }
        })
      } catch (error) {
        return roadmapError(
          "storage-failure",
          error instanceof Error ? error.message : "Failed to query roadmap items",
          true,
        )
      }
    },
  }
}
