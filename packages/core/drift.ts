/**
 * drift.ts — Typed drift reporting and graph-native repair planning contracts.
 */

import { createHash } from "node:crypto"

import { createArtifactGraph } from "./artifacts"
import { createImplDAG } from "./dag"
import type { DbPatchSuggestion, DbWorktreeObservation } from "./open-artisan-repository"
import type { RoutedPatchSuggestion } from "./patch-suggestion-routing"
import {
  ApplyPatchSuggestionSchema,
  ApplyTaskBoundaryChangeSchema,
  ProposeBacktrackToolSchema,
  RequestReviewToolSchema,
  ResetTaskToolSchema,
  ResolveHumanGateToolSchema,
  SubmitFeedbackToolSchema,
} from "./schemas"
import type { ArtifactKey, Phase, PhaseState, WorkflowMode, WorkflowState } from "./types"

export type DriftScope = "current-task" | "current-phase" | "workflow" | "roadmap"
export type DriftSeverity = "info" | "warning" | "blocking"
export type DriftOwner = "spec" | "implementation" | "task_dag" | "roadmap" | "user_gate" | "external"
export type DriftFindingKind =
  | "artifact_vs_code"
  | "artifact_vs_db_state"
  | "dag_vs_code"
  | "roadmap_vs_workflow"
  | "allowlist_vs_changes"
  | "review_vs_implementation"
  | "human_gate_vs_reality"
  | "adapter_surface_drift"
  | "generated_or_ambient_worktree"

export type DriftRepairSafety = "safe-auto" | "requires-approval" | "requires-backtrack" | "human-gated" | "blocked"

export type DriftRepairActionKind =
  | "apply_patch_suggestion"
  | "apply_task_boundary_change"
  | "reset_tasks"
  | "revalidate_artifacts"
  | "revise_artifact"
  | "propose_backtrack"
  | "request_user_decision"
  | "resolve_human_gate"

export type DriftWorkflowToolName = "report_drift" | "plan_drift_repair" | "apply_drift_repair"
export const DRIFT_WORKFLOW_TOOL_NAMES: DriftWorkflowToolName[] = ["report_drift", "plan_drift_repair", "apply_drift_repair"]

export type DriftRepairToolName =
  | "apply_patch_suggestion"
  | "apply_task_boundary_change"
  | "reset_task"
  | "request_review"
  | "propose_backtrack"
  | "submit_feedback"
  | "resolve_human_gate"

export interface DriftEvidence {
  filePath?: string
  artifactKey?: ArtifactKey
  taskId?: string
  dbRecordId?: string
  message: string
  metadata?: Record<string, unknown>
}

export interface DriftDependencyImpact {
  artifactKeys: ArtifactKey[]
  dependentArtifactKeys: ArtifactKey[]
  revalidateArtifactKeys: ArtifactKey[]
  artifactReviseTargets: Array<{ artifactKey: ArtifactKey; phase: Phase; phaseState: "REVISE" }>
  taskIds: string[]
  missingTaskIds: string[]
  downstreamTaskIds: string[]
  resetTaskIds: string[]
  inFlightTaskIds: string[]
  completedTaskIds: string[]
  delegatedTaskIds: string[]
  humanGatedTaskIds: string[]
  abortedTaskIds: string[]
  allowlistViolations: string[]
}

export interface DriftToolCallPlan {
  toolName: DriftRepairToolName
  args: Record<string, unknown>
  requiredPhase?: Phase
  requiredPhaseStates?: PhaseState[]
}

export interface DriftRepairAction {
  id: string
  kind: DriftRepairActionKind
  safety: DriftRepairSafety
  reason: string
  impact: DriftDependencyImpact
  evidence: DriftEvidence[]
  toolCall?: DriftToolCallPlan
}

export interface DriftFinding {
  id: string
  kind: DriftFindingKind
  severity: DriftSeverity
  owner: DriftOwner
  summary: string
  expected: string
  actual: string
  evidence: DriftEvidence[]
  impact: DriftDependencyImpact
  proposedActions: DriftRepairAction[]
}

export interface DriftReport {
  id: string
  workflowId: string
  scope: DriftScope
  createdAt: string
  findings: DriftFinding[]
  impact: DriftDependencyImpact
}

export interface DriftRepairPlan {
  id: string
  driftReportId: string
  strategy: "minimal" | "safe-auto" | "ask-first"
  createdAt: string
  actions: DriftRepairAction[]
  impact: DriftDependencyImpact
  requiresUserGate: boolean
  requiresBacktrack: boolean
}

export interface BuildWorkflowDriftReportInput {
  id?: string
  workflowId: string
  createdAt?: string
  state: Pick<WorkflowState, "mode" | "implDag" | "artifactDiskPaths" | "fileAllowlist" | "phase" | "currentTaskId">
  scope?: DriftScope
  artifactKeys?: ArtifactKey[]
  taskIds?: string[]
  changedFiles?: string[]
  worktreeObservations?: DbWorktreeObservation[]
  routedPatchSuggestions?: RoutedPatchSuggestion[]
}

export const EMPTY_DRIFT_IMPACT: DriftDependencyImpact = {
  artifactKeys: [],
  dependentArtifactKeys: [],
  revalidateArtifactKeys: [],
  artifactReviseTargets: [],
  taskIds: [],
  missingTaskIds: [],
  downstreamTaskIds: [],
  resetTaskIds: [],
  inFlightTaskIds: [],
  completedTaskIds: [],
  delegatedTaskIds: [],
  humanGatedTaskIds: [],
  abortedTaskIds: [],
  allowlistViolations: [],
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

function pathMatches(left: string, right: string): boolean {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

function includesPath(paths: string[], targetPath: string): boolean {
  return paths.some((path) => pathMatches(path, targetPath))
}

function patchSuggestionAction(route: RoutedPatchSuggestion, impact: DriftDependencyImpact): DriftRepairAction {
  const suggestion: DbPatchSuggestion = route.suggestion
  if (route.route === "apply-current-task") {
    return {
      id: stableId("drift-action", suggestion.id, "apply_patch_suggestion"),
      kind: "apply_patch_suggestion",
      safety: "safe-auto",
      reason: route.reason,
      impact,
      evidence: [{ filePath: suggestion.targetPath, dbRecordId: suggestion.id, message: suggestion.summary }],
      toolCall: { toolName: "apply_patch_suggestion", args: { patch_suggestion_id: suggestion.id }, requiredPhase: "IMPLEMENTATION", requiredPhaseStates: ["DRAFT", "REVISE", "SCHEDULING"] },
    }
  }

  if (route.route === "backtrack") {
    return {
      id: stableId("drift-action", suggestion.id, "propose_backtrack"),
      kind: "propose_backtrack",
      safety: "requires-backtrack",
      reason: route.reason,
      impact,
      evidence: [{ filePath: suggestion.targetPath, dbRecordId: suggestion.id, message: suggestion.summary }],
    }
  }

  return {
    id: stableId("drift-action", suggestion.id, route.route),
    kind: "request_user_decision",
    safety: "requires-approval",
    reason: route.reason,
    impact,
    evidence: [{ filePath: suggestion.targetPath, dbRecordId: suggestion.id, message: suggestion.summary }],
  }
}

export function mergeDriftImpacts(impacts: DriftDependencyImpact[]): DriftDependencyImpact {
  return {
    artifactKeys: unique(impacts.flatMap((impact) => impact.artifactKeys)),
    dependentArtifactKeys: unique(impacts.flatMap((impact) => impact.dependentArtifactKeys)),
    revalidateArtifactKeys: unique(impacts.flatMap((impact) => impact.revalidateArtifactKeys)),
    artifactReviseTargets: unique(impacts.flatMap((impact) => impact.artifactReviseTargets).map((target) => JSON.stringify(target))).map((target) => JSON.parse(target) as { artifactKey: ArtifactKey; phase: Phase; phaseState: "REVISE" }),
    taskIds: unique(impacts.flatMap((impact) => impact.taskIds)),
    missingTaskIds: unique(impacts.flatMap((impact) => impact.missingTaskIds)),
    downstreamTaskIds: unique(impacts.flatMap((impact) => impact.downstreamTaskIds)),
    resetTaskIds: unique(impacts.flatMap((impact) => impact.resetTaskIds)),
    inFlightTaskIds: unique(impacts.flatMap((impact) => impact.inFlightTaskIds)),
    completedTaskIds: unique(impacts.flatMap((impact) => impact.completedTaskIds)),
    delegatedTaskIds: unique(impacts.flatMap((impact) => impact.delegatedTaskIds)),
    humanGatedTaskIds: unique(impacts.flatMap((impact) => impact.humanGatedTaskIds)),
    abortedTaskIds: unique(impacts.flatMap((impact) => impact.abortedTaskIds)),
    allowlistViolations: unique(impacts.flatMap((impact) => impact.allowlistViolations)),
  }
}

export function computeArtifactDriftImpact(input: {
  artifactKeys: ArtifactKey[]
  mode: WorkflowMode
  hasDesignDoc?: boolean
}): DriftDependencyImpact {
  const graph = createArtifactGraph(input.hasDesignDoc ?? false)
  const artifactKeys = unique(input.artifactKeys)
  const dependentArtifactKeys = unique(artifactKeys.flatMap((artifact) => graph.getDependents(artifact, input.mode)))
  return {
    ...EMPTY_DRIFT_IMPACT,
    artifactKeys,
    dependentArtifactKeys,
    revalidateArtifactKeys: unique([...artifactKeys, ...dependentArtifactKeys]),
    artifactReviseTargets: artifactKeys.map((artifactKey) => ({ artifactKey, ...graph.getReviseTarget(artifactKey) })),
  }
}

export function computeTaskDriftImpact(state: Pick<WorkflowState, "implDag">, taskIds: string[]): DriftDependencyImpact {
  const seeds = unique(taskIds)
  if (seeds.length === 0) return { ...EMPTY_DRIFT_IMPACT }
  if (!state.implDag) return { ...EMPTY_DRIFT_IMPACT, missingTaskIds: seeds }
  const existing = new Set(state.implDag.map((task) => task.id))
  const missingTaskIds = seeds.filter((taskId) => !existing.has(taskId))
  const existingSeeds = seeds.filter((taskId) => existing.has(taskId))
  const dag = createImplDAG(state.implDag)
  const downstreamTaskIds = unique(existingSeeds.flatMap((taskId) => dag.getDependents(taskId).map((task) => task.id)))
  const allImpacted = unique([...existingSeeds, ...downstreamTaskIds])
  const statusMatches = (status: NonNullable<WorkflowState["implDag"]>[number]["status"]) => allImpacted.filter((taskId) => state.implDag?.find((candidate) => candidate.id === taskId)?.status === status)
  const inFlightTaskIds = statusMatches("in-flight")
  const completedTaskIds = statusMatches("complete")
  const delegatedTaskIds = statusMatches("delegated")
  const humanGatedTaskIds = statusMatches("human-gated")
  const abortedTaskIds = statusMatches("aborted")
  const resetTaskIds = allImpacted.filter((taskId) => {
    const task = state.implDag?.find((candidate) => candidate.id === taskId)
    return task?.status === "complete" || task?.status === "in-flight"
  })
  return {
    ...EMPTY_DRIFT_IMPACT,
    taskIds: existingSeeds,
    missingTaskIds,
    downstreamTaskIds,
    resetTaskIds,
    inFlightTaskIds,
    completedTaskIds,
    delegatedTaskIds,
    humanGatedTaskIds,
    abortedTaskIds,
  }
}

function validatedToolCall(toolCall: DriftToolCallPlan | undefined, allowedToolNames: DriftRepairToolName[]): DriftToolCallPlan | null {
  if (!toolCall || !allowedToolNames.includes(toolCall.toolName)) return null
  switch (toolCall.toolName) {
    case "apply_patch_suggestion":
      return ApplyPatchSuggestionSchema.safeParse(toolCall.args).success ? toolCall : null
    case "apply_task_boundary_change":
      return ApplyTaskBoundaryChangeSchema.safeParse(toolCall.args).success ? toolCall : null
    case "reset_task":
      return ResetTaskToolSchema.safeParse(toolCall.args).success ? toolCall : null
    case "request_review":
      return RequestReviewToolSchema.safeParse(toolCall.args).success ? toolCall : null
    case "propose_backtrack":
      return ProposeBacktrackToolSchema.safeParse(toolCall.args).success ? toolCall : null
    case "submit_feedback":
      return SubmitFeedbackToolSchema.safeParse(toolCall.args).success ? toolCall : null
    case "resolve_human_gate":
      return ResolveHumanGateToolSchema.safeParse(toolCall.args).success ? toolCall : null
  }
}

export function buildRepairToolCall(action: DriftRepairAction): DriftToolCallPlan | null {
  switch (action.kind) {
    case "apply_patch_suggestion":
      return validatedToolCall(action.toolCall, ["apply_patch_suggestion"])
    case "apply_task_boundary_change":
      return validatedToolCall(action.toolCall, ["apply_task_boundary_change"])
    case "reset_tasks":
      return {
        toolName: "reset_task",
        args: { task_ids: action.impact.resetTaskIds.length > 0 ? action.impact.resetTaskIds : action.impact.taskIds },
        requiredPhase: "IMPLEMENTATION",
        requiredPhaseStates: ["DRAFT", "REVISE", "SCHEDULING"],
      }
    case "revalidate_artifacts":
      return validatedToolCall(action.toolCall, ["request_review"])
    case "propose_backtrack":
      const target = action.impact.artifactReviseTargets[0]
      return validatedToolCall(action.toolCall, ["propose_backtrack"]) ?? {
        toolName: "propose_backtrack",
        args: { target_phase: target?.phase ?? "PLANNING", reason: action.reason },
      }
    case "resolve_human_gate":
      return validatedToolCall(action.toolCall, ["resolve_human_gate"])
    case "request_user_decision":
      return validatedToolCall(action.toolCall, ["submit_feedback"]) ?? {
        toolName: "submit_feedback",
        args: { feedback_type: "revise", feedback_text: action.reason },
      }
    case "revise_artifact":
      return null
  }
}

export function buildDriftRepairPlan(input: {
  id: string
  driftReport: DriftReport
  strategy: DriftRepairPlan["strategy"]
  createdAt: string
}): DriftRepairPlan {
  const actions = input.driftReport.findings.flatMap((finding) => finding.proposedActions)
  const impact = mergeDriftImpacts([input.driftReport.impact, ...actions.map((action) => action.impact)])
  return {
    id: input.id,
    driftReportId: input.driftReport.id,
    strategy: input.strategy,
    createdAt: input.createdAt,
    actions,
    impact,
    requiresUserGate: actions.some((action) => action.safety === "requires-approval" || action.safety === "human-gated"),
    requiresBacktrack: actions.some((action) => action.safety === "requires-backtrack"),
  }
}

export function buildWorkflowDriftReport(input: BuildWorkflowDriftReportInput): DriftReport {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const mode = input.state.mode ?? "GREENFIELD"
  const findings: DriftFinding[] = []

  const artifactKeys = unique(input.artifactKeys ?? [])
  if (artifactKeys.length > 0) {
    const impact = computeArtifactDriftImpact({ artifactKeys, mode, hasDesignDoc: Boolean(input.state.artifactDiskPaths.design) })
    const action: DriftRepairAction = {
      id: stableId("drift-action", input.workflowId, "artifact", artifactKeys.join(",")),
      kind: "propose_backtrack",
      safety: "requires-backtrack",
      reason: `Artifact drift affects ${impact.revalidateArtifactKeys.join(", ")}.`,
      impact,
      evidence: artifactKeys.map((artifactKey) => ({
        artifactKey,
        ...(input.state.artifactDiskPaths[artifactKey] ? { filePath: input.state.artifactDiskPaths[artifactKey] } : {}),
        message: `${artifactKey} was reported as drifted.`,
      })),
    }
    findings.push({
      id: stableId("drift-finding", input.workflowId, "artifact", artifactKeys.join(",")),
      kind: "artifact_vs_code",
      severity: "blocking",
      owner: "spec",
      summary: `Artifact drift reported for ${artifactKeys.join(", ")}`,
      expected: "Approved artifacts remain aligned with implementation and downstream artifacts.",
      actual: "One or more approved artifacts were reported as drifted.",
      evidence: action.evidence,
      impact,
      proposedActions: [action],
    })
  }

  const taskIds = unique(input.taskIds ?? [])
  if (taskIds.length > 0) {
    const impact = computeTaskDriftImpact({ implDag: input.state.implDag }, taskIds)
    const proposedActions: DriftRepairAction[] = []
    if (impact.resetTaskIds.length > 0) {
      proposedActions.push({
        id: stableId("drift-action", input.workflowId, "reset", impact.resetTaskIds.join(",")),
        kind: "reset_tasks",
        safety: "safe-auto",
        reason: `Reset drifted completed/in-flight task closure: ${impact.resetTaskIds.join(", ")}.`,
        impact,
        evidence: impact.resetTaskIds.map((taskId) => ({ taskId, message: `${taskId} is complete or in-flight and must be reset for repair.` })),
      })
    }
    if (impact.missingTaskIds.length > 0 || impact.delegatedTaskIds.length > 0 || impact.humanGatedTaskIds.length > 0 || impact.abortedTaskIds.length > 0) {
      proposedActions.push({
        id: stableId("drift-action", input.workflowId, "task-decision", taskIds.join(",")),
        kind: "request_user_decision",
        safety: "requires-approval",
        reason: "Task drift includes missing, delegated, human-gated, or aborted tasks and needs an explicit repair decision.",
        impact,
        evidence: [
          ...impact.missingTaskIds.map((taskId) => ({ taskId, message: `${taskId} is not present in the implementation DAG.` })),
          ...impact.delegatedTaskIds.map((taskId) => ({ taskId, message: `${taskId} is delegated to a sub-workflow.` })),
          ...impact.humanGatedTaskIds.map((taskId) => ({ taskId, message: `${taskId} is human-gated.` })),
          ...impact.abortedTaskIds.map((taskId) => ({ taskId, message: `${taskId} is aborted.` })),
        ],
      })
    }
    findings.push({
      id: stableId("drift-finding", input.workflowId, "task", taskIds.join(",")),
      kind: "dag_vs_code",
      severity: proposedActions.some((action) => action.safety !== "safe-auto") ? "blocking" : "warning",
      owner: "task_dag",
      summary: `Task drift reported for ${taskIds.join(", ")}`,
      expected: "Implementation DAG task status and downstream closure remain aligned with code changes.",
      actual: "One or more DAG tasks were reported as drifted.",
      evidence: proposedActions.flatMap((action) => action.evidence),
      impact,
      proposedActions,
    })
  }

  const changedFiles = unique((input.changedFiles ?? []).map(normalizePath).filter(Boolean))
  if (mode === "INCREMENTAL" && changedFiles.length > 0 && input.state.fileAllowlist.length > 0) {
    const allowlistViolations = changedFiles.filter((file) => !includesPath(input.state.fileAllowlist, file))
    if (allowlistViolations.length > 0) {
      const impact: DriftDependencyImpact = { ...EMPTY_DRIFT_IMPACT, allowlistViolations }
      const action: DriftRepairAction = {
        id: stableId("drift-action", input.workflowId, "allowlist", allowlistViolations.join(",")),
        kind: "request_user_decision",
        safety: "requires-approval",
        reason: `Changed files outside the approved allowlist: ${allowlistViolations.join(", ")}.`,
        impact,
        evidence: allowlistViolations.map((filePath) => ({ filePath, message: "File is outside the approved incremental allowlist." })),
      }
      findings.push({
        id: stableId("drift-finding", input.workflowId, "allowlist", allowlistViolations.join(",")),
        kind: "allowlist_vs_changes",
        severity: "blocking",
        owner: "spec",
        summary: "Changed files exceed approved allowlist",
        expected: "INCREMENTAL mode only changes approved files.",
        actual: "One or more changed files are outside the approved allowlist.",
        evidence: action.evidence,
        impact,
        proposedActions: [action],
      })
    }
  }

  for (const route of input.routedPatchSuggestions ?? []) {
    const owner = input.state.implDag?.find((task) => includesPath(task.expectedFiles, route.suggestion.targetPath))
    const impact = owner ? computeTaskDriftImpact({ implDag: input.state.implDag }, [owner.id]) : { ...EMPTY_DRIFT_IMPACT }
    const action = patchSuggestionAction(route, impact)
    findings.push({
      id: stableId("drift-finding", input.workflowId, "patch", route.suggestion.id),
      kind: "review_vs_implementation",
      severity: route.route === "apply-current-task" ? "warning" : "blocking",
      owner: "implementation",
      summary: `Pending patch suggestion ${route.suggestion.id} routes to ${route.route}`,
      expected: "Reviewer patch suggestions are either applied, deferred, backtracked, or escalated explicitly.",
      actual: route.reason,
      evidence: action.evidence,
      impact,
      proposedActions: [action],
    })
  }

  const blockingWorktree = (input.worktreeObservations ?? []).filter((observation) => observation.classification === "parallel-claimed" || observation.classification === "unowned-overlap")
  if (blockingWorktree.length > 0) {
    const impact: DriftDependencyImpact = { ...EMPTY_DRIFT_IMPACT, allowlistViolations: blockingWorktree.map((observation) => observation.path) }
    const action: DriftRepairAction = {
      id: stableId("drift-action", input.workflowId, "worktree", blockingWorktree.map((item) => item.path).join(",")),
      kind: "request_user_decision",
      safety: "requires-approval",
      reason: "Worktree contains parallel-claimed or unowned-overlap changes that need coordination before repair.",
      impact,
      evidence: blockingWorktree.map((observation) => ({ filePath: observation.path, dbRecordId: observation.id, message: `Worktree change classified as ${observation.classification}.` })),
    }
    findings.push({
      id: stableId("drift-finding", input.workflowId, "worktree", blockingWorktree.map((item) => item.path).join(",")),
      kind: "generated_or_ambient_worktree",
      severity: "blocking",
      owner: "implementation",
      summary: "Worktree coordination drift detected",
      expected: "Only task-owned, artifact, generated, or ambient changes are present during repair.",
      actual: "Parallel-claimed or unowned-overlap changes are present.",
      evidence: action.evidence,
      impact,
      proposedActions: [action],
    })
  }

  const impact = mergeDriftImpacts(findings.map((finding) => finding.impact))
  return {
    id: input.id ?? stableId("drift-report", input.workflowId, createdAt, String(findings.length)),
    workflowId: input.workflowId,
    scope: input.scope ?? "workflow",
    createdAt,
    findings,
    impact,
  }
}
