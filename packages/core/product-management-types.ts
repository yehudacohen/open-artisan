/**
 * product-management-types.ts — Product-management decision contracts.
 */

import type { Phase, PhaseState, WorkflowMode } from "./workflow-primitives"
import type { RoadmapEdge, RoadmapItem, RoadmapItemKind, RoadmapItemStatus } from "./roadmap-types"
import type {
  AgentLeaseService,
  HumanGateService,
  PatchSuggestionService,
  RoadmapService,
  WorkflowService,
} from "./open-artisan-services"

export type ProductManagementDecisionKind =
  | "continue-current-workflow"
  | "revise-current-artifact"
  | "backtrack-current-artifact"
  | "request-allowlist-expansion"
  | "queue-roadmap-item"
  | "propose-roadmap-item"
  | "propose-roadmap-edge"
  | "freeze-roadmap-node"
  | "abandon-roadmap-node"
  | "supersede-roadmap-node"
  | "reopen-roadmap-node"
  | "switch-workflow"
  | "ask-user"

export type ProductManagementConfidence = "high" | "medium" | "low"

export type ProductManagementGateKind =
  | "user-approval"
  | "artifact-review"
  | "allowlist-approval"
  | "task-review"
  | "human-gate"
  | "backtrack-approval"
  | "roadmap-mutation"
  | "workflow-switch"

export type ProductManagementWorkStatus = "ready" | "active" | "blocked" | "gated" | "complete" | "dropped" | "frozen" | "abandoned"

export type ProductManagementRoadmapNodeLifecycle = "proposed" | "active" | "frozen" | "abandoned"

export type ProductManagementQueuedItemKind = "feature" | "bug" | "issue" | "debt" | "chore" | "follow-up"

export type ProductManagementHealthStatus = "ready" | "degraded" | "unavailable"

export type ProductManagementOperationalSignal =
  | "generated-contract-drift"
  | "invalid-input"
  | "missing-roadmap-service"
  | "missing-workflow-service"
  | "degraded-context"
  | "unsafe-switch"
  | "queued-item-created"
  | "queued-item-proposed"

export type ProductManagementMetricName =
  | "product-management.assess-request"
  | "product-management.list-work"
  | "product-management.queue-item"
  | "product-management.degraded-context"
  | "product-management.unsafe-switch"

export interface ProductManagementToolCallSuggestion {
  toolName: string
  reason: string
  args?: Record<string, unknown>
}

export interface ProductManagementRequiredGate {
  kind: ProductManagementGateKind
  reason: string
  toolName?: string
}

export interface ProductManagementRejectedAlternative {
  decision: ProductManagementDecisionKind
  reason: string
}

export interface ProductManagementProvenance {
  source: "workflow-state" | "roadmap" | "repository" | "artifact" | "user-request" | "fallback"
  reference: string
}

export interface ProductManagementRequestContext {
  request: string
  currentFeatureName?: string
  currentPhase?: Phase
  currentPhaseState?: PhaseState
  currentMode?: WorkflowMode
  currentTaskId?: string
  roadmapItemIds?: string[]
  executionSliceId?: string
}

export interface ProductManagementQueueItemSource {
  workflowId?: string
  featureName?: string
  sessionId?: string
  taskId?: string
  artifactKey?: string
  artifactPath?: string
  messageId?: string
}

export interface ProductManagementQueueItemInput {
  title: string
  description: string
  kind: ProductManagementQueuedItemKind
  priority?: number
  source?: ProductManagementQueueItemSource
  discoveredWhile?: ProductManagementRequestContext
  suggestedEdges?: RoadmapEdge[]
}

export interface ProductManagementQueuedRoadmapNode {
  node: ProductManagementRoadmapNode
  requestedKind: ProductManagementQueuedItemKind
  persistedKind: RoadmapItemKind
}

export interface ProductManagementQueueItemResult {
  queuedNode: ProductManagementQueuedRoadmapNode
  appliedEdges: RoadmapEdge[]
  suggestedEdges: RoadmapEdge[]
  provenance: ProductManagementProvenance[]
  diagnostics: string[]
  followUpWorkflowActionRequired: boolean
  currentWorkflowUnchanged: boolean
  currentWorkflow?: ProductManagementWorkflowSummary
}

export interface ProductManagementRoadmapSummary {
  graph: ProductManagementRoadmapGraph
  items: RoadmapItem[]
  edges: RoadmapEdge[]
  selectedItemIds: string[]
}

export interface ProductManagementRoadmapNode {
  item: RoadmapItem
  lifecycle: ProductManagementRoadmapNodeLifecycle
  reason?: string
}

export interface ProductManagementRoadmapGraph {
  nodes: ProductManagementRoadmapNode[]
  edges: RoadmapEdge[]
  activeNodeIds: string[]
  frozenNodeIds: string[]
  abandonedNodeIds: string[]
}

export interface ProductManagementExecutionSliceSummary {
  executionSliceId?: string
  workflowId?: string
  featureName?: string
  roadmapItemIds: string[]
}

export interface ProductManagementWorkflowSummary {
  workflowId?: string
  featureName: string
  executionSlice?: ProductManagementExecutionSliceSummary
  mode?: WorkflowMode
  phase: Phase
  phaseState: PhaseState
  roadmapItemIds: string[]
  currentTaskId?: string
  unresolvedHumanGateCount: number
  pendingPatchSuggestionCount: number
  activeFileClaims: string[]
  safeToSwitch: boolean
  blockedReasons: string[]
}

export interface ProductManagementDecision {
  decision: ProductManagementDecisionKind
  rationale: string
  confidence: ProductManagementConfidence
  targetFeatureName?: string
  targetRoadmapItemIds?: string[]
  suggestedToolCalls: ProductManagementToolCallSuggestion[]
  requiredGates: ProductManagementRequiredGate[]
  rejectedAlternatives: ProductManagementRejectedAlternative[]
  provenance: ProductManagementProvenance[]
  diagnostics: string[]
}

export interface ProductManagementWorkCandidate {
  roadmapNode?: ProductManagementRoadmapNode
  workflow?: ProductManagementWorkflowSummary
  status: ProductManagementWorkStatus
  priority: number
  safeToStart: boolean
  reasons: string[]
}

export interface ProductManagementWorkList {
  candidates: ProductManagementWorkCandidate[]
  diagnostics: string[]
}

export interface ProductManagementAssessRequestInput {
  request: string
  roadmapItemIds?: string[]
  featureName?: string
  includeWorkflowCandidates?: boolean
}

export interface ProductManagementListWorkInput {
  roadmapItemIds?: string[]
  lifecycles?: ProductManagementRoadmapNodeLifecycle[]
  statuses?: RoadmapItemStatus[]
  featureName?: string
  minPriority?: number
  maxCandidates?: number
}

export interface ProductManagementServiceOptions {
  maxCandidates: number
  includeWorkflowCandidates: boolean
}

export interface ProductManagementServiceDependencies {
  roadmap?: RoadmapService
  workflow?: WorkflowService
  humanGates?: HumanGateService
  patchSuggestions?: PatchSuggestionService
  agentLeases?: AgentLeaseService
  currentWorkflow?: ProductManagementWorkflowSummary
  roadmapContext?: ProductManagementRoadmapSummary
  options?: Partial<ProductManagementServiceOptions>
  emitLog?: (event: ProductManagementLogEventPayload) => void | Promise<void>
  emitMetric?: (event: ProductManagementMetricEvent) => void | Promise<void>
}

export interface ProductManagementService {
  health(): Promise<ProductManagementHealth>
  assessRequest(input: ProductManagementAssessRequestInput): Promise<ProductManagementResult<ProductManagementDecision>>
  listWork(input: ProductManagementListWorkInput): Promise<ProductManagementResult<ProductManagementWorkList>>
  queueItem(input: ProductManagementQueueItemInput): Promise<ProductManagementResult<ProductManagementQueueItemResult>>
}

export interface ProductManagementHealth {
  status: ProductManagementHealthStatus
  signals: ProductManagementOperationalSignal[]
  diagnostics: string[]
}

export interface ProductManagementLogEventPayload {
  signal: ProductManagementOperationalSignal
  status: ProductManagementHealthStatus
  featureName?: string
  roadmapItemIds?: string[]
  message: string
  userRequestLogged: false
}

export interface ProductManagementMetricEvent {
  name: ProductManagementMetricName
  status: ProductManagementHealthStatus
  decision?: ProductManagementDecisionKind
  candidateCount?: number
  requiredGateCount?: number
  queuedItemKind?: ProductManagementQueuedItemKind
}

export type ProductManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: "invalid-input" | "not-found" | "storage-failure"; message: string; retryable: boolean } }
