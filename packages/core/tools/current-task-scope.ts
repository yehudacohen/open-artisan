import type { ApproveCurrentTaskScopeExpansionInput } from "../schemas"
import type { WorkflowState } from "../workflow-state-types"
import { findInvalidWorkflowPaths, normalizeWorkflowPaths } from "../path-normalization"
import { applyValidatedStructuralTransition } from "./structural-transition"

function addUnique(existing: string[], additions: string[]): string[] {
  return Array.from(new Set([...existing, ...additions]))
}

function pendingScopeCoveredByApproval(
  pending: WorkflowState["pendingCurrentTaskScopeExpansions"],
  taskId: string,
  files: string[],
  expectedTests: string[],
  cleanupFiles: string[],
): { success: true } | { success: false; error: string } {
  if (pending.length === 0) return { success: true }
  const approvedFiles = new Set(files)
  const approvedTests = new Set(expectedTests)
  const approvedCleanupFiles = new Set(cleanupFiles)
  for (const request of pending) {
    if (request.taskId !== taskId) {
      return {
        success: false,
        error: `A pending current-task scope expansion targets task "${request.taskId}", but this approval targets "${taskId}". Apply or reject the pending request before approving a different task scope.`,
      }
    }
    const missingFiles = request.files.filter((file) => !approvedFiles.has(file))
    const missingTests = request.expectedTests.filter((test) => !approvedTests.has(test))
    const missingCleanupFiles = (request.cleanupFiles ?? []).filter((file) => !approvedCleanupFiles.has(file))
    if (missingFiles.length > 0 || missingTests.length > 0 || missingCleanupFiles.length > 0) {
      return {
        success: false,
        error:
          "A pending current-task scope expansion already exists and is not covered by this direct approval. " +
          `Missing files: ${missingFiles.length > 0 ? missingFiles.join(", ") : "(none)"}. ` +
          `Missing expected tests: ${missingTests.length > 0 ? missingTests.join(", ") : "(none)"}. ` +
          `Missing cleanup files: ${missingCleanupFiles.length > 0 ? missingCleanupFiles.join(", ") : "(none)"}.`,
      }
    }
  }
  return { success: true }
}

export function approveCurrentTaskScopeExpansion(
  state: WorkflowState,
  args: ApproveCurrentTaskScopeExpansionInput,
  cwd: string,
  options: { explicitUserApproval?: boolean; now?: number } = {},
): { success: true; message: string; files: string[]; expectedTests: string[]; cleanupFiles: string[] } | { success: false; error: string } {
  if (state.phase !== "IMPLEMENTATION") {
    return { success: false, error: `approve_current_task_scope_expansion is only valid during IMPLEMENTATION (current: ${state.phase}).` }
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
    ...findInvalidWorkflowPaths(args.cleanup_files, cwd, { allowOutsideProject: false }),
  ]
  if (invalidPaths.length > 0) {
    return { success: false, error: `Scope expansion includes paths outside the project root or invalid paths: ${invalidPaths.join(", ")}.` }
  }

  const files = normalizeWorkflowPaths(args.files, cwd)
  const expectedTests = normalizeWorkflowPaths(args.expected_tests, cwd)
  const cleanupFiles = normalizeWorkflowPaths(args.cleanup_files, cwd)
  if (files.length === 0 && expectedTests.length === 0 && cleanupFiles.length === 0) {
    return { success: false, error: "Provide at least one file, expected_tests, or cleanup_files entry to approve." }
  }

  if (state.phaseState !== "USER_GATE") {
    const transition = applyValidatedStructuralTransition(state, "scope_expansion_requested")
    if (!transition.success) return transition
    state.pendingCurrentTaskScopeExpansions.push({
      taskId,
      files,
      expectedTests,
      ...(cleanupFiles.length > 0 ? { cleanupFiles } : {}),
      reason: args.reason.trim(),
      requestedAt: options.now ?? Date.now(),
    })
    state.userGateMessageReceived = false
    return {
      success: true,
      files,
      expectedTests,
      cleanupFiles,
      message:
        `Current-task scope expansion requested for ${taskId}. ` +
        `Files: ${files.length > 0 ? files.join(", ") : "(none)"}. ` +
        `Expected tests: ${expectedTests.length > 0 ? expectedTests.join(", ") : "(none)"}. ` +
        `Cleanup files: ${cleanupFiles.length > 0 ? cleanupFiles.join(", ") : "(none)"}. ` +
        "Present this scope change to the user for approval; do not edit these files until the expansion is approved.",
    }
  }

  if (!state.userGateMessageReceived && !options.explicitUserApproval) {
    return { success: false, error: "approve_current_task_scope_expansion requires a real user response at USER_GATE; the agent cannot self-approve scope changes." }
  }

  const pendingCoverage = pendingScopeCoveredByApproval(state.pendingCurrentTaskScopeExpansions, taskId, files, expectedTests, cleanupFiles)
  if (!pendingCoverage.success) return pendingCoverage

  const transition = applyValidatedStructuralTransition(state, "scope_expansion_approved")
  if (!transition.success) return transition

  task.expectedFiles = addUnique(normalizeWorkflowPaths(task.expectedFiles, cwd), files)
  task.expectedTests = addUnique(normalizeWorkflowPaths(task.expectedTests, cwd), expectedTests)
  state.approvedCleanupFiles = addUnique(normalizeWorkflowPaths(state.approvedCleanupFiles, cwd), cleanupFiles)

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
  state.pendingCurrentTaskScopeExpansions = state.pendingCurrentTaskScopeExpansions.filter((request) => request.taskId !== taskId)

  const gateSummary = state.mode === "INCREMENTAL"
    ? "Updated both gates: INCREMENTAL allowlist and current task boundary."
    : "Updated current task boundary."
  return {
    success: true,
    files,
    expectedTests,
    cleanupFiles,
    message:
      `Approved and applied current-task scope expansion for ${taskId}. ${gateSummary} ` +
      `Files: ${files.length > 0 ? files.join(", ") : "(none)"}. ` +
      `Expected tests: ${expectedTests.length > 0 ? expectedTests.join(", ") : "(none)"}. ` +
      `Cleanup files: ${cleanupFiles.length > 0 ? cleanupFiles.join(", ") : "(none)"}.`,
  }
}

export function applyPendingCurrentTaskScopeExpansions(
  state: WorkflowState,
  cwd: string,
  options: { explicitUserApproval?: boolean } = {},
): { success: true; message: string; files: string[]; expectedTests: string[]; cleanupFiles: string[] } | { success: false; error: string } {
  if (state.phase !== "IMPLEMENTATION") {
    return { success: false, error: `Pending current-task scope expansion is only valid during IMPLEMENTATION (current: ${state.phase}).` }
  }
  if (state.phaseState !== "USER_GATE") {
    return { success: false, error: `Pending current-task scope expansion requires USER_GATE approval before applying (current: ${state.phaseState}).` }
  }
  if (!state.userGateMessageReceived && !options.explicitUserApproval) {
    return { success: false, error: "Pending current-task scope expansion requires a real user response at USER_GATE; the agent cannot self-approve scope changes." }
  }
  if (state.pendingCurrentTaskScopeExpansions.length === 0) {
    return { success: false, error: "No pending current-task scope expansion requests to apply." }
  }
  if (!state.implDag || state.implDag.length === 0) {
    return { success: false, error: "No implementation DAG is available to repair." }
  }

  const files: string[] = []
  const expectedTests: string[] = []
  const cleanupFiles: string[] = []
  const updates: Array<{ task: NonNullable<WorkflowState["implDag"]>[number]; files: string[]; expectedTests: string[] }> = []
  for (const request of state.pendingCurrentTaskScopeExpansions) {
    if (state.currentTaskId && request.taskId !== state.currentTaskId) {
      return { success: false, error: `Pending scope expansion targets task "${request.taskId}", but current task is "${state.currentTaskId}".` }
    }
    const task = state.implDag.find((candidate) => candidate.id === request.taskId)
    if (!task) return { success: false, error: `Task "${request.taskId}" was not found in the implementation DAG.` }
    updates.push({ task, files: request.files, expectedTests: request.expectedTests })
    files.push(...request.files)
    expectedTests.push(...request.expectedTests)
    cleanupFiles.push(...(request.cleanupFiles ?? []))
  }

  const transition = applyValidatedStructuralTransition(state, "scope_expansion_approved")
  if (!transition.success) return transition

  for (const update of updates) {
    update.task.expectedFiles = addUnique(normalizeWorkflowPaths(update.task.expectedFiles, cwd), update.files)
    update.task.expectedTests = addUnique(normalizeWorkflowPaths(update.task.expectedTests, cwd), update.expectedTests)
  }

  const uniqueFiles = Array.from(new Set(files))
  const uniqueExpectedTests = Array.from(new Set(expectedTests))
  const uniqueCleanupFiles = Array.from(new Set(cleanupFiles))
  state.approvedCleanupFiles = addUnique(normalizeWorkflowPaths(state.approvedCleanupFiles, cwd), uniqueCleanupFiles)
  if (state.mode === "INCREMENTAL") {
    state.fileAllowlist = addUnique(normalizeWorkflowPaths(state.fileAllowlist, cwd), [...uniqueFiles, ...uniqueExpectedTests])
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

  const taskIds = Array.from(new Set(state.pendingCurrentTaskScopeExpansions.map((request) => request.taskId)))
  state.pendingCurrentTaskScopeExpansions = []
  state.userGateMessageReceived = false
  state.latestReviewResults = null

  return {
    success: true,
    files: uniqueFiles,
    expectedTests: uniqueExpectedTests,
    cleanupFiles: uniqueCleanupFiles,
    message:
      `Approved and applied pending current-task scope expansion for ${taskIds.join(", ")}. ` +
      `${state.mode === "INCREMENTAL" ? "Updated both gates: INCREMENTAL allowlist and current task boundary. " : "Updated current task boundary. "}` +
      `Files: ${uniqueFiles.length > 0 ? uniqueFiles.join(", ") : "(none)"}. ` +
      `Expected tests: ${uniqueExpectedTests.length > 0 ? uniqueExpectedTests.join(", ") : "(none)"}. ` +
      `Cleanup files: ${uniqueCleanupFiles.length > 0 ? uniqueCleanupFiles.join(", ") : "(none)"}.`,
  }
}
