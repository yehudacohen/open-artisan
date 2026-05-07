/**
 * open-artisan-repository-migrations.ts — schema ownership for the runtime DB.
 */

import { sql, type Kysely } from "kysely"

import { tracePGlite } from "./pglite-trace"
import type { OpenArtisanDatabase } from "./open-artisan-repository-schema"
import { acquireDatabaseOperationLease, asDatabaseOperationLeaseDb, createDatabaseOperationLeaseOwner } from "./database-operation-lease"

export const OPEN_ARTISAN_DB_SCHEMA_VERSION = 2

function nowIso(): string {
  return new Date().toISOString()
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function tableName(schemaName: string, table: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(table)}`
}

async function applyMigration(
  db: Kysely<OpenArtisanDatabase>,
  schemaName: string,
  version: number,
  run: (tx: Kysely<OpenArtisanDatabase>) => Promise<void>,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await run(tx)
    await tx.withSchema(schemaName).insertInto("schema_migrations").values({ version, applied_at: nowIso() }).execute()
  })
}

export async function ensureOpenArtisanSchema(input: {
  db: Kysely<OpenArtisanDatabase>
  databasePath: string
  schemaName: string
}): Promise<void> {
  const startedAt = Date.now()
  tracePGlite("schema.openartisan.start", { databasePath: input.databasePath, schemaName: input.schemaName })
  const schema = quoteIdentifier(input.schemaName)
  await sql.raw(`create schema if not exists ${schema}`).execute(input.db)
  await sql.raw(`
    create table if not exists ${tableName(input.schemaName, "database_operation_locks")} (
      lock_key text primary key,
      owner_id text not null,
      lease_expires_at text not null,
      created_at text not null,
      updated_at text not null
    )
  `).execute(input.db)
  await sql.raw(`
    create table if not exists ${tableName(input.schemaName, "schema_migrations")} (
      version integer primary key,
      applied_at text not null
    )
  `).execute(input.db)
  const lease = await acquireDatabaseOperationLease(asDatabaseOperationLeaseDb(input.db), input.schemaName, {
    leaseKey: `open-artisan:schema-migration:${input.schemaName}`,
    ownerId: createDatabaseOperationLeaseOwner("open-artisan-migration"),
  })
  try {
    const appliedMigrationRows = await input.db.withSchema(input.schemaName).selectFrom("schema_migrations").select("version").execute()
    const appliedMigrations = new Set(appliedMigrationRows.map((row) => row.version))

    if (!appliedMigrations.has(1)) {
      tracePGlite("schema.openartisan.migration.start", { databasePath: input.databasePath, schemaName: input.schemaName, migration: 1 })
      await applyMigration(input.db, input.schemaName, 1, (tx) => applyOpenArtisanTables(tx, input.schemaName))
      tracePGlite("schema.openartisan.migration.done", { databasePath: input.databasePath, schemaName: input.schemaName, migration: 1 })
    }

    if (!appliedMigrations.has(2)) {
      tracePGlite("schema.openartisan.migration.start", { databasePath: input.databasePath, schemaName: input.schemaName, migration: 2 })
      await applyMigration(input.db, input.schemaName, 2, (tx) => applyOpenArtisanIndexes(tx, input.schemaName))
      tracePGlite("schema.openartisan.migration.done", { databasePath: input.databasePath, schemaName: input.schemaName, migration: 2 })
    }
  } finally {
    await lease.release()
  }
  tracePGlite("schema.openartisan.done", { databasePath: input.databasePath, schemaName: input.schemaName, durationMs: Date.now() - startedAt })
}

async function applyOpenArtisanTables(db: Kysely<OpenArtisanDatabase>, schemaName: string): Promise<void> {
  const tables = [
    `create table if not exists ${tableName(schemaName, "roadmap_items")} (id text primary key, feature_name text, status text not null, priority integer not null, record jsonb not null, created_at text not null, updated_at text not null)`,
    `create table if not exists ${tableName(schemaName, "roadmap_edges")} (edge_key text primary key, from_item_id text not null, to_item_id text not null, kind text not null, record jsonb not null)`,
    `create table if not exists ${tableName(schemaName, "execution_slices")} (id text primary key, feature_name text, status text not null, record jsonb not null, created_at text not null, updated_at text not null)`,
    `create table if not exists ${tableName(schemaName, "execution_slice_items")} (slice_id text not null, roadmap_item_id text not null, primary key (slice_id, roadmap_item_id))`,
    `create table if not exists ${tableName(schemaName, "workflows")} (id text primary key, feature_name text not null unique, mode text not null, phase text not null, phase_state text not null, record jsonb not null, state_snapshot jsonb, created_at text not null, updated_at text not null)`,
    `create table if not exists ${tableName(schemaName, "workflow_events")} (id text primary key, workflow_id text not null, created_at text not null, record jsonb not null)`,
    `create table if not exists ${tableName(schemaName, "workflow_roadmap_links")} (workflow_id text not null, roadmap_item_id text not null, primary key (workflow_id, roadmap_item_id))`,
    `create table if not exists ${tableName(schemaName, "artifacts")} (id text primary key, workflow_id text not null, artifact_key text not null, current_version_id text, record jsonb not null, created_at text not null, updated_at text not null)`,
    `create table if not exists ${tableName(schemaName, "artifact_versions")} (id text primary key, artifact_id text not null, content_hash text not null, record jsonb not null, created_at text not null)`,
    `create table if not exists ${tableName(schemaName, "artifact_approvals")} (id text primary key, artifact_version_id text not null, record jsonb not null, created_at text not null)`,
    `create table if not exists ${tableName(schemaName, "artifact_roadmap_links")} (artifact_id text not null, roadmap_item_id text not null, primary key (artifact_id, roadmap_item_id))`,
    `create table if not exists ${tableName(schemaName, "tasks")} (id text primary key, workflow_id text not null, task_key text not null, status text not null, record jsonb not null, created_at text not null, updated_at text not null)`,
    `create table if not exists ${tableName(schemaName, "task_dependencies")} (workflow_id text not null, from_task_id text not null, to_task_id text not null, primary key (workflow_id, from_task_id, to_task_id))`,
    `create table if not exists ${tableName(schemaName, "task_owned_files")} (task_id text not null, path text not null, primary key (task_id, path))`,
    `create table if not exists ${tableName(schemaName, "task_expected_tests")} (task_id text not null, path text not null, primary key (task_id, path))`,
    `create table if not exists ${tableName(schemaName, "task_roadmap_links")} (task_id text not null, roadmap_item_id text not null, primary key (task_id, roadmap_item_id))`,
    `create table if not exists ${tableName(schemaName, "task_reviews")} (id text primary key, workflow_id text not null, task_id text not null, created_at text not null, record jsonb not null)`,
    `create table if not exists ${tableName(schemaName, "phase_reviews")} (id text primary key, workflow_id text not null, phase text not null, created_at text not null, record jsonb not null)`,
    `create table if not exists ${tableName(schemaName, "review_observations")} (id text primary key, review_id text not null, kind text not null, record jsonb not null)`,
    `create table if not exists ${tableName(schemaName, "patch_suggestions")} (id text primary key, workflow_id text not null, status text not null, record jsonb not null, created_at text not null, updated_at text not null)`,
    `create table if not exists ${tableName(schemaName, "patch_applications")} (id text primary key, patch_suggestion_id text not null, record jsonb not null, created_at text not null)`,
    `create table if not exists ${tableName(schemaName, "agent_leases")} (id text primary key, workflow_id text not null, session_id text not null, task_id text, expires_at text not null, record jsonb not null, created_at text not null)`,
    `create table if not exists ${tableName(schemaName, "file_claims")} (id text primary key, agent_lease_id text not null, path text not null, mode text not null, record jsonb not null, created_at text not null)`,
    `create table if not exists ${tableName(schemaName, "worktree_observations")} (id text primary key, workflow_id text not null, path text not null, classification text not null, record jsonb not null, created_at text not null)`,
    `create table if not exists ${tableName(schemaName, "human_gates")} (id text primary key, workflow_id text not null, task_id text not null, resolved boolean not null, record jsonb not null, created_at text not null, resolved_at text)`,
    `create table if not exists ${tableName(schemaName, "fast_forward_records")} (id text primary key, workflow_id text not null, record jsonb not null, created_at text not null)`,
  ]
  for (const statement of tables) await sql.raw(statement).execute(db)
}

async function applyOpenArtisanIndexes(db: Kysely<OpenArtisanDatabase>, schemaName: string): Promise<void> {
  const indexes = [
    `create index if not exists ${quoteIdentifier("roadmap_items_feature_status_idx")} on ${tableName(schemaName, "roadmap_items")} (feature_name, status, priority desc)`,
    `create index if not exists ${quoteIdentifier("roadmap_edges_from_idx")} on ${tableName(schemaName, "roadmap_edges")} (from_item_id)`,
    `create index if not exists ${quoteIdentifier("roadmap_edges_to_idx")} on ${tableName(schemaName, "roadmap_edges")} (to_item_id)`,
    `create index if not exists ${quoteIdentifier("execution_slices_feature_status_idx")} on ${tableName(schemaName, "execution_slices")} (feature_name, status)`,
    `create index if not exists ${quoteIdentifier("execution_slice_items_item_idx")} on ${tableName(schemaName, "execution_slice_items")} (roadmap_item_id)`,
    `create index if not exists ${quoteIdentifier("workflow_events_workflow_idx")} on ${tableName(schemaName, "workflow_events")} (workflow_id)`,
    `create index if not exists ${quoteIdentifier("workflow_roadmap_links_roadmap_idx")} on ${tableName(schemaName, "workflow_roadmap_links")} (roadmap_item_id)`,
    `create index if not exists ${quoteIdentifier("artifacts_workflow_idx")} on ${tableName(schemaName, "artifacts")} (workflow_id)`,
    `create index if not exists ${quoteIdentifier("artifact_versions_artifact_idx")} on ${tableName(schemaName, "artifact_versions")} (artifact_id)`,
    `create index if not exists ${quoteIdentifier("artifact_approvals_version_idx")} on ${tableName(schemaName, "artifact_approvals")} (artifact_version_id)`,
    `create index if not exists ${quoteIdentifier("artifact_roadmap_links_roadmap_idx")} on ${tableName(schemaName, "artifact_roadmap_links")} (roadmap_item_id)`,
    `create index if not exists ${quoteIdentifier("tasks_workflow_idx")} on ${tableName(schemaName, "tasks")} (workflow_id)`,
    `create index if not exists ${quoteIdentifier("task_dependencies_to_idx")} on ${tableName(schemaName, "task_dependencies")} (to_task_id)`,
    `create index if not exists ${quoteIdentifier("task_roadmap_links_roadmap_idx")} on ${tableName(schemaName, "task_roadmap_links")} (roadmap_item_id)`,
    `create index if not exists ${quoteIdentifier("task_reviews_workflow_task_idx")} on ${tableName(schemaName, "task_reviews")} (workflow_id, task_id)`,
    `create index if not exists ${quoteIdentifier("phase_reviews_workflow_phase_idx")} on ${tableName(schemaName, "phase_reviews")} (workflow_id, phase)`,
    `create index if not exists ${quoteIdentifier("review_observations_review_idx")} on ${tableName(schemaName, "review_observations")} (review_id)`,
    `create index if not exists ${quoteIdentifier("patch_suggestions_workflow_status_idx")} on ${tableName(schemaName, "patch_suggestions")} (workflow_id, status)`,
    `create index if not exists ${quoteIdentifier("patch_applications_suggestion_idx")} on ${tableName(schemaName, "patch_applications")} (patch_suggestion_id)`,
    `create index if not exists ${quoteIdentifier("agent_leases_workflow_idx")} on ${tableName(schemaName, "agent_leases")} (workflow_id)`,
    `create index if not exists ${quoteIdentifier("file_claims_lease_idx")} on ${tableName(schemaName, "file_claims")} (agent_lease_id)`,
    `create index if not exists ${quoteIdentifier("file_claims_path_idx")} on ${tableName(schemaName, "file_claims")} (path)`,
    `create index if not exists ${quoteIdentifier("worktree_observations_workflow_idx")} on ${tableName(schemaName, "worktree_observations")} (workflow_id)`,
    `create index if not exists ${quoteIdentifier("human_gates_workflow_resolved_idx")} on ${tableName(schemaName, "human_gates")} (workflow_id, resolved)`,
    `create index if not exists ${quoteIdentifier("fast_forward_records_workflow_idx")} on ${tableName(schemaName, "fast_forward_records")} (workflow_id)`,
  ]
  for (const statement of indexes) await sql.raw(statement).execute(db)
}
