/**
 * bridge-clients.ts - Shared local bridge attach/detach bookkeeping.
 */
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import {
  discoverBridge,
  removeBridgeState,
  SHARED_BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_SOCKET_FILENAME,
} from "./bridge-discovery"
import { upsertBridgeMetadata } from "./bridge-meta"
import {
  removeBridgeClientLease,
  upsertBridgeClientLease,
} from "./bridge-leases"
import type {
  AttachBridgeClientParams,
  AttachBridgeResult,
  BridgeClientLease,
  BridgeMetadata,
  BridgeShutdownEligibility,
  BridgeLeaseSnapshot,
  DetachBridgeClientParams,
} from "./shared-bridge-types"

function buildLease(params: AttachBridgeClientParams): BridgeClientLease {
  const now = new Date().toISOString()
  return {
    clientId: params.clientId,
    clientKind: params.clientKind,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    attachedAt: now,
    lastSeenAt: now,
    ...(params.processInfo ? { processInfo: params.processInfo } : {}),
  }
}

function buildMetadata(params: AttachBridgeClientParams): BridgeMetadata {
  const now = new Date().toISOString()
  return {
    version: 1,
    bridgeInstanceId: randomUUID(),
    projectDir: params.projectDir,
    stateDir: params.stateDir,
    transport: "unix-socket",
    socketPath: join(params.stateDir, DEFAULT_BRIDGE_SOCKET_FILENAME),
    startedAt: now,
    protocolVersion: SHARED_BRIDGE_PROTOCOL_VERSION,
    adapterCompatibility: {
      claudeCode: true,
      hermes: true,
    },
    lastHeartbeatAt: now,
  }
}

export function evaluateBridgeShutdownEligibility(
  leases: BridgeLeaseSnapshot,
  departingClientId?: string,
): BridgeShutdownEligibility {
  const activeClients = leases.clients.filter((client) => client.clientId !== departingClientId)
  if (activeClients.length === 0) {
    return {
      allowed: true,
      activeClientCount: 0,
      blockingClientIds: [],
    }
  }

  return {
    allowed: false,
    activeClientCount: activeClients.length,
    blockingClientIds: activeClients.map((client) => client.clientId),
    reason: "Other bridge clients are still attached.",
  }
}

export async function attachOrStartBridgeClient(
  params: AttachBridgeClientParams,
): Promise<AttachBridgeResult> {
  const discovery = await discoverBridge({
    projectDir: params.projectDir,
    stateDir: params.stateDir,
  })

  if (discovery.kind === "live_compatible_bridge") {
    const lease = buildLease(params)
    const updated = await upsertBridgeClientLease({
      projectDir: params.projectDir,
      stateDir: params.stateDir,
      lease,
    })
    return {
      kind: "attached_existing",
      metadata: discovery.metadata,
      lease: updated.lease,
      leases: updated.leases,
    }
  }

  if (discovery.kind === "live_incompatible_bridge") {
    return {
      kind: "rejected_incompatible_bridge",
      metadata: discovery.metadata,
      reason: discovery.reason,
    }
  }

  if (discovery.kind === "attach_failed") {
    return {
      kind: "failed_attach",
      reason: discovery.reason,
      ...(discovery.metadata ? { metadata: discovery.metadata } : {}),
    }
  }

  if (discovery.kind === "stale_bridge_state") {
    await removeBridgeState({
      projectDir: params.projectDir,
      stateDir: params.stateDir,
      targets: ["metadata", "leases", "pid", "socket"],
      reason: "stale",
    })
  }

  const metadata = await upsertBridgeMetadata(params.stateDir, buildMetadata(params))
  const lease = buildLease(params)
  const updated = await upsertBridgeClientLease({
    projectDir: params.projectDir,
    stateDir: params.stateDir,
    lease,
  })
  return {
    kind: "started_new_and_attached",
    metadata,
    lease: updated.lease,
    leases: updated.leases,
  }
}

export async function detachBridgeClient(
  params: DetachBridgeClientParams,
): Promise<{ detached: boolean; leases: BridgeLeaseSnapshot; shutdownEligibility: BridgeShutdownEligibility }> {
  const removal = await removeBridgeClientLease(params)
  return {
    detached: removal.removed,
    leases: removal.leases,
    shutdownEligibility: evaluateBridgeShutdownEligibility(removal.leases),
  }
}
