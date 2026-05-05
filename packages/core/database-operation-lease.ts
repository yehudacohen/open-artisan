/**
 * database-operation-lease.ts — lease-based DB coordination for repositories.
 *
 * The lease protocol uses ordinary tables and atomic insert/update statements so
 * it can run on PGlite now and map to a shared Postgres database later. This is
 * a logical lease, not the physical PGlite access queue.
 */

import { randomUUID } from "node:crypto"

import type { Kysely } from "kysely"

import {
  DB_OPERATION_LEASE_MS,
  DB_OPERATION_LEASE_MIN_RENEWAL_MS,
  DB_OPERATION_LEASE_POLL_MS,
  DB_OPERATION_LEASE_RENEWAL_DIVISOR,
  DB_OPERATION_LEASE_TIMEOUT_MS,
} from "./constants"

export interface DatabaseOperationLeaseOptions {
  leaseKey: string
  ownerId?: string
  timeoutMs?: number
  pollMs?: number
  leaseMs?: number
}

export interface DatabaseOperationLease {
  ownerId: string
  release(): Promise<void>
}

export interface DatabaseOperationLeaseDatabase {
  database_operation_locks: {
    lock_key: string
    owner_id: string
    lease_expires_at: string
    created_at: string
    updated_at: string
  }
}

export function asDatabaseOperationLeaseDb(db: unknown): Kysely<DatabaseOperationLeaseDatabase> {
  return db as Kysely<DatabaseOperationLeaseDatabase>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasUpdatedRow(result: { numUpdatedRows?: bigint | number }): boolean {
  return Number(result.numUpdatedRows ?? 0) > 0
}

function isExpectedLeaseContention(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /duplicate|unique|constraint|primary key/i.test(message)
}

function startLeaseRenewal(
  schemaDb: Kysely<DatabaseOperationLeaseDatabase>,
  leaseKey: string,
  ownerId: string,
  leaseMs: number,
): () => void {
  const intervalMs = Math.max(Math.floor(leaseMs / DB_OPERATION_LEASE_RENEWAL_DIVISOR), DB_OPERATION_LEASE_MIN_RENEWAL_MS)
  const timer = setInterval(() => {
    const now = new Date().toISOString()
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
    void schemaDb
      .updateTable("database_operation_locks")
      .set({
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      })
      .where("lock_key", "=", leaseKey)
      .where("owner_id", "=", ownerId)
      .execute()
      .catch(() => {
        // Best-effort renewal. Release or expiry will let another owner proceed.
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function buildLease(
  schemaDb: Kysely<DatabaseOperationLeaseDatabase>,
  leaseKey: string,
  ownerId: string,
  leaseMs: number,
): DatabaseOperationLease {
  const stopRenewal = startLeaseRenewal(schemaDb, leaseKey, ownerId, leaseMs)
  let released = false
  return {
    ownerId,
    release: async () => {
      if (released) return
      released = true
      stopRenewal()
      await schemaDb
        .deleteFrom("database_operation_locks")
        .where("lock_key", "=", leaseKey)
        .where("owner_id", "=", ownerId)
        .execute()
    },
  }
}

export function createDatabaseOperationLeaseOwner(prefix: string): string {
  return `${prefix}:${process.pid}:${randomUUID()}`
}

export async function acquireDatabaseOperationLease(
  db: Kysely<DatabaseOperationLeaseDatabase>,
  schemaName: string,
  options: DatabaseOperationLeaseOptions,
): Promise<DatabaseOperationLease> {
  const ownerId = options.ownerId ?? createDatabaseOperationLeaseOwner("open-artisan")
  const timeoutMs = options.timeoutMs ?? DB_OPERATION_LEASE_TIMEOUT_MS
  const pollMs = options.pollMs ?? DB_OPERATION_LEASE_POLL_MS
  const leaseMs = options.leaseMs ?? DB_OPERATION_LEASE_MS
  const deadline = Date.now() + timeoutMs
  const schemaDb = db.withSchema(schemaName)
  let lastContentionMessage: string | null = null

  while (true) {
    const now = new Date().toISOString()
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()

    const updateResult = await schemaDb
      .updateTable("database_operation_locks")
      .set({
        owner_id: ownerId,
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      })
      .where("lock_key", "=", options.leaseKey)
      .where("lease_expires_at", "<=", now)
      .executeTakeFirst()

    if (hasUpdatedRow(updateResult)) {
      return buildLease(schemaDb, options.leaseKey, ownerId, leaseMs)
    }

    try {
      await schemaDb
        .insertInto("database_operation_locks")
        .values({
          lock_key: options.leaseKey,
          owner_id: ownerId,
          lease_expires_at: leaseExpiresAt,
          created_at: now,
          updated_at: now,
        })
        .execute()
      return buildLease(schemaDb, options.leaseKey, ownerId, leaseMs)
    } catch (error) {
      if (!isExpectedLeaseContention(error)) throw error
      lastContentionMessage = error instanceof Error ? error.message : String(error)
    }

    if (Date.now() >= deadline) {
      const suffix = lastContentionMessage ? ` Last contention error: ${lastContentionMessage}` : ""
      throw new Error(`Timed out acquiring DB operation lease ${options.leaseKey}.${suffix}`)
    }
    await sleep(pollMs)
  }
}
