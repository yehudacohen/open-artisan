/**
 * state.ts — Bridge state inspection method.
 *
 * state.get: Returns the WorkflowState for a session (or null if not found).
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler } from "../server"
import { INVALID_PARAMS } from "../protocol"
import type { BridgeRuntimeHealthSummary, StateGetParams, StateHealthParams } from "../protocol"
import { loadBridgeLeaseSnapshot, loadBridgeMetadata } from "../bridge-meta"
import type { BridgeContext } from "../server"
import { workflowDbId } from "../../core/runtime-persistence"

type DbLeaseHealthSummary = Pick<
  BridgeRuntimeHealthSummary,
  "dbAgentLeaseCount" | "dbActiveAgentLeaseCount" | "dbExpiredAgentLeaseCount" | "dbCurrentSessionLeaseCount" | "dbLeaseDiagnosticsError"
>

async function buildDbLeaseHealthSummary(
  sessionId: string,
  state: Record<string, unknown>,
  ctx: BridgeContext,
): Promise<DbLeaseHealthSummary> {
  const empty = {
    dbAgentLeaseCount: null,
    dbActiveAgentLeaseCount: null,
    dbExpiredAgentLeaseCount: null,
    dbCurrentSessionLeaseCount: null,
    dbLeaseDiagnosticsError: null,
  }
  if (ctx.runtimeBackendInfo.backendKind !== "db" || !ctx.openArtisanServices) return empty

  const featureName = typeof state.featureName === "string" ? state.featureName : null
  const leases = await ctx.openArtisanServices.agentLeases.listLeases(workflowDbId({ featureName, sessionId }))
  if (!leases.ok) {
    return {
      ...empty,
      dbLeaseDiagnosticsError: leases.error.message,
    }
  }

  const now = Date.now()
  const activeLeases = leases.value.filter((lease) => Date.parse(lease.expiresAt) > now)
  const currentSessionLeases = leases.value.filter((lease) => lease.sessionId === sessionId)
  return {
    dbAgentLeaseCount: leases.value.length,
    dbActiveAgentLeaseCount: activeLeases.length,
    dbExpiredAgentLeaseCount: leases.value.length - activeLeases.length,
    dbCurrentSessionLeaseCount: currentSessionLeases.length,
    dbLeaseDiagnosticsError: null,
  }
}

async function buildRuntimeHealthSummary(
  sessionId: string,
  state: Record<string, unknown>,
  ctx: BridgeContext,
): Promise<BridgeRuntimeHealthSummary> {
  const stateDir = ctx.stateDir
  const metadata = stateDir ? await loadBridgeMetadata(stateDir) : null
  const leases = stateDir ? await loadBridgeLeaseSnapshot(stateDir) : null
  const clients = leases?.clients ?? []
  const activeKinds = Array.from(new Set(clients.map((client) => client.clientKind))).sort()
  const phase = typeof state.phase === "string" ? state.phase : "MODE_SELECT"
  const phaseState = typeof state.phaseState === "string" ? state.phaseState : "DRAFT"
  const pendingTaskReview = typeof state.taskCompletionInProgress === "string" && state.taskCompletionInProgress.length > 0
  const awaitingUserGate = phaseState === "USER_GATE"
  const dbLeaseHealth = await buildDbLeaseHealthSummary(sessionId, state, ctx)
  const noopReason = pendingTaskReview
    ? `pending task review for ${state.taskCompletionInProgress as string}`
    : awaitingUserGate
      ? `awaiting user gate at ${phase}`
      : phaseState === "REVIEW"
        ? `awaiting review result for ${phase}`
        : null

  return {
    backendKind: ctx.runtimeBackendInfo.backendKind,
    stateDir: ctx.runtimeBackendInfo.stateDir,
    pgliteDataDir: ctx.runtimeBackendInfo.pgliteDataDir,
    pgliteDatabaseFileName: ctx.runtimeBackendInfo.pgliteDatabaseFileName,
    pgliteSchemaName: ctx.runtimeBackendInfo.pgliteSchemaName,
    featureName: typeof state.featureName === "string" ? state.featureName : null,
    phase,
    phaseState,
    bridgeTransport: metadata?.transport ?? "stdio",
    bridgeSocketPath: metadata?.socketPath ?? null,
    bridgeAttachedClients: clients.length,
    bridgeActiveClientKinds: activeKinds,
    ...dbLeaseHealth,
    pendingTaskReview,
    currentTaskId: typeof state.currentTaskId === "string" ? state.currentTaskId : null,
    lastRecoveryAction:
      metadata?.transport === "unix-socket"
        ? clients.some((client) => client.sessionId === sessionId)
          ? "attached-shared-bridge"
          : "shared-bridge-active"
        : "bridge-stdio-only",
    awaitingUserGate,
    noopReason,
  }
}

export async function resolveRuntimeHealth(
  sessionId: string,
  state: Record<string, unknown> | null,
  ctx: BridgeContext,
): Promise<BridgeRuntimeHealthSummary | null> {
  return state ? buildRuntimeHealthSummary(sessionId, state, ctx) : null
}

export const handleStateGet: MethodHandler = async (params, ctx) => {
  const p = params as Partial<StateGetParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const state = ctx.engine!.store.get(p.sessionId)
  const snapshot = state ? structuredClone(state) : null
  if (!p.includeRuntimeHealth) {
    return snapshot
  }

  return {
    state: snapshot,
    runtimeHealth: await resolveRuntimeHealth(p.sessionId, snapshot as unknown as Record<string, unknown> | null, ctx),
  }
}

export const handleStateHealth: MethodHandler = async (params, ctx) => {
  const p = params as Partial<StateHealthParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const state = ctx.engine!.store.get(p.sessionId)
  const snapshot = state ? structuredClone(state) as unknown as Record<string, unknown> : null
  return resolveRuntimeHealth(p.sessionId, snapshot, ctx)
}
