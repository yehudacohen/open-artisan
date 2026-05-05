/**
 * Tests for the artisan-server entry point.
 *
 * Spawns the server as a child process, communicates via socket,
 * and verifies end-to-end behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync, readFileSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"

import { sendSocketRequest } from "#claude-code/src/socket-transport"
import { getSocketPath, DEFAULT_STATE_DIR_NAME } from "#claude-code/src/constants"

let tmpDir: string
let stateDir: string
let socketPath: string
let serverProcess: ChildProcess | null = null

// Resolve from repo root (tests/ is one level deep)
const REPO_ROOT = join(import.meta.dirname, "..")
const SERVER_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-server.ts")

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "artisan-server-test-"))
  stateDir = join(tmpDir, DEFAULT_STATE_DIR_NAME)
  socketPath = getSocketPath(stateDir)
})

afterEach(async () => {
  await stopServer()
  await rm(tmpDir, { recursive: true, force: true })
})

async function stopServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill("SIGTERM")
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      if (!serverProcess) { resolve(); return }
      serverProcess.on("exit", () => resolve())
      setTimeout(resolve, 2000) // force timeout
    })
    serverProcess = null
  }
}

/** Spawn the server and wait for the socket to become available. */
async function startServer(): Promise<void> {
  serverProcess = spawn("bun", ["run", SERVER_SCRIPT, "--project-dir", tmpDir], {
    stdio: "ignore",
    env: { ...process.env, OPENARTISAN_STATE_BACKEND: "filesystem" },
  })

  // Poll for socket availability
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      // Socket file exists — try a ping to verify it's ready
      const response = await sendSocketRequest(socketPath, {
        jsonrpc: "2.0", method: "lifecycle.ping", id: 1,
      })
      if (response && (response as any).result === "pong") return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("Server failed to start within 10s")
}

/** Send a JSON-RPC request to the server. */
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const response = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0", method, params, id: Date.now(),
  })
  if (!response) throw new Error(`No response from server for ${method}`)
  return response
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("artisan-server", () => {
  it("starts and responds to ping", async () => {
    await startServer()
    const response = await rpc("lifecycle.ping")
    expect(response.result).toBe("pong")
  }, 15000)

  it("initializes with agent-only capabilities", async () => {
    await startServer()
    // Create a session
    await rpc("lifecycle.sessionCreated", { sessionId: "test-session" })
    // Get state
    const response = await rpc("state.get", { sessionId: "test-session" })
    expect(response.result).not.toBeNull()
    expect(response.result.phase).toBe("MODE_SELECT")
  }, 15000)

  it("exposes state.health over the shared socket", async () => {
    await startServer()
    await rpc("lifecycle.sessionCreated", { sessionId: "health-session", agent: "hermes" })
    const response = await rpc("state.health", { sessionId: "health-session" })
    expect(response.result.phase).toBe("MODE_SELECT")
    expect(response.result.bridgeTransport).toBe("unix-socket")
    expect(response.result.bridgeActiveClientKinds).toContain("hermes")
  }, 15000)

  it("executes workflow tools via socket", async () => {
    await startServer()
    await rpc("lifecycle.sessionCreated", { sessionId: "tool-test" })

    // select_mode via tool.execute
    const selectResult = await rpc("tool.execute", {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: `server-test-${Date.now()}` },
      context: { sessionId: "tool-test", directory: tmpDir },
    })
    expect(selectResult.result).toContain("GREENFIELD")
    expect(selectResult.error).toBeUndefined()

    // Verify state advanced
    const stateResult = await rpc("state.get", { sessionId: "tool-test" })
    expect(stateResult.result.phase).toBe("PLANNING")
  }, 15000)

  it("enforces guard checks via socket", async () => {
    await startServer()
    await rpc("lifecycle.sessionCreated", { sessionId: "guard-test" })
    await rpc("tool.execute", {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: `guard-test-${Date.now()}` },
      context: { sessionId: "guard-test", directory: tmpDir },
    })

    // PLANNING/DRAFT blocks write tools
    const guardResult = await rpc("guard.check", {
      toolName: "write",
      args: { file_path: "/tmp/test.ts", content: "test" },
      sessionId: "guard-test",
    })
    expect(guardResult.result.allowed).toBe(false)
    expect(guardResult.result.reason).toContain("blocked")
  }, 15000)

  it("writes PID file on startup", async () => {
    await startServer()
    const pidPath = join(stateDir, ".bridge-pid")
    expect(existsSync(pidPath)).toBe(true)
  }, 15000)

  it("handles concurrent socket requests", async () => {
    await startServer()
    // Fire 5 pings concurrently
    const promises = Array.from({ length: 5 }, () => rpc("lifecycle.ping"))
    const results = await Promise.all(promises)
    for (const r of results) {
      expect(r.result).toBe("pong")
    }
  }, 15000)

  it("reuses one bridge identity for two clients on the same state dir", async () => {
    await startServer()

    await rpc("lifecycle.sessionCreated", { sessionId: "claude-a", agent: "claude-code" })
    await rpc("lifecycle.sessionCreated", { sessionId: "hermes-a", agent: "hermes" })

    const metadata = JSON.parse(readFileSync(join(stateDir, ".bridge-meta.json"), "utf-8"))
    const leases = JSON.parse(readFileSync(join(stateDir, ".bridge-clients.json"), "utf-8"))

    expect(leases.bridgeInstanceId).toBe(metadata.bridgeInstanceId)
    expect(leases.clients).toHaveLength(2)
    expect(leases.clients.map((client: any) => client.clientId).sort()).toEqual([
      "claude-a",
      "hermes-a",
    ])
    expect(leases.clients.map((client: any) => client.clientKind).sort()).toEqual([
      "claude-code",
      "hermes",
    ])
  }, 15000)

  it("removes only the exiting client lease and keeps the other client usable", async () => {
    await startServer()

    await rpc("lifecycle.sessionCreated", { sessionId: "claude-a", agent: "claude-code" })
    await rpc("lifecycle.sessionCreated", { sessionId: "hermes-a", agent: "hermes" })

    const deleteResponse = await sendSocketRequest(socketPath, {
      jsonrpc: "2.0",
      method: "lifecycle.sessionDeleted",
      params: { sessionId: "claude-a" },
      id: Date.now(),
    })
    expect((deleteResponse as any)?.result ?? null).toBeNull()

    const leases = JSON.parse(readFileSync(join(stateDir, ".bridge-clients.json"), "utf-8"))
    expect(leases.clients.map((client: any) => client.clientId)).toEqual(["hermes-a"])
    expect(leases.clients.map((client: any) => client.clientKind)).toEqual(["hermes"])

    const stateResult = await rpc("state.get", { sessionId: "hermes-a" })
    expect(stateResult.result).not.toBeNull()
  }, 15000)

  it("blocks shutdown while another client lease remains and keeps the bridge usable", async () => {
    await startServer()

    await rpc("lifecycle.sessionCreated", { sessionId: "claude-a", agent: "claude-code" })
    await rpc("lifecycle.sessionCreated", { sessionId: "hermes-a", agent: "hermes" })

    const shutdownResult = await rpc("lifecycle.shutdown")
    expect(shutdownResult.result.ok).toBe(false)
    expect(shutdownResult.result.activeClientCount).toBe(2)
    expect(shutdownResult.result.blockingClientIds.sort()).toEqual([
      "claude-a",
      "hermes-a",
    ])

    const stateResult = await rpc("state.get", { sessionId: "hermes-a" })
    expect(stateResult.result).not.toBeNull()
  }, 15000)

  it("preserves bridge identity and workflow state across restart", async () => {
    await startServer()
    await rpc("lifecycle.sessionCreated", { sessionId: "resume-a", agent: "hermes" })

    await rpc("tool.execute", {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: "restart-continuity" },
      context: { sessionId: "resume-a", directory: tmpDir },
    })

    const metadataBefore = JSON.parse(readFileSync(join(stateDir, ".bridge-meta.json"), "utf-8"))
    await stopServer()

    await startServer()

    const metadataAfter = JSON.parse(readFileSync(join(stateDir, ".bridge-meta.json"), "utf-8"))
    const stateResult = await rpc("state.get", { sessionId: "resume-a" })

    expect(metadataAfter.bridgeInstanceId).toBe(metadataBefore.bridgeInstanceId)
    expect(stateResult.result.phase).toBe("PLANNING")
    expect(stateResult.result.phaseState).toBe("DRAFT")
    expect(stateResult.result.featureName).toBe("restart-continuity")
  }, 15000)
})
