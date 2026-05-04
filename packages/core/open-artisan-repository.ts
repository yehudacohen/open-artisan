/**
 * open-artisan-repository.ts — Canonical DB-backed workflow runtime contracts.
 *
 * This file defines the repository boundary for the next major Open Artisan
 * runtime. Implementations are expected to be transactional and roadmap-aware.
 * Existing JSON WorkflowState persistence should become an import/export
 * compatibility layer over these records, not the canonical store.
 */

import type { TaskCategory, TaskComplexity, TaskStatus } from "./dag"
import type {
  ArtifactKey,
  Phase,
  PhaseState,
  RoadmapItemKind,
  RoadmapItemStatus,
  RoadmapDocument,
  WorkflowEvent,
  WorkflowMode,
  WorkflowState,
} from "./types"

export type DbRecordId = string
export type IsoTimestamp = string
export type AbsolutePath = string
export type RelativePath = string

export type OpenArtisanDbErrorCode =
  | "not-found"
  | "conflict"
  | "invalid-state"
  | "invalid-input"
  | "schema-mismatch"
  | "storage-failure"
  | "unsupported"

export interface OpenArtisanDbError {
  code: OpenArtisanDbErrorCode
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export type OpenArtisanDbResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OpenArtisanDbError }

export function openArtisanDbOk<T>(value: T): OpenArtisanDbResult<T> {
  return { ok: true, value }
}

export function openArtisanDbError(
  code: OpenArtisanDbErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): OpenArtisanDbResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Roadmap and execution slices
// ---------------------------------------------------------------------------

export interface DbRoadmapItem {
  id: DbRecordId
  kind: RoadmapItemKind
  title: string
  description?: string
  status: RoadmapItemStatus
  priority: number
  featureName?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface DbRoadmapEdge {
  fromItemId: DbRecordId
  toItemId: DbRecordId
  kind: "depends-on"
}

export interface DbExecutionSlice {
  id: DbRecordId
  featureName?: string
  title: string
  status: "draft" | "active" | "complete" | "abandoned"
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface DbExecutionSliceItem {
  sliceId: DbRecordId
  roadmapItemId: DbRecordId
}

// ---------------------------------------------------------------------------
// Workflows and artifacts
// ---------------------------------------------------------------------------

export interface DbWorkflow {
  id: DbRecordId
  featureName: string
  mode: WorkflowMode
  phase: Phase
  phaseState: PhaseState
  executionSliceId?: DbRecordId
  activeAgentId?: DbRecordId
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface DbWorkflowEvent {
  id: DbRecordId
  workflowId: DbRecordId
  event: WorkflowEvent | "repository_import" | "fast_forward" | "patch_applied"
  fromPhase?: Phase
  fromPhaseState?: PhaseState
  toPhase?: Phase
  toPhaseState?: PhaseState
  reason?: string
  createdAt: IsoTimestamp
  metadata?: Record<string, unknown>
}

export interface DbWorkflowRoadmapLink {
  workflowId: DbRecordId
  roadmapItemId: DbRecordId
}

export interface DbArtifact {
  id: DbRecordId
  workflowId: DbRecordId
  artifactKey: ArtifactKey
  currentVersionId?: DbRecordId
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface DbArtifactVersion {
  id: DbRecordId
  artifactId: DbRecordId
  contentHash: string
  diskPath?: AbsolutePath
  summary?: string
  createdAt: IsoTimestamp
}

export interface DbArtifactApproval {
  id: DbRecordId
  artifactVersionId: DbRecordId
  approvedBy: "user" | "auto-approver" | "import"
  reviewId?: DbRecordId
  createdAt: IsoTimestamp
}

export interface DbArtifactRoadmapLink {
  artifactId: DbRecordId
  roadmapItemId: DbRecordId
}

// ---------------------------------------------------------------------------
// Implementation DAG
// ---------------------------------------------------------------------------

export interface DbTask {
  id: DbRecordId
  workflowId: DbRecordId
  taskKey: string
  description: string
  status: TaskStatus
  category: TaskCategory
  complexity: TaskComplexity
  currentAgentLeaseId?: DbRecordId
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface DbTaskDependency {
  workflowId: DbRecordId
  fromTaskId: DbRecordId
  toTaskId: DbRecordId
}

export interface DbTaskOwnedFile {
  taskId: DbRecordId
  path: RelativePath | AbsolutePath
}

export interface DbTaskExpectedTest {
  taskId: DbRecordId
  path: RelativePath | AbsolutePath
}

export interface DbTaskRoadmapLink {
  taskId: DbRecordId
  roadmapItemId: DbRecordId
}

export interface DbTaskGraph {
  tasks: DbTask[]
  dependencies: DbTaskDependency[]
  ownedFiles: DbTaskOwnedFile[]
  expectedTests: DbTaskExpectedTest[]
  roadmapLinks: DbTaskRoadmapLink[]
}

// ---------------------------------------------------------------------------
// Reviews, observations, and patch suggestions
// ---------------------------------------------------------------------------

export type ReviewRecommendation = "pass" | "pass_with_suggestions" | "needs_orchestrator" | "fail"

export interface DbTaskReview {
  id: DbRecordId
  workflowId: DbRecordId
  taskId: DbRecordId
  recommendation: ReviewRecommendation
  passed: boolean
  rawOutput?: string
  createdAt: IsoTimestamp
}

export interface DbPhaseReview {
  id: DbRecordId
  workflowId: DbRecordId
  phase: Phase
  artifactVersionId?: DbRecordId
  recommendation: ReviewRecommendation
  passed: boolean
  rawOutput?: string
  createdAt: IsoTimestamp
}

export type ReviewObservationKind =
  | "blocking_issue"
  | "patch_suggestion"
  | "ownership_observation"
  | "ambient_worktree_observation"
  | "parallel_agent_observation"
  | "quality_score"

export interface DbReviewObservation {
  id: DbRecordId
  reviewId: DbRecordId
  kind: ReviewObservationKind
  severity: "blocking" | "warning" | "info"
  message: string
  filePath?: RelativePath | AbsolutePath
  line?: number
  metadata?: Record<string, unknown>
}

export type PatchSuggestionStatus = "pending" | "applied" | "deferred" | "rejected" | "escalated"

export interface DbPatchSuggestion {
  id: DbRecordId
  workflowId: DbRecordId
  reviewObservationId?: DbRecordId
  taskId?: DbRecordId
  targetPath: RelativePath | AbsolutePath
  summary: string
  suggestedPatch: string
  status: PatchSuggestionStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface DbPatchApplication {
  id: DbRecordId
  patchSuggestionId: DbRecordId
  appliedBy: "orchestrator" | "agent" | "user"
  result: "applied" | "failed"
  message?: string
  createdAt: IsoTimestamp
}

// ---------------------------------------------------------------------------
// Coordination, human gates, worktree observations, fast-forward
// ---------------------------------------------------------------------------

export interface DbAgentLease {
  id: DbRecordId
  workflowId: DbRecordId
  agentKind: "opencode" | "hermes" | "claude" | "reviewer" | "orchestrator" | "other"
  sessionId: string
  taskId?: DbRecordId
  heartbeatAt: IsoTimestamp
  expiresAt: IsoTimestamp
  createdAt: IsoTimestamp
}

export interface DbFileClaim {
  id: DbRecordId
  agentLeaseId: DbRecordId
  path: RelativePath | AbsolutePath
  mode: "read" | "write"
  createdAt: IsoTimestamp
}

export interface DbWorktreeObservation {
  id: DbRecordId
  workflowId: DbRecordId
  path: RelativePath | AbsolutePath
  status: "modified" | "added" | "deleted" | "untracked" | "renamed"
  classification: "task-owned" | "artifact" | "generated" | "ambient" | "parallel-claimed" | "unowned-overlap"
  taskId?: DbRecordId
  agentLeaseId?: DbRecordId
  createdAt: IsoTimestamp
}

export interface DbHumanGate {
  id: DbRecordId
  workflowId: DbRecordId
  taskId: DbRecordId
  whatIsNeeded: string
  why: string
  verificationSteps: string
  resolved: boolean
  resolvedAt?: IsoTimestamp
  createdAt: IsoTimestamp
}

export interface DbFastForwardRecord {
  id: DbRecordId
  workflowId: DbRecordId
  fromPhase: Phase
  fromPhaseState: PhaseState
  toPhase: Phase
  toPhaseState: PhaseState
  reason: string
  patchSuggestionIds: DbRecordId[]
  createdAt: IsoTimestamp
}

// ---------------------------------------------------------------------------
// Repository API
// ---------------------------------------------------------------------------

export interface WorkflowProjection {
  workflow: DbWorkflow
  roadmapItemIds: DbRecordId[]
  artifacts: DbArtifact[]
  taskGraph: DbTaskGraph | null
  unresolvedHumanGates: DbHumanGate[]
  pendingPatchSuggestions: DbPatchSuggestion[]
}

export interface BoundaryChangeInput {
  workflowId: DbRecordId
  taskId: DbRecordId
  addFiles?: Array<RelativePath | AbsolutePath>
  removeFiles?: Array<RelativePath | AbsolutePath>
  addExpectedTests?: Array<RelativePath | AbsolutePath>
  removeExpectedTests?: Array<RelativePath | AbsolutePath>
  reason: string
}

export interface BoundaryChangeAnalysis {
  taskId: DbRecordId
  impactedTaskIds: DbRecordId[]
  completedTaskIdsToReset: DbRecordId[]
  ownershipConflicts: string[]
  allowlistViolations: Array<RelativePath | AbsolutePath>
  message: string
}

export interface JsonWorkflowImportResult {
  workflowId: DbRecordId
  featureName: string
  warnings: string[]
}

export interface OpenArtisanRepository {
  initialize(): Promise<OpenArtisanDbResult<null>>
  dispose(): Promise<void>
  transaction<T>(run: (repo: OpenArtisanRepository) => Promise<OpenArtisanDbResult<T>>): Promise<OpenArtisanDbResult<T>>

  createRoadmapItem(item: DbRoadmapItem): Promise<OpenArtisanDbResult<DbRoadmapItem>>
  replaceRoadmap(document: RoadmapDocument): Promise<OpenArtisanDbResult<RoadmapDocument>>
  readRoadmap(): Promise<OpenArtisanDbResult<RoadmapDocument | null>>
  deleteRoadmap(): Promise<OpenArtisanDbResult<null>>
  listRoadmapItems(query?: { featureName?: string; status?: RoadmapItemStatus }): Promise<OpenArtisanDbResult<DbRoadmapItem[]>>
  upsertRoadmapEdge(edge: DbRoadmapEdge): Promise<OpenArtisanDbResult<DbRoadmapEdge>>
  listRoadmapEdges(itemId?: DbRecordId): Promise<OpenArtisanDbResult<DbRoadmapEdge[]>>
  createExecutionSlice(slice: DbExecutionSlice, itemIds: DbRecordId[]): Promise<OpenArtisanDbResult<DbExecutionSlice>>
  getExecutionSlice(sliceId: DbRecordId): Promise<OpenArtisanDbResult<{ slice: DbExecutionSlice; itemIds: DbRecordId[] } | null>>

  createWorkflow(workflow: DbWorkflow): Promise<OpenArtisanDbResult<DbWorkflow>>
  listWorkflows(): Promise<OpenArtisanDbResult<DbWorkflow[]>>
  getWorkflow(workflowId: DbRecordId): Promise<OpenArtisanDbResult<WorkflowProjection | null>>
  getWorkflowByFeature(featureName: string): Promise<OpenArtisanDbResult<WorkflowProjection | null>>
  setWorkflowPhase(workflowId: DbRecordId, phase: Phase, phaseState: PhaseState): Promise<OpenArtisanDbResult<DbWorkflow>>
  deleteWorkflow(workflowId: DbRecordId): Promise<OpenArtisanDbResult<null>>
  appendWorkflowEvent(event: DbWorkflowEvent): Promise<OpenArtisanDbResult<DbWorkflowEvent>>
  listWorkflowEvents(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbWorkflowEvent[]>>
  linkWorkflowToRoadmap(workflowId: DbRecordId, roadmapItemId: DbRecordId): Promise<OpenArtisanDbResult<DbWorkflowRoadmapLink>>

  upsertArtifact(artifact: DbArtifact): Promise<OpenArtisanDbResult<DbArtifact>>
  recordArtifactVersion(version: DbArtifactVersion): Promise<OpenArtisanDbResult<DbArtifactVersion>>
  approveArtifact(approval: DbArtifactApproval): Promise<OpenArtisanDbResult<DbArtifactApproval>>
  listArtifactVersions(artifactId: DbRecordId): Promise<OpenArtisanDbResult<DbArtifactVersion[]>>
  listArtifactApprovals(artifactVersionId: DbRecordId): Promise<OpenArtisanDbResult<DbArtifactApproval[]>>
  linkArtifactToRoadmap(artifactId: DbRecordId, roadmapItemId: DbRecordId): Promise<OpenArtisanDbResult<DbArtifactRoadmapLink>>

  replaceTaskGraph(workflowId: DbRecordId, graph: DbTaskGraph): Promise<OpenArtisanDbResult<DbTaskGraph>>
  getTaskGraph(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbTaskGraph | null>>
  claimTask(workflowId: DbRecordId, taskId: DbRecordId, lease: DbAgentLease): Promise<OpenArtisanDbResult<DbAgentLease>>
  updateTaskStatus(taskId: DbRecordId, status: TaskStatus): Promise<OpenArtisanDbResult<DbTask>>
  analyzeBoundaryChange(input: BoundaryChangeInput): Promise<OpenArtisanDbResult<BoundaryChangeAnalysis>>
  applyBoundaryChange(input: BoundaryChangeInput): Promise<OpenArtisanDbResult<BoundaryChangeAnalysis>>

  recordTaskReview(review: DbTaskReview, observations: DbReviewObservation[]): Promise<OpenArtisanDbResult<DbTaskReview>>
  recordPhaseReview(review: DbPhaseReview, observations: DbReviewObservation[]): Promise<OpenArtisanDbResult<DbPhaseReview>>
  listTaskReviews(workflowId: DbRecordId, taskId?: DbRecordId): Promise<OpenArtisanDbResult<DbTaskReview[]>>
  listPhaseReviews(workflowId: DbRecordId, phase?: Phase): Promise<OpenArtisanDbResult<DbPhaseReview[]>>
  listReviewObservations(reviewId: DbRecordId): Promise<OpenArtisanDbResult<DbReviewObservation[]>>
  recordPatchSuggestion(suggestion: DbPatchSuggestion): Promise<OpenArtisanDbResult<DbPatchSuggestion>>
  updatePatchSuggestionStatus(patchSuggestionId: DbRecordId, status: PatchSuggestionStatus, updatedAt: IsoTimestamp): Promise<OpenArtisanDbResult<DbPatchSuggestion>>
  listPatchSuggestions(workflowId: DbRecordId, status?: PatchSuggestionStatus): Promise<OpenArtisanDbResult<DbPatchSuggestion[]>>
  applyPatchSuggestion(application: DbPatchApplication): Promise<OpenArtisanDbResult<DbPatchApplication>>
  listPatchApplications(patchSuggestionId: DbRecordId): Promise<OpenArtisanDbResult<DbPatchApplication[]>>

  declareHumanGate(gate: DbHumanGate): Promise<OpenArtisanDbResult<DbHumanGate>>
  resolveHumanGate(gateId: DbRecordId, resolvedAt: IsoTimestamp): Promise<OpenArtisanDbResult<DbHumanGate>>
  listHumanGates(workflowId: DbRecordId, resolved?: boolean): Promise<OpenArtisanDbResult<DbHumanGate[]>>

  recordAgentLease(lease: DbAgentLease): Promise<OpenArtisanDbResult<DbAgentLease>>
  listAgentLeases(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbAgentLease[]>>
  recordFileClaim(claim: DbFileClaim): Promise<OpenArtisanDbResult<DbFileClaim>>
  listFileClaims(agentLeaseId: DbRecordId): Promise<OpenArtisanDbResult<DbFileClaim[]>>
  recordWorktreeObservation(observation: DbWorktreeObservation): Promise<OpenArtisanDbResult<DbWorktreeObservation>>
  listWorktreeObservations(workflowId: DbRecordId, classification?: DbWorktreeObservation["classification"]): Promise<OpenArtisanDbResult<DbWorktreeObservation[]>>
  recordFastForward(record: DbFastForwardRecord): Promise<OpenArtisanDbResult<DbFastForwardRecord>>
  listFastForwards(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbFastForwardRecord[]>>

  importWorkflowState(state: WorkflowState): Promise<OpenArtisanDbResult<JsonWorkflowImportResult>>
  exportWorkflowState(workflowId: DbRecordId): Promise<OpenArtisanDbResult<WorkflowState>>
}
