/**
 * protocol.ts — Application-level types for bridge JSON-RPC methods.
 *
 * JSON-RPC 2.0 protocol handling is provided by the `json-rpc-2.0` library.
 * This file defines only the method-specific parameter and result types.
 */
import type { Phase, PhaseState, WorkflowMode } from "../core/types"

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
  /**
   * Adapter capabilities — declares which engine features are available.
   * Defaults: all features require SubagentDispatcher (error if not available).
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

export interface StateGetParams {
  sessionId: string
  traceId?: string
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
