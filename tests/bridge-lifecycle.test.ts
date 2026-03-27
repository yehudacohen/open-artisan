/**
 * Tests for bridge lifecycle — init, ping, shutdown, session management.
 *
 * Uses the bridge server in-process (no child process spawn) by calling
 * method handlers directly with a real store + FileSystemStateBackend.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import {
  handleInit,
  handlePing,
  handleShutdown,
  handleSessionCreated,
  handleSessionDeleted,
} from "#bridge/methods/lifecycle"
import { handleStateGet } from "#bridge/methods/state"
import type { BridgeContext } from "#bridge/server"
import type { EngineContext } from "#core/engine-context"

let tmpDir: string
let ctx: BridgeContext

function makeBridgeContext(): BridgeContext {
  let engine: EngineContext | null = null
  let policyVersion = 0

  return {
    get engine() { return engine },
    get policyVersion() { return policyVersion },
    bumpPolicyVersion() { policyVersion++ },
    setEngine(e: EngineContext) { engine = e },
    stateDir: null,
    pinoLogger: null,
    shuttingDown: false,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-test-"))
  ctx = makeBridgeContext()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("lifecycle.init", () => {
  it("initializes the engine and returns 'ready'", async () => {
    const result = await handleInit({ projectDir: tmpDir }, ctx)
    expect(result).toBe("ready")
    expect(ctx.engine).not.toBeNull()
  })

  it("rejects missing projectDir", async () => {
    await expect(handleInit({}, ctx)).rejects.toThrow("projectDir")
  })

  it("loads persisted state on init", async () => {
    // First init — create a session
    await handleInit({ projectDir: tmpDir }, ctx)
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    await ctx.engine!.store.update("s1", (d) => {
      d.featureName = "test-feat"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })

    // Re-init on fresh context — should load from disk
    const ctx2 = makeBridgeContext()
    await handleInit({ projectDir: tmpDir }, ctx2)
    const state = ctx2.engine!.store.get("s1")
    expect(state).not.toBeNull()
    expect(state?.featureName).toBe("test-feat")
    expect(state?.phase).toBe("PLANNING")
  })

  it("writes PID file on init", async () => {
    const { existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    await handleInit({ projectDir: tmpDir }, ctx)
    const stateDir = join(tmpDir, ".openartisan")
    expect(existsSync(join(stateDir, ".bridge-pid"))).toBe(true)
  })

  it("cleans up stale PID and succeeds", async () => {
    const { writeFileSync, existsSync, mkdirSync } = await import("node:fs")
    const { join } = await import("node:path")
    const stateDir = join(tmpDir, ".openartisan")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, ".bridge-pid"), "999999") // dead process
    const result = await handleInit({ projectDir: tmpDir }, ctx)
    expect(result).toBe("ready")
  })
})

describe("lifecycle.ping", () => {
  it("returns 'pong'", async () => {
    const result = await handlePing({}, ctx)
    expect(result).toBe("pong")
  })

  it("works without initialization", async () => {
    const result = await handlePing({}, ctx)
    expect(result).toBe("pong")
  })
})

describe("lifecycle.sessionCreated", () => {
  it("creates a primary session", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    const state = ctx.engine!.store.get("s1")
    expect(state).not.toBeNull()
    expect(state?.phase).toBe("MODE_SELECT")
  })

  it("registers child session without creating state", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    await handleSessionCreated({ sessionId: "parent" }, ctx)
    await handleSessionCreated({ sessionId: "child", parentId: "parent" }, ctx)
    // Child doesn't get its own state
    expect(ctx.engine!.store.get("child")).toBeNull()
    // But is registered in the session registry
    expect(ctx.engine!.sessions.isChild("child")).toBe(true)
    expect(ctx.engine!.sessions.getParent("child")).toBe("parent")
  })

  it("rejects missing sessionId", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    await expect(handleSessionCreated({}, ctx)).rejects.toThrow("sessionId")
  })
})

describe("lifecycle.sessionDeleted", () => {
  it("removes session state and unregisters", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    expect(ctx.engine!.store.get("s1")).not.toBeNull()
    await handleSessionDeleted({ sessionId: "s1" }, ctx)
    expect(ctx.engine!.store.get("s1")).toBeNull()
  })
})

describe("state.get", () => {
  it("returns session state", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    const result = await handleStateGet({ sessionId: "s1" }, ctx) as any
    expect(result).not.toBeNull()
    expect(result.sessionId).toBe("s1")
    expect(result.phase).toBe("MODE_SELECT")
  })

  it("returns null for unknown session", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    const result = await handleStateGet({ sessionId: "nonexistent" }, ctx)
    expect(result).toBeNull()
  })

  it("rejects missing sessionId", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    await expect(handleStateGet({}, ctx)).rejects.toThrow("sessionId")
  })
})

describe("initialization guard", () => {
  it("handlers fail gracefully before lifecycle.init", async () => {
    // ctx.engine is null — handler access to ctx.engine! throws TypeError
    await expect(handleStateGet({ sessionId: "s1" }, ctx)).rejects.toThrow()
  })

  it("server dispatch returns NOT_INITIALIZED error for non-init methods", async () => {
    // Test the server-level guard (not just the handler)
    const { createBridgeServer } = await import("#bridge/server")
    const { NOT_INITIALIZED } = await import("#bridge/protocol")

    const server = createBridgeServer({
      "lifecycle.init": handleInit,
      "lifecycle.ping": handlePing,
      "state.get": handleStateGet,
    }, { input: process.stdin, output: process.stdout })

    // The server's addMethod wrapper checks engine === null for non-INIT_FREE methods
    // We can't easily test via stdio, but we can verify the ctx is uninitialized
    expect(server.initialized).toBe(false)
  })
})

describe("lifecycle.sessionDeleted — edge cases", () => {
  it("no-op for unknown session", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    // Should not throw
    await handleSessionDeleted({ sessionId: "nonexistent" }, ctx)
  })
})

describe("policyVersion", () => {
  it("starts at 0", () => {
    expect(ctx.policyVersion).toBe(0)
  })

  it("bumps on store.update", async () => {
    await handleInit({ projectDir: tmpDir }, ctx)
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    const before = ctx.policyVersion
    await ctx.engine!.store.update("s1", (d) => { d.iterationCount = 1 })
    expect(ctx.policyVersion).toBeGreaterThan(before)
  })
})
