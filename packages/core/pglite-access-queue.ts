/**
 * pglite-access-queue.ts — serialized access queue for local PGlite files.
 *
 * PGlite file databases can fail when separate repository instances access the
 * same database path concurrently. This queue is intentionally PGlite-specific:
 * it serializes physical file access in-process and is not a distributed DB lock.
 */

import { tracePGlite } from "./pglite-trace"

export interface PGliteAccessQueue {
  run<T>(scope: string, run: () => Promise<T>): Promise<T>
}

export function createInProcessPGliteAccessQueue(): PGliteAccessQueue {
  const queues = new Map<string, Promise<void>>()

  return {
    async run<T>(scope: string, run: () => Promise<T>): Promise<T> {
      return runQueued(queues, scope, run)
    },
  }
}

const pgliteAccessQueue = createInProcessPGliteAccessQueue()
let queuedOperationId = 0

async function runQueued<T>(queues: Map<string, Promise<void>>, scope: string, run: () => Promise<T>): Promise<T> {
  const operationId = ++queuedOperationId
  const previous = queues.get(scope) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => {}).then(() => current)
  queues.set(scope, queued)

  const queuedAt = Date.now()
  tracePGlite("queue.wait", { operationId, scope })
  await previous.catch(() => {})
  tracePGlite("queue.enter", { operationId, scope, waitMs: Date.now() - queuedAt })
  try {
    return await run()
  } finally {
    release()
    tracePGlite("queue.exit", { operationId, scope })
    if (queues.get(scope) === queued) {
      queues.delete(scope)
      tracePGlite("queue.empty", { operationId, scope })
    }
  }
}

export async function runWithPGliteAccessQueue<T>(databasePath: string, run: () => Promise<T>): Promise<T> {
  return pgliteAccessQueue.run(databasePath, run)
}
