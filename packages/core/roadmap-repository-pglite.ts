/**
 * roadmap-repository-pglite.ts — PGlite-backed roadmap repository with a Postgres-friendly Kysely layer.
 *
 * This repository owns roadmap persistence and typed item queries. It stores roadmap data in a
 * dedicated roadmap schema/namespace and does not interact with per-feature WorkflowState storage.
 */

import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { Kysely, type Selectable, sql } from "kysely"
import { PGliteDialect } from "kysely-pglite-dialect"

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
} from "./types"

const ROADMAP_SCHEMA_VERSION = 1
const DEFAULT_SCHEMA_NAME = "roadmap"
const DEFAULT_DOCUMENT_ID = "default"
const DEFAULT_DATABASE_FILE_NAME = "roadmap.pg"

interface RoadmapDatabase {
  roadmap_documents: {
    document_id: string
    schema_version: number
    document: RoadmapDocument
  }
  roadmap_items: {
    document_id: string
    item_id: string
    kind: RoadmapItem["kind"]
    title: string
    description: string | null
    status: RoadmapItem["status"]
    priority: number
    feature_name: string | null
    created_at: string
    updated_at: string
  }
  roadmap_edges: {
    document_id: string
    edge_key: string
    from_item_id: string
    to_item_id: string
    kind: string
  }
}

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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

export function createPGliteRoadmapRepository(
  options: RoadmapPGliteRepositoryOptions,
): RoadmapRepository {
  const schemaName = options.schemaName ?? DEFAULT_SCHEMA_NAME
  const dbPath = options.connection.databaseFileName
    ? join(options.connection.dataDir, options.connection.databaseFileName)
    : join(options.connection.dataDir, DEFAULT_DATABASE_FILE_NAME)

  async function withDb<T>(run: (db: Kysely<RoadmapDatabase>) => Promise<T>): Promise<T> {
    await mkdir(dirname(dbPath), { recursive: true })
    const client = new PGlite(dbPath)
    const db = new Kysely<RoadmapDatabase>({
      dialect: new PGliteDialect(client),
    })

    try {
      return await run(db)
    } finally {
      await db.destroy()
    }
  }

  async function initializeSchema(): Promise<RoadmapResult<null>> {
    try {
      await mkdir(options.connection.dataDir, { recursive: true })
      await withDb(async (db) => {
        const quotedSchema = quoteIdentifier(schemaName)
        const roadmapDocumentsTable = `${quotedSchema}.${quoteIdentifier("roadmap_documents")}`
        const roadmapItemsTable = `${quotedSchema}.${quoteIdentifier("roadmap_items")}`
        const roadmapEdgesTable = `${quotedSchema}.${quoteIdentifier("roadmap_edges")}`

        await sql.raw(`create schema if not exists ${quotedSchema}`).execute(db)
        await sql.raw(`
          create table if not exists ${roadmapDocumentsTable} (
            document_id text primary key,
            schema_version integer not null,
            document jsonb not null
          )
        `).execute(db)
        await sql.raw(`
          create table if not exists ${roadmapItemsTable} (
            document_id text not null,
            item_id text primary key,
            kind text not null,
            title text not null,
            description text,
            status text not null,
            priority integer not null,
            feature_name text,
            created_at text not null,
            updated_at text not null
          )
        `).execute(db)
        await sql.raw(`
          create index if not exists ${quoteIdentifier("roadmap_items_document_idx")}
          on ${roadmapItemsTable} (document_id)
        `).execute(db)
        await sql.raw(`
          create index if not exists ${quoteIdentifier("roadmap_items_feature_priority_idx")}
          on ${roadmapItemsTable} (feature_name, priority desc)
        `).execute(db)
        await sql.raw(`
          create index if not exists ${quoteIdentifier("roadmap_items_status_priority_idx")}
          on ${roadmapItemsTable} (status, priority desc)
        `).execute(db)
        await sql.raw(`
          create table if not exists ${roadmapEdgesTable} (
            document_id text not null,
            edge_key text primary key,
            from_item_id text not null,
            to_item_id text not null,
            kind text not null
          )
        `).execute(db)
        await sql.raw(`
          create index if not exists ${quoteIdentifier("roadmap_edges_document_idx")}
          on ${roadmapEdgesTable} (document_id)
        `).execute(db)
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

    const initialized = await initializeSchema()
    if (!initialized.ok) return initialized

    try {
      const persistedDocument = cloneDocument(document)
      await withDb(async (db) => {
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
    const initialized = await initializeSchema()
    if (!initialized.ok) return initialized

    try {
      return await withDb(async (db) => {
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
      return initializeSchema()
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
      const initialized = await initializeSchema()
      if (!initialized.ok) return initialized

      try {
        await withDb(async (db) => {
          const schemaDb = db.withSchema(schemaName)
          await schemaDb.transaction().execute(async (tx) => {
            await tx.deleteFrom("roadmap_edges").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
            await tx.deleteFrom("roadmap_items").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
            await tx.deleteFrom("roadmap_documents").where("document_id", "=", DEFAULT_DOCUMENT_ID).execute()
          })
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
      const initialized = await initializeSchema()
      if (!initialized.ok) return initialized

      try {
        return await withDb(async (db) => {
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
