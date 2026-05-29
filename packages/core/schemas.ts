/**
 * schemas.ts — Shared Zod schemas for Open Artisan runtime interfaces.
 */

import { z } from "zod"

export { z }

export const OpenArtisanPersistenceKindSchema = z.enum(["filesystem", "db", "pglite"])

export const OpenArtisanPersistenceSchema = z.object({
  kind: OpenArtisanPersistenceKindSchema.optional(),
  pglite: z.object({
    dataDir: z.string().optional(),
    databaseFileName: z.string().optional(),
    schemaName: z.string().optional(),
  }).optional(),
}).strict()

export const BridgeCapabilitiesSchema = z.object({
  selfReview: z.enum(["isolated", "agent-only"]).optional(),
  orchestrator: z.boolean().optional(),
  discoveryFleet: z.boolean().optional(),
}).strict()

export const LifecycleInitParamsSchema = z.object({
  projectDir: z.string().min(1),
  stateDir: z.string().optional(),
  transport: z.enum(["stdio", "unix-socket"]).optional(),
  socketPath: z.string().optional(),
  registerRuntime: z.boolean().optional(),
  persistence: OpenArtisanPersistenceSchema.optional(),
  capabilities: BridgeCapabilitiesSchema.optional(),
  traceId: z.string().optional(),
}).strict()

export const TaskReviewPatchSuggestionSchema = z.object({
  target_path: z.string().min(1),
  summary: z.string().min(1),
  suggested_patch: z.string().min(1),
}).strict()

export const TaskReviewOutputSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  scores: z.object({
    code_quality: z.number(),
    error_handling: z.number(),
  }).partial().optional(),
  patch_suggestions: z.array(TaskReviewPatchSuggestionSchema).default([]),
  reasoning: z.string().default(""),
}).strict()

const AbsoluteFilePathSchema = z.string().min(1).refine((path) => path.startsWith("/"), {
  message: "must be an absolute file path",
})

const NonEmptyTrimmedUserTextSchema = z.string().trim().min(1)

/**
 * Zod contract for the persisted real-world acceptance scenario captured from PLANNING.
 * Mirrors `ScenarioSufficiencyContext` in workflow-state-types.ts.
 */
export const ScenarioSufficiencyContextSchema = z.object({
  scenario: NonEmptyTrimmedUserTextSchema,
  requiredCapabilities: z.array(NonEmptyTrimmedUserTextSchema).min(1),
  acceptanceChecks: z.array(NonEmptyTrimmedUserTextSchema).min(1),
  explicitNonGoals: z.array(NonEmptyTrimmedUserTextSchema),
  sourceArtifactPath: AbsoluteFilePathSchema,
  capturedAtPhase: z.literal("PLANNING"),
}).strict()

export const ScenarioSufficiencyValidationCodeSchema = z.enum([
  "SCENARIO_SECTION_MISSING",
  "SCENARIO_PROSE_MISSING",
  "REQUIRED_CAPABILITIES_MISSING",
  "ACCEPTANCE_CHECKS_MISSING",
  "EXPLICIT_NON_GOALS_MISSING",
  "SOURCE_ARTIFACT_PATH_INVALID",
])

export const ScenarioSufficiencyValidationErrorSchema = z.object({
  code: ScenarioSufficiencyValidationCodeSchema,
  message: z.string().min(1),
  sourceArtifactPath: z.string().min(1),
}).strict()

export const ScenarioSufficiencyParseResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), scenario: ScenarioSufficiencyContextSchema }).strict(),
  z.object({ success: z.literal(false), errors: z.array(ScenarioSufficiencyValidationErrorSchema).min(1) }).strict(),
])

export const ScenarioSufficiencyPromptBlockOptionsSchema = z.object({
  heading: z.string().min(1).optional(),
  includeSourcePath: z.boolean().optional(),
}).strict()

export const ScenarioSufficiencyPromptBlockResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), block: z.string().nullable() }).strict(),
  z.object({ success: z.literal(false), errors: z.array(ScenarioSufficiencyValidationErrorSchema).min(1) }).strict(),
])

export const ScenarioSufficiencyLogEventSchema = z.enum([
  "scenario.section_missing",
  "scenario.validation_failed",
  "scenario.captured",
  "scenario.prompt_block_omitted",
])

export const ScenarioSufficiencyLogEventPayloadSchema = z.object({
  event: ScenarioSufficiencyLogEventSchema,
  sourceArtifactPath: z.string().min(1).optional(),
  errorCodes: z.array(ScenarioSufficiencyValidationCodeSchema).optional(),
  scenarioTextLogged: z.literal(false),
}).strict()

export const ReviewedFileRoleSchema = z.enum(["contract-only", "mixed-contract-module", "executable-implementation"])

export const MixedContractModuleApprovalSchema = z.object({
  filePath: AbsoluteFilePathSchema,
  publicContractSurface: z.array(z.string().min(1)).min(1),
  executableBehaviorInScope: z.array(z.string().min(1)),
  approvedInPlan: z.literal(true),
}).strict()

export const CriterionSeveritySchema = z.enum(["blocking", "suggestion", "design-invariant"])

export const ReviewCriterionDefinitionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  severity: CriterionSeveritySchema,
  qualityDimension: z.string().min(1).optional(),
}).strict()

export const CriterionResultSchema = z.object({
  criterionId: z.string().min(1).optional(),
  criterion_id: z.string().min(1).optional(),
  criterion: z.string().min(1),
  met: z.boolean(),
  evidence: z.string().min(1),
  severity: CriterionSeveritySchema,
  score: z.number().optional(),
}).strict()

export const GitCheckpointSkippedSchema = z.object({
  success: z.literal(true),
  skipped: z.literal(true),
  reason: z.literal("not-a-git-repository"),
  tag: z.null(),
  commitHash: z.null(),
  warnings: z.array(z.string().min(1)).min(1),
}).strict()

export const AnalyzeTaskBoundaryChangeSchema = z.object({
  task_id: z.string().min(1),
  add_files: z.array(AbsoluteFilePathSchema).optional(),
  remove_files: z.array(AbsoluteFilePathSchema).optional(),
  add_expected_tests: z.array(AbsoluteFilePathSchema).optional(),
  remove_expected_tests: z.array(AbsoluteFilePathSchema).optional(),
  reason: z.string().min(1),
}).strict()

export const ApplyTaskBoundaryChangeSchema = AnalyzeTaskBoundaryChangeSchema.extend({
  expected_impacted_tasks: z.array(z.string()),
  expected_reset_tasks: z.array(z.string()),
})

export const RoutePatchSuggestionsSchema = z.object({}).strict()

export const ResolvePatchSuggestionSchema = z.object({
  patch_suggestion_id: z.string().min(1),
  resolution: z.enum(["applied", "failed", "deferred", "rejected", "escalated"]),
  message: z.string().optional(),
  applied_by: z.enum(["agent", "orchestrator", "user"]).optional(),
}).strict()

export const ApplyPatchSuggestionSchema = z.object({
  patch_suggestion_id: z.string().min(1),
  force: z.boolean().optional(),
  applied_by: z.enum(["agent", "orchestrator", "user"]).optional(),
}).strict()

export const GuardedEditSchema = z.object({
  file_path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
}).strict()

export const GuardedWriteSchema = z.object({
  file_path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().optional(),
}).strict()

export const GuardedPatchSchema = z.object({
  patch_text: z.string().min(1),
}).strict()

export const ProposeDirectApplicationSchema = z.object({
  summary: z.string().min(1),
  why_safe: z.string().min(1),
  affected_files: z.array(z.string().min(1)).min(1).max(3),
  patch: z.string().min(1).max(20_000),
  verification_command: z.string().optional(),
}).strict()

export const ArtifactKeySchema = z.enum(["design", "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation"])

export const ChangeProposalRouteSchema = z.enum([
  "current-task-fix",
  "task-boundary-change",
  "planning-allowlist-revision",
  "impl-plan-revision",
  "backtrack",
  "defer-final-review",
  "reject-out-of-scope",
  "ask-user",
])

export const ChangeProposalToolSchema = z.object({
  summary: z.string().min(1),
  why_needed: z.string().min(1),
  affected_files: z.array(z.string().min(1)).optional(),
  failing_command: z.string().min(1).optional(),
  failing_output: z.string().min(1).optional(),
  task_ids: z.array(z.string().min(1)).optional(),
  artifact_keys: z.array(z.string().min(1)).optional(),
}).strict()

export const RequestAllowlistExpansionToolSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
  reason: z.string().min(20),
  source_artifact: ArtifactKeySchema,
}).strict()

export const ApproveCurrentTaskScopeExpansionToolSchema = z.object({
  task_id: z.string().min(1).optional(),
  files: z.array(z.string().min(1)).optional(),
  expected_tests: z.array(z.string().min(1)).optional(),
  cleanup_files: z.array(z.string().min(1)).optional(),
  reason: z.string().min(20),
}).strict()

export const RepairCurrentTaskBoundaryFromImplPlanToolSchema = z.object({
  task_id: z.string().min(1).optional(),
  reason: z.string().min(20),
}).strict()

export const SummarizeWorkflowIncidentToolSchema = z.object({}).strict()

export const ChangeProposalReviewOutputSchema = z.object({
  approved: z.boolean(),
  route: ChangeProposalRouteSchema,
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().min(1),
  required_actions: z.array(z.string().min(1)).default([]),
  allowed_files: z.array(z.string().min(1)).default([]),
  rejected_files: z.array(z.string().min(1)).default([]),
}).strict()

export const TaskDriftReviewOutputSchema = z.object({
  drift_detected: z.boolean(),
  updated_descriptions: z.record(z.string(), z.string()).default({}),
  reasoning: z.string().default(""),
}).strict()

export const OrchestratorAssessOutputSchema = z.object({
  affected_artifacts: z.array(ArtifactKeySchema),
  root_cause_artifact: ArtifactKeySchema,
  reasoning: z.string().default(""),
}).strict()

export const OrchestratorDivergeOutputSchema = z.object({
  classification: z.enum(["tactical", "backtrack", "strategic"]),
  trigger_criterion: z.enum(["scope_expansion", "architectural_shift", "cascade_depth", "accumulated_drift", "upstream_root_cause"]).nullable().optional(),
  reasoning: z.string().default(""),
}).strict()

export const AutoApproveOutputSchema = z.object({
  approve: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().default(""),
  feedback: z.string().optional(),
}).strict()

export const RebuttalReviewOutputSchema = z.object({
  criteria_results: z.array(z.object({
    criterion: z.string().min(1),
    met: z.boolean(),
    evidence: z.string().min(1),
    severity: CriterionSeveritySchema.optional(),
    score: z.number().optional(),
    rebuttal_accepted: z.boolean().optional(),
  }).strict()),
}).strict()

export const IntentComparisonOutputSchema = z.object({
  classification: z.enum(["FULL", "PARTIAL", "DIFFERENT", "ERROR"]),
  explanation: z.string().default(""),
}).strict()

export const DisableOpenArtisanToolSchema = z.object({}).strict()

export const DriftScopeSchema = z.enum(["current-task", "current-phase", "workflow", "roadmap"])
export const DriftRepairStrategySchema = z.enum(["minimal", "safe-auto", "ask-first"])

export const ReportDriftToolSchema = z.object({
  scope: DriftScopeSchema.optional(),
  include_worktree: z.boolean().optional(),
  include_artifacts: z.boolean().optional(),
  include_db: z.boolean().optional(),
  changed_files: z.array(z.string()).optional(),
  drifted_artifact_keys: z.array(ArtifactKeySchema).optional(),
  task_ids: z.array(z.string()).optional(),
}).strict()

export const PlanDriftRepairToolSchema = z.object({
  drift_report_id: z.string().min(1).optional(),
  strategy: DriftRepairStrategySchema.optional(),
}).strict()

export const ApplyDriftRepairToolSchema = z.object({
  repair_plan_id: z.string().min(1),
  approved_actions: z.array(z.string()).optional(),
  apply_safe_actions: z.boolean().optional(),
}).strict()

export const SelectModeToolSchema = z.object({
  mode: z.enum(["GREENFIELD", "REFACTOR", "INCREMENTAL"]),
  feature_name: z.string().min(1),
  roadmap_item_ids: z.array(z.string().min(1)).optional(),
  roadmapItemIds: z.array(z.string().min(1)).optional(),
  execution_slice_id: z.string().min(1).optional(),
  executionSliceId: z.string().min(1).optional(),
}).strict()

export const RequestReviewToolSchema = z.object({
  summary: z.string().min(1),
  artifact_description: z.string().min(1),
  artifact_files: z.array(z.string()).min(1, "artifact_files must list at least one on-disk artifact file"),
  artifact_data_json: z.string().optional(),
}).strict()

export const MarkSatisfiedToolSchema = z.object({
  criteria_met: z.array(z.object({
    criterionId: z.string().min(1).optional(),
    criterion_id: z.string().min(1).optional(),
    criterion: z.string(),
    met: z.boolean(),
    evidence: z.string(),
    severity: z.enum(["blocking", "suggestion", "design-invariant"]).optional(),
    score: z.union([z.string(), z.number()]).optional(),
  }).strict()),
}).strict()

export const SubmitFeedbackToolSchema = z.object({
  feedback_type: z.enum(["approve", "revise"]),
  feedback_text: z.string().optional(),
  approved_files: z.array(z.string()).optional(),
  resolved_human_gates: z.array(z.string()).optional(),
  dry_run: z.boolean().optional(),
}).strict()

export const MarkTaskCompleteToolSchema = z.object({
  task_id: z.string().min(1),
  implementation_summary: z.string(),
  tests_passing: z.boolean(),
}).strict()

export const MarkScanCompleteToolSchema = z.object({ scan_summary: z.string() }).strict()
export const MarkAnalyzeCompleteToolSchema = z.object({ analysis_summary: z.string() }).strict()
export const CheckPriorWorkflowToolSchema = z.object({
  feature_name: z.string().min(1),
  user_intent: z.string().optional(),
}).strict()
export const StructuralTransitionToolSchema = z.object({}).strict()

export const ProposeBacktrackToolSchema = z.object({
  target_phase: z.string().min(1),
  reason: z.string().min(1),
}).strict()

export const ResolveHumanGateToolSchema = z.object({
  task_id: z.string().min(1),
  what_is_needed: z.string().min(1),
  why: z.string().optional(),
  verification_steps: z.string().optional(),
}).strict()

export const SpawnSubWorkflowToolSchema = z.object({
  task_id: z.string().min(1),
  feature_name: z.string().min(1),
}).strict()

export const QueryParentWorkflowToolSchema = z.object({}).strict()
export const QueryChildWorkflowToolSchema = z.object({ task_id: z.string().min(1) }).strict()
export const SubmitTaskReviewToolSchema = z.object({
  review_output: z.string().min(1).optional(),
  passed: z.boolean().optional(),
  issues: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
  code_quality_score: z.union([z.string(), z.number()]).optional(),
  error_handling_score: z.union([z.string(), z.number()]).optional(),
  patch_suggestions: z.array(TaskReviewPatchSuggestionSchema).optional(),
  review_token: z.string().min(1),
}).strict()
export const SubmitPhaseReviewToolSchema = z.object({
  review_output: z.string().optional(),
  satisfied: z.boolean().optional(),
  criteria_results: z.array(CriterionResultSchema.extend({
    score: z.union([z.string(), z.number()]).optional(),
  })).optional(),
  review_stdout: z.string().optional(),
  review_stderr: z.string().optional(),
  review_exit_code: z.number().int().nullable().optional(),
  review_error: z.string().nullable().optional(),
  review_token: z.string().min(1),
}).strict()
export const SubmitTaskReviewResultToolSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
  code_quality_score: z.string().optional(),
  error_handling_score: z.string().optional(),
  patch_suggestions: z.array(TaskReviewPatchSuggestionSchema).optional(),
}).strict()
export const SubmitPhaseReviewResultToolSchema = z.object({
  satisfied: z.boolean(),
  criteria_results: z.array(z.object({
    criterionId: z.string().optional(),
    criterion_id: z.string().optional(),
    criterion: z.string(),
    met: z.boolean(),
    evidence: z.string(),
    severity: z.enum(["blocking", "suggestion", "design-invariant"]).optional(),
    score: z.string().optional(),
  }).strict()),
}).strict()
export const SubmitReviewRubricItemToolSchema = z.object({
  review_token: z.string().min(1).optional(),
  criterion: z.string().min(1),
  status: z.enum(["pending", "passed", "failed", "unknown"]),
  evidence: z.string().optional(),
  severity: z.enum(["blocking", "suggestion", "design-invariant"]).optional(),
  score: z.union([z.string(), z.number()]).optional(),
}).strict()
export const SubmitChangeProposalReviewResultToolSchema = ChangeProposalReviewOutputSchema
export const SubmitTaskDriftReviewResultToolSchema = TaskDriftReviewOutputSchema
export const SubmitOrchestratorAssessResultToolSchema = OrchestratorAssessOutputSchema
export const SubmitOrchestratorDivergeResultToolSchema = OrchestratorDivergeOutputSchema.extend({
  trigger_criterion: z.string().optional(),
})
export const SubmitAutoApproveResultToolSchema = z.object({
  approve: z.boolean(),
  confidence: z.string().min(1),
  reasoning: z.string().optional(),
  feedback: z.string().optional(),
}).strict()
export const SubmitRebuttalReviewResultToolSchema = z.object({
  criteria_results: z.array(z.object({
    criterion: z.string().min(1),
    met: z.boolean(),
    evidence: z.string().min(1),
    severity: z.enum(["blocking", "suggestion", "design-invariant"]).optional(),
    score: z.string().optional(),
    rebuttal_accepted: z.boolean().optional(),
  }).strict()),
}).strict()
export const SubmitIntentComparisonResultToolSchema = IntentComparisonOutputSchema
export const SubmitAutoApproveToolSchema = z.object({
  review_output: z.string().min(1).optional(),
  approve: z.boolean().optional(),
  confidence: z.union([z.string(), z.number()]).optional(),
  reasoning: z.string().optional(),
  feedback: z.string().optional(),
  review_token: z.string().min(1),
}).strict()
export const ResetTaskToolSchema = z.object({
  task_id: z.string().optional(),
  task_ids: z.array(z.string()).optional(),
  reason: z.string().optional(),
}).strict()
export const StateToolSchema = z.object({}).strict()

export const RoadmapFeatureNameSchema = z.string().min(1).refine(
  (value) => !value.includes("..") && !value.includes("/") && !value.includes("\\"),
  { message: "featureName must not contain path traversal or path separators" },
)

export const RoadmapItemKindSchema = z.enum(["feature", "bug", "debt", "chore"])
export const RoadmapItemStatusSchema = z.enum(["todo", "in-progress", "blocked", "done", "dropped"])
export const RoadmapEdgeKindSchema = z.literal("depends-on")

export const RoadmapItemSchema = z.object({
  id: z.string().min(1),
  kind: RoadmapItemKindSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  status: RoadmapItemStatusSchema,
  priority: z.number().finite(),
  featureName: RoadmapFeatureNameSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict()

export const RoadmapEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: RoadmapEdgeKindSchema,
}).strict()

export const RoadmapDocumentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  items: z.array(RoadmapItemSchema),
  edges: z.array(RoadmapEdgeSchema),
}).strict()

export const RoadmapQuerySchema = z.object({
  itemIds: z.array(z.string()).optional(),
  kinds: z.array(RoadmapItemKindSchema).optional(),
  statuses: z.array(RoadmapItemStatusSchema).optional(),
  featureName: RoadmapFeatureNameSchema.optional(),
  minPriority: z.number().optional(),
}).strict()

export const RoadmapQueryToolSchema = z.object({
  query: RoadmapQuerySchema.optional(),
}).strict()

export const ProductManagementAssessRequestToolSchema = z.object({
  request: z.string().trim().min(1),
  roadmap_item_ids: z.array(z.string().min(1)).optional(),
  roadmapItemIds: z.array(z.string().min(1)).optional(),
  feature_name: RoadmapFeatureNameSchema.optional(),
  featureName: RoadmapFeatureNameSchema.optional(),
  include_workflow_candidates: z.boolean().optional(),
  includeWorkflowCandidates: z.boolean().optional(),
}).strict()

export const ProductManagementListWorkToolSchema = z.object({
  roadmap_item_ids: z.array(z.string().min(1)).optional(),
  roadmapItemIds: z.array(z.string().min(1)).optional(),
  lifecycles: z.array(z.enum(["proposed", "active", "frozen", "abandoned"])).optional(),
  statuses: z.array(RoadmapItemStatusSchema).optional(),
  feature_name: RoadmapFeatureNameSchema.optional(),
  featureName: RoadmapFeatureNameSchema.optional(),
  min_priority: z.number().finite().optional(),
  minPriority: z.number().finite().optional(),
  max_candidates: z.number().int().positive().max(100).optional(),
  maxCandidates: z.number().int().positive().max(100).optional(),
}).strict()

export const ProductManagementQueuedItemKindSchema = z.enum(["feature", "bug", "issue", "debt", "chore", "follow-up"])

export const ProductManagementDecisionKindSchema = z.enum([
  "continue-current-workflow",
  "revise-current-artifact",
  "backtrack-current-artifact",
  "request-allowlist-expansion",
  "queue-roadmap-item",
  "propose-roadmap-item",
  "propose-roadmap-edge",
  "freeze-roadmap-node",
  "abandon-roadmap-node",
  "supersede-roadmap-node",
  "reopen-roadmap-node",
  "switch-workflow",
  "ask-user",
])

export const ProductManagementConfidenceSchema = z.enum(["high", "medium", "low"])
export const ProductManagementGateKindSchema = z.enum([
  "user-approval",
  "artifact-review",
  "allowlist-approval",
  "task-review",
  "human-gate",
  "backtrack-approval",
  "roadmap-mutation",
  "workflow-switch",
])
export const ProductManagementWorkStatusSchema = z.enum(["ready", "active", "blocked", "gated", "complete", "dropped", "frozen", "abandoned"])
export const ProductManagementRoadmapNodeLifecycleSchema = z.enum(["proposed", "active", "frozen", "abandoned"])
export const ProductManagementHealthStatusSchema = z.enum(["ready", "degraded", "unavailable"])
export const ProductManagementOperationalSignalSchema = z.enum([
  "generated-contract-drift",
  "invalid-input",
  "missing-roadmap-service",
  "missing-workflow-service",
  "degraded-context",
  "unsafe-switch",
  "queued-item-created",
  "queued-item-proposed",
])
export const ProductManagementMetricNameSchema = z.enum([
  "product-management.assess-request",
  "product-management.list-work",
  "product-management.queue-item",
  "product-management.degraded-context",
  "product-management.unsafe-switch",
])
export const WorkflowPhaseSchema = z.enum([
  "MODE_SELECT",
  "DISCOVERY",
  "PLANNING",
  "INTERFACES",
  "TESTS",
  "IMPL_PLAN",
  "IMPLEMENTATION",
  "DONE",
])
export const WorkflowPhaseStateSchema = z.enum([
  "SCAN",
  "ANALYZE",
  "CONVENTIONS",
  "DRAFT",
  "REVIEW",
  "USER_GATE",
  "ESCAPE_HATCH",
  "REVISE",
  "REDRAFT",
  "SKIP_CHECK",
  "CASCADE_CHECK",
  "SCHEDULING",
  "TASK_REVIEW",
  "TASK_REVISE",
  "HUMAN_GATE",
  "DELEGATED_WAIT",
])

export const ProductManagementRequestContextSchema = z.object({
  request: z.string().trim().min(1),
  currentFeatureName: RoadmapFeatureNameSchema.optional(),
  currentPhase: WorkflowPhaseSchema.optional(),
  currentPhaseState: WorkflowPhaseStateSchema.optional(),
  currentMode: z.enum(["GREENFIELD", "REFACTOR", "INCREMENTAL"]).optional(),
  currentTaskId: z.string().min(1).optional(),
  roadmapItemIds: z.array(z.string().min(1)).optional(),
  executionSliceId: z.string().min(1).optional(),
}).strict()

export const ProductManagementQueueItemSourceSchema = z.object({
  workflowId: z.string().min(1).optional(),
  featureName: RoadmapFeatureNameSchema.optional(),
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  artifactKey: ArtifactKeySchema.optional(),
  artifactPath: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
}).strict()

export const ProductManagementQueueItemToolSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  kind: ProductManagementQueuedItemKindSchema,
  priority: z.number().finite().optional(),
  source: ProductManagementQueueItemSourceSchema.optional(),
  discovered_while: ProductManagementRequestContextSchema.optional(),
  discoveredWhile: ProductManagementRequestContextSchema.optional(),
  suggested_edges: z.array(RoadmapEdgeSchema).optional(),
  suggestedEdges: z.array(RoadmapEdgeSchema).optional(),
}).strict()

export const ProductManagementToolCallSuggestionSchema = z.object({
  toolName: z.string().min(1),
  reason: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const ProductManagementRequiredGateSchema = z.object({
  kind: ProductManagementGateKindSchema,
  reason: z.string().min(1),
  toolName: z.string().min(1).optional(),
}).strict()

export const ProductManagementRejectedAlternativeSchema = z.object({
  decision: ProductManagementDecisionKindSchema,
  reason: z.string().min(1),
}).strict()

export const ProductManagementProvenanceSchema = z.object({
  source: z.enum(["workflow-state", "roadmap", "repository", "artifact", "user-request", "fallback"]),
  reference: z.string().min(1),
}).strict()

export const ProductManagementRoadmapNodeSchema = z.object({
  item: RoadmapItemSchema,
  lifecycle: ProductManagementRoadmapNodeLifecycleSchema,
  reason: z.string().min(1).optional(),
}).strict()

export const ProductManagementRoadmapGraphSchema = z.object({
  nodes: z.array(ProductManagementRoadmapNodeSchema),
  edges: z.array(RoadmapEdgeSchema),
  activeNodeIds: z.array(z.string().min(1)),
  frozenNodeIds: z.array(z.string().min(1)),
  abandonedNodeIds: z.array(z.string().min(1)),
}).strict()

export const ProductManagementRoadmapSummarySchema = z.object({
  graph: ProductManagementRoadmapGraphSchema,
  items: z.array(RoadmapItemSchema),
  edges: z.array(RoadmapEdgeSchema),
  selectedItemIds: z.array(z.string().min(1)),
}).strict()

export const ProductManagementExecutionSliceSummarySchema = z.object({
  executionSliceId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  featureName: RoadmapFeatureNameSchema.optional(),
  roadmapItemIds: z.array(z.string().min(1)),
}).strict()

export const ProductManagementWorkflowSummarySchema = z.object({
  workflowId: z.string().min(1).optional(),
  featureName: RoadmapFeatureNameSchema,
  executionSlice: ProductManagementExecutionSliceSummarySchema.optional(),
  mode: z.enum(["GREENFIELD", "REFACTOR", "INCREMENTAL"]).optional(),
  phase: WorkflowPhaseSchema,
  phaseState: WorkflowPhaseStateSchema,
  roadmapItemIds: z.array(z.string().min(1)),
  currentTaskId: z.string().min(1).optional(),
  unresolvedHumanGateCount: z.number().int().min(0),
  pendingPatchSuggestionCount: z.number().int().min(0),
  activeFileClaims: z.array(z.string().min(1)),
  safeToSwitch: z.boolean(),
  blockedReasons: z.array(z.string().min(1)),
}).strict()

export const ProductManagementDecisionSchema = z.object({
  decision: ProductManagementDecisionKindSchema,
  rationale: z.string().min(1),
  confidence: ProductManagementConfidenceSchema,
  targetFeatureName: RoadmapFeatureNameSchema.optional(),
  targetRoadmapItemIds: z.array(z.string().min(1)).optional(),
  suggestedToolCalls: z.array(ProductManagementToolCallSuggestionSchema),
  requiredGates: z.array(ProductManagementRequiredGateSchema),
  rejectedAlternatives: z.array(ProductManagementRejectedAlternativeSchema),
  provenance: z.array(ProductManagementProvenanceSchema),
  diagnostics: z.array(z.string().min(1)),
}).strict()

export const ProductManagementQueuedRoadmapNodeSchema = z.object({
  node: ProductManagementRoadmapNodeSchema,
  requestedKind: ProductManagementQueuedItemKindSchema,
  persistedKind: RoadmapItemKindSchema,
}).strict()

export const ProductManagementQueueItemResultValueSchema = z.object({
  queuedNode: ProductManagementQueuedRoadmapNodeSchema,
  appliedEdges: z.array(RoadmapEdgeSchema),
  suggestedEdges: z.array(RoadmapEdgeSchema),
  provenance: z.array(ProductManagementProvenanceSchema),
  diagnostics: z.array(z.string().min(1)),
  followUpWorkflowActionRequired: z.boolean(),
  currentWorkflowUnchanged: z.boolean(),
  currentWorkflow: ProductManagementWorkflowSummarySchema.optional(),
}).strict()

export const ProductManagementWorkCandidateSchema = z.object({
  roadmapNode: ProductManagementRoadmapNodeSchema.optional(),
  workflow: ProductManagementWorkflowSummarySchema.optional(),
  status: ProductManagementWorkStatusSchema,
  priority: z.number().finite(),
  safeToStart: z.boolean(),
  reasons: z.array(z.string().min(1)),
}).strict()

export const ProductManagementWorkListSchema = z.object({
  candidates: z.array(ProductManagementWorkCandidateSchema),
  diagnostics: z.array(z.string().min(1)),
}).strict()

export const ProductManagementHealthSchema = z.object({
  status: ProductManagementHealthStatusSchema,
  signals: z.array(ProductManagementOperationalSignalSchema),
  diagnostics: z.array(z.string().min(1)),
}).strict()

export const ProductManagementLogEventPayloadSchema = z.object({
  signal: ProductManagementOperationalSignalSchema,
  status: ProductManagementHealthStatusSchema,
  featureName: RoadmapFeatureNameSchema.optional(),
  roadmapItemIds: z.array(z.string().min(1)).optional(),
  message: z.string().min(1),
  userRequestLogged: z.literal(false),
}).strict()

export const ProductManagementMetricEventSchema = z.object({
  name: ProductManagementMetricNameSchema,
  status: ProductManagementHealthStatusSchema,
  decision: ProductManagementDecisionKindSchema.optional(),
  candidateCount: z.number().int().min(0).optional(),
  requiredGateCount: z.number().int().min(0).optional(),
  queuedItemKind: ProductManagementQueuedItemKindSchema.optional(),
}).strict()

export const ProductManagementErrorSchema = z.object({
  code: z.enum(["invalid-input", "not-found", "storage-failure"]),
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict()

export const ProductManagementAssessRequestResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ProductManagementDecisionSchema }).strict(),
  z.object({ ok: z.literal(false), error: ProductManagementErrorSchema }).strict(),
])

export const ProductManagementListWorkResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ProductManagementWorkListSchema }).strict(),
  z.object({ ok: z.literal(false), error: ProductManagementErrorSchema }).strict(),
])

export const ProductManagementQueueItemResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ProductManagementQueueItemResultValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: ProductManagementErrorSchema }).strict(),
])

export const RoadmapDeriveExecutionSliceToolSchema = z.object({
  roadmap_item_ids: z.array(z.string().min(1)).optional(),
  roadmapItemIds: z.array(z.string().min(1)).optional(),
  feature_name: RoadmapFeatureNameSchema.optional(),
  featureName: RoadmapFeatureNameSchema.optional(),
  execution_slice_id: z.string().min(1).optional(),
  executionSliceId: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  const itemIds = value.roadmap_item_ids ?? value.roadmapItemIds ?? []
  const executionSliceId = value.execution_slice_id ?? value.executionSliceId
  if (itemIds.length === 0 && !executionSliceId) {
    ctx.addIssue({ code: "custom", message: "roadmap item ids or execution slice id is required" })
  }
})

export const RoadmapUpsertItemToolSchema = z.object({
  item: RoadmapItemSchema,
}).strict()

export const RoadmapUpdateItemStatusToolSchema = z.object({
  item_id: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  status: RoadmapItemStatusSchema,
  updated_at: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.item_id && !value.itemId) {
    ctx.addIssue({ code: "custom", message: "item_id or itemId is required" })
  }
})

export const RoadmapDeleteItemToolSchema = z.object({
  item_id: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.item_id && !value.itemId) {
    ctx.addIssue({ code: "custom", message: "item_id or itemId is required" })
  }
})

export const RoadmapUpsertEdgeToolSchema = z.object({
  edge: RoadmapEdgeSchema,
}).strict()

export const RoadmapDeleteEdgeToolSchema = z.object({
  edge: RoadmapEdgeSchema,
}).strict()

export const RoadmapReplaceToolSchema = z.object({
  document: RoadmapDocumentSchema,
}).strict()

export type LifecycleInitParamsFromSchema = z.infer<typeof LifecycleInitParamsSchema>
export type ScenarioSufficiencyContextFromSchema = z.infer<typeof ScenarioSufficiencyContextSchema>
export type ScenarioSufficiencyValidationErrorFromSchema = z.infer<typeof ScenarioSufficiencyValidationErrorSchema>
export type ScenarioSufficiencyParseResultFromSchema = z.infer<typeof ScenarioSufficiencyParseResultSchema>
export type ScenarioSufficiencyPromptBlockOptionsFromSchema = z.infer<typeof ScenarioSufficiencyPromptBlockOptionsSchema>
export type ScenarioSufficiencyPromptBlockResultFromSchema = z.infer<typeof ScenarioSufficiencyPromptBlockResultSchema>
export type ScenarioSufficiencyLogEventPayloadFromSchema = z.infer<typeof ScenarioSufficiencyLogEventPayloadSchema>
export type MixedContractModuleApprovalFromSchema = z.infer<typeof MixedContractModuleApprovalSchema>
export type ReviewCriterionDefinitionFromSchema = z.infer<typeof ReviewCriterionDefinitionSchema>
export type CriterionResultFromSchema = z.infer<typeof CriterionResultSchema>
export type GitCheckpointSkippedFromSchema = z.infer<typeof GitCheckpointSkippedSchema>
export type TaskReviewOutput = z.infer<typeof TaskReviewOutputSchema>
export type ChangeProposalToolInput = z.infer<typeof ChangeProposalToolSchema>
export type ChangeProposalReviewOutput = z.infer<typeof ChangeProposalReviewOutputSchema>
export type TaskDriftReviewOutput = z.infer<typeof TaskDriftReviewOutputSchema>
export type OrchestratorAssessOutput = z.infer<typeof OrchestratorAssessOutputSchema>
export type OrchestratorDivergeOutput = z.infer<typeof OrchestratorDivergeOutputSchema>
export type AutoApproveOutput = z.infer<typeof AutoApproveOutputSchema>
export type RebuttalReviewOutput = z.infer<typeof RebuttalReviewOutputSchema>
export type IntentComparisonOutput = z.infer<typeof IntentComparisonOutputSchema>
export type ApproveCurrentTaskScopeExpansionInput = z.infer<typeof ApproveCurrentTaskScopeExpansionToolSchema>
export type DisableOpenArtisanToolInput = z.infer<typeof DisableOpenArtisanToolSchema>
export type ReportDriftToolInput = z.infer<typeof ReportDriftToolSchema>
export type PlanDriftRepairToolInput = z.infer<typeof PlanDriftRepairToolSchema>
export type ApplyDriftRepairToolInput = z.infer<typeof ApplyDriftRepairToolSchema>
export type RoadmapItemFromSchema = z.infer<typeof RoadmapItemSchema>
export type RoadmapEdgeFromSchema = z.infer<typeof RoadmapEdgeSchema>
export type RoadmapDocumentFromSchema = z.infer<typeof RoadmapDocumentSchema>
export type ProductManagementAssessRequestInput = z.infer<typeof ProductManagementAssessRequestToolSchema>
export type ProductManagementListWorkInput = z.infer<typeof ProductManagementListWorkToolSchema>
export type ProductManagementQueueItemInput = z.infer<typeof ProductManagementQueueItemToolSchema>
export type ProductManagementRoadmapSummaryFromSchema = z.infer<typeof ProductManagementRoadmapSummarySchema>
export type ProductManagementWorkflowSummaryFromSchema = z.infer<typeof ProductManagementWorkflowSummarySchema>
export type ProductManagementDecisionFromSchema = z.infer<typeof ProductManagementDecisionSchema>
export type ProductManagementWorkListFromSchema = z.infer<typeof ProductManagementWorkListSchema>
export type ProductManagementAssessRequestResult = z.infer<typeof ProductManagementAssessRequestResultSchema>
export type ProductManagementListWorkResult = z.infer<typeof ProductManagementListWorkResultSchema>
export type ProductManagementQueueItemResult = z.infer<typeof ProductManagementQueueItemResultSchema>
export type ProductManagementHealthFromSchema = z.infer<typeof ProductManagementHealthSchema>
export type ProductManagementLogEventPayloadFromSchema = z.infer<typeof ProductManagementLogEventPayloadSchema>
export type ProductManagementMetricEventFromSchema = z.infer<typeof ProductManagementMetricEventSchema>
export type RoadmapUpsertItemInput = z.infer<typeof RoadmapUpsertItemToolSchema>
export type RoadmapUpdateItemStatusInput = z.infer<typeof RoadmapUpdateItemStatusToolSchema>
export type RoadmapDeleteItemInput = z.infer<typeof RoadmapDeleteItemToolSchema>
export type RoadmapUpsertEdgeInput = z.infer<typeof RoadmapUpsertEdgeToolSchema>
export type RoadmapDeleteEdgeInput = z.infer<typeof RoadmapDeleteEdgeToolSchema>
export type RoadmapReplaceInput = z.infer<typeof RoadmapReplaceToolSchema>

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}
