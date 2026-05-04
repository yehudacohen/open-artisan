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

export const AnalyzeTaskBoundaryChangeSchema = z.object({
  task_id: z.string().min(1),
  add_files: z.array(z.string()).optional(),
  remove_files: z.array(z.string()).optional(),
  add_expected_tests: z.array(z.string()).optional(),
  remove_expected_tests: z.array(z.string()).optional(),
  reason: z.string().min(1),
}).strict()

export const ApplyTaskBoundaryChangeSchema = AnalyzeTaskBoundaryChangeSchema.extend({
  expected_impacted_tasks: z.array(z.string()).optional(),
  expected_reset_tasks: z.array(z.string()).optional(),
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

export const ArtifactKeySchema = z.enum(["design", "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation"])
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
}).strict()

export const RequestReviewToolSchema = z.object({
  summary: z.string().min(1),
  artifact_description: z.string().min(1),
  artifact_files: z.array(z.string()),
  artifact_markdown: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.artifact_files.length === 0 && !value.artifact_markdown?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["artifact_files"],
      message: "artifact_files must list at least one file unless artifact_markdown is provided for a markdown phase",
    })
  }
})

export const MarkSatisfiedToolSchema = z.object({
  criteria_met: z.array(z.object({
    criterion: z.string(),
    met: z.boolean(),
    evidence: z.string(),
    severity: z.enum(["blocking", "suggestion"]).optional(),
    score: z.union([z.string(), z.number()]).optional(),
  }).strict()),
}).strict()

export const SubmitFeedbackToolSchema = z.object({
  feedback_type: z.enum(["approve", "revise"]),
  feedback_text: z.string().optional(),
  approved_files: z.array(z.string()).optional(),
  resolved_human_gates: z.array(z.string()).optional(),
}).strict()

export const MarkTaskCompleteToolSchema = z.object({
  task_id: z.string().min(1),
  implementation_summary: z.string(),
  tests_passing: z.boolean(),
}).strict()

export const MarkScanCompleteToolSchema = z.object({ scan_summary: z.string() }).strict()
export const MarkAnalyzeCompleteToolSchema = z.object({ analysis_summary: z.string() }).strict()
export const CheckPriorWorkflowToolSchema = z.object({ feature_name: z.string().min(1) }).strict()

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
export const SubmitTaskReviewToolSchema = z.object({ review_output: z.string().min(1) }).strict()
export const SubmitAutoApproveToolSchema = z.object({ review_output: z.string().min(1) }).strict()
export const ResetTaskToolSchema = z.object({
  task_id: z.string().optional(),
  task_ids: z.array(z.string()).optional(),
  reason: z.string().optional(),
}).strict()
export const StateToolSchema = z.object({}).strict()

export type LifecycleInitParamsFromSchema = z.infer<typeof LifecycleInitParamsSchema>
export type TaskReviewOutput = z.infer<typeof TaskReviewOutputSchema>
export type ReportDriftToolInput = z.infer<typeof ReportDriftToolSchema>
export type PlanDriftRepairToolInput = z.infer<typeof PlanDriftRepairToolSchema>
export type ApplyDriftRepairToolInput = z.infer<typeof ApplyDriftRepairToolSchema>

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}
