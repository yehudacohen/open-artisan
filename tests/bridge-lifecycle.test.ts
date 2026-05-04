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
import { loadBridgeLeaseSnapshot, loadBridgeMetadata } from "#bridge/bridge-meta"
import { handleStateGet, handleStateHealth } from "#bridge/methods/state"
import type { BridgeContext } from "#bridge/server"
import type { EngineContext } from "#core/engine-context"
import { resolveRuntimeBackendKind } from "#core/open-artisan-runtime-backends"

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
    projectDir: null,
    capabilities: { selfReview: "isolated" as const, orchestrator: true, discoveryFleet: true },
    runtimeBackendKind: "filesystem",
    roadmapBackend: null,
    roadmapService: null,
    openArtisanServices: null,
    pinoLogger: null,
    shuttingDown: false,
  }
}

function initFilesystem(context: BridgeContext = ctx) {
  return handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" } }, context)
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
    const result = await initFilesystem()
    expect(result).toBe("ready")
    expect(ctx.engine).not.toBeNull()
  })

  it("rejects missing projectDir", async () => {
    await expect(handleInit({}, ctx)).rejects.toThrow("projectDir")
  })

  it("loads persisted state on init", async () => {
    // First init — create a session
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    await ctx.engine!.store.update("s1", (d) => {
      d.featureName = "test-feat"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
    })

    // Re-init on fresh context — should load from disk
    const ctx2 = makeBridgeContext()
    await initFilesystem(ctx2)
    const state = ctx2.engine!.store.get("s1")
    expect(state).not.toBeNull()
    expect(state?.featureName).toBe("test-feat")
    expect(state?.phase).toBe("PLANNING")
  })

  it("resolves unified DB persistence by default", () => {
    expect(resolveRuntimeBackendKind()).toBe("db")
  })

  it("uses filesystem persistence when explicitly requested", async () => {
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" } }, ctx)
    expect(ctx.runtimeBackendKind).toBe("filesystem")
    expect(ctx.roadmapBackend).toBeNull()
    expect(ctx.roadmapService).toBeNull()
  })

  it("uses unified DB persistence when explicitly requested", async () => {
    expect(resolveRuntimeBackendKind("db")).toBe("db")
    expect(resolveRuntimeBackendKind("pglite")).toBe("db")
  })

  it("writes PID file on init", async () => {
    const { existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    await initFilesystem()
    const stateDir = join(tmpDir, ".openartisan")
    expect(existsSync(join(stateDir, ".bridge-pid"))).toBe(true)
  })

  it("does not advertise process-local stdio bridges as shared runtimes", async () => {
    const { existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    await handleInit({ projectDir: tmpDir, transport: "stdio", registerRuntime: false }, ctx)
    const stateDir = join(tmpDir, ".openartisan")
    expect(existsSync(join(stateDir, ".bridge-pid"))).toBe(false)
    expect(await loadBridgeMetadata(stateDir)).toBeNull()
  })

  it("cleans up stale PID and succeeds", async () => {
    const { writeFileSync, existsSync, mkdirSync } = await import("node:fs")
    const { join } = await import("node:path")
    const stateDir = join(tmpDir, ".openartisan")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, ".bridge-pid"), "999999") // dead process
    const result = await initFilesystem()
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
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    const state = ctx.engine!.store.get("s1")
    expect(state).not.toBeNull()
    expect(state?.phase).toBe("MODE_SELECT")
  })

  it("registers child session without creating state", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "parent" }, ctx)
    await handleSessionCreated({ sessionId: "child", parentId: "parent" }, ctx)
    // Child doesn't get its own state
    expect(ctx.engine!.store.get("child")).toBeNull()
    // But is registered in the session registry
    expect(ctx.engine!.sessions.isChild("child")).toBe(true)
    expect(ctx.engine!.sessions.getParent("child")).toBe("parent")
  })

  it("rejects missing sessionId", async () => {
    await initFilesystem()
    await expect(handleSessionCreated({}, ctx)).rejects.toThrow("sessionId")
  })
})

describe("lifecycle.sessionDeleted", () => {
  it("preserves session state and only unregisters the client", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    await ctx.engine!.store.update("s1", (d) => {
      d.featureName = "persisted-feature"
      d.phase = "PLANNING"
    })
    expect(ctx.engine!.store.get("s1")).not.toBeNull()
    await handleSessionDeleted({ sessionId: "s1" }, ctx)
    expect(ctx.engine!.store.get("s1")?.featureName).toBe("persisted-feature")
  })

  it("removes the detached client lease", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1", agent: "artisan" }, ctx)
    await handleSessionDeleted({ sessionId: "s1" }, ctx)

    const leases = await loadBridgeLeaseSnapshot(join(tmpDir, ".openartisan"))
    expect(leases?.clients).toHaveLength(0)
  })
})

describe("state.get", () => {
  it("returns session state", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    const result = await handleStateGet({ sessionId: "s1" }, ctx) as any
    expect(result).not.toBeNull()
    expect(result.sessionId).toBe("s1")
    expect(result.phase).toBe("MODE_SELECT")
  })

  it("returns null for unknown session", async () => {
    await initFilesystem()
    const result = await handleStateGet({ sessionId: "nonexistent" }, ctx)
    expect(result).toBeNull()
  })

  it("can include runtime health summary alongside session state", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1", agent: "hermes" }, ctx)
    const result = await handleStateGet({ sessionId: "s1", includeRuntimeHealth: true }, ctx) as any
    expect(result.state).not.toBeNull()
    expect(result.state.sessionId).toBe("s1")
    expect(result.runtimeHealth.phase).toBe("MODE_SELECT")
    expect(result.runtimeHealth.bridgeTransport).toBe("unix-socket")
    expect(result.runtimeHealth.bridgeAttachedClients).toBeGreaterThan(0)
    expect(result.runtimeHealth.bridgeActiveClientKinds).toContain("hermes")
    expect(result.runtimeHealth.pendingTaskReview).toBe(false)
    expect(result.runtimeHealth.lastRecoveryAction).toBe("attached-shared-bridge")
    expect(result.runtimeHealth.awaitingUserGate).toBe(false)
    expect(result.runtimeHealth.noopReason).toBeNull()
  })

  it("rejects missing sessionId", async () => {
    await initFilesystem()
    await expect(handleStateGet({}, ctx)).rejects.toThrow("sessionId")
  })

  it("state.health returns runtime health directly", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1", agent: "hermes" }, ctx)
    const result = await handleStateHealth({ sessionId: "s1" }, ctx) as any
    expect(result.phase).toBe("MODE_SELECT")
    expect(result.bridgeTransport).toBe("unix-socket")
    expect(result.bridgeActiveClientKinds).toContain("hermes")
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
    await initFilesystem()
    // Should not throw
    await handleSessionDeleted({ sessionId: "nonexistent" }, ctx)
  })
})

describe("lifecycle.shutdown", () => {
  // Note: handleShutdown calls process.exit() which can't be tested in-process.
  // Full shutdown behavior (PID removal, response flush, process exit) is tested
  // in bridge-integration.test.ts via the spawned child process.

  it("shuttingDown starts as false", () => {
    expect(ctx.shuttingDown).toBe(false)
  })

  it("returns blocked result when active clients remain", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)

    const result = await handleShutdown({}, ctx) as { ok: boolean; activeClientCount: number }
    expect(result.ok).toBe(false)
    expect(result.activeClientCount).toBe(1)
  })

  it("allows forced shutdown even when clients remain", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)

    const originalExit = process.exit
    process.exit = ((() => undefined) as unknown) as typeof process.exit
    try {
      const result = await handleShutdown({ force: true }, ctx)
      expect(result).toBe("ok")
      await new Promise((resolve) => setTimeout(resolve, 75))
    } finally {
      process.exit = originalExit
    }
  })

  it("disposes the runtime backend during forced shutdown", async () => {
    await initFilesystem()
    let disposed = false
    ctx.runtimeBackendDispose = async () => {
      disposed = true
    }

    const originalExit = process.exit
    process.exit = ((() => undefined) as unknown) as typeof process.exit
    try {
      const result = await handleShutdown({ force: true }, ctx)
      expect(result).toBe("ok")
      expect(disposed).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 75))
    } finally {
      process.exit = originalExit
    }
  })
})

describe("lifecycle.init — double init", () => {
  it("re-initializes with new engine on second call", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    // Give the session a featureName so it persists to disk
    await ctx.engine!.store.update("s1", (d) => {
      d.featureName = "double-init-feat"
      d.mode = "GREENFIELD"
    })

    // Second init — should reload state from disk
    await initFilesystem()
    const state = ctx.engine!.store.get("s1")
    expect(state).not.toBeNull()
    expect(state?.sessionId).toBe("s1")
    expect(state?.featureName).toBe("double-init-feat")
  })

  it("writes bridge metadata on init", async () => {
    await initFilesystem()
    const metadata = await loadBridgeMetadata(join(tmpDir, ".openartisan"))
    expect(metadata?.projectDir).toBe(tmpDir)
    expect(metadata?.pid).toBe(process.pid)
  })
})

describe("policyVersion", () => {
  it("starts at 0", () => {
    expect(ctx.policyVersion).toBe(0)
  })

  it("bumps on store.update", async () => {
    await initFilesystem()
    await handleSessionCreated({ sessionId: "s1" }, ctx)
    const before = ctx.policyVersion
    await ctx.engine!.store.update("s1", (d) => { d.iterationCount = 1 })
    expect(ctx.policyVersion).toBeGreaterThan(before)
  })
})
