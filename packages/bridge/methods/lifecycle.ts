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
import { migrateLegacyStateFile } from "../../core/state-backend-fs"
import { createOpenArtisanRuntimeBackend } from "../../core/open-artisan-runtime-backends"
import { createStateMachine } from "../../core/state-machine"
import { createArtifactGraph } from "../../core/artifacts"
import { createSessionRegistry } from "../../core/session-registry"
import { normalizeAgentName } from "../../core/agent-policy"
import { detectMode } from "../../core/mode-detect"
import { setDefaultStateDir } from "../../core/logger"
import { writeStatusFile } from "../../core/status-writer"
import { LifecycleInitParamsSchema, formatZodError } from "../../core/schemas"
import { checkPidFile, writePidFile, removePidFile } from "../pid-file"
import { createBridgeLogger, adaptPinoToLogger } from "../structured-log"
import { loadBridgeLeaseSnapshot, loadBridgeMetadata, upsertBridgeMetadata } from "../bridge-meta"
import { detachBridgeClient, evaluateBridgeShutdownEligibility } from "../bridge-clients"
import { upsertBridgeClientLease } from "../bridge-leases"
import { DEFAULT_BRIDGE_SOCKET_FILENAME, SHARED_BRIDGE_PROTOCOL_VERSION } from "../bridge-discovery"
import { createRoadmapSliceService } from "../../core/roadmap-slice-service"
import { matchesRoadmapQuery, roadmapError, roadmapOk } from "../../core/roadmap-types"
import type { EngineContext } from "../../core/engine-context"
import type { SubagentDispatcher } from "../../core/subagent-dispatcher"
import type { NotificationSink } from "../../core/logger"
import type { ArtifactKey, Phase } from "../../core/types"
import type { OrchestratorRouteInput } from "../../core/orchestrator-types"
import type { BridgeClientLease, BridgeMetadata } from "../shared-bridge-types"

// Bridge adapters run review/discovery externally and submit results back via bridge tools.
const externalReviewDispatcher: SubagentDispatcher = {
  async createSession() {
    throw new Error(
      "This bridge uses adapter-managed external review sessions. " +
      "Request review context through the bridge and submit reviewer output with the matching submit tool.",
    )
  },
}

// No-op notification sink — bridge doesn't have a TUI.
const noopNotify: NotificationSink = {
  toast() { /* no-op */ },
}

function buildBridgeMetadata(
  projectDir: string,
  stateDir: string,
  transport: BridgeMetadata["transport"],
  socketPath: string | undefined,
  existing?: BridgeMetadata | null,
): BridgeMetadata {
  const now = new Date().toISOString()
  const resolvedSocketPath = transport === "unix-socket"
    ? socketPath ?? existing?.socketPath ?? join(stateDir, DEFAULT_BRIDGE_SOCKET_FILENAME)
    : undefined
  return {
    version: 1,
    bridgeInstanceId: existing?.bridgeInstanceId ?? randomUUID(),
    projectDir,
    stateDir,
    transport,
    ...(resolvedSocketPath ? { socketPath: resolvedSocketPath } : {}),
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
  const parsedParams = LifecycleInitParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    throw new JSONRPCErrorException(`Invalid lifecycle.init params: ${formatZodError(parsedParams.error)}`, INVALID_PARAMS)
  }
  const p = parsedParams.data

  const projectDir = p.projectDir.replace(/\/+$/, "")
  const stateDir = p.stateDir ?? join(projectDir, ".openartisan")
  const legacyStateFile = join(projectDir, ".opencode", "workflow-state.json")
  const transport = p.transport ?? "unix-socket"
  const registerRuntime = p.registerRuntime ?? true

  if (registerRuntime) {
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

    // Write PID file and shared bridge metadata only for reusable runtimes.
    await writePidFile(stateDir)

    const existingMetadata = await loadBridgeMetadata(stateDir)
    await upsertBridgeMetadata(stateDir, buildBridgeMetadata(projectDir, stateDir, transport, p.socketPath, existingMetadata))
  }

  // Create backend and store. DB/PGlite is the default; filesystem is an explicit legacy opt-out.
  const runtimeOptions: Parameters<typeof createOpenArtisanRuntimeBackend>[1] = {}
  if (p.persistence?.kind) runtimeOptions.kind = p.persistence.kind
  if (p.persistence?.pglite) {
    runtimeOptions.pglite = {
      connection: {
        ...(p.persistence.pglite.dataDir ? { dataDir: p.persistence.pglite.dataDir } : {}),
        ...(p.persistence.pglite.databaseFileName ? { databaseFileName: p.persistence.pglite.databaseFileName } : {}),
        debugName: "open-artisan-bridge-workflow",
      },
      ...(p.persistence.pglite.schemaName ? { schemaName: p.persistence.pglite.schemaName } : {}),
    }
  }
  const runtimeBackend = createOpenArtisanRuntimeBackend(stateDir, runtimeOptions)
  const backend = runtimeBackend.stateBackend
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

  // Capability-aware orchestrator fallback for bridge clients without LLM classification.
  const orchestrator = {
    async route(input: OrchestratorRouteInput) {
      const artifact: ArtifactKey = input.currentPhase === "DISCOVERY"
        ? "conventions"
        : input.currentPhase === "PLANNING"
          ? "plan"
          : input.currentPhase === "INTERFACES"
            ? "interfaces"
            : input.currentPhase === "TESTS"
              ? "tests"
              : input.currentPhase === "IMPL_PLAN"
                ? "impl_plan"
                : "implementation"
      return {
        classification: "tactical" as const,
        revisionSteps: [{
          artifact,
          phase: input.currentPhase as Exclude<Phase, "MODE_SELECT" | "DONE">,
          phaseState: "REVISE" as const,
          instructions: input.feedback,
        }],
      }
    },
  }

  // Assemble EngineContext
  const engine: EngineContext = {
    store,
    sm,
    orchestrator,
    subagentDispatcher: externalReviewDispatcher,
    log,
    notify: noopNotify,
    graph,
    ...(runtimeBackend.services ? { openArtisanServices: runtimeBackend.services } : {}),
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
  ctx.runtimeBackendKind = runtimeBackend.kind
  ctx.roadmapBackend = runtimeBackend.roadmapBackend ?? null
  ctx.openArtisanServices = runtimeBackend.services ?? null
  ctx.runtimeBackendDispose = runtimeBackend.dispose
  ctx.roadmapService = runtimeBackend.roadmapBackend
    ? createRoadmapSliceService(runtimeBackend.roadmapBackend, {
      async queryRoadmapItems(query) {
        const result = await runtimeBackend.roadmapBackend!.readRoadmap()
        if (!result.ok) return result
        if (result.value === null) return roadmapError("not-found", "No roadmap document exists", false)
        return roadmapOk(result.value.items.filter((item) => matchesRoadmapQuery(item, query)))
      },
    })
    : null

  log.info("Bridge initialized", {
    detail: `projectDir=${projectDir} stateDir=${stateDir} backend=${runtimeBackend.kind} loaded=${loadResult.count} migrated=${migration.migrated.length}`,
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

  try {
    await ctx.runtimeBackendDispose?.()
  } catch (error) {
    ctx.engine?.log.warn("Runtime backend dispose failed", {
      detail: error instanceof Error ? error.message : String(error),
    })
  }

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
  const existingState = store.get(p.sessionId)
  if (!existingState) {
    try {
      await store.create(p.sessionId)
    } catch {
      // Already exists from a previous load — no-op
    }

    // Set active agent and run mode detection only for freshly-created sessions.
    // Repeated sessionCreated calls for the same session must remain idempotent
    // and must not mutate workflow meaning on resumed turns.
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
