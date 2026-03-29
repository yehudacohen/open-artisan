#!/usr/bin/env bun
/**
 * artisan-server.ts — Claude Code adapter server entry point.
 *
 * A long-lived background process that hosts the bridge engine in-process
 * and exposes it via a Unix domain socket. Hook scripts and the artisan CLI
 * connect to the socket for one-shot JSON-RPC requests.
 *
 * Lifecycle:
 *   1. Started by `/artisan on`, SessionStart hook, or `artisan enable`
 *   2. Initializes the core engine (state machine, store, tools)
 *   3. Opens Unix socket at .openartisan/.bridge.sock
 *   4. Writes PID file at .openartisan/.bridge-pid
 *   5. Runs until killed or `artisan disable` is called
 *
 * Usage:
 *   bun run packages/claude-code/bin/artisan-server.ts --project-dir /path/to/project
 *   bun run packages/claude-code/bin/artisan-server.ts --project-dir . --daemon
 */

import { join } from "node:path"
import { resolve } from "node:path"
import { existsSync } from "node:fs"

import { createBridgeServer } from "../../bridge/server"
import {
  handleInit,
  handlePing,
  handleShutdown,
  handleSessionCreated,
  handleSessionDeleted,
} from "../../bridge/methods/lifecycle"
import { handleStateGet } from "../../bridge/methods/state"
import { handleGuardCheck, handleGuardPolicy } from "../../bridge/methods/guard"
import { handlePromptBuild, handlePromptCompaction } from "../../bridge/methods/prompt"
import { handleMessageProcess } from "../../bridge/methods/message"
import { handleIdleCheck } from "../../bridge/methods/idle"
import { handleToolExecute } from "../../bridge/methods/tool-execute"

import { createSocketTransport } from "../src/socket-transport"
import {
  DEFAULT_STATE_DIR_NAME,
  getSocketPath,
} from "../src/constants"

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { projectDir: string; daemon: boolean; stateDir?: string } {
  const args = process.argv.slice(2)
  let projectDir = ""
  let daemon = false
  let stateDir: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--project-dir" && args[i + 1]) {
      projectDir = args[++i]!
    } else if (arg === "--state-dir" && args[i + 1]) {
      stateDir = args[++i]!
    } else if (arg === "--daemon") {
      daemon = true
    }
  }

  if (!projectDir) {
    console.error("Usage: artisan-server --project-dir <path> [--state-dir <path>] [--daemon]")
    process.exit(1)
  }

  return { projectDir: resolve(projectDir), daemon, stateDir: stateDir ? resolve(stateDir) : undefined }
}

// ---------------------------------------------------------------------------
// Daemonize — fork self and exit parent
// ---------------------------------------------------------------------------

async function daemonize(projectDir: string, stateDir?: string): Promise<never> {
  const { fork } = await import("node:child_process")
  const childArgs = ["--project-dir", projectDir]
  if (stateDir) childArgs.push("--state-dir", stateDir)
  // Fork without --daemon flag so the child runs in foreground mode
  const child = fork(process.argv[1]!, childArgs, {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  // Give the child a moment to start before exiting
  await new Promise((r) => setTimeout(r, 200))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { projectDir, daemon, stateDir: customStateDir } = parseArgs()
  const stateDir = customStateDir ?? join(projectDir, DEFAULT_STATE_DIR_NAME)
  const socketPath = getSocketPath(stateDir)

  // Daemonize if requested
  if (daemon) {
    await daemonize(projectDir, customStateDir)
  }

  // Create the bridge server (registers all JSON-RPC method handlers)
  const bridge = createBridgeServer({
    "lifecycle.init": handleInit,
    "lifecycle.ping": handlePing,
    "lifecycle.shutdown": handleShutdown,
    "lifecycle.sessionCreated": handleSessionCreated,
    "lifecycle.sessionDeleted": handleSessionDeleted,
    "state.get": handleStateGet,
    "guard.check": handleGuardCheck,
    "guard.policy": handleGuardPolicy,
    "prompt.build": handlePromptBuild,
    "prompt.compaction": handlePromptCompaction,
    "message.process": handleMessageProcess,
    "idle.check": handleIdleCheck,
    "tool.execute": handleToolExecute,
  }, {
    // Don't start the stdio reader — we use the socket transport instead
    input: new (await import("node:stream")).Readable({ read() {} }),
    output: new (await import("node:stream")).Writable({ write(_c, _e, cb) { cb() } }),
  })

  // Initialize the engine with agent-only capabilities
  // (no SubagentDispatcher — the agent self-reviews, the human reviews at USER_GATE)
  await handleInit({
    projectDir,
    stateDir,
    capabilities: {
      selfReview: "agent-only",
      orchestrator: false,
      discoveryFleet: false,
    },
  }, bridge.ctx)

  // Start the socket transport
  const transport = createSocketTransport(
    (json) => bridge.receiveJSON(json),
    { socketPath, pidFilePath: join(stateDir, ".bridge-pid") },
  )

  await transport.start()

  // Log startup
  const log = bridge.ctx.pinoLogger
  if (log) {
    log.info({ socketPath, pid: process.pid, projectDir }, "Artisan server started")
  } else {
    console.error(`artisan-server: listening on ${socketPath} (PID ${process.pid})`)
  }

  // Signal handlers for graceful shutdown
  const shutdown = async (signal: string) => {
    if (log) log.info({ signal }, "Artisan server shutting down")
    await transport.stop()
    try {
      await handleShutdown({}, bridge.ctx)
    } catch { /* handleShutdown calls process.exit — catch in case it doesn't */ }
    process.exit(0)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  // Keep the process alive
  // (The socket server's net.Server keeps the event loop running)
}

main().catch((err) => {
  console.error("artisan-server: fatal error:", err)
  process.exit(1)
})
