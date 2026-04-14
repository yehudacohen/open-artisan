/**
 * bridge-discovery.ts - Shared local bridge discovery and stale cleanup.
 */
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"

import { checkPidFile, PID_FILENAME } from "./pid-file"
import {
  getBridgeLeasesPath,
  getBridgeMetadataPath,
  loadBridgeLeaseSnapshot,
  loadBridgeMetadata,
  removeBridgeLeaseSnapshot,
  removeBridgeMetadata,
} from "./bridge-meta"
import type {
  BridgeDiscoveryResult,
  BridgeMetadata,
  BridgeLeaseSnapshot,
  RemoveBridgeStateParams,
  RemoveBridgeStateResult,
} from "./shared-bridge-types"

export const SHARED_BRIDGE_PROTOCOL_VERSION = "1"
export const DEFAULT_BRIDGE_SOCKET_FILENAME = ".bridge.sock"

export interface DiscoverBridgeParams {
  projectDir: string
  stateDir: string
}

function buildEmptyLeaseSnapshot(metadata: BridgeMetadata): BridgeLeaseSnapshot {
  return {
    bridgeInstanceId: metadata.bridgeInstanceId,
    clients: [],
  }
}

export async function discoverBridge({ projectDir, stateDir }: DiscoverBridgeParams): Promise<BridgeDiscoveryResult> {
  const metadataPath = getBridgeMetadataPath(stateDir)
  const leasesPath = getBridgeLeasesPath(stateDir)
  const socketPath = join(stateDir, DEFAULT_BRIDGE_SOCKET_FILENAME)

  const [metadata, leases, pidCheck] = await Promise.all([
    loadBridgeMetadata(stateDir),
    loadBridgeLeaseSnapshot(stateDir),
    checkPidFile(stateDir),
  ])

  const hasArtifacts = existsSync(metadataPath) || existsSync(leasesPath) || existsSync(socketPath) || pidCheck.running || pidCheck.staleCleaned
  if (!hasArtifacts) {
    return { kind: "no_bridge" }
  }

  if (!metadata) {
    return {
      kind: "attach_failed",
      reason: "Bridge metadata is missing or malformed.",
    }
  }

  if (metadata.projectDir !== projectDir || metadata.stateDir !== stateDir) {
    return {
      kind: "live_incompatible_bridge",
      metadata,
      reason: "Bridge metadata does not match the requested project/state directory.",
    }
  }

  if (metadata.protocolVersion !== SHARED_BRIDGE_PROTOCOL_VERSION) {
    return {
      kind: "live_incompatible_bridge",
      metadata,
      reason: `Bridge protocol mismatch: expected ${SHARED_BRIDGE_PROTOCOL_VERSION}, got ${metadata.protocolVersion}.`,
    }
  }

  if (!pidCheck.running) {
    const stalePaths = [metadataPath, leasesPath, socketPath, join(stateDir, PID_FILENAME)].filter((path) => existsSync(path))
    return {
      kind: "stale_bridge_state",
      stalePaths,
      ...(pidCheck.pid ? { previousPid: pidCheck.pid } : {}),
      reason: "Bridge metadata exists but the recorded bridge process is not running.",
    }
  }

  return {
    kind: "live_compatible_bridge",
    metadata,
    leases: leases ?? buildEmptyLeaseSnapshot(metadata),
  }
}

export async function removeBridgeState(params: RemoveBridgeStateParams): Promise<RemoveBridgeStateResult> {
  const removedTargets: Array<"metadata" | "leases" | "pid" | "socket"> = []

  for (const target of params.targets) {
    if (target === "metadata") {
      if (await removeBridgeMetadata(params.stateDir)) removedTargets.push("metadata")
      continue
    }
    if (target === "leases") {
      if (await removeBridgeLeaseSnapshot(params.stateDir)) removedTargets.push("leases")
      continue
    }
    if (target === "pid") {
      try {
        await rm(join(params.stateDir, PID_FILENAME))
        removedTargets.push("pid")
      } catch {
        // ignore
      }
      continue
    }
    if (target === "socket") {
      try {
        await rm(join(params.stateDir, DEFAULT_BRIDGE_SOCKET_FILENAME))
        removedTargets.push("socket")
      } catch {
        // ignore
      }
    }
  }

  return { removedTargets }
}
