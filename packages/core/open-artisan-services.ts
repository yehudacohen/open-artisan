/**
 * open-artisan-services.ts — Thin service seams over OpenArtisanRepository.
 *
 * These services intentionally delegate to the repository for now. They establish
 * the runtime-facing seams that orchestration, adapter wiring, and DB-backed
 * stores can target without coupling directly to table-level persistence methods.
 */

import type {
  BoundaryChangeInput,
  DbAgentLease,
  DbArtifact,
  DbArtifactApproval,
  DbArtifactRoadmapLink,
  DbArtifactVersion,
  DbExecutionSlice,
  DbFastForwardRecord,
  DbFileClaim,
  DbHumanGate,
  DbPatchApplication,
  DbPatchSuggestion,
  DbPhaseReview,
  DbRecordId,
  DbReviewObservation,
  DbRoadmapEdge,
  DbRoadmapItem,
  DbWorkflowRoadmapLink,
  DbTaskGraph,
  DbTaskReview,
  DbWorkflow,
  DbWorkflowEvent,
  DbWorktreeObservation,
  OpenArtisanDbResult,
  OpenArtisanRepository,
  PatchSuggestionStatus,
} from "./open-artisan-repository"
import type { Phase } from "./types"
import type { RoadmapDocument, RoadmapItemStatus } from "./roadmap-types"

export interface RoadmapService {
  replaceRoadmap(document: RoadmapDocument): Promise<OpenArtisanDbResult<RoadmapDocument>>
  readRoadmap(): Promise<OpenArtisanDbResult<RoadmapDocument | null>>
  deleteRoadmap(): Promise<OpenArtisanDbResult<null>>
  createItem(item: DbRoadmapItem): Promise<OpenArtisanDbResult<DbRoadmapItem>>
  listItems(query?: { featureName?: string; status?: RoadmapItemStatus }): Promise<OpenArtisanDbResult<DbRoadmapItem[]>>
  upsertEdge(edge: DbRoadmapEdge): Promise<OpenArtisanDbResult<DbRoadmapEdge>>
  listEdges(itemId?: DbRecordId): Promise<OpenArtisanDbResult<DbRoadmapEdge[]>>
}

export interface ExecutionSliceService {
  createSlice(slice: DbExecutionSlice, itemIds: DbRecordId[]): ReturnType<OpenArtisanRepository["createExecutionSlice"]>
  getSlice(sliceId: DbRecordId): ReturnType<OpenArtisanRepository["getExecutionSlice"]>
}

export interface WorkflowService {
  createWorkflow(workflow: DbWorkflow): Promise<OpenArtisanDbResult<DbWorkflow>>
  listWorkflows(): Promise<OpenArtisanDbResult<DbWorkflow[]>>
  getWorkflow(workflowId: DbRecordId): ReturnType<OpenArtisanRepository["getWorkflow"]>
  getWorkflowByFeature(featureName: string): ReturnType<OpenArtisanRepository["getWorkflowByFeature"]>
  setPhase(...args: Parameters<OpenArtisanRepository["setWorkflowPhase"]>): ReturnType<OpenArtisanRepository["setWorkflowPhase"]>
  deleteWorkflow(workflowId: DbRecordId): Promise<OpenArtisanDbResult<null>>
  appendEvent(event: DbWorkflowEvent): Promise<OpenArtisanDbResult<DbWorkflowEvent>>
  listEvents(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbWorkflowEvent[]>>
  linkRoadmap(workflowId: DbRecordId, roadmapItemId: DbRecordId): Promise<OpenArtisanDbResult<DbWorkflowRoadmapLink>>
}

export interface ArtifactService {
  upsertArtifact(artifact: DbArtifact): Promise<OpenArtisanDbResult<DbArtifact>>
  recordVersion(version: DbArtifactVersion): Promise<OpenArtisanDbResult<DbArtifactVersion>>
  approve(approval: DbArtifactApproval): Promise<OpenArtisanDbResult<DbArtifactApproval>>
  listVersions(artifactId: DbRecordId): Promise<OpenArtisanDbResult<DbArtifactVersion[]>>
  listApprovals(artifactVersionId: DbRecordId): Promise<OpenArtisanDbResult<DbArtifactApproval[]>>
  linkRoadmap(artifactId: DbRecordId, roadmapItemId: DbRecordId): Promise<OpenArtisanDbResult<DbArtifactRoadmapLink>>
}

export interface TaskGraphService {
  replaceTaskGraph(workflowId: DbRecordId, graph: DbTaskGraph): Promise<OpenArtisanDbResult<DbTaskGraph>>
  getTaskGraph(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbTaskGraph | null>>
  analyzeBoundaryChange(input: BoundaryChangeInput): ReturnType<OpenArtisanRepository["analyzeBoundaryChange"]>
  applyBoundaryChange(input: BoundaryChangeInput): ReturnType<OpenArtisanRepository["applyBoundaryChange"]>
}

export interface ReviewService {
  recordTaskReview(review: DbTaskReview, observations: DbReviewObservation[]): Promise<OpenArtisanDbResult<DbTaskReview>>
  recordPhaseReview(review: DbPhaseReview, observations: DbReviewObservation[]): Promise<OpenArtisanDbResult<DbPhaseReview>>
  listTaskReviews(workflowId: DbRecordId, taskId?: DbRecordId): Promise<OpenArtisanDbResult<DbTaskReview[]>>
  listPhaseReviews(workflowId: DbRecordId, phase?: Phase): Promise<OpenArtisanDbResult<DbPhaseReview[]>>
  listObservations(reviewId: DbRecordId): Promise<OpenArtisanDbResult<DbReviewObservation[]>>
}

export interface PatchSuggestionService {
  recordSuggestion(suggestion: DbPatchSuggestion): Promise<OpenArtisanDbResult<DbPatchSuggestion>>
  updateStatus(suggestionId: DbRecordId, status: PatchSuggestionStatus, updatedAt: string): Promise<OpenArtisanDbResult<DbPatchSuggestion>>
  listSuggestions(workflowId: DbRecordId, status?: PatchSuggestionStatus): Promise<OpenArtisanDbResult<DbPatchSuggestion[]>>
  applySuggestion(application: DbPatchApplication): Promise<OpenArtisanDbResult<DbPatchApplication>>
  listApplications(patchSuggestionId: DbRecordId): Promise<OpenArtisanDbResult<DbPatchApplication[]>>
}

export interface HumanGateService {
  declareGate(gate: DbHumanGate): Promise<OpenArtisanDbResult<DbHumanGate>>
  resolveGate(gateId: DbRecordId, resolvedAt: string): Promise<OpenArtisanDbResult<DbHumanGate>>
  listGates(workflowId: DbRecordId, resolved?: boolean): Promise<OpenArtisanDbResult<DbHumanGate[]>>
}

export interface AgentLeaseService {
  recordLease(lease: DbAgentLease): Promise<OpenArtisanDbResult<DbAgentLease>>
  listLeases(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbAgentLease[]>>
  recordFileClaim(claim: DbFileClaim): Promise<OpenArtisanDbResult<DbFileClaim>>
  listFileClaims(agentLeaseId: DbRecordId): Promise<OpenArtisanDbResult<DbFileClaim[]>>
}

export interface WorktreeObservationService {
  recordObservation(observation: DbWorktreeObservation): Promise<OpenArtisanDbResult<DbWorktreeObservation>>
  listObservations(workflowId: DbRecordId, classification?: DbWorktreeObservation["classification"]): Promise<OpenArtisanDbResult<DbWorktreeObservation[]>>
}

export interface FastForwardService {
  recordFastForward(record: DbFastForwardRecord): Promise<OpenArtisanDbResult<DbFastForwardRecord>>
  listFastForwards(workflowId: DbRecordId): Promise<OpenArtisanDbResult<DbFastForwardRecord[]>>
}

export interface OpenArtisanServices {
  roadmap: RoadmapService
  executionSlices: ExecutionSliceService
  workflow: WorkflowService
  artifacts: ArtifactService
  taskGraph: TaskGraphService
  reviews: ReviewService
  patchSuggestions: PatchSuggestionService
  humanGates: HumanGateService
  agentLeases: AgentLeaseService
  worktreeObservations: WorktreeObservationService
  fastForward: FastForwardService
}

export function createOpenArtisanServices(repository: OpenArtisanRepository): OpenArtisanServices {
  return {
    roadmap: {
      replaceRoadmap: (document) => repository.replaceRoadmap(document),
      readRoadmap: () => repository.readRoadmap(),
      deleteRoadmap: () => repository.deleteRoadmap(),
      createItem: (item) => repository.createRoadmapItem(item),
      listItems: (query) => repository.listRoadmapItems(query),
      upsertEdge: (edge) => repository.upsertRoadmapEdge(edge),
      listEdges: (itemId) => repository.listRoadmapEdges(itemId),
    },
    executionSlices: {
      createSlice: (slice, itemIds) => repository.createExecutionSlice(slice, itemIds),
      getSlice: (sliceId) => repository.getExecutionSlice(sliceId),
    },
    workflow: {
      createWorkflow: (workflow) => repository.createWorkflow(workflow),
      listWorkflows: () => repository.listWorkflows(),
      getWorkflow: (workflowId) => repository.getWorkflow(workflowId),
      getWorkflowByFeature: (featureName) => repository.getWorkflowByFeature(featureName),
      setPhase: (workflowId, phase, phaseState) => repository.setWorkflowPhase(workflowId, phase, phaseState),
      deleteWorkflow: (workflowId) => repository.deleteWorkflow(workflowId),
      appendEvent: (event) => repository.appendWorkflowEvent(event),
      listEvents: (workflowId) => repository.listWorkflowEvents(workflowId),
      linkRoadmap: (workflowId, roadmapItemId) => repository.linkWorkflowToRoadmap(workflowId, roadmapItemId),
    },
    artifacts: {
      upsertArtifact: (artifact) => repository.upsertArtifact(artifact),
      recordVersion: (version) => repository.recordArtifactVersion(version),
      approve: (approval) => repository.approveArtifact(approval),
      listVersions: (artifactId) => repository.listArtifactVersions(artifactId),
      listApprovals: (artifactVersionId) => repository.listArtifactApprovals(artifactVersionId),
      linkRoadmap: (artifactId, roadmapItemId) => repository.linkArtifactToRoadmap(artifactId, roadmapItemId),
    },
    taskGraph: {
      replaceTaskGraph: (workflowId, graph) => repository.replaceTaskGraph(workflowId, graph),
      getTaskGraph: (workflowId) => repository.getTaskGraph(workflowId),
      analyzeBoundaryChange: (input) => repository.analyzeBoundaryChange(input),
      applyBoundaryChange: (input) => repository.applyBoundaryChange(input),
    },
    reviews: {
      recordTaskReview: (review, observations) => repository.recordTaskReview(review, observations),
      recordPhaseReview: (review, observations) => repository.recordPhaseReview(review, observations),
      listTaskReviews: (workflowId, taskId) => repository.listTaskReviews(workflowId, taskId),
      listPhaseReviews: (workflowId, phase) => repository.listPhaseReviews(workflowId, phase),
      listObservations: (reviewId) => repository.listReviewObservations(reviewId),
    },
    patchSuggestions: {
      recordSuggestion: (suggestion) => repository.recordPatchSuggestion(suggestion),
      updateStatus: (suggestionId, status, updatedAt) => repository.updatePatchSuggestionStatus(suggestionId, status, updatedAt),
      listSuggestions: (workflowId, status) => repository.listPatchSuggestions(workflowId, status),
      applySuggestion: (application) => repository.applyPatchSuggestion(application),
      listApplications: (patchSuggestionId) => repository.listPatchApplications(patchSuggestionId),
    },
    humanGates: {
      declareGate: (gate) => repository.declareHumanGate(gate),
      resolveGate: (gateId, resolvedAt) => repository.resolveHumanGate(gateId, resolvedAt),
      listGates: (workflowId, resolved) => repository.listHumanGates(workflowId, resolved),
    },
    agentLeases: {
      recordLease: (lease) => repository.recordAgentLease(lease),
      listLeases: (workflowId) => repository.listAgentLeases(workflowId),
      recordFileClaim: (claim) => repository.recordFileClaim(claim),
      listFileClaims: (agentLeaseId) => repository.listFileClaims(agentLeaseId),
    },
    worktreeObservations: {
      recordObservation: (observation) => repository.recordWorktreeObservation(observation),
      listObservations: (workflowId, classification) => repository.listWorktreeObservations(workflowId, classification),
    },
    fastForward: {
      recordFastForward: (record) => repository.recordFastForward(record),
      listFastForwards: (workflowId) => repository.listFastForwards(workflowId),
    },
  }
}
