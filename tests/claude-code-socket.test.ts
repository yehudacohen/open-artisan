/**
 * Tests for the Unix domain socket transport.
 *
 * Covers:
 * - Server startup and shutdown
 * - Single request/response round-trip
 * - Concurrent connections
 * - Stale socket cleanup
 * - Client graceful fallback when socket unavailable
 * - Connection timeout
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync, writeFileSync, mkdirSync } from "node:fs"

import {
  createSocketTransport,
  sendSocketRequest,
  type JsonRpcDispatcher,
} from "#claude-code/src/socket-transport"

let tmpDir: string
let socketPath: string
let pidFilePath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "socket-test-"))
  socketPath = join(tmpDir, "test.sock")
  pidFilePath = join(tmpDir, "test.pid")
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// Simple echo dispatcher for testing
const echoDispatcher: JsonRpcDispatcher = async (json) => {
  const req = JSON.parse(json)
  return JSON.stringify({
    jsonrpc: "2.0",
    result: { echo: req.params },
    id: req.id,
  })
}

// Dispatcher that returns method-specific responses
const methodDispatcher: JsonRpcDispatcher = async (json) => {
  const req = JSON.parse(json)
  if (req.method === "ping") {
    return JSON.stringify({ jsonrpc: "2.0", result: "pong", id: req.id })
  }
  if (req.method === "error") {
    return JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: req.id,
    })
  }
  return null // notification — no response
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

describe("socket transport — server lifecycle", () => {
  it("starts and stops cleanly", async () => {
    const transport = createSocketTransport(echoDispatcher, { socketPath })
    await transport.start()
    expect(transport.listening).toBe(true)
    expect(existsSync(socketPath)).toBe(true)

    await transport.stop()
    expect(transport.listening).toBe(false)
    expect(existsSync(socketPath)).toBe(false)
  })

  it("removes stale socket on startup (no PID file)", async () => {
    // Create a stale socket file
    writeFileSync(socketPath, "stale")
    expect(existsSync(socketPath)).toBe(true)

    const transport = createSocketTransport(echoDispatcher, { socketPath })
    await transport.start()
    expect(transport.listening).toBe(true)
    await transport.stop()
  })

  it("removes stale socket when PID file references dead process", async () => {
    writeFileSync(socketPath, "stale")
    writeFileSync(pidFilePath, "999999") // dead PID

    const transport = createSocketTransport(echoDispatcher, { socketPath, pidFilePath })
    await transport.start()
    expect(transport.listening).toBe(true)
    await transport.stop()
  })

  it("refuses to start when socket is owned by live process", async () => {
    writeFileSync(socketPath, "active")
    writeFileSync(pidFilePath, String(process.pid)) // our own PID — alive

    const transport = createSocketTransport(echoDispatcher, { socketPath, pidFilePath })
    await expect(transport.start()).rejects.toThrow("in use")
  })
})

// ---------------------------------------------------------------------------
// Request/response
// ---------------------------------------------------------------------------

describe("socket transport — request/response", () => {
  it("handles a single JSON-RPC request", async () => {
    const transport = createSocketTransport(echoDispatcher, { socketPath })
    await transport.start()
    try {
      const response = await sendSocketRequest(socketPath, {
        jsonrpc: "2.0",
        method: "test",
        params: { hello: "world" },
        id: 1,
      })
      expect(response).not.toBeNull()
      const r = response as any
      expect(r.result.echo.hello).toBe("world")
      expect(r.id).toBe(1)
    } finally {
      await transport.stop()
    }
  })

  it("handles concurrent connections", async () => {
    const transport = createSocketTransport(echoDispatcher, { socketPath })
    await transport.start()
    try {
      // Fire 5 requests concurrently
      const promises = Array.from({ length: 5 }, (_, i) =>
        sendSocketRequest(socketPath, {
          jsonrpc: "2.0",
          method: "test",
          params: { index: i },
          id: i + 1,
        }),
      )
      const results = await Promise.all(promises)
      expect(results).toHaveLength(5)
      for (let i = 0; i < 5; i++) {
        const r = results[i] as any
        expect(r.result.echo.index).toBe(i)
        expect(r.id).toBe(i + 1)
      }
    } finally {
      await transport.stop()
    }
  })

  it("handles method-specific responses", async () => {
    const transport = createSocketTransport(methodDispatcher, { socketPath })
    await transport.start()
    try {
      const pong = await sendSocketRequest(socketPath, {
        jsonrpc: "2.0", method: "ping", id: 1,
      })
      expect((pong as any).result).toBe("pong")

      const err = await sendSocketRequest(socketPath, {
        jsonrpc: "2.0", method: "error", id: 2,
      })
      expect((err as any).error.code).toBe(-32601)
    } finally {
      await transport.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Client fallback
// ---------------------------------------------------------------------------

describe("socket transport — client fallback", () => {
  it("returns null when socket does not exist", async () => {
    const result = await sendSocketRequest("/nonexistent/path.sock", {
      jsonrpc: "2.0", method: "test", id: 1,
    })
    expect(result).toBeNull()
  })

  it("returns null on connection error", async () => {
    // Create a file that's not a socket
    writeFileSync(socketPath, "not-a-socket")
    const result = await sendSocketRequest(socketPath, {
      jsonrpc: "2.0", method: "test", id: 1,
    })
    expect(result).toBeNull()
  })

  it("returns null on timeout", async () => {
    // Server that never responds (hangs dispatch)
    const hangingDispatcher: JsonRpcDispatcher = () => new Promise(() => {}) // never resolves
    const transport = createSocketTransport(hangingDispatcher, { socketPath })
    await transport.start()
    try {
      const result = await sendSocketRequest(socketPath, {
        jsonrpc: "2.0", method: "hang", id: 1,
      }, 200) // 200ms timeout
      expect(result).toBeNull()
    } finally {
      await transport.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("socket transport — error handling", () => {
  it("returns JSON-RPC error when dispatch throws", async () => {
    const throwingDispatcher: JsonRpcDispatcher = async () => { throw new Error("boom") }
    const transport = createSocketTransport(throwingDispatcher, { socketPath })
    await transport.start()
    try {
      const response = await sendSocketRequest(socketPath, {
        jsonrpc: "2.0", method: "fail", id: 1,
      })
      expect(response).not.toBeNull()
      const r = response as any
      expect(r.error.code).toBe(-32603)
      expect(r.error.message).toBe("boom")
    } finally {
      await transport.stop()
    }
  })
})
