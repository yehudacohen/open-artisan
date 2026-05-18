import { parseImplPlan } from "../impl-plan-parser"
import { normalizeWorkflowPaths } from "../path-normalization"
import type { ApplyTaskBoundaryChangeArgs } from "../tool-types"
import type { WorkflowState } from "../workflow-state-types"
import { analyzeTaskBoundaryChange, applyTaskBoundaryChange } from "./transitions"

function addUnique(existing: string[], additions: string[]): string[] {
  return Array.from(new Set([...existing, ...additions]))
}

function sameMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item))
}

export function repairCurrentTaskBoundaryFromImplPlan(
  state: WorkflowState,
  planContent: string,
  cwd: string,
  args: { task_id?: string; reason?: string } = {},
): { success: true; message: string; taskId: string; files: string[]; expectedTests: string[] } | { success: false; error: string } {
  if (state.phase !== "IMPLEMENTATION") {
    return { success: false, error: `repair_current_task_boundary_from_impl_plan is only valid during IMPLEMENTATION (current: ${state.phase}).` }
  }
  if (!state.implDag || state.implDag.length === 0) {
    return { success: false, error: "No implementation DAG is available to repair." }
  }
  const taskId = args.task_id ?? state.currentTaskId
  if (!taskId) return { success: false, error: "No current task is active; pass task_id explicitly." }
  if (state.currentTaskId && taskId !== state.currentTaskId) {
    return { success: false, error: `Task "${taskId}" is not the current task. Current task: "${state.currentTaskId}".` }
  }

  const currentTask = state.implDag.find((task) => task.id === taskId)
  if (!currentTask) return { success: false, error: `Task "${taskId}" was not found in the active implementation DAG.` }

  const parsed = parseImplPlan(planContent)
  if (!parsed.success) {
    return { success: false, error: `Approved IMPL_PLAN could not be parsed: ${parsed.errors.join("; ")}` }
  }
  const planTask = Array.from(parsed.dag.tasks).find((task) => task.id === taskId)
  if (!planTask) return { success: false, error: `Task "${taskId}" was not found in the approved IMPL_PLAN artifact.` }

  const files = normalizeWorkflowPaths(planTask.expectedFiles, cwd)
  const expectedTests = normalizeWorkflowPaths(planTask.expectedTests, cwd)
  const currentExpectedFiles = normalizeWorkflowPaths(currentTask.expectedFiles, cwd)
  const currentExpectedTests = normalizeWorkflowPaths(currentTask.expectedTests, cwd)
  const missingFiles = files.filter((file) => !currentExpectedFiles.includes(file))
  const missingTests = expectedTests.filter((file) => !currentExpectedTests.includes(file))
  if (missingFiles.length === 0 && missingTests.length === 0) {
    return { success: true, message: `Current task boundary already matches approved IMPL_PLAN for ${taskId}.`, taskId, files: [], expectedTests: [] }
  }

  const expandedAllowlist = addUnique(normalizeWorkflowPaths(state.fileAllowlist, cwd), [...missingFiles, ...missingTests])
  const reason = args.reason ?? "Synchronize active task boundary with approved implementation plan metadata."
  const boundaryArgs = {
    task_id: taskId,
    add_files: missingFiles,
    remove_files: [],
    add_expected_tests: missingTests,
    remove_expected_tests: [],
    expected_impacted_tasks: [taskId],
    expected_reset_tasks: [],
    reason,
  } as unknown as ApplyTaskBoundaryChangeArgs
  const analysisState: WorkflowState = {
    ...state,
    fileAllowlist: state.mode === "INCREMENTAL" ? expandedAllowlist : state.fileAllowlist,
    implDag: state.implDag.map((task) => ({ ...task })),
  }
  const analysis = analyzeTaskBoundaryChange(boundaryArgs, analysisState, cwd)
  if (!analysis.success) return { success: false, error: analysis.error.message }
  if (
    analysis.analysis.conflicts.length > 0 ||
    !sameMembers(analysis.analysis.impactedTaskIds, [taskId]) ||
    analysis.analysis.completedTaskIdsToReset.length > 0
  ) {
    const conflictText = analysis.analysis.conflicts.map((conflict) => conflict.message).join("; ") ||
      `Impacted tasks: ${analysis.analysis.impactedTaskIds.join(", ")}`
    return {
      success: false,
      error:
        `Approved IMPL_PLAN boundary repair is not safe to apply automatically because it affects existing task ownership. ${conflictText}. ` +
        `Use analyze_task_boundary_change and apply_task_boundary_change with explicit impacted/reset acknowledgements.`,
    }
  }

  const applied = applyTaskBoundaryChange(boundaryArgs, analysisState, cwd)
  if (!applied.success) return { success: false, error: applied.error.message }
  state.implDag = applied.updatedNodes

  if (state.mode === "INCREMENTAL") {
    state.fileAllowlist = expandedAllowlist
    const allowSet = new Set(state.fileAllowlist)
    state.pendingAllowlistExpansions = state.pendingAllowlistExpansions.filter((request) => {
      const remaining = request.files.filter((file) => {
        const normalized = normalizeWorkflowPaths([file], cwd)[0]
        return normalized ? !allowSet.has(normalized) : true
      })
      request.files = remaining
      return remaining.length > 0
    })
  }

  state.phaseState = "DRAFT"
  state.taskCompletionInProgress = null
  state.latestReviewResults = null
  state.reviewArtifactHash = null

  return {
    success: true,
    taskId,
    files: missingFiles,
    expectedTests: missingTests,
    message:
      `Repaired current task boundary from approved IMPL_PLAN for ${taskId}. ` +
      `${state.mode === "INCREMENTAL" ? "Updated both gates: INCREMENTAL allowlist and current task boundary. " : "Updated current task boundary. "}` +
      `Files added: ${missingFiles.join(", ") || "none"}. Expected tests added: ${missingTests.join(", ") || "none"}.`,
  }
}
