/**
 * Integration tests for the bridge server.
 *
 * Spawns the bridge as a child process and communicates via stdin/stdout
 * JSON-RPC. Tests the full round-trip: request → parse → dispatch → response.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import type { Subprocess } from "bun"

// ---------------------------------------------------------------------------
// BridgeTestClient — helper for spawning and communicating with the bridge
// ---------------------------------------------------------------------------

class BridgeTestClient {
  private proc: Subprocess
  private buffer = ""
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
  }>()
  private nextId = 1
  private decoder = new TextDecoder()

  constructor(proc: Subprocess) {
    this.proc = proc
    this.startReading()
  }

  private startReading() {
    const stdout = this.proc.stdout
    if (!stdout) throw new Error("Bridge process has no stdout")

    const reader = stdout.getReader()
    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          this.buffer += this.decoder.decode(value, { stream: true })
          this.processBuffer()
        }
      } catch {
        // Process closed
      }
    }
    readLoop()
  }

  private processBuffer() {
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? "" // keep incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const response = JSON.parse(line)
        const pending = this.pending.get(response.id)
        if (pending) {
          this.pending.delete(response.id)
          if (response.error) {
            pending.reject(new Error(`JSON-RPC error ${response.error.code}: ${response.error.message}`))
          } else {
            pending.resolve(response.result)
          }
        }
      } catch {
        // Ignore unparseable lines
      }
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin!.write(request)

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`Timeout waiting for response to ${method} (id=${id})`))
        }
      }, 10_000)
    })
  }

  async shutdown(): Promise<void> {
    // Send shutdown request (don't await response — process may exit before responding)
    try {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "lifecycle.shutdown",
        params: {},
      }) + "\n"
      this.proc.stdin!.write(request)
    } catch {
      // stdin may already be closed
    }

    // Wait for process to exit (or kill after timeout)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc.kill()
        resolve()
      }, 3000)
      this.proc.exited.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  static spawn(opts?: { env?: Record<string, string> }): BridgeTestClient {
    const proc = Bun.spawn(["bun", "run", "packages/bridge/cli.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...(opts?.env ?? {}) },
    })
    return new BridgeTestClient(proc)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string
let client: BridgeTestClient

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-integ-"))
  client = BridgeTestClient.spawn()
})

afterEach(async () => {
  await client.shutdown()
  await rm(tmpDir, { recursive: true, force: true })
})

describe("Bridge integration — lifecycle", () => {
  it("ping returns pong without init", async () => {
    const result = await client.call("lifecycle.ping")
    expect(result).toBe("pong")
  })

  it("init returns ready", async () => {
    const result = await client.call("lifecycle.init", { projectDir: tmpDir })
    expect(result).toBe("ready")
  })

  it("state.get returns null for unknown session after init", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    const result = await client.call("state.get", { sessionId: "nonexistent" })
    expect(result).toBeNull()
  })

  it("sessionCreated + state.get returns fresh state", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })
    const state = await client.call("state.get", { sessionId: "s1" }) as any
    expect(state).not.toBeNull()
    expect(state.sessionId).toBe("s1")
    expect(state.phase).toBe("MODE_SELECT")
  })

  it("methods before init return NOT_INITIALIZED error", async () => {
    await expect(
      client.call("state.get", { sessionId: "s1" }),
    ).rejects.toThrow("not initialized")
  })
})

describe("Bridge integration — PID file", () => {
  it("writes PID file on init and removes on shutdown", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    const pidPath = join(tmpDir, ".openartisan", ".bridge-pid")
    expect(existsSync(pidPath)).toBe(true)

    await client.shutdown()
    // Give filesystem time to sync
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(pidPath)).toBe(false)
  })
})

describe("Bridge integration — tool execution", () => {
  it("select_mode transitions to PLANNING", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })

    const result = await client.call("tool.execute", {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: "test-feature" },
      context: { sessionId: "s1", directory: tmpDir },
    }) as string
    expect(result).toContain("GREENFIELD")
    expect(result).toContain("PLANNING")

    const state = await client.call("state.get", { sessionId: "s1" }) as any
    expect(state.phase).toBe("PLANNING")
    expect(state.mode).toBe("GREENFIELD")
    expect(state.featureName).toBe("test-feature")
  })

  it("unknown tool returns error string", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })

    const result = await client.call("tool.execute", {
      name: "nonexistent_tool",
      args: {},
      context: { sessionId: "s1", directory: tmpDir },
    }) as string
    expect(result).toContain("Unknown tool")
  })
})

describe("Bridge integration — guard", () => {
  it("guard.check blocks writes in MODE_SELECT", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })

    const result = await client.call("guard.check", {
      toolName: "write_file",
      args: { filePath: "/foo.ts" },
      sessionId: "s1",
    }) as any
    expect(result.allowed).toBe(false)
    expect(typeof result.policyVersion).toBe("number")
  })

  it("guard.check allows after mode selection", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })
    await client.call("tool.execute", {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: "gf" },
      context: { sessionId: "s1", directory: tmpDir },
    })

    // In PLANNING/DRAFT, read tools should be allowed
    const result = await client.call("guard.check", {
      toolName: "read_file",
      args: {},
      sessionId: "s1",
    }) as any
    expect(result.allowed).toBe(true)
  })
})

describe("Bridge integration — prompt", () => {
  it("prompt.build returns system prompt for active session", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })

    const result = await client.call("prompt.build", { sessionId: "s1" }) as string
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("Bridge integration — persistence", () => {
  it("state survives bridge restart", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })
    await client.call("tool.execute", {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: "persist-test" },
      context: { sessionId: "s1", directory: tmpDir },
    })

    // Shutdown first bridge
    await client.shutdown()

    // Spawn second bridge, init with same projectDir
    const client2 = BridgeTestClient.spawn()
    try {
      await client2.call("lifecycle.init", { projectDir: tmpDir })
      const state = await client2.call("state.get", { sessionId: "s1" }) as any
      expect(state).not.toBeNull()
      expect(state.phase).toBe("PLANNING")
      expect(state.featureName).toBe("persist-test")
    } finally {
      await client2.shutdown()
    }
  })
})

describe("Bridge integration — traceId correlation", () => {
  it("accepts traceId in params without error", async () => {
    await client.call("lifecycle.init", { projectDir: tmpDir })
    await client.call("lifecycle.sessionCreated", { sessionId: "s1" })

    // Passing traceId should not cause errors
    const result = await client.call("state.get", {
      sessionId: "s1",
      traceId: "trace-integration-test",
    }) as any
    expect(result).not.toBeNull()
    expect(result.sessionId).toBe("s1")
  })
})
