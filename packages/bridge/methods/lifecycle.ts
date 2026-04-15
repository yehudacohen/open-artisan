/**
 * lifecycle.ts — Bridge lifecycle methods.
 *
 * lifecycle.init:           Create EngineContext, load persisted state.
 * lifecycle.ping:           Health check — returns "pong".
 * lifecycle.shutdown:       Graceful shutdown.
 * lifecycle.sessionCreated: Register a new session.
 * lifecycle.sessionDeleted: Unregister and delete session state.
 */
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler, BridgeContext } from "../server"
import type { LifecycleInitParams, LifecycleSessionParams, LifecycleShutdownParams } from "../protocol"
import { INVALID_PARAMS, NOT_INITIALIZED } from "../protocol"

import { createSessionStateStore, setPostUpdateHook } from "../../core/session-state"
import { createFileSystemStateBackend, migrateLegacyStateFile } from "../../core/state-backend-fs"
import { createStateMachine } from "../../core/state-machine"
import { createArtifactGraph } from "../../core/artifacts"
import { createSessionRegistry } from "../../core/session-registry"
import { normalizeAgentName } from "../../core/agent-policy"
import { detectMode } from "../../core/mode-detect"
import { setDefaultStateDir } from "../../core/logger"
import { writeStatusFile } from "../../core/status-writer"
import { checkPidFile, writePidFile, removePidFile } from "../pid-file"
import { createBridgeLogger, adaptPinoToLogger } from "../structured-log"
import { loadBridgeLeaseSnapshot, loadBridgeMetadata, upsertBridgeMetadata } from "../bridge-meta"
import { detachBridgeClient, evaluateBridgeShutdownEligibility } from "../bridge-clients"
import { upsertBridgeClientLease } from "../bridge-leases"
import { DEFAULT_BRIDGE_SOCKET_FILENAME, SHARED_BRIDGE_PROTOCOL_VERSION } from "../bridge-discovery"
import type { EngineContext } from "../../core/engine-context"
import type { SubagentDispatcher } from "../../core/subagent-dispatcher"
import type { NotificationSink } from "../../core/logger"
import type { BridgeClientLease, BridgeMetadata } from "../shared-bridge-types"

// Stub SubagentDispatcher — returns descriptive errors for Phase 4.
const stubSubagentDispatcher: SubagentDispatcher = {
  async createSession() {
    throw new Error(
      "SubagentDispatcher not available in bridge mode. " +
      "Self-review, orchestrator, and discovery fleet require an LLM client. " +
      "Use an in-process adapter or configure an LLM client in lifecycle.init.",
    )
  },
}

// No-op notification sink — bridge doesn't have a TUI.
const noopNotify: NotificationSink = {
  toast() { /* no-op */ },
}

function buildBridgeMetadata(projectDir: string, stateDir: string, existing?: BridgeMetadata | null): BridgeMetadata {
  const now = new Date().toISOString()
  return {
    version: 1,
    bridgeInstanceId: existing?.bridgeInstanceId ?? randomUUID(),
    projectDir,
    stateDir,
    transport: existing?.transport ?? "unix-socket",
    socketPath: existing?.socketPath ?? join(stateDir, DEFAULT_BRIDGE_SOCKET_FILENAME),
    pid: process.pid,
    startedAt: existing?.startedAt ?? now,
    protocolVersion: SHARED_BRIDGE_PROTOCOL_VERSION,
    adapterCompatibility: existing?.adapterCompatibility ?? { claudeCode: true, hermes: true },
    lastHeartbeatAt: now,
  }
}

function buildSessionLease(sessionId: string, agent?: string): BridgeClientLease {
  const now = new Date().toISOString()
  return {
    clientId: sessionId,
    clientKind: agent === "hermes" ? "hermes" : agent === "claude-code" ? "claude-code" : "unknown",
    sessionId,
    attachedAt: now,
    lastSeenAt: now,
  }
}

export const handleInit: MethodHandler = async (params, ctx) => {
  const p = params as Partial<LifecycleInitParams>
  if (!p.projectDir || typeof p.projectDir !== "string") {
    throw new JSONRPCErrorException("projectDir is required", INVALID_PARAMS)
  }

  const projectDir = p.projectDir.replace(/\/+$/, "")
  const stateDir = p.stateDir ?? join(projectDir, ".openartisan")
  const legacyStateFile = join(projectDir, ".opencode", "workflow-state.json")

  // Check for existing bridge process (stale PID detection).
  // Allow re-init from the same process (our own PID is fine).
  const pidCheck = await checkPidFile(stateDir)
  if (pidCheck.running && pidCheck.pid !== process.pid) {
    throw new JSONRPCErrorException(
      `Another bridge process is already running (PID ${pidCheck.pid}). ` +
      `Kill it or remove .bridge-pid manually.`,
      NOT_INITIALIZED,
    )
  }

  // Write PID file
  await writePidFile(stateDir)

  const existingMetadata = await loadBridgeMetadata(stateDir)
  await upsertBridgeMetadata(stateDir, buildBridgeMetadata(projectDir, stateDir, existingMetadata))

  // Create backend and store
  const backend = createFileSystemStateBackend(stateDir)
  const store = createSessionStateStore(backend)

  // Legacy migration
  const migration = await migrateLegacyStateFile(backend, legacyStateFile)

  // Core components
  const sm = createStateMachine()
  const graph = createArtifactGraph(false) // no design doc detection in bridge
  const sessions = createSessionRegistry()
  const pinoLogger = createBridgeLogger(stateDir)
  const log = adaptPinoToLogger(pinoLogger, noopNotify)
  setDefaultStateDir(stateDir) // for core error log persistence

  // Post-update hook: bump policy version + write status file
  setPostUpdateHook((state, dir) => {
    ctx.bumpPolicyVersion()
    writeStatusFile(dir, state).catch(() => { /* non-fatal */ })
  }, projectDir)

  // Load persisted state
  const loadResult = await store.load()
  if (!loadResult.success) {
    throw new JSONRPCErrorException(`Failed to load state: ${loadResult.error}`, NOT_INITIALIZED)
  }

  // Create stub orchestrator (needs SubagentDispatcher for real implementation)
  const orchestrator = {
    async route() {
      throw new Error("Orchestrator not available in bridge mode (requires SubagentDispatcher).")
    },
  }

  // Assemble EngineContext
  const engine: EngineContext = {
    store,
    sm,
    orchestrator,
    subagentDispatcher: stubSubagentDispatcher,
    log,
    notify: noopNotify,
    graph,
    designDocPath: null,
    sessions,
    lastRepromptTimestamps: new Map(),
    async promptExistingSession() {
      // No-op in bridge mode — adapter handles reprompting via idle.check
    },
  }

  ctx.setEngine(engine)
  ctx.stateDir = stateDir
  ctx.projectDir = projectDir
  ctx.capabilities = {
    selfReview: p.capabilities?.selfReview ?? "agent-only",
    orchestrator: p.capabilities?.orchestrator ?? false,
    discoveryFleet: p.capabilities?.discoveryFleet ?? false,
  }
  ctx.pinoLogger = pinoLogger

  log.info("Bridge initialized", {
    detail: `projectDir=${projectDir} stateDir=${stateDir} loaded=${loadResult.count} migrated=${migration.migrated.length}`,
  })

  return "ready"
}

export const handlePing: MethodHandler = async () => {
  return "pong"
}

export const handleShutdown: MethodHandler = async (params, ctx) => {
  const p = params as Partial<LifecycleShutdownParams>
  if (ctx.stateDir) {
    const leases = await loadBridgeLeaseSnapshot(ctx.stateDir)
    const eligibility = evaluateBridgeShutdownEligibility(leases ?? { bridgeInstanceId: "bridge", clients: [] })
    if (!p.force && !eligibility.allowed) {
      return {
        ok: false,
        reason: eligibility.reason ?? "Other bridge clients are still attached.",
        activeClientCount: eligibility.activeClientCount,
        blockingClientIds: eligibility.blockingClientIds,
      }
    }
  }

  ctx.shuttingDown = true
  ctx.engine?.log.info("Bridge shutting down")

  // Remove PID file before exit
  if (ctx.stateDir) {
    await removePidFile(ctx.stateDir)
  }

  // Flush pino's async transport before exit to avoid losing buffered log entries
  if (ctx.pinoLogger) {
    ctx.pinoLogger.flush()
  }

  // Schedule exit after the response has been written to stdout.
  process.nextTick(() => {
    setTimeout(() => process.exit(0), 50)
  })
  return "ok"
}

export const handleSessionCreated: MethodHandler = async (params, ctx) => {
  const p = params as Partial<LifecycleSessionParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const { store, sessions, log } = ctx.engine!

  if (p.parentId) {
    // Child session — register but don't create WorkflowState
    sessions.registerChild(p.sessionId, p.parentId)
    return null
  }

  // Primary session
  sessions.registerPrimary(p.sessionId)
  try {
    await store.create(p.sessionId)
  } catch {
    // Already exists from a previous load — no-op
  }

  // Set active agent and run mode detection for fresh sessions
  const needsUpdate = (p.agent && typeof p.agent === "string") || ctx.projectDir
  if (needsUpdate) {
    try {
      const normalizedAgent = normalizeAgentName(p.agent)
      await store.update(p.sessionId, (draft) => {
        // Set active agent if provided (e.g. "robot-artisan" for automation mode)
        if (normalizedAgent) {
          draft.activeAgent = normalizedAgent
        }
        // Auto-detect mode for fresh sessions at MODE_SELECT
        if (draft.phase === "MODE_SELECT" && !draft.modeDetectionNote && ctx.projectDir) {
          const detection = detectMode(ctx.projectDir)
          draft.modeDetectionNote = `**Auto-detected:** ${detection.reasoning}\n\nSuggested mode: **${detection.suggestedMode}**`
        }
      })
    } catch {
      // Non-fatal — session may not exist yet if create was a no-op
    }
  }

  log.debug("Session created", { detail: `${p.sessionId}${p.agent ? ` (agent: ${p.agent})` : ""}` })

  if (ctx.stateDir && ctx.projectDir) {
    await upsertBridgeClientLease({
      projectDir: ctx.projectDir,
      stateDir: ctx.stateDir,
      lease: buildSessionLease(p.sessionId, normalizeAgentName(p.agent) ?? undefined),
    })
  }

  return null
}

export const handleSessionDeleted: MethodHandler = async (params, ctx) => {
  const p = params as Partial<LifecycleSessionParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const { store, sessions, log } = ctx.engine!

  sessions.unregister(p.sessionId)

  const state = store.get(p.sessionId)
  if (!state) {
    return null
  }

  if (ctx.stateDir && ctx.projectDir) {
    await detachBridgeClient({
      projectDir: ctx.projectDir,
      stateDir: ctx.stateDir,
      clientId: p.sessionId,
      reason: "disconnect",
    })
  }

  log.debug("Session detached (state preserved)", {
    detail: `${p.sessionId}${state.featureName ? ` feature=${state.featureName}` : ""}`,
  })

  return null
}
