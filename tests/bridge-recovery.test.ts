import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { recoverStaleBridgeRuntime } from "#bridge/recovery"

async function withProject(fn: (projectDir: string) => Promise<void>) {
  const projectDir = await mkdtemp(join(tmpdir(), "oa-recovery-"))
  try {
    await mkdir(join(projectDir, ".openartisan"), { recursive: true })
    await fn(projectDir)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}

describe("bridge runtime recovery", () => {
  it("clears malformed bridge metadata", async () => {
    await withProject(async (projectDir) => {
      const stateDir = join(projectDir, ".openartisan")
      await writeFile(join(stateDir, ".bridge-meta.json"), "{not-json")

      const result = recoverStaleBridgeRuntime(projectDir)

      expect(result.kind).toBe("stale_bridge_recovered")
      expect(result.discovery.kind).toBe("attach_failed")
      expect(result.clearedPaths).toContain(join(stateDir, ".bridge-meta.json"))
    })
  })

  it("does not clear live bridge metadata", async () => {
    await withProject(async (projectDir) => {
      const stateDir = join(projectDir, ".openartisan")
      const socketPath = join(stateDir, ".bridge.sock")
      await writeFile(socketPath, "")
      await writeFile(join(stateDir, ".bridge-meta.json"), JSON.stringify({
        pid: process.pid,
        socketPath,
      }))

      const result = recoverStaleBridgeRuntime(projectDir)

      expect(result.kind).toBe("no_recovery_needed")
      expect(result.clearedPaths).toEqual([])
    })
  })
})
