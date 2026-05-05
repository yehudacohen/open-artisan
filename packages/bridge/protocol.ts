/**
 * protocol.ts — Application-level types for bridge JSON-RPC methods.
 *
 * JSON-RPC 2.0 protocol handling is provided by the `json-rpc-2.0` library.
 * This file defines only the method-specific parameter and result types.
 */
import type { Phase, PhaseState, WorkflowMode } from "../core/types"
import type {
  AttachBridgeResult,
  AttachBridgeClientParams,
  BridgeClientLease,
  BridgeDiscoveryResult,
  BridgeLeaseSnapshot,
  BridgeMetadata,
  BridgeShutdownEligibility,
  DetachBridgeClientParams,
  RefreshBridgeClientLeaseParams,
  RemoveBridgeClientLeaseParams,
  RemoveBridgeClientLeaseResult,
  RemoveBridgeStateParams,
  RemoveBridgeStateResult,
  UpsertBridgeClientLeaseParams,
  UpsertBridgeClientLeaseResult,
  UpsertBridgeMetadataParams,
  UpsertBridgeMetadataResult,
} from "./shared-bridge-types"

// ---------------------------------------------------------------------------
// Application error codes (used with JSONRPCErrorException)
// ---------------------------------------------------------------------------

export const NOT_INITIALIZED = -32000
export const SESSION_NOT_FOUND = -32001
export const INVALID_STATE = -32002
export const SUBAGENT_UNAVAILABLE = -32003

/** Standard JSON-RPC 2.0 "Invalid params" error code. */
export const INVALID_PARAMS = -32602

// ---------------------------------------------------------------------------
// Method parameter types
// ---------------------------------------------------------------------------

export interface LifecycleInitParams {
  projectDir: string
  stateDir?: string
  /** Transport hosting this bridge engine. Stdio transports are process-local and should not advertise a reusable socket. */
  transport?: "stdio" | "unix-socket"
  /** Unix socket path when transport is unix-socket. */
  socketPath?: string
  /** Whether to publish shared runtime metadata and a PID file. Defaults to true for backward compatibility. */
  registerRuntime?: boolean
  /** Workflow state persistence backend. Defaults to DB/PGlite; set filesystem for legacy opt-out. */
  persistence?: {
    kind?: "filesystem" | "db" | "pglite"
    pglite?: {
      dataDir?: string
      databaseFileName?: string
      schemaName?: string
    }
  }
  /**
   * Adapter capabilities — declares which engine features are available.
   * Defaults: bridge adapters use agent-managed review/orchestration unless a capability is declared.
   *
   * - selfReview: "isolated" (SubagentDispatcher) | "agent-only" (agent self-evaluates)
   * - orchestrator: true (feedback classification via LLM) | false (direct route to REVISE)
   * - discoveryFleet: true (parallel scanner subagents) | false (agent provides summary directly)
   *
   * Example: Claude Code adapter sets { selfReview: "agent-only", orchestrator: false, discoveryFleet: false }
   */
  capabilities?: {
    selfReview?: "isolated" | "agent-only"
    orchestrator?: boolean
    discoveryFleet?: boolean
  }
  traceId?: string
}

export interface LifecycleSessionParams {
  sessionId: string
  parentId?: string
  /** Agent name driving this session (e.g. "artisan", "robot-artisan"). */
  agent?: string
  traceId?: string
}

export interface LifecycleShutdownParams {
  force?: boolean
  traceId?: string
}

export interface StateGetParams {
  sessionId: string
  includeRuntimeHealth?: boolean
  traceId?: string
}

export interface StateHealthParams {
  sessionId: string
  traceId?: string
}

export interface BridgeRuntimeHealthSummary {
  featureName: string | null
  phase: string
  phaseState: string
  bridgeTransport: "stdio" | "unix-socket"
  bridgeAttachedClients: number
  bridgeActiveClientKinds: string[]
  pendingTaskReview: boolean
  currentTaskId: string | null
  lastRecoveryAction: string
  awaitingUserGate: boolean
  noopReason: string | null
}

export interface StateGetWithRuntimeHealthResult {
  state: Record<string, unknown> | null
  runtimeHealth: BridgeRuntimeHealthSummary | null
}

export interface GuardCheckParams {
  toolName: string
  args: Record<string, unknown>
  sessionId: string
  traceId?: string
}

export interface GuardPolicyParams {
  phase: Phase
  phaseState: PhaseState
  mode: WorkflowMode | null
  allowlist: string[]
  /** Per-task expected files from the current DAG task (IMPLEMENTATION phase) */
  taskExpectedFiles?: string[]
  traceId?: string
}

export interface PromptBuildParams {
  sessionId: string
  traceId?: string
}

export interface IdleCheckParams {
  sessionId: string
  traceId?: string
}

export interface MessageProcessParams {
  sessionId: string
  parts: Array<{ type: string; text?: string }>
  traceId?: string
}

export interface ToolExecuteParams {
  name: string
  args: Record<string, unknown>
  context: {
    sessionId: string
    directory: string
    agent?: string
  }
  traceId?: string
}

export interface BridgeDiscoverParams {
  projectDir: string
  stateDir: string
  traceId?: string
}

export interface BridgeAttachParams extends AttachBridgeClientParams {
  traceId?: string
}

export interface BridgeLeaseRefreshParams extends RefreshBridgeClientLeaseParams {
  traceId?: string
}

export interface BridgeDetachParams extends DetachBridgeClientParams {
  traceId?: string
}

export interface BridgeMetadataGetParams {
  projectDir: string
  stateDir: string
  traceId?: string
}

export interface BridgeShutdownEligibilityParams {
  projectDir: string
  stateDir: string
  traceId?: string
}

export interface BridgeMetadataUpsertParams extends UpsertBridgeMetadataParams {
  traceId?: string
}

export interface BridgeLeaseUpsertParams extends UpsertBridgeClientLeaseParams {
  traceId?: string
}

export interface BridgeLeaseRemoveParams extends RemoveBridgeClientLeaseParams {
  traceId?: string
}

export interface BridgeStateRemoveParams extends RemoveBridgeStateParams {
  traceId?: string
}

// ---------------------------------------------------------------------------
// Method result types
// ---------------------------------------------------------------------------

export interface GuardCheckResult {
  allowed: boolean
  reason?: string
  policyVersion: number
  /** Current phase (included so callers don't need a separate state.get call). */
  phase?: string
  /** Current phase sub-state. */
  phaseState?: string
}

export interface GuardPolicyResult {
  blocked: string[]
  allowedDescription: string
  hasWritePathPredicate: boolean
  hasBashCommandPredicate: boolean
  policyVersion: number
}

export interface IdleCheckResult {
  action: "reprompt" | "escalate" | "ignore"
  message?: string
  retryCount?: number
}

export interface MessageProcessResult {
  parts: Array<{ type: string; text?: string }>
  intercepted: boolean
}

export interface BridgeDiscoverResult {
  discovery: BridgeDiscoveryResult
}

export interface BridgeAttachRpcResult {
  attach: AttachBridgeResult
}

export interface BridgeLeaseRefreshResult {
  lease?: BridgeClientLease
  leases: BridgeLeaseSnapshot
}

export interface BridgeDetachResult {
  detached: boolean
  leases: BridgeLeaseSnapshot
  shutdownEligibility: BridgeShutdownEligibility
}

export interface BridgeMetadataGetResult {
  metadata?: BridgeMetadata
  leases?: BridgeLeaseSnapshot
}

export interface BridgeShutdownEligibilityResult {
  eligibility: BridgeShutdownEligibility
}

export interface BridgeMetadataUpsertResult extends UpsertBridgeMetadataResult {}

export interface BridgeLeaseUpsertResult extends UpsertBridgeClientLeaseResult {}

export interface BridgeLeaseRemoveResult extends RemoveBridgeClientLeaseResult {}

export interface BridgeStateRemoveResultRpc {
  removal: RemoveBridgeStateResult
}
