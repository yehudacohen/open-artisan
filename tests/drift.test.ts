import { describe, expect, it } from "bun:test"

import {
  buildDriftRepairPlan,
  buildRepairToolCall,
  buildWorkflowDriftReport,
  computeArtifactDriftImpact,
  computeTaskDriftImpact,
  DRIFT_WORKFLOW_TOOL_NAMES,
  EMPTY_DRIFT_IMPACT,
  mergeDriftImpacts,
  type DriftReport,
  type DriftRepairAction,
} from "#core/drift"
import { WORKFLOW_TOOL_NAMES } from "#core/constants"
import { ApplyDriftRepairToolSchema, PlanDriftRepairToolSchema, ReportDriftToolSchema, toJsonSchema } from "#core/schemas"
import type { WorkflowState } from "#core/workflow-state-types"
import type { ArtifactKey, Phase } from "#core/workflow-primitives"

function stateWithDag(tasks: NonNullable<WorkflowState["implDag"]>): Pick<WorkflowState, "implDag"> {
  return { implDag: tasks }
}

describe("drift impact interfaces", () => {
  it("keeps drift tool names registered as callable workflow tools", () => {
    for (const toolName of DRIFT_WORKFLOW_TOOL_NAMES) {
      expect(WORKFLOW_TOOL_NAMES.has(toolName)).toBe(true)
    }
  })

  it("walks every artifact through the canonical dependency graph", () => {
    const cases: Array<{ artifact: ArtifactKey; targetPhase: Phase; dependents: ArtifactKey[] }> = [
      { artifact: "conventions", targetPhase: "DISCOVERY", dependents: ["plan", "interfaces", "tests", "impl_plan", "implementation"] },
      { artifact: "plan", targetPhase: "PLANNING", dependents: ["interfaces", "tests", "impl_plan", "implementation"] },
      { artifact: "interfaces", targetPhase: "INTERFACES", dependents: ["tests", "impl_plan", "implementation"] },
      { artifact: "tests", targetPhase: "TESTS", dependents: ["impl_plan", "implementation"] },
      { artifact: "impl_plan", targetPhase: "IMPL_PLAN", dependents: ["implementation"] },
      { artifact: "implementation", targetPhase: "IMPLEMENTATION", dependents: [] },
    ]

    for (const item of cases) {
      const impact = computeArtifactDriftImpact({ artifactKeys: [item.artifact], mode: "INCREMENTAL" })
      expect(impact.dependentArtifactKeys).toEqual(item.dependents)
      expect(impact.artifactReviseTargets).toEqual([{ artifactKey: item.artifact, phase: item.targetPhase, phaseState: "REVISE" }])
      expect(impact.revalidateArtifactKeys).toEqual([item.artifact, ...item.dependents])
    }
  })

  it("routes design drift to planning and walks the design-dependent closure", () => {
    const impact = computeArtifactDriftImpact({ artifactKeys: ["design"], mode: "INCREMENTAL", hasDesignDoc: true })

    expect(impact.artifactReviseTargets).toEqual([{ artifactKey: "design", phase: "PLANNING", phaseState: "REVISE" }])
    expect(impact.dependentArtifactKeys).toEqual(["plan", "interfaces", "tests", "impl_plan", "implementation"])
  })

  it("walks artifact dependents using the canonical artifact graph", () => {
    const impact = computeArtifactDriftImpact({ artifactKeys: ["interfaces"], mode: "INCREMENTAL" })

    expect(impact.artifactKeys).toEqual(["interfaces"])
    expect(impact.dependentArtifactKeys).toEqual(["tests", "impl_plan", "implementation"])
    expect(impact.revalidateArtifactKeys).toEqual(["interfaces", "tests", "impl_plan", "implementation"])
    expect(impact.artifactReviseTargets).toEqual([{ artifactKey: "interfaces", phase: "INTERFACES", phaseState: "REVISE" }])
  })

  it("walks implementation DAG dependents and marks completed tasks for reset", () => {
    const impact = computeTaskDriftImpact(stateWithDag([
      { id: "T1", description: "One", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      { id: "T2", description: "Two", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      { id: "T3", description: "Three", dependencies: ["T2"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
    ]), ["T1"])

    expect(impact.taskIds).toEqual(["T1"])
    expect(impact.downstreamTaskIds).toEqual(["T2", "T3"])
    expect(impact.resetTaskIds).toEqual(["T1", "T2"])
    expect(impact.completedTaskIds).toEqual(["T1", "T2"])
    expect(impact.missingTaskIds).toEqual([])
  })

  it("classifies missing and special-state task impacts explicitly", () => {
    const impact = computeTaskDriftImpact(stateWithDag([
      { id: "T1", description: "Delegated", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "delegated" },
      { id: "T2", description: "Gate", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "human-gated" },
      { id: "T3", description: "Abort", dependencies: ["T2"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "aborted" },
    ]), ["T1", "missing-task"])

    expect(impact.taskIds).toEqual(["T1"])
    expect(impact.missingTaskIds).toEqual(["missing-task"])
    expect(impact.delegatedTaskIds).toEqual(["T1"])
    expect(impact.humanGatedTaskIds).toEqual(["T2"])
    expect(impact.abortedTaskIds).toEqual(["T3"])
    expect(impact.resetTaskIds).toEqual([])
  })

  it("classifies task drift without an implementation DAG as missing", () => {
    const impact = computeTaskDriftImpact({ implDag: null }, ["T1", "T2", "T1"])

    expect(impact.taskIds).toEqual([])
    expect(impact.missingTaskIds).toEqual(["T1", "T2"])
    expect(impact.downstreamTaskIds).toEqual([])
    expect(impact.resetTaskIds).toEqual([])
  })

  it("includes in-flight tasks in reset candidates and status buckets", () => {
    const impact = computeTaskDriftImpact(stateWithDag([
      { id: "T1", description: "One", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      { id: "T2", description: "Two", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "in-flight" },
      { id: "T3", description: "Three", dependencies: ["T2"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
    ]), ["T1"])

    expect(impact.downstreamTaskIds).toEqual(["T2", "T3"])
    expect(impact.inFlightTaskIds).toEqual(["T2"])
    expect(impact.completedTaskIds).toEqual(["T3"])
    expect(impact.resetTaskIds).toEqual(["T2", "T3"])
  })

  it("maps reset repair actions back to the existing reset_task tool", () => {
    const action: DriftRepairAction = {
      id: "A1",
      kind: "reset_tasks",
      safety: "safe-auto",
      reason: "Upstream completed task changed; reset downstream closure.",
      impact: { ...EMPTY_DRIFT_IMPACT, taskIds: ["T1"], resetTaskIds: ["T1", "T2"] },
      evidence: [{ message: "T2 depends on T1" }],
    }

    expect(buildRepairToolCall(action)).toEqual({
      toolName: "reset_task",
      args: { task_ids: ["T1", "T2"] },
      requiredPhase: "IMPLEMENTATION",
      requiredPhaseStates: ["DRAFT", "REVISE", "SCHEDULING"],
    })
  })

  it("does not emit invalid request_review calls for unresolved artifact revalidation", () => {
    const action: DriftRepairAction = {
      id: "A-revalidate",
      kind: "revalidate_artifacts",
      safety: "requires-approval",
      reason: "Revalidate affected artifacts after drift repair.",
      impact: { ...EMPTY_DRIFT_IMPACT, revalidateArtifactKeys: ["interfaces", "tests"] },
      evidence: [{ message: "Artifact paths must be resolved before request_review can run." }],
    }

    expect(buildRepairToolCall(action)).toBeNull()
  })

  it("maps artifact revalidation only when artifact files are explicit and valid", () => {
    const action: DriftRepairAction = {
      id: "A-revalidate-files",
      kind: "revalidate_artifacts",
      safety: "requires-approval",
      reason: "Revalidate affected artifacts after drift repair.",
      impact: { ...EMPTY_DRIFT_IMPACT, revalidateArtifactKeys: ["interfaces"] },
      evidence: [{ message: "Artifact paths resolved." }],
      toolCall: {
        toolName: "request_review",
        args: {
          summary: "Interfaces repaired after drift",
          artifact_description: "Updated interface artifact",
          artifact_files: [".openartisan/feature/interfaces.ts"],
        },
      },
    }

    expect(buildRepairToolCall(action)).toEqual(action.toolCall!)
    expect(buildRepairToolCall({
      ...action,
      toolCall: { toolName: "request_review", args: { summary: "Missing files", artifact_description: "Invalid" } },
    })).toBeNull()
    expect(buildRepairToolCall({
      ...action,
      toolCall: { toolName: "submit_feedback", args: { feedback_type: "approve" } },
    })).toBeNull()
  })

  it("requires explicit validated tool calls for patch and boundary repair actions", () => {
    const patchAction: DriftRepairAction = {
      id: "A-patch",
      kind: "apply_patch_suggestion",
      safety: "safe-auto",
      reason: "Apply current-task reviewer patch.",
      impact: { ...EMPTY_DRIFT_IMPACT, taskIds: ["T1"] },
      evidence: [{ message: "Patch suggestion is current-task owned." }],
    }
    const boundaryAction: DriftRepairAction = {
      id: "A-boundary",
      kind: "apply_task_boundary_change",
      safety: "safe-auto",
      reason: "Move file ownership to current task.",
      impact: { ...EMPTY_DRIFT_IMPACT, taskIds: ["T1"] },
      evidence: [{ message: "Boundary analysis already ran." }],
    }

    expect(buildRepairToolCall(patchAction)).toBeNull()
    expect(buildRepairToolCall(boundaryAction)).toBeNull()

    expect(buildRepairToolCall({
      ...patchAction,
      toolCall: { toolName: "apply_patch_suggestion", args: { patch_suggestion_id: "patch-1" }, requiredPhase: "IMPLEMENTATION" },
    })).toEqual({ toolName: "apply_patch_suggestion", args: { patch_suggestion_id: "patch-1" }, requiredPhase: "IMPLEMENTATION" })

    expect(buildRepairToolCall({
      ...boundaryAction,
      toolCall: { toolName: "apply_task_boundary_change", args: { task_id: "T1", add_files: ["/repo/src/a.ts"], reason: "Reviewer found ownership drift in implementation task." }, requiredPhase: "IMPLEMENTATION" },
    })).toEqual({ toolName: "apply_task_boundary_change", args: { task_id: "T1", add_files: ["/repo/src/a.ts"], reason: "Reviewer found ownership drift in implementation task." }, requiredPhase: "IMPLEMENTATION" })

    expect(buildRepairToolCall({
      ...patchAction,
      toolCall: { toolName: "apply_patch_suggestion", args: { force: true }, requiredPhase: "IMPLEMENTATION" },
    })).toBeNull()

    expect(buildRepairToolCall({
      ...boundaryAction,
      toolCall: { toolName: "apply_task_boundary_change", args: { task_id: "T1", add_files: ["/repo/src/a.ts"] }, requiredPhase: "IMPLEMENTATION" },
    })).toBeNull()

    expect(buildRepairToolCall({
      ...patchAction,
      toolCall: { toolName: "reset_task", args: { task_ids: ["T1"] }, requiredPhase: "IMPLEMENTATION" },
    })).toBeNull()
  })

  it("targets artifact-specific phases for backtrack repair actions", () => {
    const action: DriftRepairAction = {
      id: "A-backtrack",
      kind: "propose_backtrack",
      safety: "requires-backtrack",
      reason: "Interfaces drift changes public contracts.",
      impact: computeArtifactDriftImpact({ artifactKeys: ["interfaces"], mode: "INCREMENTAL" }),
      evidence: [{ artifactKey: "interfaces", message: "Interface artifact is stale." }],
    }

    expect(buildRepairToolCall(action)).toEqual({
      toolName: "propose_backtrack",
      args: { target_phase: "INTERFACES", reason: "Interfaces drift changes public contracts." },
    })
  })

  it("validates human gate and user decision repair tool mappings", () => {
    const humanGateAction: DriftRepairAction = {
      id: "A-human-gate",
      kind: "resolve_human_gate",
      safety: "human-gated",
      reason: "External prerequisite must be declared structurally.",
      impact: { ...EMPTY_DRIFT_IMPACT, taskIds: ["T1"], humanGatedTaskIds: ["T1"] },
      evidence: [{ taskId: "T1", message: "Needs an external account." }],
      toolCall: {
        toolName: "resolve_human_gate",
        args: { task_id: "T1", what_is_needed: "Create account", why: "Required for API tests", verification_steps: "Run API health check" },
      },
    }
    const userDecisionAction: DriftRepairAction = {
      id: "A-user-decision",
      kind: "request_user_decision",
      safety: "requires-approval",
      reason: "Choose whether to backtrack or defer the patch.",
      impact: EMPTY_DRIFT_IMPACT,
      evidence: [{ message: "Both paths are valid." }],
    }

    expect(buildRepairToolCall(humanGateAction)).toEqual(humanGateAction.toolCall!)
    expect(buildRepairToolCall({
      ...humanGateAction,
      toolCall: { toolName: "resolve_human_gate", args: { task_id: "T1" } },
    })).toBeNull()
    expect(buildRepairToolCall(userDecisionAction)).toEqual({
      toolName: "submit_feedback",
      args: { feedback_type: "revise", feedback_text: "Choose whether to backtrack or defer the patch." },
    })
    expect(buildRepairToolCall({
      ...userDecisionAction,
      toolCall: { toolName: "submit_feedback", args: { feedback_type: "revise", feedback_text: "Please choose." } },
    })).toEqual({ toolName: "submit_feedback", args: { feedback_type: "revise", feedback_text: "Please choose." } })
  })

  it("deduplicates merged drift impacts while preserving first-seen order", () => {
    const impact = mergeDriftImpacts([
      { ...EMPTY_DRIFT_IMPACT, artifactKeys: ["plan"], revalidateArtifactKeys: ["plan", "interfaces"], taskIds: ["T1"], resetTaskIds: ["T1"] },
      { ...EMPTY_DRIFT_IMPACT, artifactKeys: ["plan", "interfaces"], revalidateArtifactKeys: ["interfaces", "tests"], taskIds: ["T1", "T2"], resetTaskIds: ["T2"] },
    ])

    expect(impact.artifactKeys).toEqual(["plan", "interfaces"])
    expect(impact.revalidateArtifactKeys).toEqual(["plan", "interfaces", "tests"])
    expect(impact.taskIds).toEqual(["T1", "T2"])
    expect(impact.resetTaskIds).toEqual(["T1", "T2"])
  })

  it("builds a repair plan from proposed actions and summarizes gates", () => {
    const action: DriftRepairAction = {
      id: "A1",
      kind: "propose_backtrack",
      safety: "requires-backtrack",
      reason: "Plan drift changes public scope.",
      impact: { ...EMPTY_DRIFT_IMPACT, artifactKeys: ["plan"], dependentArtifactKeys: ["interfaces"] },
      evidence: [{ artifactKey: "plan", message: "Plan no longer matches implementation." }],
    }
    const report: DriftReport = {
      id: "R1",
      workflowId: "workflow:drift",
      scope: "workflow",
      createdAt: "2026-05-01T00:00:00.000Z",
      findings: [{
        id: "F1",
        kind: "artifact_vs_code",
        severity: "blocking",
        owner: "spec",
        summary: "Plan stale",
        expected: "Approved plan",
        actual: "Implementation changed",
        evidence: action.evidence,
        impact: action.impact,
        proposedActions: [action],
      }],
      impact: action.impact,
    }

    const plan = buildDriftRepairPlan({ id: "P1", driftReport: report, strategy: "minimal", createdAt: report.createdAt })

    expect(plan.requiresBacktrack).toBe(true)
    expect(plan.requiresUserGate).toBe(false)
    expect(plan.impact.artifactKeys).toEqual(["plan"])
    expect(plan.actions.map((item) => item.id)).toEqual(["A1"])
  })

  it("builds repair plans that merge multiple finding impacts and gate requirements", () => {
    const safeAction: DriftRepairAction = {
      id: "A-reset",
      kind: "reset_tasks",
      safety: "safe-auto",
      reason: "Reset stale task output.",
      impact: { ...EMPTY_DRIFT_IMPACT, taskIds: ["T1"], resetTaskIds: ["T1"] },
      evidence: [{ taskId: "T1", message: "Output changed." }],
    }
    const approvalAction: DriftRepairAction = {
      id: "A-decision",
      kind: "request_user_decision",
      safety: "requires-approval",
      reason: "Choose repair direction.",
      impact: { ...EMPTY_DRIFT_IMPACT, allowlistViolations: ["src/out-of-scope.ts"] },
      evidence: [{ filePath: "src/out-of-scope.ts", message: "Outside allowlist." }],
    }
    const report: DriftReport = {
      id: "R-multi",
      workflowId: "workflow:drift",
      scope: "workflow",
      createdAt: "2026-05-01T00:00:00.000Z",
      findings: [
        { id: "F-reset", kind: "dag_vs_code", severity: "warning", owner: "task_dag", summary: "Task stale", expected: "DAG output", actual: "Changed output", evidence: safeAction.evidence, impact: safeAction.impact, proposedActions: [safeAction] },
        { id: "F-allowlist", kind: "allowlist_vs_changes", severity: "blocking", owner: "spec", summary: "Out of scope", expected: "Allowlist", actual: "Extra file", evidence: approvalAction.evidence, impact: approvalAction.impact, proposedActions: [approvalAction] },
      ],
      impact: { ...EMPTY_DRIFT_IMPACT, artifactKeys: ["plan"], revalidateArtifactKeys: ["plan"] },
    }

    const plan = buildDriftRepairPlan({ id: "P-multi", driftReport: report, strategy: "ask-first", createdAt: report.createdAt })

    expect(plan.actions.map((action) => action.id)).toEqual(["A-reset", "A-decision"])
    expect(plan.requiresUserGate).toBe(true)
    expect(plan.requiresBacktrack).toBe(false)
    expect(plan.impact.artifactKeys).toEqual(["plan"])
    expect(plan.impact.resetTaskIds).toEqual(["T1"])
    expect(plan.impact.allowlistViolations).toEqual(["src/out-of-scope.ts"])
  })

  it("builds workflow drift reports from artifact, task, and allowlist signals", () => {
    const report = buildWorkflowDriftReport({
      workflowId: "workflow:drift",
      createdAt: "2026-05-01T00:00:00.000Z",
      state: {
        mode: "INCREMENTAL",
        phase: "IMPLEMENTATION",
        currentTaskId: null,
        artifactDiskPaths: { interfaces: ".openartisan/feat/interfaces.ts" },
        fileAllowlist: ["src/allowed.ts"],
        implDag: [
          { id: "T1", description: "Done", dependencies: [], expectedTests: [], expectedFiles: ["src/allowed.ts"], estimatedComplexity: "small", status: "complete" },
        ],
      },
      artifactKeys: ["interfaces"],
      taskIds: ["T1"],
      changedFiles: ["src/out-of-scope.ts"],
    })

    expect(report.findings.map((finding) => finding.kind)).toEqual(["artifact_vs_code", "dag_vs_code", "allowlist_vs_changes"])
    expect(report.impact.revalidateArtifactKeys).toEqual(["interfaces", "tests", "impl_plan", "implementation"])
    expect(report.impact.resetTaskIds).toEqual(["T1"])
    expect(report.impact.allowlistViolations).toEqual(["src/out-of-scope.ts"])
  })

  it("exposes drift tool interface schemas", () => {
    expect(DRIFT_WORKFLOW_TOOL_NAMES).toEqual(["report_drift", "plan_drift_repair", "apply_drift_repair"])
    expect(ReportDriftToolSchema.parse({ scope: "workflow", drifted_artifact_keys: ["plan"], task_ids: ["T1"] })).toEqual({
      scope: "workflow",
      drifted_artifact_keys: ["plan"],
      task_ids: ["T1"],
    })
    expect(PlanDriftRepairToolSchema.parse({ strategy: "safe-auto" })).toEqual({ strategy: "safe-auto" })
    expect(ApplyDriftRepairToolSchema.parse({ repair_plan_id: "P1", apply_safe_actions: true })).toEqual({ repair_plan_id: "P1", apply_safe_actions: true })
    expect(toJsonSchema(ReportDriftToolSchema).type).toBe("object")
  })
})
