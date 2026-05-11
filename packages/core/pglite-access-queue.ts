/**
 * pglite-access-queue.ts — serialized access queue for local PGlite files.
 *
 * PGlite file databases can fail when separate repository instances access the
 * same database path concurrently. This queue is intentionally PGlite-specific:
 * it serializes physical file access in-process and, for cooperating Open Artisan
 * processes, with a small filesystem lock beside the database path.
 */

import { mkdir, open, readFile, stat, unlink, utimes, type FileHandle } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"

import {
  PGLITE_FILE_LOCK_POLL_MS,
  PGLITE_FILE_LOCK_STALE_MS,
  PGLITE_FILE_LOCK_TIMEOUT_MS,
  PGLITE_QUEUE_WAIT_TIMEOUT_ENV,
  PGLITE_QUEUE_WAIT_TIMEOUT_MS,
} from "./constants"
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pgliteQueueWaitTimeoutMs(): number {
  const raw = process.env[PGLITE_QUEUE_WAIT_TIMEOUT_ENV]
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PGLITE_QUEUE_WAIT_TIMEOUT_MS
}

function waitForPreviousQueuedOperation(scope: string, operationId: number, previous: Promise<void>): Promise<void> {
  const timeoutMs = pgliteQueueWaitTimeoutMs()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      tracePGlite("queue.wait.timeout", { operationId, scope, timeoutMs })
      reject(new Error(`Timed out waiting for prior PGlite operation for ${scope} after ${timeoutMs}ms`))
    }, timeoutMs)
    previous.then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

function lockPathForScope(scope: string): string {
  const safeName = basename(scope).replace(/[^a-zA-Z0-9._-]/g, "_") || "database"
  return join(dirname(scope), `.openartisan-${safeName}.pglite.lock`)
}

export interface PGlitePhysicalLockInfo {
  lockPath: string
  exists: boolean
  pid: number | null
  ownerId: string | null
  ageMs: number | null
  ownerAlive: boolean | null
  stale: boolean
}

export interface PGlitePhysicalLockCleanupResult extends PGlitePhysicalLockInfo {
  removed: boolean
  reason: "missing" | "owner-dead" | "stale-no-owner" | "live-owner" | "fresh" | "unreadable"
}

function isPidAlive(pid: number | null): boolean | null {
  if (pid === null || pid <= 0) return null
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function inspectPhysicalPGliteLock(scope: string, now = Date.now()): Promise<PGlitePhysicalLockInfo> {
  const lockPath = lockPathForScope(scope)
  try {
    const raw = await readFile(lockPath, "utf-8")
    const current = raw ? JSON.parse(raw) as { pid?: unknown; ownerId?: unknown } : null
    const info = await stat(lockPath)
    const pid = typeof current?.pid === "number" ? current.pid : null
    const ageMs = Math.max(0, now - info.mtimeMs)
    return {
      lockPath,
      exists: true,
      pid,
      ownerId: typeof current?.ownerId === "string" ? current.ownerId : null,
      ageMs,
      ownerAlive: isPidAlive(pid),
      stale: ageMs > PGLITE_FILE_LOCK_STALE_MS,
    }
  } catch {
    return { lockPath, exists: false, pid: null, ownerId: null, ageMs: null, ownerAlive: null, stale: false }
  }
}

export async function cleanupStalePhysicalPGliteLock(scope: string): Promise<PGlitePhysicalLockCleanupResult> {
  const info = await inspectPhysicalPGliteLock(scope)
  if (!info.exists) return { ...info, removed: false, reason: "missing" }
  if (info.ownerAlive === false) {
    await unlink(info.lockPath).catch(() => {})
    return { ...info, removed: true, reason: "owner-dead" }
  }
  if (info.stale && info.pid === null) {
    await unlink(info.lockPath).catch(() => {})
    return { ...info, removed: true, reason: "stale-no-owner" }
  }
  if (info.ownerAlive === true) return { ...info, removed: false, reason: "live-owner" }
  return { ...info, removed: false, reason: info.stale ? "unreadable" : "fresh" }
}

export async function acquirePhysicalPGliteLock(scope: string, operationId: number): Promise<() => Promise<void>> {
  const lockPath = lockPathForScope(scope)
  const deadline = Date.now() + PGLITE_FILE_LOCK_TIMEOUT_MS
  const ownerId = `${process.pid}:${randomUUID()}`
  let lastOwner: { pid: number | null; ownerId: string | null; ageMs: number | null } | null = null
  await mkdir(dirname(lockPath), { recursive: true })

  while (true) {
    let handle: FileHandle | null = null
    try {
      handle = await open(lockPath, "wx")
      await handle.writeFile(JSON.stringify({ ownerId, pid: process.pid, acquiredAt: new Date().toISOString(), scope }))
      const renewal = setInterval(() => {
        const now = new Date()
        void utimes(lockPath, now, now).catch(() => {})
      }, Math.max(PGLITE_FILE_LOCK_POLL_MS, Math.floor(PGLITE_FILE_LOCK_STALE_MS / 3)))
      tracePGlite("file-lock.acquired", { operationId, scope, lockPath })
      return async () => {
        clearInterval(renewal)
        try { await handle?.close() } catch { /* best-effort */ }
        try {
          const raw = await readFile(lockPath, "utf-8")
          const current = JSON.parse(raw) as { ownerId?: unknown }
          if (current.ownerId === ownerId) await unlink(lockPath)
        } catch { /* best-effort */ }
        tracePGlite("file-lock.released", { operationId, scope, lockPath })
      }
    } catch (error) {
      try { await handle?.close() } catch { /* best-effort */ }
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : ""
      if (code !== "EEXIST") throw error
      try {
        const raw = await readFile(lockPath, "utf-8").catch(() => "")
        const current = raw ? JSON.parse(raw) as { pid?: unknown; ownerId?: unknown } : null
        const pid = typeof current?.pid === "number" ? current.pid : null
        const info = await stat(lockPath)
        lastOwner = {
          pid,
          ownerId: typeof current?.ownerId === "string" ? current.ownerId : null,
          ageMs: Math.max(0, Date.now() - info.mtimeMs),
        }
        const ownerAlive = pid !== null && pid > 0 ? (() => {
          try { process.kill(pid, 0); return true } catch { return false }
        })() : false
        if (pid !== null && !ownerAlive) {
          await unlink(lockPath)
          tracePGlite("file-lock.reclaimed", { operationId, scope, lockPath, ownerId: typeof current?.ownerId === "string" ? current.ownerId : null, reason: "owner-dead" })
          continue
        }
        if (Date.now() - info.mtimeMs > PGLITE_FILE_LOCK_STALE_MS) {
          if (pid === null) {
            await unlink(lockPath)
            tracePGlite("file-lock.reclaimed", { operationId, scope, lockPath, ownerId: null, reason: "stale-no-owner" })
            continue
          }
        }
      } catch (statError) {
        const statCode = statError && typeof statError === "object" && "code" in statError ? String((statError as { code?: unknown }).code) : ""
        if (statCode !== "ENOENT") throw statError
      }
      if (Date.now() >= deadline) {
        const ownerDetail = lastOwner
          ? ` Lock holder: pid=${lastOwner.pid ?? "unknown"}, ownerId=${lastOwner.ownerId ?? "unknown"}, ageMs=${lastOwner.ageMs ?? "unknown"}, lockPath=${lockPath}.`
          : ` Lock holder details unavailable; lockPath=${lockPath}.`
        throw new Error(`Timed out acquiring physical PGlite lock for ${scope}.${ownerDetail}`)
      }
      await sleep(PGLITE_FILE_LOCK_POLL_MS)
    }
  }
}

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
  try {
    await waitForPreviousQueuedOperation(scope, operationId, previous)
  } catch (error) {
    release()
    if (queues.get(scope) === queued) queues.delete(scope)
    throw error
  }
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
