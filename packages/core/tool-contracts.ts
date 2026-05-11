/**
 * tool-contracts.ts — shared registry for externally visible Open Artisan tools.
 *
 * This file is the canonical source of truth for adapter exposure and Hermes
 * surface-role classification. Runtime generation/validation layers consume these
 * declarations and must preserve the invariants documented here.
 */

import type { z } from "./schemas"
import {
  AnalyzeTaskBoundaryChangeSchema,
  ApplyDriftRepairToolSchema,
  ApplyPatchSuggestionSchema,
  ApplyTaskBoundaryChangeSchema,
  CheckPriorWorkflowToolSchema,
  GuardedEditSchema,
  GuardedPatchSchema,
  GuardedWriteSchema,
  MarkAnalyzeCompleteToolSchema,
  MarkSatisfiedToolSchema,
  MarkScanCompleteToolSchema,
  MarkTaskCompleteToolSchema,
  PlanDriftRepairToolSchema,
  ProposeDirectApplicationSchema,
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
  StructuralTransitionToolSchema,
  SubmitAutoApproveToolSchema,
  SubmitFeedbackToolSchema,
  SubmitPhaseReviewToolSchema,
  SubmitTaskReviewToolSchema,
} from "./schemas"

/** Adapter families that may consume a tool contract. */
export type ToolAdapterExposure = "bridge" | "mcp" | "opencode"

/** Hermes workflow surface roles derived from the canonical contract registry. */
export type HermesSurfaceRole = "author" | "reviewer" | "control" | "none"

/** Known ToolContract field names for validation/reporting. */
export type ToolContractFieldName = "name" | "description" | "schema" | "workflowGuard" | "exposeTo" | "hermesSurfaceRole" | "mcpName"

/** Structured validation error codes for contract metadata and projection invariants. */
export type ToolContractValidationErrorCode =
  | "missing-hermes-surface-role"
  | "author-surface-requires-mcp-exposure"
  | "mcp-exposed-tool-missing-mcp-name"
  | "duplicate-canonical-name"
  | "duplicate-mcp-name"
  | "invalid-hermes-surface-role"

/**
 * Canonical workflow tool contract.
 *
 * Invariants:
 * - hermesSurfaceRole is always explicit; there is no implicit default.
 * - author-facing Hermes tools must also be exposed to MCP so generation stays
 *   on the existing MCP-derived naming/schema pipeline.
 * - reviewer/control/none roles are excluded from the normal generated Hermes
 *   author-facing artifact.
 */
export interface ToolContract {
  /** Canonical bridge/runtime tool name. */
  name: string
  /** Human-facing description shared across projections. */
  description: string
  /** Canonical runtime input schema. */
  schema: z.ZodType
  /** Whether the workflow guard treats this as a guarded workflow tool. */
  workflowGuard: boolean
  /** Adapter families that may project or dispatch the tool. */
  exposeTo: readonly ToolAdapterExposure[]
  /** Explicit Hermes workflow surface classification. */
  hermesSurfaceRole: HermesSurfaceRole
  /** MCP/Hermes-visible external name when one exists. */
  mcpName?: string
}

/**
 * Structured metadata validation error.
 *
 * The registry is static, so validation failures should surface before runtime
 * generation or adapter registration proceeds.
 */
export interface ToolContractValidationError {
  code: ToolContractValidationErrorCode
  contractName: string
  field: ToolContractFieldName | "registry"
  message: string
}

/** Successful validation result for a canonical registry snapshot. */
export interface ToolContractValidationSuccess {
  success: true
  contracts: readonly ToolContract[]
}

/** Failed validation result for a canonical registry snapshot. */
export interface ToolContractValidationFailure {
  success: false
  errors: readonly ToolContractValidationError[]
}

/** Structured success/error result for contract validation. */
export type ToolContractValidationResult = ToolContractValidationSuccess | ToolContractValidationFailure

/** Configuration for deriving a projected tool surface from the canonical registry. */
export interface ToolContractProjectionConfig {
  adapterExposure: ToolAdapterExposure
  hermesSurfaceRole?: HermesSurfaceRole
}

/** Structured projection error describing why a derived tool surface is invalid. */
export interface ToolContractProjectionError {
  code: "projection-invariant-violation" | "projection-name-collision"
  message: string
  contractName?: string
}

/** Successful result for a derived tool-surface projection. */
export interface ToolContractProjectionSuccess {
  success: true
  contracts: readonly ToolContract[]
  config: ToolContractProjectionConfig
}

/** Failed result for a derived tool-surface projection. */
export interface ToolContractProjectionFailure {
  success: false
  errors: readonly ToolContractProjectionError[]
  config: ToolContractProjectionConfig
}

/** Structured success/error result for derived tool-surface projection. */
export type ToolContractProjectionResult = ToolContractProjectionSuccess | ToolContractProjectionFailure

/**
 * Pure validation contract for canonical registry checking.
 *
 * Implementations must verify explicit role classification, canonical naming,
 * and author-facing MCP exposure invariants before generation proceeds.
 */
export declare function validateToolContracts(
  contracts: readonly ToolContract[],
): ToolContractValidationResult

/**
 * Pure projection contract for deriving adapter-facing tool surfaces from the
 * canonical registry.
 */
export declare function deriveToolContractProjection(
  contracts: readonly ToolContract[],
  config: ToolContractProjectionConfig,
): ToolContractProjectionResult

/** Operational drift signal for generated or declared adapter surfaces. */
export interface ToolContractOperationalDrift {
  kind: "generated-artifact-drift" | "manifest-drift"
  expectedSource: "canonical-registry" | "hermes-author-projection"
  affectedToolNames: readonly string[]
}

/** Metric names emitted for projection/validation observability. */
export type ToolContractProjectionMetricName =
  | "tool-contracts.validation"
  | "tool-contracts.projection"
  | "tool-contracts.drift"

/** Structured metric event for projection/validation observability. */
export interface ToolContractProjectionMetricEvent {
  name: ToolContractProjectionMetricName
  health: ToolContractProjectionHealth
  contractCount: number
  errorCount: number
}

/** Log levels used by projection/validation observability. */
export type ToolContractProjectionLogLevel = "debug" | "info" | "warn" | "error"

/** Structured log event for projection/validation observability. */
export interface ToolContractProjectionLogEvent {
  level: ToolContractProjectionLogLevel
  message: string
  health: ToolContractProjectionHealth
  contractName?: string
  code?: ToolContractValidationErrorCode | ToolContractProjectionError["code"]
}

/** Valid runtime health/configuration states for the Hermes projection pipeline. */
export type ToolContractProjectionHealth = "ready" | "invalid-registry" | "generated-artifact-stale" | "manifest-out-of-sync"

/** Explicitly supported Hermes author-facing projection configuration. */
export const HERMES_AUTHOR_PROJECTION_CONFIG = {
  adapterExposure: "mcp",
  hermesSurfaceRole: "author",
} as const satisfies ToolContractProjectionConfig

export const TOOL_CONTRACTS: readonly ToolContract[] = [
  { name: "check_prior_workflow", description: "Check whether a prior workflow exists for a feature name before selecting mode.", schema: CheckPriorWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_check_prior_workflow" },
  { name: "select_mode", description: "Select the workflow mode and feature name.", schema: SelectModeToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_select_mode" },
  { name: "mark_scan_complete", description: "Mark discovery scanning complete.", schema: MarkScanCompleteToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_mark_scan_complete" },
  { name: "mark_analyze_complete", description: "Mark discovery analysis complete.", schema: MarkAnalyzeCompleteToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_mark_analyze_complete" },
  { name: "mark_satisfied", description: "Submit isolated phase-review criteria assessment for the current artifact.", schema: MarkSatisfiedToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "reviewer", mcpName: "oa_mark_satisfied" },
  { name: "request_review", description: "Submit the current artifact for isolated review.", schema: RequestReviewToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_request_review" },
  { name: "submit_feedback", description: "Approve or request revision of the current artifact at a user gate.", schema: SubmitFeedbackToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_submit_feedback" },
  { name: "scheduling_complete", description: "Resolve a structural SKIP_CHECK, CASCADE_CHECK, or SCHEDULING state by entering active work.", schema: StructuralTransitionToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_scheduling_complete" },
  { name: "phase_skipped", description: "Resolve a structural SKIP_CHECK state by skipping the current phase.", schema: StructuralTransitionToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_phase_skipped" },
  { name: "mark_task_complete", description: "Mark the current implementation DAG task complete and request task review.", schema: MarkTaskCompleteToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_mark_task_complete" },
  { name: "submit_task_review", description: "Submit per-task isolated review results.", schema: SubmitTaskReviewToolSchema, workflowGuard: true, exposeTo: ["bridge"], hermesSurfaceRole: "reviewer" },
  { name: "submit_phase_review", description: "Submit phase-level isolated review results.", schema: SubmitPhaseReviewToolSchema, workflowGuard: false, exposeTo: ["bridge"], hermesSurfaceRole: "reviewer" },
  { name: "submit_auto_approve", description: "Submit auto-approval results for robot-artisan mode.", schema: SubmitAutoApproveToolSchema, workflowGuard: true, exposeTo: ["bridge"], hermesSurfaceRole: "control" },
  { name: "reset_task", description: "Reset implementation DAG tasks to pending for rework.", schema: ResetTaskToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp"], hermesSurfaceRole: "author", mcpName: "oa_reset_task" },
  { name: "resolve_human_gate", description: "Record a real external prerequisite for an implementation DAG task.", schema: ResolveHumanGateToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_resolve_human_gate" },
  { name: "propose_backtrack", description: "Propose returning to an earlier workflow phase when current artifacts cannot be repaired locally.", schema: ProposeBacktrackToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_propose_backtrack" },
  { name: "propose_direct_application", description: "Propose and structurally apply a small safe patch without starting the full workflow.", schema: ProposeDirectApplicationSchema, workflowGuard: true, exposeTo: ["bridge", "mcp"], hermesSurfaceRole: "author", mcpName: "oa_propose_direct_application" },
  { name: "spawn_sub_workflow", description: "Delegate an implementation DAG task to a child workflow.", schema: SpawnSubWorkflowToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "query_parent_workflow", description: "Inspect the parent workflow from a child workflow.", schema: QueryParentWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_query_parent_workflow" },
  { name: "query_child_workflow", description: "Inspect a child workflow delegated from this workflow.", schema: QueryChildWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_query_child_workflow" },
  { name: "analyze_task_boundary_change", description: "Preview a localized implementation DAG task-boundary change.", schema: AnalyzeTaskBoundaryChangeSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_analyze_task_boundary_change" },
  { name: "apply_task_boundary_change", description: "Apply an approved localized implementation DAG task-boundary change.", schema: ApplyTaskBoundaryChangeSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_apply_task_boundary_change" },
  { name: "route_patch_suggestions", description: "Route pending reviewer patch suggestions to apply, defer, backtrack, or ask.", schema: RoutePatchSuggestionsSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_route_patch_suggestions" },
  { name: "resolve_patch_suggestion", description: "Record the disposition of a persisted reviewer patch suggestion.", schema: ResolvePatchSuggestionSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_resolve_patch_suggestion" },
  { name: "apply_patch_suggestion", description: "Apply a persisted reviewer patch suggestion to the worktree.", schema: ApplyPatchSuggestionSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_apply_patch_suggestion" },
  { name: "guarded_edit", description: "Safely edit one file after validating the target path against the active phase policy.", schema: GuardedEditSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "guarded_write", description: "Safely create one file after validating the target path against the active phase policy.", schema: GuardedWriteSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "guarded_patch", description: "Safely apply an OpenCode-style patch after validating every target path against the active phase policy.", schema: GuardedPatchSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "report_drift", description: "Report workflow drift using artifact, task, worktree, DB, and changed-file signals.", schema: ReportDriftToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_report_drift" },
  { name: "plan_drift_repair", description: "Build a graph-native repair plan for reported workflow drift.", schema: PlanDriftRepairToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_plan_drift_repair" },
  { name: "apply_drift_repair", description: "Apply approved drift repair actions through existing workflow tools.", schema: ApplyDriftRepairToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_apply_drift_repair" },
  { name: "roadmap_read", description: "Read the current roadmap document.", schema: StateToolSchema, workflowGuard: false, exposeTo: ["bridge"], hermesSurfaceRole: "none" },
  { name: "roadmap_query", description: "Query roadmap items by id, kind, status, feature name, or priority.", schema: RoadmapQueryToolSchema, workflowGuard: false, exposeTo: ["bridge"], hermesSurfaceRole: "none" },
  { name: "roadmap_derive_execution_slice", description: "Derive a workflow execution slice from roadmap item ids.", schema: RoadmapDeriveExecutionSliceToolSchema, workflowGuard: false, exposeTo: ["bridge"], hermesSurfaceRole: "none" },
  { name: "_state_get", description: "Show the current workflow state.", schema: StateToolSchema, workflowGuard: false, exposeTo: ["mcp"], hermesSurfaceRole: "author", mcpName: "oa_state" },
]

/** All guarded workflow tools regardless of adapter surface. */
export const WORKFLOW_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.workflowGuard)

/** Bridge-dispatchable tool contracts. */
export const BRIDGE_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("bridge"))

/** MCP-exposed tool contracts used by Claude/MCP-compatible consumers. */
export const MCP_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("mcp"))

/** OpenCode-exposed tool contracts. */
export const OPENCODE_TOOL_CONTRACTS = TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("opencode"))

/**
 * Hermes author-facing projection.
 *
 * Invariant: every returned contract is MCP-exposed and explicitly marked as
 * author-facing for the normal generated Hermes workflow tool surface.
 */
export const HERMES_AUTHOR_TOOL_CONTRACTS = MCP_TOOL_CONTRACTS.filter(
  (contract) => contract.hermesSurfaceRole === "author",
)

/** Canonical workflow tool name list used by workflow guards. */
export const WORKFLOW_TOOL_NAME_LIST = WORKFLOW_TOOL_CONTRACTS.map((contract) => contract.name)
