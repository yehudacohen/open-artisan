/**
 * roadmap-repository-migrations.ts — schema ownership for the standalone roadmap DB.
 */

import { mkdir } from "node:fs/promises"

import { Kysely, sql } from "kysely"

import { tracePGlite } from "./pglite-trace"
import type { RoadmapDocument, RoadmapItem } from "./roadmap-types"

export const ROADMAP_SCHEMA_VERSION = 1

export interface RoadmapDatabase {
  schema_migrations: {
    version: number
    applied_at: string
  }
  database_operation_locks: {
    lock_key: string
    owner_id: string
    lease_expires_at: string
    created_at: string
    updated_at: string
  }
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

async function applyRoadmapMigration(input: {
  db: Kysely<RoadmapDatabase>
  schemaName: string
  version: number
  run: (tx: Kysely<RoadmapDatabase>) => Promise<void>
}): Promise<void> {
  await input.db.transaction().execute(async (tx) => {
    await input.run(tx)
    await tx
      .withSchema(input.schemaName)
      .insertInto("schema_migrations")
      .values({ version: input.version, applied_at: new Date().toISOString() })
      .execute()
  })
}

export async function ensureRoadmapSchema(input: {
  db: Kysely<RoadmapDatabase>
  dataDir: string
  databasePath: string
  schemaName: string
}): Promise<void> {
  await mkdir(input.dataDir, { recursive: true })
  const startedAt = Date.now()
  tracePGlite("schema.roadmap.start", { databasePath: input.databasePath, schemaName: input.schemaName })
  const quotedSchema = quoteIdentifier(input.schemaName)
  const roadmapDocumentsTable = `${quotedSchema}.${quoteIdentifier("roadmap_documents")}`
  const roadmapItemsTable = `${quotedSchema}.${quoteIdentifier("roadmap_items")}`
  const roadmapEdgesTable = `${quotedSchema}.${quoteIdentifier("roadmap_edges")}`

  await sql.raw(`create schema if not exists ${quotedSchema}`).execute(input.db)
  await sql.raw(`
    create table if not exists ${quotedSchema}.${quoteIdentifier("database_operation_locks")} (
      lock_key text primary key,
      owner_id text not null,
      lease_expires_at text not null,
      created_at text not null,
      updated_at text not null
    )
  `).execute(input.db)
  await sql.raw(`
    create table if not exists ${quotedSchema}.${quoteIdentifier("schema_migrations")} (
      version integer primary key,
      applied_at text not null
    )
  `).execute(input.db)
  const appliedMigrationRows = await input.db.withSchema(input.schemaName).selectFrom("schema_migrations").select("version").execute()
  const appliedMigrations = new Set(appliedMigrationRows.map((row) => row.version))
  if (appliedMigrations.has(ROADMAP_SCHEMA_VERSION)) {
    tracePGlite("schema.roadmap.done", { databasePath: input.databasePath, schemaName: input.schemaName, durationMs: Date.now() - startedAt })
    return
  }

  tracePGlite("schema.roadmap.migration.start", { databasePath: input.databasePath, schemaName: input.schemaName, migration: ROADMAP_SCHEMA_VERSION })
  await applyRoadmapMigration({
    db: input.db,
    schemaName: input.schemaName,
    version: ROADMAP_SCHEMA_VERSION,
    async run(tx) {
      await sql.raw(`
        create table if not exists ${roadmapDocumentsTable} (
          document_id text primary key,
          schema_version integer not null,
          document jsonb not null
        )
      `).execute(tx)
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
      `).execute(tx)
      await sql.raw(`create index if not exists ${quoteIdentifier("roadmap_items_document_idx")} on ${roadmapItemsTable} (document_id)`).execute(tx)
      await sql.raw(`create index if not exists ${quoteIdentifier("roadmap_items_feature_priority_idx")} on ${roadmapItemsTable} (feature_name, priority desc)`).execute(tx)
      await sql.raw(`create index if not exists ${quoteIdentifier("roadmap_items_status_priority_idx")} on ${roadmapItemsTable} (status, priority desc)`).execute(tx)
      await sql.raw(`
        create table if not exists ${roadmapEdgesTable} (
          document_id text not null,
          edge_key text primary key,
          from_item_id text not null,
          to_item_id text not null,
          kind text not null
        )
      `).execute(tx)
      await sql.raw(`create index if not exists ${quoteIdentifier("roadmap_edges_document_idx")} on ${roadmapEdgesTable} (document_id)`).execute(tx)
    },
  })
  tracePGlite("schema.roadmap.migration.done", { databasePath: input.databasePath, schemaName: input.schemaName, migration: ROADMAP_SCHEMA_VERSION })
  tracePGlite("schema.roadmap.done", { databasePath: input.databasePath, schemaName: input.schemaName, durationMs: Date.now() - startedAt })
}
