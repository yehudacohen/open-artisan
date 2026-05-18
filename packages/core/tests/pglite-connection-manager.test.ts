import { afterEach, expect, it, setDefaultTimeout } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { sql } from "kysely"

import { createPGliteDatabaseHandle } from "#core/pglite-connection-manager"
import { cleanupStalePhysicalPGliteLock, createInProcessPGliteAccessQueue, inspectPhysicalPGliteLock, type PGliteAccessQueue } from "#core/pglite-access-queue"
import { PGLITE_QUEUE_WAIT_TIMEOUT_ENV } from "#core/constants"
import { pgliteShardDescribe } from "../../../tests/helpers/pglite-shard-gate"

interface TestDatabase {
  items: {
    id: string
  }
}

const tempDirs: string[] = []
let previousQueueWaitTimeout: string | undefined
setDefaultTimeout(90_000)
process.env["OPENARTISAN_PGLITE_QUEUE_WAIT_TIMEOUT_MS"] = "120000"

afterEach(async () => {
  if (previousQueueWaitTimeout === undefined) {
    delete process.env[PGLITE_QUEUE_WAIT_TIMEOUT_ENV]
  } else {
    process.env[PGLITE_QUEUE_WAIT_TIMEOUT_ENV] = previousQueueWaitTimeout
  }
  previousQueueWaitTimeout = undefined
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oa-pglite-handle-"))
  tempDirs.push(dir)
  return join(dir, "test.pg")
}

pgliteShardDescribe("PGliteDatabaseHandle", () => {
  it("inspects and removes stale physical lock files without an owner", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openartisan-pglite-lock-"))
    const databasePath = join(tempDir, "workflow-db")
    await mkdir(databasePath, { recursive: true })
    const lockPath = join(tempDir, `.openartisan-${basename(databasePath)}.pglite.lock`)
    await writeFile(lockPath, JSON.stringify({ ownerId: "stale-owner", acquiredAt: new Date(0).toISOString(), scope: databasePath }))
    const staleDate = new Date(Date.now() - 700_000)
    await utimes(lockPath, staleDate, staleDate)

    const before = await inspectPhysicalPGliteLock(databasePath)
    const cleanup = await cleanupStalePhysicalPGliteLock(databasePath)
    const after = await inspectPhysicalPGliteLock(databasePath)

    expect(before.exists).toBe(true)
    expect(before.stale).toBe(true)
    expect(cleanup.removed).toBe(true)
    expect(cleanup.reason).toBe("stale-no-owner")
    expect(after.exists).toBe(false)
    await rm(tempDir, { recursive: true, force: true })
  })

  it("does not remove a live physical lock file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openartisan-pglite-live-lock-"))
    const databasePath = join(tempDir, "workflow-db")
    await mkdir(databasePath, { recursive: true })
    const lockPath = join(tempDir, `.openartisan-${basename(databasePath)}.pglite.lock`)
    await writeFile(lockPath, JSON.stringify({ ownerId: "live-owner", pid: process.pid, acquiredAt: new Date().toISOString(), scope: databasePath }))

    const cleanup = await cleanupStalePhysicalPGliteLock(databasePath)
    const after = await inspectPhysicalPGliteLock(databasePath)

    expect(cleanup.removed).toBe(false)
    expect(cleanup.reason).toBe("live-owner")
    expect(after.exists).toBe(true)
    await rm(tempDir, { recursive: true, force: true })
  })

  it("times out behind a wedged in-process queue operation and allows later operations", async () => {
    previousQueueWaitTimeout = process.env[PGLITE_QUEUE_WAIT_TIMEOUT_ENV]
    process.env[PGLITE_QUEUE_WAIT_TIMEOUT_ENV] = "10"
    const queue = createInProcessPGliteAccessQueue()
    let releaseFirstOperation: () => void = () => {
      throw new Error("first operation was not registered")
    }
    const firstOperationStarted = new Promise<void>((resolve) => {
      void queue.run("wedged-db", async () => {
        resolve()
        await new Promise<void>((release) => { releaseFirstOperation = release })
      })
    })
    await firstOperationStarted

    await expect(queue.run("wedged-db", async () => "blocked")).rejects.toThrow("Timed out waiting for prior PGlite operation")
    await expect(queue.run("wedged-db", async () => "recovered")).resolves.toBe("recovered")

    releaseFirstOperation()
  })

  it("preserves data across operation-scoped lock acquisitions", async () => {
    const databasePath = await tempDbPath()
    const handle = createPGliteDatabaseHandle<TestDatabase>({ databasePath })

    await handle.run((db) => sql.raw("create table items (id text primary key)").execute(db))
    await handle.run((db) => db.insertInto("items").values({ id: "one" }).execute())
    const rows = await handle.run((db) => db.selectFrom("items").select("id").execute())

    expect(rows).toEqual([{ id: "one" }])
    await handle.dispose()
  })

  it("does not hold the physical database lock while idle", async () => {
    const databasePath = await tempDbPath()
    const firstHandle = createPGliteDatabaseHandle<TestDatabase>({ databasePath })
    const secondHandle = createPGliteDatabaseHandle<TestDatabase>({ databasePath })

    await firstHandle.run((db) => sql.raw("create table items (id text primary key)").execute(db))
    await firstHandle.run((db) => db.insertInto("items").values({ id: "one" }).execute())

    const rows = await secondHandle.run((db) => db.selectFrom("items").select("id").execute())

    expect(rows).toEqual([{ id: "one" }])
    await firstHandle.dispose()
    await secondHandle.dispose()
  })

  it("waits for queued operations before disposing", async () => {
    const databasePath = await tempDbPath()
    let releaseQueuedOperation: () => void = () => {
      throw new Error("queued operation was not registered")
    }
    let queuedOperationReceived: (() => void) | null = null
    const queuedOperationStarted = new Promise<void>((resolve) => {
      queuedOperationReceived = resolve
    })
    const queue: PGliteAccessQueue = {
      async run(_scope, run) {
        queuedOperationReceived?.()
        await new Promise<void>((resolve) => {
          releaseQueuedOperation = resolve
        })
        return run()
      },
    }
    const handle = createPGliteDatabaseHandle<TestDatabase>({ databasePath, accessQueue: queue })

    const operation = handle.run((db) => sql.raw("select 1").execute(db))
    await queuedOperationStarted
    let disposed = false
    const disposal = handle.dispose().then(() => {
      disposed = true
    })

    await Promise.resolve()
    expect(disposed).toBe(false)

    releaseQueuedOperation()
    await operation
    await disposal
    expect(disposed).toBe(true)
  })

  it("rejects operations after disposal", async () => {
    const databasePath = await tempDbPath()
    const handle = createPGliteDatabaseHandle<TestDatabase>({ databasePath })

    await handle.run((db) => sql.raw("select 1").execute(db))
    await handle.dispose()

    await expect(handle.run((db) => sql.raw("select 1").execute(db))).rejects.toThrow("has been disposed")
  })
})
