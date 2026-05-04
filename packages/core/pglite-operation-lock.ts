/**
 * pglite-operation-lock.ts — externalizable operation queue for local PGlite access.
 *
 * PGlite file databases can fail when separate repository instances open the
 * same database path concurrently. The interface is intentionally small so a
 * future cluster runtime can swap this in-process queue for a broker-backed or
 * DB-backed queue without changing repository call sites.
 */

export interface DatabaseOperationQueue {
  run<T>(scope: string, run: () => Promise<T>): Promise<T>
}

export function createInProcessDatabaseOperationQueue(): DatabaseOperationQueue {
  const queues = new Map<string, Promise<void>>()

  return {
    async run<T>(scope: string, run: () => Promise<T>): Promise<T> {
      return runQueued(queues, scope, run)
    },
  }
}

const pgliteOperationQueue = createInProcessDatabaseOperationQueue()

async function runQueued<T>(queues: Map<string, Promise<void>>, scope: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(scope) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => {}).then(() => current)
  queues.set(scope, queued)

  await previous.catch(() => {})
  try {
    return await run()
  } finally {
    release()
    if (queues.get(scope) === queued) {
      queues.delete(scope)
    }
  }
}

export async function runWithPGliteDatabaseLock<T>(databasePath: string, run: () => Promise<T>): Promise<T> {
  return pgliteOperationQueue.run(databasePath, run)
}
