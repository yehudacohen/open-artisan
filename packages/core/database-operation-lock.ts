/**
 * database-operation-lock.ts — lease-based DB locks for repository operations.
 *
 * The lock protocol uses ordinary tables and atomic insert/update statements so
 * it can run on PGlite now and map to a shared Postgres database later.
 */

import { randomUUID } from "node:crypto"

import type { Kysely } from "kysely"

import {
  DB_OPERATION_LOCK_LEASE_MS,
  DB_OPERATION_LOCK_POLL_MS,
  DB_OPERATION_LOCK_TIMEOUT_MS,
} from "./constants"

export interface DatabaseOperationLockOptions {
  lockKey: string
  ownerId?: string
  timeoutMs?: number
  pollMs?: number
  leaseMs?: number
}

export interface DatabaseOperationLockLease {
  ownerId: string
  release(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasUpdatedRow(result: { numUpdatedRows?: bigint | number }): boolean {
  return Number(result.numUpdatedRows ?? 0) > 0
}

export function createDatabaseOperationLockOwner(prefix: string): string {
  return `${prefix}:${process.pid}:${randomUUID()}`
}

export async function acquireDatabaseOperationLock(
  db: Kysely<any>,
  schemaName: string,
  options: DatabaseOperationLockOptions,
): Promise<DatabaseOperationLockLease> {
  const ownerId = options.ownerId ?? createDatabaseOperationLockOwner("open-artisan")
  const timeoutMs = options.timeoutMs ?? DB_OPERATION_LOCK_TIMEOUT_MS
  const pollMs = options.pollMs ?? DB_OPERATION_LOCK_POLL_MS
  const leaseMs = options.leaseMs ?? DB_OPERATION_LOCK_LEASE_MS
  const deadline = Date.now() + timeoutMs
  const schemaDb = db.withSchema(schemaName)

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
      .where("lock_key", "=", options.lockKey)
      .where("lease_expires_at", "<=", now)
      .executeTakeFirst()

    if (hasUpdatedRow(updateResult)) {
      return {
        ownerId,
        release: async () => {
          await schemaDb
            .deleteFrom("database_operation_locks")
            .where("lock_key", "=", options.lockKey)
            .where("owner_id", "=", ownerId)
            .execute()
        },
      }
    }

    try {
      await schemaDb
        .insertInto("database_operation_locks")
        .values({
          lock_key: options.lockKey,
          owner_id: ownerId,
          lease_expires_at: leaseExpiresAt,
          created_at: now,
          updated_at: now,
        })
        .execute()
      return {
        ownerId,
        release: async () => {
          await schemaDb
            .deleteFrom("database_operation_locks")
            .where("lock_key", "=", options.lockKey)
            .where("owner_id", "=", ownerId)
            .execute()
        },
      }
    } catch {
      // Another worker inserted the lock first; wait for release or stale lease.
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring DB operation lock ${options.lockKey}`)
    }
    await sleep(pollMs)
  }
}
