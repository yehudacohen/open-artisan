import { createHash } from "node:crypto"

import type { WorkflowState, WorkflowToolFailureCategory, WorkflowToolFailureEntry } from "./workflow-state-types"

const MAX_FAILURE_HISTORY = 20
const MAX_FAILURE_MESSAGE = 500

export function sanitizeFailureMessage(message: string): string {
  return message
    .replace(/[a-f0-9]{16,}/gi, "<hash>")
    .replace(/sess_[A-Za-z0-9_-]+|ses_[A-Za-z0-9_-]+|msg_[A-Za-z0-9_-]+|prt_[A-Za-z0-9_-]+/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
    .replace(/ids=\{?[^\s}]+\}?/gi, "ids=<redacted>")
    .replace(/history=\{[^\n]+?\}/gi, "history=<redacted>")
    .replace(/original=\{[^\n]+?\}/gi, "original=<redacted>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim()
}

export function fingerprintToolFailure(input: {
  category: WorkflowToolFailureCategory
  toolName: string
  taskId?: string | null
  message: string
}): string {
  const normalized = sanitizeFailureMessage(input.message).slice(0, MAX_FAILURE_MESSAGE)
  return createHash("sha256")
    .update([input.category, input.toolName, input.taskId ?? "", normalized].join("\0"))
    .digest("hex")
    .slice(0, 16)
}

export function recordToolFailure(
  state: WorkflowState,
  input: {
    category: WorkflowToolFailureCategory
    toolName: string
    message: string
    taskId?: string | null
    now?: number
  },
): WorkflowToolFailureEntry {
  const now = input.now ?? Date.now()
  const fingerprint = fingerprintToolFailure(input)
  const sanitized = sanitizeFailureMessage(input.message)
  const message = sanitized.length > MAX_FAILURE_MESSAGE
    ? `${sanitized.slice(0, MAX_FAILURE_MESSAGE)}...[truncated]`
    : sanitized
  const existing = state.toolFailureHistory.find((entry) => entry.fingerprint === fingerprint)
  if (existing) {
    existing.count += 1
    existing.lastSeenAt = now
    existing.phase = state.phase
    existing.phaseState = state.phaseState
    existing.message = message
    if (input.taskId) existing.taskId = input.taskId
    return existing
  }

  const entry: WorkflowToolFailureEntry = {
    fingerprint,
    category: input.category,
    toolName: input.toolName,
    message,
    count: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    phase: state.phase,
    phaseState: state.phaseState,
    ...(input.taskId ? { taskId: input.taskId } : {}),
  }
  state.toolFailureHistory = [entry, ...state.toolFailureHistory].slice(0, MAX_FAILURE_HISTORY)
  return entry
}

export function buildIncidentSummary(state: WorkflowState): string {
  const currentTask = state.currentTaskId ? state.implDag?.find((task) => task.id === state.currentTaskId) : null
  const repeatedFailures = state.toolFailureHistory.filter((entry) => entry.count > 1)
  const lines: string[] = []
  lines.push(`# Open Artisan Incident Summary`)
  lines.push(``)
  lines.push(`- Workflow: ${state.featureName ?? state.sessionId}`)
  lines.push(`- State: ${state.phase}/${state.phaseState}`)
  lines.push(`- Mode: ${state.mode ?? "unselected"}`)
  lines.push(`- Current task: ${state.currentTaskId ?? "none"}`)
  if (currentTask) {
    lines.push(`- Current task files: ${(currentTask.expectedFiles ?? []).join(", ") || "none"}`)
    lines.push(`- Current task tests: ${(currentTask.expectedTests ?? []).join(", ") || "none"}`)
  }
  lines.push(`- Allowlist size: ${state.fileAllowlist.length}`)
  lines.push(`- Pending allowlist expansions: ${state.pendingAllowlistExpansions.length}`)
  lines.push(`- Recorded tool failures: ${state.toolFailureHistory.length}`)
  lines.push(`- Repeated tool failures: ${repeatedFailures.length}`)
  lines.push(``)

  if (state.pendingAllowlistExpansions.length > 0) {
    lines.push(`## Pending Allowlist Expansions`)
    for (const request of state.pendingAllowlistExpansions) {
      lines.push(`- ${request.files.join(", ")} (${request.sourceArtifact}): ${request.reason}`)
    }
    lines.push(``)
  }

  if (state.latestReviewResults?.length) {
    lines.push(`## Latest Review Results`)
    for (const result of state.latestReviewResults.slice(0, 10)) {
      lines.push(`- ${result.met ? "PASS" : "FAIL"}: ${result.criterion} — ${result.evidence}`)
    }
    lines.push(``)
  }

  if (state.toolFailureHistory.length > 0) {
    lines.push(`## Tool Failure History`)
    for (const entry of state.toolFailureHistory) {
      lines.push(`- ${entry.category}/${entry.toolName} x${entry.count} at ${entry.phase}/${entry.phaseState}${entry.taskId ? ` task=${entry.taskId}` : ""}: ${entry.message}`)
    }
    lines.push(``)
  }

  lines.push(`## Recommended Maintainer Action`)
  if (repeatedFailures.some((entry) => entry.category === "reviewer-infrastructure")) {
    lines.push(`- Treat repeated reviewer failures as tooling defects. Do not request implementation rewrites until reviewer submission/extraction is fixed.`)
  }
  if (state.pendingAllowlistExpansions.length > 0 || (state.phase === "IMPLEMENTATION" && state.currentTaskId)) {
    lines.push(`- If blocked writes involve approved task files, run the atomic current-task scope repair or repair from approved IMPL_PLAN before backtracking.`)
  }
  if (state.toolFailureHistory.length === 0 && state.pendingAllowlistExpansions.length === 0) {
    lines.push(`- No repeated tooling incident is currently recorded. Continue normal workflow repair.`)
  }

  return lines.join("\n")
}
