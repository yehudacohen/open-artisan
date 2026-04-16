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

async function buildRuntimeHealthSummary(
  sessionId: string,
  state: Record<string, unknown>,
  stateDir: string | null,
): Promise<BridgeRuntimeHealthSummary> {
  const metadata = stateDir ? await loadBridgeMetadata(stateDir) : null
  const leases = stateDir ? await loadBridgeLeaseSnapshot(stateDir) : null
  const clients = leases?.clients ?? []
  const activeKinds = Array.from(new Set(clients.map((client) => client.clientKind))).sort()
  const phase = typeof state.phase === "string" ? state.phase : "MODE_SELECT"
  const phaseState = typeof state.phaseState === "string" ? state.phaseState : "DRAFT"
  const pendingTaskReview = typeof state.taskCompletionInProgress === "string" && state.taskCompletionInProgress.length > 0
  const awaitingUserGate = phaseState === "USER_GATE"
  const noopReason = pendingTaskReview
    ? `pending task review for ${state.taskCompletionInProgress as string}`
    : awaitingUserGate
      ? `awaiting user gate at ${phase}`
      : phaseState === "REVIEW"
        ? `awaiting review result for ${phase}`
        : null

  return {
    featureName: typeof state.featureName === "string" ? state.featureName : null,
    phase,
    phaseState,
    bridgeTransport: metadata?.transport ?? "stdio",
    bridgeAttachedClients: clients.length,
    bridgeActiveClientKinds: activeKinds,
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
  stateDir: string | null,
): Promise<BridgeRuntimeHealthSummary | null> {
  return state ? buildRuntimeHealthSummary(sessionId, state, stateDir) : null
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
    runtimeHealth: await resolveRuntimeHealth(p.sessionId, snapshot as Record<string, unknown> | null, ctx.stateDir),
  }
}

export const handleStateHealth: MethodHandler = async (params, ctx) => {
  const p = params as Partial<StateHealthParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }

  const state = ctx.engine!.store.get(p.sessionId)
  const snapshot = state ? structuredClone(state) as Record<string, unknown> : null
  return resolveRuntimeHealth(p.sessionId, snapshot, ctx.stateDir)
}
