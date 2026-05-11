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

export type DatabaseOperationLeaseRenewal = (input: {
  leaseKey: string
  ownerId: string
  leaseMs: number
  intervalMs: number
}) => () => void

export interface DatabaseOperationLeaseOptions {
  leaseKey: string
  ownerId?: string
  timeoutMs?: number
  pollMs?: number
  leaseMs?: number
  allowSameProcessReclaim?: boolean
  renew?: DatabaseOperationLeaseRenewal
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

const sameProcessLeases = new Map<string, Map<string, number>>()

function leaseIdentity(schemaName: string, leaseKey: string): string {
  return `${schemaName}:${leaseKey}`
}

function hasSameProcessHolder(identity: string, ownerId: string): boolean {
  const owners = sameProcessLeases.get(identity)
  if (!owners) return false
  for (const [heldOwnerId, count] of owners) {
    if (heldOwnerId !== ownerId && count > 0) return true
  }
  return false
}

function registerSameProcessLease(identity: string, ownerId: string): () => void {
  let owners = sameProcessLeases.get(identity)
  if (!owners) {
    owners = new Map()
    sameProcessLeases.set(identity, owners)
  }
  owners.set(ownerId, (owners.get(ownerId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const currentOwners = sameProcessLeases.get(identity)
    if (!currentOwners) return
    const nextCount = (currentOwners.get(ownerId) ?? 0) - 1
    if (nextCount > 0) {
      currentOwners.set(ownerId, nextCount)
    } else {
      currentOwners.delete(ownerId)
    }
    if (currentOwners.size === 0) sameProcessLeases.delete(identity)
  }
}

function buildLease(
  schemaDb: Kysely<DatabaseOperationLeaseDatabase>,
  leaseKey: string,
  ownerId: string,
  stopRenewal: () => void,
  unregisterSameProcessLease: () => void,
): DatabaseOperationLease {
  let released = false
  return {
    ownerId,
    release: async () => {
      if (released) return
      released = true
      stopRenewal()
      unregisterSameProcessLease()
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
  const intervalMs = Math.max(Math.floor(leaseMs / DB_OPERATION_LEASE_RENEWAL_DIVISOR), DB_OPERATION_LEASE_MIN_RENEWAL_MS)
  const deadline = Date.now() + timeoutMs
  const schemaDb = db.withSchema(schemaName)
  const identity = leaseIdentity(schemaName, options.leaseKey)
  let lastContentionMessage: string | null = null

  while (true) {
    if (!options.allowSameProcessReclaim && hasSameProcessHolder(identity, ownerId)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring DB operation lease ${options.leaseKey}. Same-process lease is still held.`)
      }
      await sleep(pollMs)
      continue
    }

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
      const stopRenewal = options.renew?.({ leaseKey: options.leaseKey, ownerId, leaseMs, intervalMs }) ?? (() => {})
      return buildLease(schemaDb, options.leaseKey, ownerId, stopRenewal, registerSameProcessLease(identity, ownerId))
    }

    const sameOwnerUpdateResult = await schemaDb
      .updateTable("database_operation_locks")
      .set({
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      })
      .where("lock_key", "=", options.leaseKey)
      .where("owner_id", "=", ownerId)
      .executeTakeFirst()

    if (hasUpdatedRow(sameOwnerUpdateResult)) {
      const stopRenewal = options.renew?.({ leaseKey: options.leaseKey, ownerId, leaseMs, intervalMs }) ?? (() => {})
      return buildLease(schemaDb, options.leaseKey, ownerId, stopRenewal, registerSameProcessLease(identity, ownerId))
    }

    const existingLock = await schemaDb
      .selectFrom("database_operation_locks")
      .select(["owner_id"])
      .where("lock_key", "=", options.leaseKey)
      .executeTakeFirst()

    // Runtime recovery only: OpenCode can restart while the old repository owner
    // left a live logical lease behind. Normal repository callers leave this off
    // so contention semantics remain strict in tests and non-runtime code.
    if (options.allowSameProcessReclaim && existingLock) {
      const sameProcessUpdateResult = await schemaDb
        .updateTable("database_operation_locks")
        .set({
          owner_id: ownerId,
          lease_expires_at: leaseExpiresAt,
          updated_at: now,
        })
        .where("lock_key", "=", options.leaseKey)
        .where("owner_id", "=", existingLock.owner_id)
        .executeTakeFirst()

      if (hasUpdatedRow(sameProcessUpdateResult)) {
        const stopRenewal = options.renew?.({ leaseKey: options.leaseKey, ownerId, leaseMs, intervalMs }) ?? (() => {})
        return buildLease(schemaDb, options.leaseKey, ownerId, stopRenewal, registerSameProcessLease(identity, ownerId))
      }
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
      const stopRenewal = options.renew?.({ leaseKey: options.leaseKey, ownerId, leaseMs, intervalMs }) ?? (() => {})
      return buildLease(schemaDb, options.leaseKey, ownerId, stopRenewal, registerSameProcessLease(identity, ownerId))
    } catch (error) {
      if (!isExpectedLeaseContention(error)) throw error
      if (options.allowSameProcessReclaim) {
        const reclaimResult = await schemaDb
          .updateTable("database_operation_locks")
          .set({
            owner_id: ownerId,
            lease_expires_at: leaseExpiresAt,
            updated_at: now,
          })
          .where("lock_key", "=", options.leaseKey)
          .executeTakeFirst()

        if (hasUpdatedRow(reclaimResult)) {
          const stopRenewal = options.renew?.({ leaseKey: options.leaseKey, ownerId, leaseMs, intervalMs }) ?? (() => {})
          return buildLease(schemaDb, options.leaseKey, ownerId, stopRenewal, registerSameProcessLease(identity, ownerId))
        }
      }
      lastContentionMessage = error instanceof Error ? error.message : String(error)
    }

    if (Date.now() >= deadline) {
      const suffix = lastContentionMessage ? ` Last contention error: ${lastContentionMessage}` : ""
      throw new Error(`Timed out acquiring DB operation lease ${options.leaseKey}.${suffix}`)
    }
    await sleep(pollMs)
  }
}
