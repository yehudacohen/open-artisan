import type { RequestAllowlistExpansionArgs } from "../tool-types"
import type { WorkflowState } from "../workflow-state-types"
import { isTestFile } from "../hooks/tool-guard"
import { findInvalidWorkflowPaths, normalizeWorkflowPaths } from "../path-normalization"

export function normalizeAllowlistExpansionFiles(files: string[], cwd: string): string[] {
  return normalizeWorkflowPaths(files, cwd, { allowOutsideProject: false })
}

export function recordAllowlistExpansionRequest(
  state: WorkflowState,
  args: RequestAllowlistExpansionArgs,
  cwd: string,
  now = Date.now(),
): { success: true; message: string; files: string[] } | { success: false; error: string } {
  if (state.mode !== "INCREMENTAL") {
    return { success: false, error: "request_allowlist_expansion is only valid in INCREMENTAL mode." }
  }
  if (!args.reason?.trim() || args.reason.trim().length < 20) {
    return { success: false, error: "reason must be at least 20 characters." }
  }
  const invalidPaths = findInvalidWorkflowPaths(args.files ?? [], cwd, { allowOutsideProject: false })
  if (invalidPaths.length > 0) {
    return { success: false, error: `allowlist expansion includes paths outside the project root or invalid paths: ${invalidPaths.join(", ")}.` }
  }
  const files = normalizeAllowlistExpansionFiles(args.files ?? [], cwd)
  if (files.length === 0) return { success: false, error: "files must contain at least one path." }
  const existingAllowlist = new Set(normalizeWorkflowPaths(state.fileAllowlist, cwd))
  const requestedFiles = files.filter((file) => !existingAllowlist.has(file))
  if (requestedFiles.length === 0) {
    return { success: false, error: "All requested files are already in the approved INCREMENTAL allowlist." }
  }
  state.pendingAllowlistExpansions.push({
    files: requestedFiles,
    reason: args.reason.trim(),
    sourceArtifact: args.source_artifact,
    requestedAtPhase: state.phase,
    requestedAt: now,
  })
  if ((state.phase === "IMPL_PLAN" || state.phase === "IMPLEMENTATION") && state.phaseState !== "USER_GATE") {
    state.phaseState = "USER_GATE"
    state.userGateMessageReceived = false
  }
  return {
    success: true,
    files: requestedFiles,
    message:
      `allowlist expansion requested for ${requestedFiles.join(", ")}. ` +
      "This is recorded for explicit user/planning approval; do not edit these files until the allowlist is expanded.",
  }
}

export function applyPendingAllowlistExpansions(
  state: WorkflowState,
  cwd?: string,
): { success: true; files: string[]; message: string } | { success: false; error: string } {
  if (state.mode !== "INCREMENTAL") {
    return { success: false, error: "Pending allowlist expansions can only be applied in INCREMENTAL mode." }
  }
  if (state.pendingAllowlistExpansions.length === 0) {
    return { success: false, error: "No pending allowlist expansion requests to apply." }
  }
  const normalize = (paths: string[]) => cwd ? normalizeWorkflowPaths(paths, cwd) : Array.from(new Set(paths))
  const previousAllowlist = normalize(state.fileAllowlist)
  const expanded = new Set(previousAllowlist)
  for (const request of state.pendingAllowlistExpansions) {
    for (const file of normalize(request.files)) expanded.add(file)
  }
  const files = Array.from(expanded).filter((file) => !previousAllowlist.includes(file))
  state.fileAllowlist = Array.from(expanded)
  state.pendingAllowlistExpansions = []
  let boundaryMessage = ""
  if (state.phase === "IMPLEMENTATION" && state.currentTaskId && state.implDag && files.length > 0) {
    const task = state.implDag.find((candidate) => candidate.id === state.currentTaskId)
    if (task) {
      const expectedTests = files.filter(isTestFile)
      const expectedFiles = files.filter((file) => !isTestFile(file))
      task.expectedFiles = Array.from(new Set([...normalize(task.expectedFiles ?? []), ...expectedFiles]))
      task.expectedTests = Array.from(new Set([...normalize(task.expectedTests ?? []), ...expectedTests]))
      boundaryMessage = ` Updated current task boundary for ${task.id}: files ${expectedFiles.join(", ") || "none"}; expected tests ${expectedTests.join(", ") || "none"}.`
    }
  }
  if (state.phase === "IMPL_PLAN" || state.phase === "IMPLEMENTATION") {
    state.phaseState = "DRAFT"
    state.userGateMessageReceived = false
  }
  return {
    success: true,
    files,
    message: `Applied approved allowlist expansion for ${files.join(", ")}.${boundaryMessage} Returning to ${state.phase}/${state.phaseState}.`,
  }
}
