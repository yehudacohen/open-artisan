/**
 * change-proposal.ts — Isolated routing review for scope-affecting changes.
 */

import type { SubagentDispatcher } from "./subagent-dispatcher"
import type { WorkflowState } from "./workflow-state-types"
import type { ChangeProposalReviewOutput, ChangeProposalToolInput } from "./schemas"
import { ChangeProposalReviewOutputSchema, toJsonSchema } from "./schemas"
import { REVIEW_PROGRESS_HARD_TIMEOUT_MS, REVIEW_PROGRESS_IDLE_TIMEOUT_MS } from "./constants"
import { extractJsonFromText, extractTextFromPromptResult } from "./utils"
import { runWithProgressTimeout } from "./progress-timeout"

export interface ChangeProposalReviewRequest {
  proposal: ChangeProposalToolInput
  state: WorkflowState
  cwd: string
  parentSessionId?: string
  parentModel?: string | { modelID: string; providerID?: string }
}

export interface ChangeProposalReviewSuccess {
  success: true
  decision: ChangeProposalReviewOutput
  prompt: string
}

export interface ChangeProposalReviewError {
  success: false
  error: string
}

export type ChangeProposalReviewResult = ChangeProposalReviewSuccess | ChangeProposalReviewError
export type ChangeProposalParseResult =
  | { success: true; decision: ChangeProposalReviewOutput }
  | ChangeProposalReviewError

const ROUTE_DEFINITIONS: Record<ChangeProposalReviewOutput["route"], string> = {
  "current-task-fix": "The change is inside the current task and approved scope; the agent can fix it normally.",
  "task-boundary-change": "The change is valid but belongs in a different or expanded implementation DAG task boundary.",
  "planning-allowlist-revision": "The change is valid fallout of approved work but requires explicit user-approved INCREMENTAL allowlist expansion. This route does not by itself mean backtrack to PLANNING.",
  "impl-plan-revision": "The change requires revising task ordering, ownership, expected tests, or DAG metadata.",
  backtrack: "The change reveals a flawed upstream artifact that must be revisited before implementation continues.",
  "defer-final-review": "The change is worth tracking but should be judged by final implementation review, not repaired now.",
  "reject-out-of-scope": "The change is unrelated scope creep or an unrelated regression and should not be made in this workflow.",
  "ask-user": "The reviewer cannot safely choose a route without an explicit user decision.",
}

function listItems(items: string[] | undefined, empty = "(none)"): string {
  if (!items || items.length === 0) return empty
  return items.map((item) => `- ${item}`).join("\n")
}

function taskLine(task: NonNullable<WorkflowState["implDag"]>[number]): string {
  const files = task.expectedFiles.length > 0 ? task.expectedFiles.join(", ") : "no expected files"
  return `- ${task.id} [${task.status}]: ${task.description} (${files})`
}

export function buildChangeProposalReviewPrompt(req: ChangeProposalReviewRequest): string {
  const currentTask = req.state.currentTaskId && req.state.implDag
    ? req.state.implDag.find((task) => task.id === req.state.currentTaskId)
    : null
  const allowlist = req.state.fileAllowlist ?? []
  const affectedFiles = req.proposal.affected_files ?? []
  const outsideAllowlist = req.state.mode === "INCREMENTAL" && allowlist.length > 0
    ? affectedFiles.filter((file) => !allowlist.includes(file))
    : []

  const lines: string[] = []
  lines.push("You are an isolated Open Artisan change-proposal reviewer.")
  lines.push("Classify the correct workflow route for a proposed change. Do not approve code edits directly.")
  lines.push("")
  lines.push("## Proposal")
  lines.push(`Summary: ${req.proposal.summary}`)
  lines.push(`Why needed: ${req.proposal.why_needed}`)
  lines.push("")
  lines.push("Affected files:")
  lines.push(listItems(affectedFiles))
  if (req.proposal.failing_command) lines.push(`\nFailing command: ${req.proposal.failing_command}`)
  if (req.proposal.failing_output) lines.push(`Failing output:\n${req.proposal.failing_output}`)
  lines.push("")
  lines.push("## Workflow Context")
  lines.push(`Mode: ${req.state.mode ?? "unknown"}`)
  lines.push(`Current state: ${req.state.phase}/${req.state.phaseState}`)
  lines.push(`Feature: ${req.state.featureName ?? "(none)"}`)
  lines.push(`Current task: ${currentTask ? `${currentTask.id} - ${currentTask.description}` : "(none)"}`)
  lines.push("")
  lines.push("Current task files:")
  lines.push(listItems(currentTask?.expectedFiles))
  lines.push("")
  lines.push("Incremental allowlist status:")
  lines.push(`- Allowlist entries: ${allowlist.length}`)
  lines.push(`- Affected files outside allowlist: ${outsideAllowlist.length > 0 ? outsideAllowlist.join(", ") : "(none)"}`)
  lines.push("")
  if (req.state.implDag && req.state.implDag.length > 0) {
    lines.push("Implementation DAG tasks:")
    lines.push(req.state.implDag.map(taskLine).join("\n"))
    lines.push("")
  }
  lines.push("Referenced task IDs:")
  lines.push(listItems(req.proposal.task_ids))
  lines.push("")
  lines.push("Referenced artifact keys:")
  lines.push(listItems(req.proposal.artifact_keys))
  lines.push("")
  lines.push("## Available Routes")
  for (const [route, definition] of Object.entries(ROUTE_DEFINITIONS)) {
    lines.push(`- ${route}: ${definition}`)
  }
  lines.push("")
  lines.push("## Decision Rules")
  lines.push("- Prefer the narrowest route that preserves approved workflow scope.")
  lines.push("- If a file is outside the INCREMENTAL allowlist but is valid fallout of approved work, choose planning-allowlist-revision. Do not choose backtrack unless an approved artifact is actually wrong.")
  lines.push("- If the proposal is cleanup of stale generated output, build output, temp directories, or lock files left by timed-out review/build tooling, classify it as valid fallout when the cleanup is needed to restore verification. Prefer planning-allowlist-revision for files outside the allowlist, then request explicit user approval for the allowlist expansion.")
  lines.push("- If a file is inside the allowlist but belongs to another DAG task, choose task-boundary-change or impl-plan-revision.")
  lines.push("- If the proposal reveals an upstream artifact is wrong, choose backtrack.")
  lines.push("- Reject unrelated scope creep even if the edit is small.")
  lines.push("")
  lines.push("Preferred submission path: if the `submit_change_proposal_review_result` tool is available, call it exactly once with the routing decision instead of replying with text. The tool validates the structured payload.")
  lines.push("If that tool is unavailable, return ONLY a JSON object matching this shape:")
  lines.push(JSON.stringify({
    approved: true,
    route: "planning-allowlist-revision",
    confidence: "high",
    reason: "The failing typecheck is valid fallout of the approved state schema change, but the fixture file is outside the approved INCREMENTAL allowlist.",
    required_actions: ["Revise PLANNING allowlist to include the fixture file before editing it."],
    allowed_files: [],
    rejected_files: [],
  }, null, 2))
  return lines.join("\n")
}

export function buildChangeProposalNextAction(input: {
  decision: ChangeProposalReviewOutput
  proposal: ChangeProposalToolInput
  state: WorkflowState
}): string {
  const route = input.decision.route
  if (route === "planning-allowlist-revision") {
    const files = input.decision.allowed_files.length > 0
      ? input.decision.allowed_files
      : input.proposal.affected_files ?? []
    const fileList = files.length > 0 ? files.join(", ") : "the affected files identified in the proposal"
    if (input.state.phase === "INTERFACES" || input.state.phase === "TESTS" || input.state.phase === "IMPLEMENTATION" || input.state.phase === "IMPL_PLAN") {
      return (
        `Next action: call request_allowlist_expansion for ${fileList}, then continue the current review/approval path so the pending expansion can be approved at the next valid gate. ` +
        "Do not call propose_backtrack for this route unless the reviewer also says an approved upstream artifact is wrong."
      )
    }
    return `Next action: revise the current planning allowlist to include ${fileList}; do not edit those files until the revised allowlist is approved.`
  }
  if (route === "task-boundary-change") {
    return "Next action: use analyze_task_boundary_change/apply_task_boundary_change for cross-task ownership changes. For active-task scope expansion, call approve_current_task_scope_expansion; if you are not at USER_GATE it will record the request and move to a valid approval gate before applying."
  }
  if (route === "backtrack") {
    return "Next action: call propose_backtrack only from an active DRAFT/REVISE/TASK_REVISE state; at USER_GATE, present the issue as revision feedback for the user to route."
  }
  if (route === "ask-user") {
    return "Next action: ask the user for an explicit decision before changing workflow scope."
  }
  return "Next action: follow the selected route; do not edit files outside the active allowlist/task boundary without the matching approval tool."
}

function extractChangeProposalPayload(raw: unknown): unknown {
  if (typeof raw === "string") return JSON.parse(extractJsonFromText(raw))
  if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>
    if ("approved" in candidate && "route" in candidate) return raw
    const text = extractTextFromPromptResult(raw, "Change Proposal Review")
    return JSON.parse(extractJsonFromText(text))
  }
  throw new Error(`Unsupported Change Proposal Review result: ${typeof raw}`)
}

export function parseChangeProposalReviewResult(raw: unknown): ChangeProposalParseResult {
  try {
    const parsed = extractChangeProposalPayload(raw)
    const schema = ChangeProposalReviewOutputSchema.safeParse(parsed)
    if (!schema.success) return { success: false, error: schema.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ") }
    return { success: true, decision: schema.data }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function ephemeralChangeProposalPrompt(
  dispatcher: SubagentDispatcher,
  prompt: string,
  parentSessionId?: string,
  parentModel?: string | { modelID: string; providerID?: string },
): Promise<unknown> {
  const session = await dispatcher.createSession({
    title: "Change Proposal Review",
    agent: "workflow-reviewer",
    ...(parentSessionId ? { parentId: parentSessionId } : {}),
    ...(parentModel ? { model: parentModel } : {}),
  })
  try {
    return await runWithProgressTimeout({
      policy: {
        label: "change-proposal-review",
        idleTimeoutMs: REVIEW_PROGRESS_IDLE_TIMEOUT_MS,
        hardTimeoutMs: REVIEW_PROGRESS_HARD_TIMEOUT_MS,
      },
      run: (signal) => session.prompt(prompt, {
        onProgress: signal.progress,
        submissionTool: { name: "submit_change_proposal_review_result" },
        responseFormat: {
          type: "json_schema",
          schema: toJsonSchema(ChangeProposalReviewOutputSchema),
        },
      }),
      onIdleTimeout: () => session.destroy(),
      onHardTimeout: () => session.destroy(),
    })
  } finally {
    await session.destroy()
  }
}

export async function dispatchChangeProposalReview(
  dispatcher: SubagentDispatcher,
  req: ChangeProposalReviewRequest,
): Promise<ChangeProposalReviewResult> {
  const prompt = buildChangeProposalReviewPrompt(req)
  try {
    const raw = await ephemeralChangeProposalPrompt(dispatcher, prompt, req.parentSessionId, req.parentModel)
    const parsed = parseChangeProposalReviewResult(raw)
    if (!parsed.success) return parsed
    return { ...parsed, prompt }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
