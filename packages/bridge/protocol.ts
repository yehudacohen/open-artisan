/**
 * protocol.ts — Application-level types for bridge JSON-RPC methods.
 *
 * JSON-RPC 2.0 protocol handling is provided by the `json-rpc-2.0` library.
 * This file defines only the method-specific parameter and result types.
 */
import type { Phase, PhaseState, WorkflowMode } from "../core/workflow-primitives"
import type { WorkflowProgressEvent, WorkflowProgressStatus } from "../core/workflow-progress"
import type { WorkflowNextActionKind } from "../core/workflow-next-action"
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
   * - selfReview: "isolated" (reviewer subprocess/subagent) | "agent-only" (agent self-evaluates)
   * - orchestrator: true (feedback classification via LLM) | false (direct route to REVISE)
   * - discoveryFleet: true (parallel scanner subagents) | false (agent provides summary directly)
   *
   * Example: Claude Code adapter sets { selfReview: "isolated", orchestrator: false, discoveryFleet: false }
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

export interface ProgressEmitParams {
  sessionId: string
  kind: string
  status?: WorkflowProgressStatus
  message: string
  spanId?: string | null
  parentSpanId?: string | null
  parentEventId?: string | null
  taskId?: string | null
  metadata?: Record<string, unknown>
  traceId?: string
}

export interface ProgressEmitResult {
  event: WorkflowProgressEvent
}

export interface ProgressListParams {
  sessionId: string
  sinceEventId?: string | null
  limit?: number
  traceId?: string
}

export interface ProgressListResult {
  events: WorkflowProgressEvent[]
  nextCursor: string | null
}

export interface BridgeRuntimeHealthSummary {
  initialized: boolean
  backendKind: "filesystem" | "db"
  projectDir: string | null
  stateDir: string | null
  pgliteDataDir: string | null
  pgliteDatabasePath: string | null
  pgliteDatabaseFileName: string | null
  pgliteSchemaName: string | null
  requestedSessionFound: boolean
  featureName: string | null
  phase: string
  phaseState: string
  bridgeTransport: "stdio" | "unix-socket"
  bridgeSocketPath: string | null
  bridgeAttachedClients: number
  bridgeActiveClientKinds: string[]
  dbAgentLeaseCount: number | null
  dbActiveAgentLeaseCount: number | null
  dbExpiredAgentLeaseCount: number | null
  dbCurrentSessionLeaseCount: number | null
  dbLeaseDiagnosticsError: string | null
  pendingTaskReview: boolean
  currentTaskId: string | null
  lastRecoveryAction: string
  awaitingUserGate: boolean
  nextAction: WorkflowNextActionKind
  shouldContinue: boolean
  requiresAdapterAction: boolean
  stopReason: string | null
  continuationMessage: string | null
  noopReason: string | null
}

export interface StateGetWithRuntimeHealthResult {
  state: Record<string, unknown> | null
  runtimeHealth: BridgeRuntimeHealthSummary | null
}

export interface GuardCheckParams {
  toolName: string
  args?: unknown
  sessionId: string
  traceId?: string
  [key: string]: unknown
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

export interface TaskReviewContextParams {
  sessionId: string
  traceId?: string
}

export interface TaskReviewContextResult {
  prompt: string | null
}

export interface PhaseReviewContextParams {
  sessionId: string
  traceId?: string
}

export interface PhaseReviewContextResult {
  prompt: string | null
}

export interface AutoApproveContextParams {
  sessionId: string
  traceId?: string
}

export interface AutoApproveContextResult {
  prompt: string | null
}

export interface IdleCheckParams {
  sessionId: string
  traceId?: string
}

export interface MessageProcessParams {
  sessionId: string
  parts: Array<{ type: string; text?: string }>
  source?: "user" | "synthetic"
  traceId?: string
}

export interface ToolExecuteParams {
  name: string
  args: Record<string, unknown>
  context: {
    sessionId: string
    directory?: string
    agent?: string
    invocation?: "author" | "isolated-reviewer" | "auto-approver" | "system"
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

/**
 * Structured bridge method error surfaced at the application protocol layer.
 * Numeric code aligns with JSON-RPC / bridge runtime error codes, while message/data
 * carry method-specific details for tests and adapters.
 */
export interface BridgeMethodError {
  code: number
  message: string
  data?: Record<string, unknown>
  retryable?: boolean
}

/** Generic success/error result envelope for bridge protocol methods. */
export type BridgeMethodResult<T> =
  | { success: true; value: T }
  | { success: false; error: BridgeMethodError }

export type LifecycleInitMethodResult = BridgeMethodResult<void>
export type LifecycleSessionMethodResult = BridgeMethodResult<void>
export type LifecycleShutdownMethodResult = BridgeMethodResult<void>
export type StateGetMethodResult = BridgeMethodResult<Record<string, unknown> | StateGetWithRuntimeHealthResult | null>
export type StateHealthMethodResult = BridgeMethodResult<BridgeRuntimeHealthSummary>
export type ProgressEmitMethodResult = BridgeMethodResult<ProgressEmitResult>
export type ProgressListMethodResult = BridgeMethodResult<ProgressListResult>
export type GuardCheckMethodResult = BridgeMethodResult<GuardCheckResult>
export type GuardPolicyMethodResult = BridgeMethodResult<GuardPolicyResult>
export type PromptBuildMethodResult = BridgeMethodResult<string>
export type TaskReviewContextMethodResult = BridgeMethodResult<TaskReviewContextResult>
export type PhaseReviewContextMethodResult = BridgeMethodResult<PhaseReviewContextResult>
export type AutoApproveContextMethodResult = BridgeMethodResult<AutoApproveContextResult>
export type IdleCheckMethodResult = BridgeMethodResult<IdleCheckResult>
export type MessageProcessMethodResult = BridgeMethodResult<MessageProcessResult>
export type ToolExecuteMethodResult = BridgeMethodResult<string | Record<string, unknown>>
export type BridgeDiscoverMethodResult = BridgeMethodResult<BridgeDiscoverResult>
export type BridgeAttachMethodResult = BridgeMethodResult<BridgeAttachRpcResult>
export type BridgeLeaseRefreshMethodResult = BridgeMethodResult<BridgeLeaseRefreshResult>
export type BridgeDetachMethodResult = BridgeMethodResult<BridgeDetachResult>
export type BridgeMetadataGetMethodResult = BridgeMethodResult<BridgeMetadataGetResult>
export type BridgeShutdownEligibilityMethodResult = BridgeMethodResult<BridgeShutdownEligibilityResult>
export type BridgeMetadataUpsertMethodResult = BridgeMethodResult<BridgeMetadataUpsertResult>
export type BridgeLeaseUpsertMethodResult = BridgeMethodResult<BridgeLeaseUpsertResult>
export type BridgeLeaseRemoveMethodResult = BridgeMethodResult<BridgeLeaseRemoveResult>
export type BridgeStateRemoveMethodResult = BridgeMethodResult<BridgeStateRemoveResultRpc>
