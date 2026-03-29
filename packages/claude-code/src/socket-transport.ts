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
import { existsSync, unlinkSync, readFileSync } from "node:fs"

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
  const { socketPath, pidFilePath, connectionTimeout = 30_000 } = opts
  let server: Server | null = null

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

      server = createServer((connection) => {
        let buffer = ""
        const timeout = setTimeout(() => {
          connection.destroy()
        }, connectionTimeout)

        connection.on("data", (chunk) => {
          buffer += chunk.toString()
          // Look for newline delimiter — process first complete line
          const newlineIdx = buffer.indexOf("\n")
          if (newlineIdx === -1) return

          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)

          if (!line) {
            clearTimeout(timeout)
            connection.end()
            return
          }

          dispatch(line)
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
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Socket request timed out after ${timeout}ms`))
    }, timeout)

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n")
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString()
    })

    socket.on("end", () => {
      clearTimeout(timer)
      const trimmed = buffer.trim()
      if (!trimmed) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(trimmed))
      } catch {
        reject(new Error(`Invalid JSON response: ${trimmed.slice(0, 200)}`))
      }
    })

    socket.on("error", (err) => {
      clearTimeout(timer)
      resolve(null) // Socket error — graceful fallback
    })
  })
}
