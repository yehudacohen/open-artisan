/**
 * pglite-connection-manager.ts — PGlite connection and repository lifecycle.
 *
 * PGlite file databases are expensive to open and sensitive to concurrent access.
 * This module keeps those constraints behind a provider-specific handle: callers
 * get serialized operations, a shared per-path Kysely connection while the
 * handle is active, operation-scoped physical locking, and explicit disposal
 * semantics without duplicating lifecycle state in each repository.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { Kysely } from "kysely"
import { PGliteDialect } from "kysely-pglite-dialect"

import { acquirePhysicalPGliteLock, runWithPGliteAccessQueue, type PGliteAccessQueue } from "./pglite-access-queue"
import { tracePGlite } from "./pglite-trace"

interface SharedPGliteConnectionEntry {
  dbPromise: Promise<Kysely<unknown>>
  refCount: number
  closePromise: Promise<void> | null
}

export interface SharedPGliteConnection<Database> {
  db: Kysely<Database>
  release(): Promise<void>
}

export interface PGliteDatabaseHandle<Database> {
  readonly databasePath: string
  run<T>(operation: (db: Kysely<Database>) => Promise<T>, label?: string): Promise<T>
  dispose(): Promise<void>
}

export interface PGliteDatabaseHandleOptions {
  databasePath: string
  accessQueue?: PGliteAccessQueue
}

const connections = new Map<string, SharedPGliteConnectionEntry>()
const pgliteClients = new WeakMap<Kysely<unknown>, PGlite>()
let handleOperationId = 0

async function createKyselyConnection<Database>(databasePath: string): Promise<Kysely<Database>> {
  const startedAt = Date.now()
  tracePGlite("connection.open.start", { databasePath })
  await mkdir(dirname(databasePath), { recursive: true })
  const client = new PGlite(databasePath)
  const db = new Kysely<Database>({ dialect: new PGliteDialect(client) })
  pgliteClients.set(db as unknown as Kysely<unknown>, client)
  tracePGlite("connection.open.ready", { databasePath, durationMs: Date.now() - startedAt })
  return db
}

export async function executePGliteRawBatch<Database>(db: Kysely<Database>, statements: string[]): Promise<boolean> {
  if (statements.length === 0) return true
  const client = pgliteClients.get(db as unknown as Kysely<unknown>)
  if (!client) return false
  await client.exec(statements.join(";\n"))
  return true
}

export async function acquireSharedPGliteConnection<Database>(databasePath: string): Promise<SharedPGliteConnection<Database>> {
  const existing = connections.get(databasePath)
  if (existing?.closePromise) {
    tracePGlite("connection.acquire.wait-close", { databasePath })
    await existing.closePromise
    return acquireSharedPGliteConnection(databasePath)
  }

  let entry = connections.get(databasePath)
  if (!entry) {
    tracePGlite("connection.entry.create", { databasePath })
    entry = {
      dbPromise: createKyselyConnection<unknown>(databasePath).catch((error) => {
        if (connections.get(databasePath) === entry) connections.delete(databasePath)
        tracePGlite("connection.open.error", { databasePath, message: error instanceof Error ? error.message : String(error) })
        throw error
      }),
      refCount: 0,
      closePromise: null,
    }
    connections.set(databasePath, entry)
  }

  entry.refCount++
  tracePGlite("connection.acquire.start", { databasePath, refCount: entry.refCount })
  let released = false
  const db = await entry.dbPromise as Kysely<Database>
  tracePGlite("connection.acquire.ready", { databasePath, refCount: entry.refCount })

  return {
    db,
    async release() {
      if (released) return
      released = true

      const current = connections.get(databasePath)
      if (current !== entry) return

      current.refCount--
      tracePGlite("connection.release", { databasePath, refCount: current.refCount })
      if (current.refCount > 0 || current.closePromise) return

      tracePGlite("connection.close.start", { databasePath })
      current.closePromise = current.dbPromise
        .then((database) => database.destroy())
        .finally(() => {
          if (connections.get(databasePath) === current) connections.delete(databasePath)
          tracePGlite("connection.close.done", { databasePath })
        })
      await current.closePromise
    },
  }
}

export function createPGliteDatabaseHandle<Database>(options: PGliteDatabaseHandleOptions): PGliteDatabaseHandle<Database> {
  const runQueued = <Result>(scope: string, operation: () => Promise<Result>) =>
    options.accessQueue
      ? options.accessQueue.run(scope, () => runWithPGliteAccessQueue(scope, operation))
      : runWithPGliteAccessQueue(scope, operation)
  let connectionPromise: Promise<SharedPGliteConnection<Database>> | null = null
  let pendingOperations = 0
  let closing = false
  let closed = false
  const idleWaiters: Array<() => void> = []

  function notifyIdle(): void {
    if (pendingOperations > 0) return
    for (const resolve of idleWaiters.splice(0)) resolve()
  }

  function waitForIdle(): Promise<void> {
    if (pendingOperations === 0) return Promise.resolve()
    tracePGlite("handle.dispose.wait-idle", { databasePath: options.databasePath, pendingOperations })
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  async function getConnection(): Promise<SharedPGliteConnection<Database>> {
    connectionPromise ??= acquireSharedPGliteConnection<Database>(options.databasePath).catch((error) => {
      connectionPromise = null
      throw error
    })
    return connectionPromise
  }

  return {
    databasePath: options.databasePath,

    async run<T>(operation: (db: Kysely<Database>) => Promise<T>, label = "operation"): Promise<T> {
      if (closing || closed) {
        throw new Error(`PGlite database handle for ${options.databasePath} has been disposed`)
      }
      const operationId = ++handleOperationId
      const startedAt = Date.now()
      pendingOperations++
      tracePGlite("handle.operation.start", { operationId, databasePath: options.databasePath, pendingOperations, label })
      try {
        return await runQueued(options.databasePath, async () => {
          tracePGlite("handle.operation.enter", { operationId, databasePath: options.databasePath, pendingOperations, label })
          const releasePhysicalLock = await acquirePhysicalPGliteLock(options.databasePath, operationId)
          try {
            const connection = await getConnection()
            const result = await operation(connection.db)
            tracePGlite("handle.operation.done", { operationId, databasePath: options.databasePath, durationMs: Date.now() - startedAt, label })
            return result
          } finally {
            await releasePhysicalLock()
          }
        })
      } finally {
        pendingOperations--
        tracePGlite("handle.operation.exit", { operationId, databasePath: options.databasePath, pendingOperations, label })
        notifyIdle()
      }
    },

    async dispose(): Promise<void> {
      if (closed) return
      tracePGlite("handle.dispose.start", { databasePath: options.databasePath, pendingOperations })
      closing = true
      await waitForIdle()
      const connectionToRelease = connectionPromise
      connectionPromise = null
      if (connectionToRelease) await (await connectionToRelease).release()
      closed = true
      tracePGlite("handle.dispose.done", { databasePath: options.databasePath })
    },
  }
}
