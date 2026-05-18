/**
 * change-proposal.ts — Isolated routing review for scope-affecting changes.
 */

import type { SubagentDispatcher } from "./subagent-dispatcher"
import type { WorkflowState } from "./workflow-state-types"
import type { ChangeProposalReviewOutput, ChangeProposalToolInput } from "./schemas"
import { ChangeProposalReviewOutputSchema, toJsonSchema } from "./schemas"
import { CHANGE_PROPOSAL_REVIEW_TIMEOUT_MS } from "./constants"
import { extractJsonFromText, extractTextFromPromptResult, withTimeout } from "./utils"

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
  "planning-allowlist-revision": "The change is valid fallout of approved work but requires expanding the INCREMENTAL file allowlist.",
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
  lines.push("- If a file is outside the INCREMENTAL allowlist but is valid fallout of approved work, choose planning-allowlist-revision.")
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
    return await session.prompt(prompt, {
      submissionTool: { name: "submit_change_proposal_review_result" },
      responseFormat: {
        type: "json_schema",
        schema: toJsonSchema(ChangeProposalReviewOutputSchema),
      },
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
    const raw = await withTimeout(
      ephemeralChangeProposalPrompt(dispatcher, prompt, req.parentSessionId, req.parentModel),
      CHANGE_PROPOSAL_REVIEW_TIMEOUT_MS,
      "change-proposal-review",
    )
    const parsed = parseChangeProposalReviewResult(raw)
    if (!parsed.success) return parsed
    return { ...parsed, prompt }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
