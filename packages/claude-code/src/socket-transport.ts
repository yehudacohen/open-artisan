/**
 * socket-transport.ts — Unix domain socket transport for JSON-RPC.
 *
 * Provides a one-request-per-connection socket server. Each client:
 *   1. Connects to the Unix socket
 *   2. Sends a single newline-delimited JSON-RPC request
 *   3. Receives the JSON-RPC response
 *   4. Connection closes
 *
 * This pattern is designed for ephemeral hook scripts and CLI commands
 * that need to send a single request to the running bridge engine.
 * Concurrent connections are supported (each is independent).
 *
 * Uses node:net for the socket server and delegates JSON-RPC dispatch
 * to the bridge server's receiveJSON method.
 */

import { createServer, type Server } from "node:net"
import { existsSync, unlinkSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"

import { attachOrStartBridgeClient, detachBridgeClient, evaluateBridgeShutdownEligibility } from "#bridge/bridge-clients"
import { discoverBridge } from "#bridge/bridge-discovery"
import { loadBridgeLeaseSnapshot } from "#bridge/bridge-meta"
import type {
  BridgeAttachParams,
  BridgeAttachRpcResult,
  BridgeDetachParams,
  BridgeDetachResult,
  BridgeDiscoverParams,
  BridgeDiscoverResult,
  BridgeShutdownEligibilityParams,
  BridgeShutdownEligibilityResult,
} from "#bridge/protocol"
import { SOCKET_TOKEN_FILENAME } from "./constants"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function that processes a JSON-RPC request string and returns a response string (or null). */
export type JsonRpcDispatcher = (json: string) => Promise<string | null>

export interface SocketTransportOptions {
  /** Absolute path for the Unix domain socket file. */
  socketPath: string
  /** PID file path — used for stale socket detection. */
  pidFilePath?: string
  /** Connection timeout in milliseconds (default: 30000). */
  connectionTimeout?: number
  /** Optional token path. When set, socket requests must include this token. */
  authTokenPath?: string
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Creates a Unix domain socket server that dispatches JSON-RPC requests.
 *
 * @param dispatch - Function that processes JSON-RPC (from createBridgeServer().receiveJSON)
 * @param opts - Socket path and options
 * @returns Control handle with start/stop methods
 */
export function createSocketTransport(
  dispatch: JsonRpcDispatcher,
  opts: SocketTransportOptions,
) {
  const { socketPath, pidFilePath, connectionTimeout = 30_000, authTokenPath } = opts
  let server: Server | null = null
  let authToken: string | null = null

  function ensureAuthToken(): string | null {
    if (!authTokenPath) return null
    if (authToken) return authToken
    if (existsSync(authTokenPath)) {
      authToken = readFileSync(authTokenPath, "utf-8").trim()
    }
    if (!authToken) {
      authToken = randomBytes(32).toString("hex")
      writeFileSync(authTokenPath, authToken, { encoding: "utf-8", mode: 0o600 })
    }
    try {
      chmodSync(authTokenPath, 0o600)
    } catch {
      // Non-fatal on filesystems that do not support POSIX modes.
    }
    return authToken
  }

  function validateAuthenticatedLine(line: string, token: string | null): { ok: true; line: string } | { ok: false; response: string } {
    if (!token) return { ok: true, line }
    let parsed: { id?: unknown; openArtisanAuthToken?: unknown }
    try {
      parsed = JSON.parse(line) as { id?: unknown; openArtisanAuthToken?: unknown }
    } catch {
      return {
        ok: false,
        response: JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }),
      }
    }
    if (parsed.openArtisanAuthToken !== token) {
      return {
        ok: false,
        response: JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized socket request" }, id: parsed.id ?? null }),
      }
    }
    delete parsed.openArtisanAuthToken
    return { ok: true, line: JSON.stringify(parsed) }
  }

  function cleanupStaleSocket(): void {
    if (!existsSync(socketPath)) return

    // If a PID file exists, check if the process is still alive
    if (pidFilePath && existsSync(pidFilePath)) {
      try {
        const pid = parseInt(readFileSync(pidFilePath, "utf-8").trim(), 10)
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0) // signal 0 = check if process exists
            // Process is alive — socket is in use, don't remove
            throw new Error(`Socket ${socketPath} is in use by PID ${pid}`)
          } catch (err: any) {
            if (err.code === "ESRCH") {
              // Process is dead — stale socket, safe to remove
              unlinkSync(socketPath)
            } else if (err.code === "EPERM") {
              // Process exists but we can't signal it — socket is in use
              throw new Error(`Socket ${socketPath} is in use (PID ${pid}, EPERM)`)
            } else {
              throw err
            }
          }
        }
      } catch (err: any) {
        if (err.message?.includes("in use")) throw err
        // PID file unreadable — treat socket as stale
        unlinkSync(socketPath)
      }
    } else {
      // No PID file — treat socket as stale
      unlinkSync(socketPath)
    }
  }

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      cleanupStaleSocket()
      const token = ensureAuthToken()

      server = createServer((connection) => {
        let buffer = ""
        let processed = false
        const timeout = setTimeout(() => {
          connection.destroy()
        }, connectionTimeout)

        connection.on("data", (chunk) => {
          if (processed) return // One request per connection — ignore further data
          buffer += chunk.toString()

          // Buffer size guard — prevent unbounded memory growth
          if (buffer.length > 1_048_576) { // 1MB
            clearTimeout(timeout)
            processed = true
            connection.destroy()
            return
          }

          // Look for newline delimiter — process first complete line
          const newlineIdx = buffer.indexOf("\n")
          if (newlineIdx === -1) return

          processed = true // Mark as processed — ignore further data events
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = "" // Release buffer memory

          if (!line) {
            clearTimeout(timeout)
            connection.end()
            return
          }

          const auth = validateAuthenticatedLine(line, token)
          if (!auth.ok) {
            clearTimeout(timeout)
            connection.end(auth.response + "\n")
            return
          }

          dispatch(auth.line)
            .then((response) => {
              clearTimeout(timeout)
              if (response) {
                connection.end(response + "\n")
              } else {
                connection.end()
              }
            })
            .catch((err) => {
              clearTimeout(timeout)
              // Return a JSON-RPC error response
              const errorResponse = JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
                id: null,
              })
              connection.end(errorResponse + "\n")
            })
        })

        connection.on("error", () => {
          clearTimeout(timeout)
        })
      })

      server.on("error", (err) => {
        reject(err)
      })

      server.listen({ path: socketPath }, () => {
        try {
          chmodSync(socketPath, 0o600)
        } catch {
          // Non-fatal on filesystems that do not support POSIX modes.
        }
        resolve()
      })
    })
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!server) {
        resolve()
        return
      }
      server.close(() => {
        // Clean up socket file
        try {
          if (existsSync(socketPath)) unlinkSync(socketPath)
        } catch { /* best effort */ }
        server = null
        resolve()
      })
    })
  }

  return {
    start,
    stop,
    get listening() { return server !== null && server.listening },
  }
}

// ---------------------------------------------------------------------------
// Client — one-shot request sender for hook scripts and CLI
// ---------------------------------------------------------------------------

/**
 * Send a single JSON-RPC request to the socket and return the response.
 * Connects, sends, reads response, disconnects.
 *
 * @param socketPath - Path to the Unix domain socket
 * @param request - JSON-RPC request object (will be serialized)
 * @param timeout - Connection timeout in ms (default: 10000)
 * @returns Parsed JSON-RPC response, or null if socket unavailable
 */
export async function sendSocketRequest(
  socketPath: string,
  request: { jsonrpc: "2.0"; method: string; params?: unknown; id: number | string },
  timeout = 10_000,
): Promise<unknown> {
  const { connect } = await import("node:net")

  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      resolve(null) // Socket not available — graceful fallback
      return
    }

    const socket = connect({ path: socketPath })
    let buffer = ""
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolve(null) // Timeout — treat as unavailable (consistent with error fallback)
      }
    }, timeout)

    socket.on("connect", () => {
      const tokenPath = join(dirname(socketPath), SOCKET_TOKEN_FILENAME)
      const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf-8").trim() : ""
      const payload = token ? { ...request, openArtisanAuthToken: token } : request
      socket.write(JSON.stringify(payload) + "\n")
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString()
    })

    socket.on("end", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const trimmed = buffer.trim()
      if (!trimmed) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(trimmed))
      } catch {
        resolve(null) // Invalid JSON — treat as unavailable
      }
    })

    socket.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(null) // Socket error — graceful fallback
    })
  })
}

// ---------------------------------------------------------------------------
// Shared bridge contract helpers for Claude Code
// ---------------------------------------------------------------------------

export async function discoverSharedBridge(
  params: BridgeDiscoverParams,
): Promise<BridgeDiscoverResult> {
  return {
    discovery: await discoverBridge(params),
  }
}

export async function attachOrStartSocketBridge(
  params: BridgeAttachParams,
): Promise<BridgeAttachRpcResult> {
  return {
    attach: await attachOrStartBridgeClient(params),
  }
}

export async function detachSocketBridgeClient(
  params: BridgeDetachParams,
): Promise<BridgeDetachResult> {
  return detachBridgeClient(params)
}

export async function getSocketShutdownEligibility(
  params: BridgeShutdownEligibilityParams,
): Promise<BridgeShutdownEligibilityResult> {
  const leases = await loadBridgeLeaseSnapshot(params.stateDir)
  return {
    eligibility: evaluateBridgeShutdownEligibility(
      leases ?? { bridgeInstanceId: "bridge", clients: [] },
    ),
  }
}
