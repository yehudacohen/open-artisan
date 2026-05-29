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
  ApproveCurrentTaskScopeExpansionToolSchema,
  ApplyDriftRepairToolSchema,
  ApplyPatchSuggestionSchema,
  ApplyTaskBoundaryChangeSchema,
  ChangeProposalToolSchema,
  CheckPriorWorkflowToolSchema,
  DisableOpenArtisanToolSchema,
  GuardedEditSchema,
  GuardedPatchSchema,
  GuardedWriteSchema,
  SubmitIntentComparisonResultToolSchema,
  MarkAnalyzeCompleteToolSchema,
  MarkSatisfiedToolSchema,
  MarkScanCompleteToolSchema,
  MarkTaskCompleteToolSchema,
  PlanDriftRepairToolSchema,
  ProposeDirectApplicationSchema,
  ProposeBacktrackToolSchema,
  ProductManagementAssessRequestToolSchema,
  ProductManagementListWorkToolSchema,
  ProductManagementQueueItemToolSchema,
  QueryChildWorkflowToolSchema,
  QueryParentWorkflowToolSchema,
  RequestReviewToolSchema,
  RequestAllowlistExpansionToolSchema,
  RepairCurrentTaskBoundaryFromImplPlanToolSchema,
  ReportDriftToolSchema,
  ResetTaskToolSchema,
  ResolveHumanGateToolSchema,
  ResolvePatchSuggestionSchema,
  RoadmapDeleteEdgeToolSchema,
  RoadmapDeleteItemToolSchema,
  RoadmapDeriveExecutionSliceToolSchema,
  RoadmapReplaceToolSchema,
  RoadmapQueryToolSchema,
  RoadmapUpdateItemStatusToolSchema,
  RoadmapUpsertEdgeToolSchema,
  RoadmapUpsertItemToolSchema,
  RoutePatchSuggestionsSchema,
  SelectModeToolSchema,
  SpawnSubWorkflowToolSchema,
  StateToolSchema,
  StructuralTransitionToolSchema,
  SubmitAutoApproveToolSchema,
  SubmitAutoApproveResultToolSchema,
  SubmitChangeProposalReviewResultToolSchema,
  SubmitFeedbackToolSchema,
  SubmitOrchestratorAssessResultToolSchema,
  SubmitOrchestratorDivergeResultToolSchema,
  SubmitPhaseReviewResultToolSchema,
  SubmitPhaseReviewToolSchema,
  SubmitRebuttalReviewResultToolSchema,
  SubmitReviewRubricItemToolSchema,
  SubmitTaskDriftReviewResultToolSchema,
  SubmitTaskReviewResultToolSchema,
  SubmitTaskReviewToolSchema,
  SummarizeWorkflowIncidentToolSchema,
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
export function validateToolContracts(
  contracts: readonly ToolContract[],
): ToolContractValidationResult {
  const errors: ToolContractValidationError[] = []
  const names = new Set<string>()
  const mcpNames = new Set<string>()
  const validRoles: HermesSurfaceRole[] = ["author", "reviewer", "control", "none"]

  for (const contract of contracts) {
    if (names.has(contract.name)) {
      errors.push({
        code: "duplicate-canonical-name",
        contractName: contract.name,
        field: "name",
        message: `Duplicate canonical tool name: ${contract.name}`,
      })
    }
    names.add(contract.name)

    if (!validRoles.includes(contract.hermesSurfaceRole)) {
      errors.push({
        code: "invalid-hermes-surface-role",
        contractName: contract.name,
        field: "hermesSurfaceRole",
        message: `Invalid Hermes surface role for ${contract.name}: ${String(contract.hermesSurfaceRole)}`,
      })
    }

    if (!contract.hermesSurfaceRole) {
      errors.push({
        code: "missing-hermes-surface-role",
        contractName: contract.name,
        field: "hermesSurfaceRole",
        message: `Tool ${contract.name} must declare hermesSurfaceRole explicitly.`,
      })
    }

    if (contract.hermesSurfaceRole === "author" && !contract.exposeTo.includes("mcp")) {
      errors.push({
        code: "author-surface-requires-mcp-exposure",
        contractName: contract.name,
        field: "exposeTo",
        message: `Author-facing Hermes tool ${contract.name} must be exposed to MCP.`,
      })
    }

    if (contract.exposeTo.includes("mcp")) {
      if (!contract.mcpName) {
        errors.push({
          code: "mcp-exposed-tool-missing-mcp-name",
          contractName: contract.name,
          field: "mcpName",
          message: `MCP-exposed tool ${contract.name} must declare mcpName.`,
        })
      } else if (mcpNames.has(contract.mcpName)) {
        errors.push({
          code: "duplicate-mcp-name",
          contractName: contract.name,
          field: "mcpName",
          message: `Duplicate MCP tool name: ${contract.mcpName}`,
        })
      } else {
        mcpNames.add(contract.mcpName)
      }
    }
  }

  return errors.length > 0 ? { success: false, errors } : { success: true, contracts }
}

/** Human-readable validation summary for fail-fast runtime startup errors. */
export function formatToolContractValidationErrors(
  errors: readonly ToolContractValidationError[],
): string {
  return errors
    .map((error) => `${error.code} ${error.contractName}.${error.field}: ${error.message}`)
    .join("\n")
}

/**
 * Runtime assertion for adapter startup. Import-time registry derivation should
 * fail closed instead of exposing a partially invalid workflow tool surface.
 */
export function assertValidToolContracts(
  contracts: readonly ToolContract[],
): readonly ToolContract[] {
  const validation = validateToolContracts(contracts)
  if (!validation.success) {
    throw new Error(
      `Invalid Open Artisan tool contract registry:\n${formatToolContractValidationErrors(validation.errors)}`,
    )
  }
  return validation.contracts
}

/** Structured non-throwing variant for tests, diagnostics, and adapters that need result envelopes. */
export function validateToolContractsForStartup(
  contracts: readonly ToolContract[],
): ToolContractValidationResult {
  return validateToolContracts(contracts)
}

/**
 * Pure projection contract for deriving adapter-facing tool surfaces from the
 * canonical registry.
 */
export function deriveToolContractProjection(
  contracts: readonly ToolContract[],
  config: ToolContractProjectionConfig,
): ToolContractProjectionResult {
  const validation = validateToolContracts(contracts)
  if (!validation.success) {
    return {
      success: false,
      config,
      errors: validation.errors.map((error) => ({
        code: "projection-invariant-violation",
        contractName: error.contractName,
        message: error.message,
      })),
    }
  }

  const projected = validation.contracts.filter((contract) =>
    contract.exposeTo.includes(config.adapterExposure) &&
    (config.hermesSurfaceRole === undefined || contract.hermesSurfaceRole === config.hermesSurfaceRole),
  )

  if (config.adapterExposure === "mcp") {
    const names = new Set<string>()
    const errors: ToolContractProjectionError[] = []
    for (const contract of projected) {
      const name = contract.mcpName ?? `oa_${contract.name}`
      if (names.has(name)) {
        errors.push({
          code: "projection-name-collision",
          contractName: contract.name,
          message: `Projected MCP tool name collision: ${name}`,
        })
      }
      names.add(name)
      if (config.hermesSurfaceRole === "author" && contract.hermesSurfaceRole !== "author") {
        errors.push({
          code: "projection-invariant-violation",
          contractName: contract.name,
          message: `Hermes author projection included non-author tool ${contract.name}.`,
        })
      }
    }
    if (errors.length > 0) return { success: false, errors, config }
  }

  return { success: true, contracts: projected, config }
}

/** Operational drift signal for generated or declared adapter surfaces. */
export interface ToolContractOperationalDrift {
  kind: "generated-artifact-drift" | "manifest-drift"
  expectedSource: "canonical-registry" | "hermes-author-projection"
  affectedToolNames: readonly string[]
}

export type DriftBacktrackAutoSkipBlockReason =
  | "scope-changing backtrack requires explicit artifact updates"
  | "scope expansion requires explicit artifact updates"
  | "blocking drift report requires explicit artifact updates"

export type DriftBacktrackSignal =
  | "artifact-drift"
  | "allowlist-drift"
  | "completed-task-drift"
  | "drift-report"
  | "drift-repair"

export interface DriftBacktrackAutoSkipPolicy {
  signals: readonly DriftBacktrackSignal[]
  blockedReason: DriftBacktrackAutoSkipBlockReason
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
  { name: "submit_review_rubric_item", description: "Persist one isolated reviewer rubric item before the final review result.", schema: SubmitReviewRubricItemToolSchema, workflowGuard: true, exposeTo: ["bridge", "opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_task_review_result", description: "Reviewer-only OpenCode tool for structured per-task isolated review result submission.", schema: SubmitTaskReviewResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_phase_review_result", description: "Reviewer-only OpenCode tool for structured phase isolated review result submission.", schema: SubmitPhaseReviewResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_change_proposal_review_result", description: "Reviewer-only OpenCode tool for structured change-proposal routing submission.", schema: SubmitChangeProposalReviewResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_task_drift_review_result", description: "Reviewer-only OpenCode tool for structured task-drift review submission.", schema: SubmitTaskDriftReviewResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_orchestrator_assess_result", description: "Orchestrator-only OpenCode tool for structured feedback artifact assessment submission.", schema: SubmitOrchestratorAssessResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_orchestrator_diverge_result", description: "Orchestrator-only OpenCode tool for structured feedback divergence submission.", schema: SubmitOrchestratorDivergeResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_auto_approve_result", description: "Auto-approver-only OpenCode tool for structured auto-approval submission.", schema: SubmitAutoApproveResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "control" },
  { name: "submit_rebuttal_review_result", description: "Reviewer-only OpenCode tool for structured rebuttal review submission.", schema: SubmitRebuttalReviewResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_intent_comparison_result", description: "Reviewer-only OpenCode tool for structured prior-workflow intent comparison submission.", schema: SubmitIntentComparisonResultToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "reviewer" },
  { name: "submit_auto_approve", description: "Submit auto-approval results for robot-artisan mode.", schema: SubmitAutoApproveToolSchema, workflowGuard: true, exposeTo: ["bridge"], hermesSurfaceRole: "control" },
  { name: "reset_task", description: "Reset unfinished implementation DAG tasks to pending for rework; completed tasks are immutable and must be corrected by future tasks.", schema: ResetTaskToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp"], hermesSurfaceRole: "author", mcpName: "oa_reset_task" },
  { name: "resolve_human_gate", description: "Record a real external prerequisite for an implementation DAG task.", schema: ResolveHumanGateToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_resolve_human_gate" },
  { name: "propose_backtrack", description: "Propose returning to an earlier workflow phase when current artifacts cannot be repaired locally.", schema: ProposeBacktrackToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_propose_backtrack" },
  { name: "propose_direct_application", description: "Propose and structurally apply a small safe patch without starting the full workflow.", schema: ProposeDirectApplicationSchema, workflowGuard: true, exposeTo: ["bridge", "mcp"], hermesSurfaceRole: "author", mcpName: "oa_propose_direct_application" },
  { name: "spawn_sub_workflow", description: "Delegate an implementation DAG task to a child workflow.", schema: SpawnSubWorkflowToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "query_parent_workflow", description: "Inspect the parent workflow from a child workflow.", schema: QueryParentWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_query_parent_workflow" },
  { name: "query_child_workflow", description: "Inspect a child workflow delegated from this workflow.", schema: QueryChildWorkflowToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_query_child_workflow" },
  { name: "analyze_task_boundary_change", description: "Preview a localized implementation DAG task-boundary change.", schema: AnalyzeTaskBoundaryChangeSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_analyze_task_boundary_change" },
  { name: "apply_task_boundary_change", description: "Apply an approved localized implementation DAG task-boundary change.", schema: ApplyTaskBoundaryChangeSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_apply_task_boundary_change" },
  { name: "approve_current_task_scope_expansion", description: "Approve current-task scope expansion or cleanup deletes; cleanup files do not mutate DAG task ownership.", schema: ApproveCurrentTaskScopeExpansionToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_approve_current_task_scope_expansion" },
  { name: "repair_current_task_boundary_from_impl_plan", description: "Synchronize the active task boundary with the approved IMPL_PLAN task metadata.", schema: RepairCurrentTaskBoundaryFromImplPlanToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_repair_current_task_boundary_from_impl_plan" },
  { name: "route_patch_suggestions", description: "Route pending reviewer patch suggestions to apply, defer, backtrack, or ask.", schema: RoutePatchSuggestionsSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_route_patch_suggestions" },
  { name: "resolve_patch_suggestion", description: "Record the disposition of a persisted reviewer patch suggestion.", schema: ResolvePatchSuggestionSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_resolve_patch_suggestion" },
  { name: "apply_patch_suggestion", description: "Apply a persisted reviewer patch suggestion to the worktree.", schema: ApplyPatchSuggestionSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_apply_patch_suggestion" },
  { name: "propose_change", description: "Ask an isolated reviewer to classify a needed scope, boundary, allowlist, or artifact change before repairing it.", schema: ChangeProposalToolSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "request_allowlist_expansion", description: "Record a typed request for user-approved INCREMENTAL allowlist expansion.", schema: RequestAllowlistExpansionToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_request_allowlist_expansion" },
  { name: "summarize_workflow_incident", description: "Produce a concise maintainer-ready summary of repeated tooling failures and contradictory workflow state.", schema: SummarizeWorkflowIncidentToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_summarize_workflow_incident" },
  { name: "disable_open_artisan", description: "Disable Open Artisan for an opted-in build-mode OpenCode session.", schema: DisableOpenArtisanToolSchema, workflowGuard: false, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "guarded_edit", description: "Safely edit one file after validating the target path against the active phase policy.", schema: GuardedEditSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "guarded_write", description: "Safely create one file after validating the target path against the active phase policy.", schema: GuardedWriteSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "guarded_patch", description: "Safely apply an OpenCode-style patch after validating every target path against the active phase policy.", schema: GuardedPatchSchema, workflowGuard: true, exposeTo: ["opencode"], hermesSurfaceRole: "none" },
  { name: "report_drift", description: "Report workflow drift using artifact, task, worktree, DB, and changed-file signals.", schema: ReportDriftToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_report_drift" },
  { name: "plan_drift_repair", description: "Build a graph-native repair plan for reported workflow drift.", schema: PlanDriftRepairToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_plan_drift_repair" },
  { name: "apply_drift_repair", description: "Apply approved drift repair actions through existing workflow tools.", schema: ApplyDriftRepairToolSchema, workflowGuard: true, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_apply_drift_repair" },
  { name: "product_management_assess_request", description: "Assess whether a request should continue current work, queue product memory, revise/backtrack, request allowlist expansion, switch workflows, or ask the user.", schema: ProductManagementAssessRequestToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_product_management_assess_request" },
  { name: "product_management_list_work", description: "List product-management roadmap and workflow candidates with lifecycle, priority, safety, and degraded-context diagnostics.", schema: ProductManagementListWorkToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_product_management_list_work" },
  { name: "product_management_queue_item", description: "Queue a bug, issue, feature, debt, chore, or follow-up into roadmap product memory without mutating current workflow gates or task state.", schema: ProductManagementQueueItemToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_product_management_queue_item" },
  { name: "roadmap_read", description: "Read the current roadmap document.", schema: StateToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_read" },
  { name: "roadmap_query", description: "Query roadmap items by id, kind, status, feature name, or priority.", schema: RoadmapQueryToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_query" },
  { name: "roadmap_derive_execution_slice", description: "Derive a workflow execution slice from roadmap item ids.", schema: RoadmapDeriveExecutionSliceToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_derive_execution_slice" },
  { name: "roadmap_upsert_item", description: "Create or update one roadmap item without changing workflow phase state.", schema: RoadmapUpsertItemToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_upsert_item" },
  { name: "roadmap_update_item_status", description: "Update one roadmap item's status without implying workflow or task completion.", schema: RoadmapUpdateItemStatusToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_update_item_status" },
  { name: "roadmap_delete_item", description: "Delete one roadmap item and its roadmap-only links without deleting workflows or artifacts.", schema: RoadmapDeleteItemToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_delete_item" },
  { name: "roadmap_upsert_edge", description: "Create or update one roadmap dependency edge.", schema: RoadmapUpsertEdgeToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_upsert_edge" },
  { name: "roadmap_delete_edge", description: "Delete one roadmap dependency edge.", schema: RoadmapDeleteEdgeToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_delete_edge" },
  { name: "roadmap_replace", description: "Replace the standalone roadmap document after full document validation.", schema: RoadmapReplaceToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_replace" },
  { name: "roadmap_delete", description: "Delete the standalone roadmap document without deleting workflow artifacts.", schema: StateToolSchema, workflowGuard: false, exposeTo: ["bridge", "mcp", "opencode"], hermesSurfaceRole: "author", mcpName: "oa_roadmap_delete" },
  { name: "_state_get", description: "Show the current workflow state.", schema: StateToolSchema, workflowGuard: false, exposeTo: ["mcp"], hermesSurfaceRole: "author", mcpName: "oa_state" },
]

const VALIDATED_TOOL_CONTRACTS = assertValidToolContracts(TOOL_CONTRACTS)

/** All guarded workflow tools regardless of adapter surface. */
export const WORKFLOW_TOOL_CONTRACTS = VALIDATED_TOOL_CONTRACTS.filter((contract) => contract.workflowGuard)

/** Bridge-dispatchable tool contracts. */
export const BRIDGE_TOOL_CONTRACTS = VALIDATED_TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("bridge"))

/** MCP-exposed tool contracts used by Claude/MCP-compatible consumers. */
export const MCP_TOOL_CONTRACTS = VALIDATED_TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("mcp"))

/** OpenCode-exposed tool contracts. */
export const OPENCODE_TOOL_CONTRACTS = VALIDATED_TOOL_CONTRACTS.filter((contract) => contract.exposeTo.includes("opencode"))

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
