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

import { join, resolve } from "node:path"
import { existsSync } from "node:fs"
import { parseArgs } from "node:util"

import { createBridgeEngine } from "#bridge/server"
import {
  handleInit,
  handlePing,
  handleShutdown,
  handleSessionCreated,
  handleSessionDeleted,
} from "#bridge/methods/lifecycle"
import { handleStateGet, handleStateHealth } from "#bridge/methods/state"
import type { LifecycleInitParams } from "#bridge/protocol"
import { handleGuardCheck, handleGuardPolicy } from "#bridge/methods/guard"
import { handlePromptBuild, handlePromptCompaction } from "#bridge/methods/prompt"
import { handleMessageProcess } from "#bridge/methods/message"
import { handleIdleCheck } from "#bridge/methods/idle"
import { handleToolExecute, handleTaskGetReviewContext, handlePhaseGetReviewContext, handleAutoApproveContext } from "#bridge/methods/tool-execute"

import { createSocketTransport } from "#claude-code/src/socket-transport"
import { DEFAULT_STATE_DIR_NAME, getSocketPath, getSocketTokenPath, PID_FILENAME } from "#claude-code/src/constants"

// ---------------------------------------------------------------------------
// Parse CLI args (using node:util parseArgs — handles --flag=value and --flag value)
// ---------------------------------------------------------------------------

type ParsedPersistence = NonNullable<LifecycleInitParams["persistence"]>

function parseCLIArgs(): { projectDir: string; daemon: boolean; stateDir?: string; persistence?: ParsedPersistence } {
  const { values } = parseArgs({
    options: {
      "project-dir": { type: "string" },
      "state-dir": { type: "string" },
      persistence: { type: "string" },
      "db-dir": { type: "string" },
      "db-file": { type: "string" },
      "db-schema": { type: "string" },
      daemon: { type: "boolean", default: false },
    },
    strict: false, // ignore unknown args
  })

  const projectDirValue = values["project-dir"]
  if (typeof projectDirValue !== "string" || projectDirValue.length === 0) {
    console.error("Usage: artisan-server --project-dir <path> [--state-dir <path>] [--daemon]")
    process.exit(1)
  }

  const stateDirValue = values["state-dir"]
  const persistenceKind = typeof values.persistence === "string" ? values.persistence : process.env["OPENARTISAN_STATE_BACKEND"]
  const dbDir = typeof values["db-dir"] === "string" ? resolve(values["db-dir"]) : process.env["OPENARTISAN_DB_DIR"]
  const dbFile = typeof values["db-file"] === "string" ? values["db-file"] : process.env["OPENARTISAN_DB_FILE"]
  const dbSchema = typeof values["db-schema"] === "string" ? values["db-schema"] : process.env["OPENARTISAN_DB_SCHEMA"]
  const daemon = values.daemon === true
  const persistence: ParsedPersistence | undefined =
    persistenceKind === "filesystem"
      ? { kind: "filesystem" }
      : persistenceKind === "db" || persistenceKind === "pglite"
        ? {
          kind: persistenceKind,
          pglite: {
            ...(dbDir ? { dataDir: dbDir } : {}),
            ...(dbFile ? { databaseFileName: dbFile } : {}),
            ...(dbSchema ? { schemaName: dbSchema } : {}),
          },
        }
        : undefined

  return {
    projectDir: resolve(projectDirValue),
    daemon,
    ...(typeof stateDirValue === "string" ? { stateDir: resolve(stateDirValue) } : {}),
    ...(persistence ? { persistence } : {}),
  }
}

// ---------------------------------------------------------------------------
// Daemonize — fork self and exit parent
// ---------------------------------------------------------------------------

async function daemonize(projectDir: string, stateDir?: string, persistence?: ParsedPersistence): Promise<never> {
  const { fork } = await import("node:child_process")
  const scriptPath = process.argv[1]
  if (!scriptPath) {
    console.error("artisan-server: cannot determine script path for daemonization")
    process.exit(1)
  }
  const childArgs = ["--project-dir", projectDir]
  if (stateDir) childArgs.push("--state-dir", stateDir)
  if (persistence?.kind) childArgs.push("--persistence", persistence.kind)
  if (persistence?.pglite?.dataDir) childArgs.push("--db-dir", persistence.pglite.dataDir)
  if (persistence?.pglite?.databaseFileName) childArgs.push("--db-file", persistence.pglite.databaseFileName)
  if (persistence?.pglite?.schemaName) childArgs.push("--db-schema", persistence.pglite.schemaName)
  // Fork without --daemon flag so the child runs in foreground mode
  const child = fork(scriptPath, childArgs, {
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  // Wait for the socket to become available (readiness signal)
  const socketPath = getSocketPath(stateDir ?? join(projectDir, DEFAULT_STATE_DIR_NAME))
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      console.error(`artisan-server: daemon started (PID ${child.pid})`)
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  console.error("artisan-server: daemon failed to start within 5s")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { projectDir, daemon, stateDir: customStateDir, persistence } = parseCLIArgs()
  const stateDir = customStateDir ?? join(projectDir, DEFAULT_STATE_DIR_NAME)
  const socketPath = getSocketPath(stateDir)

  // Validate project directory exists
  if (!existsSync(projectDir)) {
    console.error(`artisan-server: project directory does not exist: ${projectDir}`)
    process.exit(1)
  }

  // Daemonize if requested
  if (daemon) {
    await daemonize(projectDir, customStateDir, persistence)
  }

  // Create the bridge engine (transport-agnostic — no stdio wiring)
  const engine = createBridgeEngine({
    "lifecycle.init": handleInit,
    "lifecycle.ping": handlePing,
    "lifecycle.shutdown": handleShutdown,
    "lifecycle.sessionCreated": handleSessionCreated,
    "lifecycle.sessionDeleted": handleSessionDeleted,
    "state.get": handleStateGet,
    "state.health": handleStateHealth,
    "guard.check": handleGuardCheck,
    "guard.policy": handleGuardPolicy,
    "prompt.build": handlePromptBuild,
    "prompt.compaction": handlePromptCompaction,
    "message.process": handleMessageProcess,
    "idle.check": handleIdleCheck,
    "tool.execute": handleToolExecute,
    "task.getReviewContext": handleTaskGetReviewContext,
    "task.getPhaseReviewContext": handlePhaseGetReviewContext,
    "task.getAutoApproveContext": handleAutoApproveContext,
  })

  // Initialize the engine with isolated reviewer capabilities.
  await handleInit({
    projectDir,
    stateDir,
    transport: "unix-socket",
    socketPath,
    registerRuntime: true,
    ...(persistence ? { persistence } : {}),
    capabilities: {
      selfReview: "isolated",
      orchestrator: false,
      discoveryFleet: false,
    },
  }, engine.ctx)

  // Start the socket transport
  const transport = createSocketTransport(
    engine.receiveJSON,
    { socketPath, pidFilePath: join(stateDir, PID_FILENAME), authTokenPath: getSocketTokenPath(stateDir) },
  )

  await transport.start()

  // Log startup
  const log = engine.ctx.pinoLogger
  if (log) {
    log.info({ socketPath, pid: process.pid, projectDir }, "Artisan server started")
  } else {
    console.error(`artisan-server: listening on ${socketPath} (PID ${process.pid})`)
  }

  // Graceful shutdown with double-signal guard
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    if (log) log.info({ signal }, "Artisan server shutting down")
    await transport.stop()
    try {
      await handleShutdown({}, engine.ctx)
    } catch { /* handleShutdown may call process.exit */ }
    process.exit(0)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((err) => {
  console.error("artisan-server: fatal error:", err)
  process.exit(1)
})
