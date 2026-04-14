/**
 * shared-bridge-types.ts — Types for local shared bridge discovery, metadata,
 * leases, and adapter-facing attach semantics.
 */

// ---------------------------------------------------------------------------
// Metadata and lease records
// ---------------------------------------------------------------------------

export type BridgeTransportKind = "stdio" | "unix-socket"

export type BridgeClientKind = "claude-code" | "hermes" | "unknown"

export interface BridgeProcessInfo {
  pid?: number
  ppid?: number
  command?: string
}

export interface BridgeMetadata {
  version: 1
  bridgeInstanceId: string
  projectDir: string
  stateDir: string
  transport: BridgeTransportKind
  socketPath?: string
  pid?: number
  startedAt: string
  protocolVersion: string
  adapterCompatibility?: {
    claudeCode?: boolean
    hermes?: boolean
  }
  lastHeartbeatAt: string
}

export interface BridgeClientLease {
  clientId: string
  clientKind: BridgeClientKind
  sessionId?: string
  attachedAt: string
  lastSeenAt: string
  processInfo?: BridgeProcessInfo
  shutdownIntent?: boolean
}

export interface BridgeLeaseSnapshot {
  bridgeInstanceId: string
  clients: BridgeClientLease[]
}

export interface BridgeMetadataWriteParams {
  projectDir: string
  stateDir: string
  metadata: BridgeMetadata
}

export interface BridgeMetadataDeleteParams {
  projectDir: string
  stateDir: string
  reason?: "stale" | "shutdown" | "replace"
}

export interface BridgeLeaseWriteParams {
  projectDir: string
  stateDir: string
  lease: BridgeClientLease
}

export interface BridgeLeaseDeleteParams {
  projectDir: string
  stateDir: string
  clientId: string
  reason?: "shutdown" | "disconnect" | "stale" | "replace"
}

// ---------------------------------------------------------------------------
// Discovery and attach results
// ---------------------------------------------------------------------------

export interface NoBridgeDiscoveryResult {
  kind: "no_bridge"
}

export interface StaleBridgeStateDiscoveryResult {
  kind: "stale_bridge_state"
  stalePaths: string[]
  previousPid?: number
  reason: string
}

export interface LiveCompatibleBridgeDiscoveryResult {
  kind: "live_compatible_bridge"
  metadata: BridgeMetadata
  leases: BridgeLeaseSnapshot
}

export interface LiveIncompatibleBridgeDiscoveryResult {
  kind: "live_incompatible_bridge"
  metadata: BridgeMetadata
  reason: string
}

export interface StartRequiredDiscoveryResult {
  kind: "start_required"
  reason: string
}

export interface AttachFailedDiscoveryResult {
  kind: "attach_failed"
  reason: string
  metadata?: BridgeMetadata
}

export type BridgeDiscoveryResult =
  | NoBridgeDiscoveryResult
  | StaleBridgeStateDiscoveryResult
  | LiveCompatibleBridgeDiscoveryResult
  | LiveIncompatibleBridgeDiscoveryResult
  | StartRequiredDiscoveryResult
  | AttachFailedDiscoveryResult

export interface AttachedExistingBridgeResult {
  kind: "attached_existing"
  metadata: BridgeMetadata
  lease: BridgeClientLease
  leases: BridgeLeaseSnapshot
}

export interface StartedNewAndAttachedBridgeResult {
  kind: "started_new_and_attached"
  metadata: BridgeMetadata
  lease: BridgeClientLease
  leases: BridgeLeaseSnapshot
}

export interface RejectedIncompatibleBridgeResult {
  kind: "rejected_incompatible_bridge"
  metadata: BridgeMetadata
  reason: string
}

export interface FailedStartBridgeResult {
  kind: "failed_start"
  reason: string
}

export interface FailedAttachBridgeResult {
  kind: "failed_attach"
  reason: string
  metadata?: BridgeMetadata
}

export type AttachBridgeResult =
  | AttachedExistingBridgeResult
  | StartedNewAndAttachedBridgeResult
  | RejectedIncompatibleBridgeResult
  | FailedStartBridgeResult
  | FailedAttachBridgeResult

// ---------------------------------------------------------------------------
// Adapter-facing attach contract
// ---------------------------------------------------------------------------

export interface AttachBridgeClientParams {
  projectDir: string
  stateDir: string
  clientId: string
  clientKind: BridgeClientKind
  sessionId?: string
  processInfo?: BridgeProcessInfo
  capabilities?: {
    supportsReconnect?: boolean
    supportsDetach?: boolean
  }
}

export interface UpsertBridgeMetadataParams {
  metadata: BridgeMetadata
}

export interface UpsertBridgeMetadataResult {
  metadata: BridgeMetadata
}

export interface RefreshBridgeClientLeaseParams {
  projectDir: string
  stateDir: string
  clientId: string
  observedAt: string
}

export interface UpsertBridgeClientLeaseParams {
  projectDir: string
  stateDir: string
  lease: BridgeClientLease
}

export interface UpsertBridgeClientLeaseResult {
  lease: BridgeClientLease
  leases: BridgeLeaseSnapshot
}

export interface DetachBridgeClientParams {
  projectDir: string
  stateDir: string
  clientId: string
  reason?: "shutdown" | "disconnect" | "stale" | "force"
  requestedAt?: string
}

export interface RemoveBridgeClientLeaseParams {
  projectDir: string
  stateDir: string
  clientId: string
  reason?: "shutdown" | "disconnect" | "stale" | "force"
}

export interface RemoveBridgeClientLeaseResult {
  removed: boolean
  leases: BridgeLeaseSnapshot
}

export interface RemoveBridgeStateParams {
  projectDir: string
  stateDir: string
  targets: Array<"metadata" | "leases" | "pid" | "socket">
  reason: "stale" | "reset" | "force"
}

export interface RemoveBridgeStateResult {
  removedTargets: Array<"metadata" | "leases" | "pid" | "socket">
}

export interface BridgeShutdownEligibility {
  allowed: boolean
  activeClientCount: number
  blockingClientIds: string[]
  reason?: string
}
