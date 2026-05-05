/**
 * tool-contracts.ts — shared registry for externally visible Open Artisan tools.
 */

import type { z } from "./schemas"
import {
  AnalyzeTaskBoundaryChangeSchema,
  ApplyDriftRepairToolSchema,
  ApplyPatchSuggestionSchema,
  ApplyTaskBoundaryChangeSchema,
  CheckPriorWorkflowToolSchema,
  MarkAnalyzeCompleteToolSchema,
  MarkSatisfiedToolSchema,
  MarkScanCompleteToolSchema,
  MarkTaskCompleteToolSchema,
  PlanDriftRepairToolSchema,
  ProposeBacktrackToolSchema,
  QueryChildWorkflowToolSchema,
  QueryParentWorkflowToolSchema,
  RequestReviewToolSchema,
  ReportDriftToolSchema,
  ResetTaskToolSchema,
  ResolveHumanGateToolSchema,
  ResolvePatchSuggestionSchema,
  RoadmapDeriveExecutionSliceToolSchema,
  RoadmapQueryToolSchema,
  RoutePatchSuggestionsSchema,
  SelectModeToolSchema,
  SpawnSubWorkflowToolSchema,
  StateToolSchema,
  SubmitAutoApproveToolSchema,
  SubmitFeedbackToolSchema,
  SubmitPhaseReviewToolSchema,
  SubmitTaskReviewToolSchema,
} from "./schemas"

export type ToolAdapterExposure = "bridge" | "mcp" | "opencode"

export interface ToolContract {
  name: string
  description: string
  schema: z.ZodType
  workflowGuard: boolean
  exposeTo: readonly ToolAdapterExposure[]
  mcpName?: string
}

function toolContract(contract: ToolContract): ToolContract {
  return contract
}

export const TOOL_CONTRACTS = [
  toolContract({ name: "check_prior_workflow", description: "Check whether a prior workflow exists for a feature name before selecting mode.", schema: CheckPriorWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_check_prior_workflow" }),
  toolContract({ name: "select_mode", description: "Select the workflow mode and feature name.", schema: SelectModeToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_select_mode" }),
  toolContract({ name: "mark_scan_complete", description: "Mark discovery scanning complete.", schema: MarkScanCompleteToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_mark_scan_complete" }),
  toolContract({ name: "mark_analyze_complete", description: "Mark discovery analysis complete.", schema: MarkAnalyzeCompleteToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_mark_analyze_complete" }),
  toolContract({ name: "mark_satisfied", description: "Submit self-review criteria assessment for the current artifact.", schema: MarkSatisfiedToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_mark_satisfied" }),
  toolContract({ name: "request_review", description: "Submit the current artifact for isolated review.", schema: RequestReviewToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_request_review" }),
  toolContract({ name: "submit_feedback", description: "Approve or request revision of the current artifact at a user gate.", schema: SubmitFeedbackToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_submit_feedback" }),
  toolContract({ name: "mark_task_complete", description: "Mark the current implementation DAG task complete and request task review.", schema: MarkTaskCompleteToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_mark_task_complete" }),
  toolContract({ name: "submit_task_review", description: "Submit per-task isolated review results.", schema: SubmitTaskReviewToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp"], mcpName: "oa_submit_task_review" }),
  toolContract({ name: "submit_phase_review", description: "Submit phase-level isolated review results.", schema: SubmitPhaseReviewToolSchema, workflowGuard: false, exposeTo: ["bridge"] }),
  toolContract({ name: "submit_auto_approve", description: "Submit auto-approval results for robot-artisan mode.", schema: SubmitAutoApproveToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp"], mcpName: "oa_submit_auto_approve" }),
  toolContract({ name: "reset_task", description: "Reset implementation DAG tasks to pending for rework.", schema: ResetTaskToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp"], mcpName: "oa_reset_task" }),
  toolContract({ name: "resolve_human_gate", description: "Record a real external prerequisite for an implementation DAG task.", schema: ResolveHumanGateToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_resolve_human_gate" }),
  toolContract({ name: "propose_backtrack", description: "Propose returning to an earlier workflow phase when current artifacts cannot be repaired locally.", schema: ProposeBacktrackToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_propose_backtrack" }),
  toolContract({ name: "spawn_sub_workflow", description: "Delegate an implementation DAG task to a child workflow.", schema: SpawnSubWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_spawn_sub_workflow" }),
  toolContract({ name: "query_parent_workflow", description: "Inspect the parent workflow from a child workflow.", schema: QueryParentWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_query_parent_workflow" }),
  toolContract({ name: "query_child_workflow", description: "Inspect a child workflow delegated from this workflow.", schema: QueryChildWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_query_child_workflow" }),
  toolContract({ name: "analyze_task_boundary_change", description: "Preview a localized implementation DAG task-boundary change.", schema: AnalyzeTaskBoundaryChangeSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_analyze_task_boundary_change" }),
  toolContract({ name: "apply_task_boundary_change", description: "Apply an approved localized implementation DAG task-boundary change.", schema: ApplyTaskBoundaryChangeSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_apply_task_boundary_change" }),
  toolContract({ name: "route_patch_suggestions", description: "Route pending reviewer patch suggestions to apply, defer, backtrack, or ask.", schema: RoutePatchSuggestionsSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_route_patch_suggestions" }),
  toolContract({ name: "resolve_patch_suggestion", description: "Record the disposition of a persisted reviewer patch suggestion.", schema: ResolvePatchSuggestionSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_resolve_patch_suggestion" }),
  toolContract({ name: "apply_patch_suggestion", description: "Apply a persisted reviewer patch suggestion to the worktree.", schema: ApplyPatchSuggestionSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_apply_patch_suggestion" }),
  toolContract({ name: "report_drift", description: "Report workflow drift using artifact, task, worktree, DB, and changed-file signals.", schema: ReportDriftToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_report_drift" }),
  toolContract({ name: "plan_drift_repair", description: "Build a graph-native repair plan for reported workflow drift.", schema: PlanDriftRepairToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_plan_drift_repair" }),
  toolContract({ name: "apply_drift_repair", description: "Apply approved drift repair actions through existing workflow tools.", schema: ApplyDriftRepairToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], mcpName: "oa_apply_drift_repair" }),
  toolContract({ name: "roadmap_read", description: "Read the current roadmap document.", schema: StateToolSchema, workflowGuard: false, exposeTo: ["bridge"] }),
  toolContract({ name: "roadmap_query", description: "Query roadmap items by id, kind, status, feature name, or priority.", schema: RoadmapQueryToolSchema, workflowGuard: false, exposeTo: ["bridge"] }),
  toolContract({ name: "roadmap_derive_execution_slice", description: "Derive a workflow execution slice from roadmap item ids.", schema: RoadmapDeriveExecutionSliceToolSchema, workflowGuard: false, exposeTo: ["bridge"] }),
  toolContract({ name: "_state_get", description: "Show the current workflow state.", schema: StateToolSchema, workflowGuard: false, exposeTo: ["mcp"], mcpName: "oa_state" }),
] as const satisfies readonly ToolContract[]

export const WORKFLOW_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.workflowGuard)
export const BRIDGE_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("bridge"))
export const MCP_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("mcp"))
export const OPENCODE_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("opencode"))

export const WORKFLOW_TOOL_NAME_LIST = WORKFLOW_TOOL_CONTRACTS.map((contract) => contract.name)
