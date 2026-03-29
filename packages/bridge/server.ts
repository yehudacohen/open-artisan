/**
 * server.ts — Bridge engine and server factories.
 *
 * Two layers:
 *   createBridgeEngine  — Transport-agnostic: BridgeContext + JSON-RPC dispatch.
 *                         Used by both the stdio server and the socket server.
 *   createBridgeServer  — Stdio transport: readline from stdin, write to stdout.
 *                         Used by the bridge CLI entry point.
 */
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { JSONRPCServer, JSONRPCErrorException } from "json-rpc-2.0"
import type { EngineContext } from "../core/engine-context"
import type pino from "pino"
import { NOT_INITIALIZED } from "./protocol"

// ---------------------------------------------------------------------------
// Bridge context — shared state for all method handlers
// ---------------------------------------------------------------------------

export interface BridgeContext {
  /** The engine context — null until lifecycle.init completes. */
  engine: EngineContext | null
  /** Policy version counter — bumped on every state transition. */
  policyVersion: number
  /** Bump the policy version (called after store.update). */
  bumpPolicyVersion(): void
  /** Set the engine context (called by lifecycle.init). */
  setEngine(engine: EngineContext): void
  /** The state directory path — set during lifecycle.init. */
  stateDir: string | null
  /** The project directory path — set during lifecycle.init. Used for path resolution. */
  projectDir: string | null
  /** Adapter capabilities — set during lifecycle.init. */
  capabilities: {
    selfReview: "isolated" | "agent-only"
    orchestrator: boolean
    discoveryFleet: boolean
  }
  /** Pino logger instance — set during lifecycle.init. Available for request logging. */
  pinoLogger: pino.Logger | null
  /** Flag for shutdown. */
  shuttingDown: boolean
}

// ---------------------------------------------------------------------------
// Method handler type (application-level, receives typed params + context)
// ---------------------------------------------------------------------------

/**
 * Bridge method handler. Receives the JSON-RPC params, the BridgeContext,
 * and a request-scoped logger with traceId bound (if provided in params).
 * Return value becomes the JSON-RPC result. Thrown errors become JSON-RPC errors.
 */
export type MethodHandler = (
  params: Record<string, unknown>,
  ctx: BridgeContext,
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Bridge engine — transport-agnostic dispatch layer
// ---------------------------------------------------------------------------

export interface BridgeEngine {
  /** Process a single JSON-RPC request string. Returns response string or null. */
  receiveJSON(json: string): Promise<string | null>
  /** The shared bridge context (engine, capabilities, state). */
  ctx: BridgeContext
  /** Whether lifecycle.init has been called. */
  initialized: boolean
  /** Current policy version counter. */
  policyVersion: number
}

/**
 * Creates the bridge engine: BridgeContext + JSON-RPC method dispatch.
 * Transport-agnostic — callers wire their own I/O (stdio, socket, HTTP).
 *
 * Used by:
 * - createBridgeServer() for stdio transport
 * - artisan-server.ts for Unix socket transport
 */
export function createBridgeEngine(
  handlers: Record<string, MethodHandler>,
): BridgeEngine {
  let policyVersion = 0
  let engine: EngineContext | null = null
  let shuttingDown = false
  let stateDir: string | null = null
  let projectDir: string | null = null
  let capabilities = { selfReview: "isolated" as const, orchestrator: true, discoveryFleet: true }
  let pinoLogger: pino.Logger | null = null

  const bridgeCtx: BridgeContext = {
    get engine() { return engine },
    get policyVersion() { return policyVersion },
    bumpPolicyVersion() { policyVersion++ },
    setEngine(e: EngineContext) { engine = e },
    get stateDir() { return stateDir },
    set stateDir(v: string | null) { stateDir = v },
    get projectDir() { return projectDir },
    set projectDir(v: string | null) { projectDir = v },
    get capabilities() { return capabilities },
    set capabilities(v: typeof capabilities) { capabilities = v },
    get pinoLogger() { return pinoLogger },
    set pinoLogger(v: pino.Logger | null) { pinoLogger = v },
    get shuttingDown() { return shuttingDown },
    set shuttingDown(v: boolean) { shuttingDown = v },
  }

  // Methods that don't require initialization
  const INIT_FREE = new Set(["lifecycle.init", "lifecycle.ping", "lifecycle.shutdown"])

  // Create the JSON-RPC server from the library
  const rpcServer = new JSONRPCServer()

  // Register each method handler
  for (const [method, handler] of Object.entries(handlers)) {
    rpcServer.addMethod(method, async (params: Record<string, unknown>) => {
      // Check initialization for methods that require it
      if (!INIT_FREE.has(method) && !engine) {
        throw new JSONRPCErrorException("Bridge not initialized. Call lifecycle.init first.", NOT_INITIALIZED)
      }

      // Create request-scoped context with traceId-bound logger
      const traceId = params?.traceId as string | undefined
      let requestCtx = bridgeCtx

      if (traceId && engine) {
        const childLog = engine.log.child({ traceId })
        const scopedEngine = { ...engine, log: childLog }
        requestCtx = {
          ...bridgeCtx,
          get engine() { return scopedEngine },
        }
      }

      if (pinoLogger) {
        const reqLog = traceId ? pinoLogger.child({ traceId }) : pinoLogger
        reqLog.debug({ method, component: "bridge" }, "JSON-RPC request")
      }

      return handler(params ?? {}, requestCtx)
    })
  }

  async function receiveJSON(json: string): Promise<string | null> {
    if (shuttingDown) {
      return JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bridge is shutting down" }, id: null })
    }
    const response = await rpcServer.receiveJSON(json)
    return response ? JSON.stringify(response) : null
  }

  return {
    receiveJSON,
    get ctx() { return bridgeCtx },
    get initialized() { return engine !== null },
    get policyVersion() { return policyVersion },
  }
}

// ---------------------------------------------------------------------------
// Bridge server — stdio transport wrapping the engine
// ---------------------------------------------------------------------------

export interface BridgeServerOptions {
  input?: Readable
  output?: Writable
}

/**
 * Creates a bridge server with stdio transport.
 * Wraps createBridgeEngine with readline input + stdout output.
 *
 * Used by the bridge CLI entry point (packages/bridge/cli.ts).
 */
export function createBridgeServer(
  handlers: Record<string, MethodHandler>,
  opts?: BridgeServerOptions,
) {
  const input = opts?.input ?? process.stdin
  const output = opts?.output ?? process.stdout
  const engine = createBridgeEngine(handlers)

  function start() {
    const rl = createInterface({ input, crlfDelay: Infinity })

    rl.on("line", async (line: string) => {
      if (engine.ctx.shuttingDown) return
      const trimmed = line.trim()
      if (!trimmed) return

      const response = await engine.receiveJSON(trimmed)
      if (response) {
        output.write(response + "\n")
      }
    })

    rl.on("close", () => {
      engine.ctx.shuttingDown = true
    })
  }

  return {
    start,
    receiveJSON: engine.receiveJSON,
    get ctx() { return engine.ctx },
    get initialized() { return engine.initialized },
    get policyVersion() { return engine.policyVersion },
  }
}
