import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sql } from "kysely"

import { createPGliteDatabaseHandle } from "#core/pglite-connection-manager"
import type { PGliteAccessQueue } from "#core/pglite-access-queue"

interface TestDatabase {
  items: {
    id: string
  }
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oa-pglite-handle-"))
  tempDirs.push(dir)
  return join(dir, "test.pg")
}

describe("PGliteDatabaseHandle", () => {
  it("keeps a shared database connection alive until explicit disposal", async () => {
    const databasePath = await tempDbPath()
    const handle = createPGliteDatabaseHandle<TestDatabase>({ databasePath })

    await handle.run((db) => sql.raw("create table items (id text primary key)").execute(db))
    await handle.run((db) => db.insertInto("items").values({ id: "one" }).execute())
    const rows = await handle.run((db) => db.selectFrom("items").select("id").execute())

    expect(rows).toEqual([{ id: "one" }])
    await handle.dispose()
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
