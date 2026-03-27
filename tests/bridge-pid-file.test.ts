/**
 * Tests for bridge PID file lifecycle management.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { checkPidFile, writePidFile, removePidFile } from "#bridge/pid-file"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pid-test-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("writePidFile", () => {
  it("writes current PID to .bridge-pid", async () => {
    await writePidFile(tmpDir)
    const content = await readFile(join(tmpDir, ".bridge-pid"), "utf-8")
    expect(parseInt(content.trim(), 10)).toBe(process.pid)
  })

  it("creates directory if it doesn't exist", async () => {
    const nested = join(tmpDir, "nested", "dir")
    await writePidFile(nested)
    expect(existsSync(join(nested, ".bridge-pid"))).toBe(true)
  })
})

describe("checkPidFile", () => {
  it("returns not running when no PID file exists", async () => {
    const result = await checkPidFile(tmpDir)
    expect(result.running).toBe(false)
    expect(result.pid).toBeUndefined()
  })

  it("returns running when PID file points to alive process", async () => {
    // Write our own PID — we're alive
    writeFileSync(join(tmpDir, ".bridge-pid"), String(process.pid))
    const result = await checkPidFile(tmpDir)
    expect(result.running).toBe(true)
    expect(result.pid).toBe(process.pid)
  })

  it("cleans up stale PID file from dead process", async () => {
    // PID 999999 is almost certainly not running
    writeFileSync(join(tmpDir, ".bridge-pid"), "999999")
    const result = await checkPidFile(tmpDir)
    expect(result.running).toBe(false)
    expect(result.pid).toBe(999999)
    expect(result.staleCleaned).toBe(true)
    // PID file should be removed
    expect(existsSync(join(tmpDir, ".bridge-pid"))).toBe(false)
  })

  it("cleans up corrupt PID file", async () => {
    writeFileSync(join(tmpDir, ".bridge-pid"), "not-a-number")
    const result = await checkPidFile(tmpDir)
    expect(result.running).toBe(false)
    expect(result.staleCleaned).toBe(true)
    expect(existsSync(join(tmpDir, ".bridge-pid"))).toBe(false)
  })
})

describe("removePidFile", () => {
  it("removes PID file", async () => {
    await writePidFile(tmpDir)
    expect(existsSync(join(tmpDir, ".bridge-pid"))).toBe(true)
    await removePidFile(tmpDir)
    expect(existsSync(join(tmpDir, ".bridge-pid"))).toBe(false)
  })

  it("no-op when PID file doesn't exist", async () => {
    // Should not throw
    await removePidFile(tmpDir)
  })
})

describe("lifecycle integration", () => {
  it("write → check (running) → remove → check (not running)", async () => {
    await writePidFile(tmpDir)

    const check1 = await checkPidFile(tmpDir)
    expect(check1.running).toBe(true)

    await removePidFile(tmpDir)

    const check2 = await checkPidFile(tmpDir)
    expect(check2.running).toBe(false)
  })
})
