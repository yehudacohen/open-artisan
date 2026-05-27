import type { ApproveCurrentTaskScopeExpansionInput } from "../schemas"
import type { WorkflowState } from "../workflow-state-types"
import { findInvalidWorkflowPaths, normalizeWorkflowPaths } from "../path-normalization"
import { applyValidatedStructuralTransition } from "./structural-transition"

function addUnique(existing: string[], additions: string[]): string[] {
  return Array.from(new Set([...existing, ...additions]))
}

export function approveCurrentTaskScopeExpansion(
  state: WorkflowState,
  args: ApproveCurrentTaskScopeExpansionInput,
  cwd: string,
): { success: true; message: string; files: string[]; expectedTests: string[] } | { success: false; error: string } {
  if (state.phase !== "IMPLEMENTATION") {
    return { success: false, error: `approve_current_task_scope_expansion is only valid during IMPLEMENTATION (current: ${state.phase}).` }
  }
  if (state.phaseState !== "USER_GATE") {
    return { success: false, error: `approve_current_task_scope_expansion requires USER_GATE approval before changing task scope (current: ${state.phaseState}).` }
  }
  if (!state.userGateMessageReceived) {
    return { success: false, error: "approve_current_task_scope_expansion requires a real user response at USER_GATE; the agent cannot self-approve scope changes." }
  }
  if (!state.implDag || state.implDag.length === 0) {
    return { success: false, error: "No implementation DAG is available to repair." }
  }
  const taskId = args.task_id ?? state.currentTaskId
  if (!taskId) return { success: false, error: "No current task is active; pass task_id explicitly." }
  const task = state.implDag.find((candidate) => candidate.id === taskId)
  if (!task) return { success: false, error: `Task "${taskId}" was not found in the implementation DAG.` }
  if (state.currentTaskId && taskId !== state.currentTaskId) {
    return { success: false, error: `Task "${taskId}" is not the current task. Current task: "${state.currentTaskId}".` }
  }

  const invalidPaths = [
    ...findInvalidWorkflowPaths(args.files, cwd, { allowOutsideProject: false }),
    ...findInvalidWorkflowPaths(args.expected_tests, cwd, { allowOutsideProject: false }),
  ]
  if (invalidPaths.length > 0) {
    return { success: false, error: `Scope expansion includes paths outside the project root or invalid paths: ${invalidPaths.join(", ")}.` }
  }

  const files = normalizeWorkflowPaths(args.files, cwd)
  const expectedTests = normalizeWorkflowPaths(args.expected_tests, cwd)
  if (files.length === 0 && expectedTests.length === 0) {
    return { success: false, error: "Provide at least one file or expected_tests entry to approve." }
  }

  const transition = applyValidatedStructuralTransition(state, "scope_expansion_approved")
  if (!transition.success) return transition

  task.expectedFiles = addUnique(normalizeWorkflowPaths(task.expectedFiles, cwd), files)
  task.expectedTests = addUnique(normalizeWorkflowPaths(task.expectedTests, cwd), expectedTests)

  if (state.mode === "INCREMENTAL") {
    state.fileAllowlist = addUnique(normalizeWorkflowPaths(state.fileAllowlist, cwd), [...files, ...expectedTests])
    const allowSet = new Set(normalizeWorkflowPaths(state.fileAllowlist, cwd))
    state.pendingAllowlistExpansions = state.pendingAllowlistExpansions.filter((request) => {
      const remaining = request.files.filter((file) => {
        const normalized = normalizeWorkflowPaths([file], cwd)[0]
        return normalized ? !allowSet.has(normalized) : true
      })
      request.files = remaining
      return remaining.length > 0
    })
  }

  state.userGateMessageReceived = false
  state.latestReviewResults = null

  const gateSummary = state.mode === "INCREMENTAL"
    ? "Updated both gates: INCREMENTAL allowlist and current task boundary."
    : "Updated current task boundary."
  return {
    success: true,
    files,
    expectedTests,
    message:
      `Approved and applied current-task scope expansion for ${taskId}. ${gateSummary} ` +
      `Files: ${files.length > 0 ? files.join(", ") : "(none)"}. ` +
      `Expected tests: ${expectedTests.length > 0 ? expectedTests.join(", ") : "(none)"}.`,
  }
}
