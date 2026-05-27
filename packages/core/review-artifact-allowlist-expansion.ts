import type { SubagentDispatcher } from "./subagent-dispatcher"
import type { WorkflowState } from "./workflow-state-types"
import { isInterfaceFile, isTestFile } from "./hooks/tool-guard"
import { normalizeWorkflowPaths } from "./path-normalization"
import { CHANGE_PROPOSAL_REVIEW_TIMEOUT_MS } from "./constants"
import { extractJsonFromText, extractTextFromPromptResult, withTimeout } from "./utils"
import { toJsonSchema, z } from "./schemas"

export const ReviewArtifactAllowlistExpansionDecisionSchema = z.object({
  approved: z.boolean(),
  architecturally_sound: z.boolean(),
  dag_safe: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().min(1),
  approved_files: z.array(z.string().min(1)),
  rejected_files: z.array(z.string().min(1)).default([]),
}).strict()

export type ReviewArtifactAllowlistExpansionDecision = z.infer<typeof ReviewArtifactAllowlistExpansionDecisionSchema>

export type ReviewArtifactAllowlistExpansionCandidate =
  | { success: true; files: string[]; evidence: string[] }
  | { success: false; error: string }

export type ReviewArtifactAllowlistExpansionReviewResult =
  | { success: true; decision: ReviewArtifactAllowlistExpansionDecision; prompt: string }
  | { success: false; error: string }

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

function sameSet(left: string[], right: string[]): boolean {
  const l = new Set(left)
  const r = new Set(right)
  return l.size === r.size && Array.from(l).every((value) => r.has(value))
}

function taskOwnsFile(task: NonNullable<WorkflowState["implDag"]>[number], file: string, cwd: string): boolean {
  const files = normalizeWorkflowPaths([...(task.expectedFiles ?? []), ...(task.expectedTests ?? [])], cwd)
  return files.includes(file)
}

export function precheckReviewArtifactAllowlistExpansion(args: {
  state: WorkflowState
  cwd: string
  effectiveAllowlist: string[]
  missingFiles: string[]
}): ReviewArtifactAllowlistExpansionCandidate {
  const { state, cwd } = args
  if (state.mode !== "INCREMENTAL") return { success: false, error: "Automatic reviewed-artifact allowlist expansion only applies in INCREMENTAL mode." }
  if (state.phase !== "INTERFACES" && state.phase !== "TESTS") {
    return { success: false, error: `Automatic reviewed-artifact allowlist expansion is only valid for INTERFACES or TESTS approval (current: ${state.phase}).` }
  }
  if (state.phaseState !== "USER_GATE") {
    return { success: false, error: `Automatic reviewed-artifact allowlist expansion requires USER_GATE (current: ${state.phase}/${state.phaseState}).` }
  }

  const reviewedFiles = new Set(normalizeWorkflowPaths(state.reviewArtifactFiles, cwd))
  const allowlist = new Set(normalizeWorkflowPaths(args.effectiveAllowlist, cwd))
  const files = unique(normalizeWorkflowPaths(args.missingFiles, cwd)).filter((file) => !allowlist.has(file))
  if (files.length === 0) return { success: false, error: "No reviewed artifact files need allowlist expansion." }

  for (const file of files) {
    if (!reviewedFiles.has(file)) {
      return { success: false, error: `Refusing to expand allowlist for ${file}; it is not one of the reviewed artifact files.` }
    }
    if (state.phase === "INTERFACES" && !isInterfaceFile(file)) {
      return { success: false, error: `Refusing to expand INTERFACES allowlist for non-interface file: ${file}` }
    }
    if (state.phase === "TESTS" && !isTestFile(file)) {
      return { success: false, error: `Refusing to expand TESTS allowlist for non-test file: ${file}` }
    }
  }

  const evidence: string[] = [
    `All ${files.length} file(s) are already registered in reviewArtifactFiles.`,
    `All ${files.length} file(s) satisfy the ${state.phase} phase file policy.`,
  ]

  const dag = state.implDag ?? []
  if (dag.length === 0) {
    evidence.push("No implementation DAG exists yet; expansion cannot conflict with task ownership.")
    return { success: true, files, evidence }
  }

  const implPlanAlreadyApproved = Boolean(state.approvedArtifacts.impl_plan)
  for (const file of files) {
    const owners = dag.filter((task) => taskOwnsFile(task, file, cwd))
    const completed = owners.filter((task) => task.status === "complete" || task.status === "aborted")
    if (completed.length > 0) {
      return { success: false, error: `Refusing to expand allowlist for ${file}; completed/aborted task ownership is immutable (${completed.map((task) => task.id).join(", ")}).` }
    }
    const active = owners.filter((task) => task.status === "in-flight" || task.status === "delegated" || task.status === "human-gated")
    if (active.length > 0) {
      return { success: false, error: `Refusing to expand allowlist for ${file}; it overlaps active or delegated task ownership (${active.map((task) => task.id).join(", ")}).` }
    }
    if (owners.length > 1) {
      return { success: false, error: `Refusing to expand allowlist for ${file}; multiple DAG tasks claim it (${owners.map((task) => task.id).join(", ")}).` }
    }
    if (implPlanAlreadyApproved && owners.length === 0) {
      return { success: false, error: `Refusing to expand allowlist for ${file}; the approved IMPL_PLAN does not assign it to a future task.` }
    }
  }

  evidence.push("Implementation DAG ownership check passed: no completed, active, delegated, or overlapping task ownership conflicts.")
  return { success: true, files, evidence }
}

export function buildReviewArtifactAllowlistExpansionPrompt(args: {
  state: WorkflowState
  cwd: string
  files: string[]
  evidence: string[]
}): string {
  const { state, files, evidence } = args
  const lines: string[] = []
  lines.push("You are an isolated Open Artisan scope-expansion reviewer.")
  lines.push("Review whether a failed INCREMENTAL artifact approval may safely expand the allowlist for the listed reviewed artifact files.")
  lines.push("Approve only if BOTH conditions are true:")
  lines.push("1. The expansion is architecturally sound for the approved feature/artifact and is not disguised implementation or unrelated scope creep.")
  lines.push("2. The expansion does not create an implementation execution-DAG ownership, ordering, or completed-task immutability problem.")
  lines.push("")
  lines.push("## Workflow Context")
  lines.push(`Feature: ${state.featureName ?? "(none)"}`)
  lines.push(`Current state: ${state.phase}/${state.phaseState}`)
  lines.push(`Mode: ${state.mode ?? "unknown"}`)
  lines.push(`Current task: ${state.currentTaskId ?? "(none)"}`)
  lines.push("")
  lines.push("## Files Proposed For Allowlist Expansion")
  lines.push(files.map((file) => `- ${file}`).join("\n"))
  lines.push("")
  lines.push("## Structural Precheck Evidence")
  lines.push(evidence.map((item) => `- ${item}`).join("\n"))
  if (state.implDag && state.implDag.length > 0) {
    lines.push("")
    lines.push("## Implementation DAG")
    lines.push(state.implDag.map((task) => {
      const filesForTask = [...(task.expectedFiles ?? []), ...(task.expectedTests ?? [])]
      return `- ${task.id} [${task.status}]: ${task.description}; files: ${filesForTask.join(", ") || "(none)"}`
    }).join("\n"))
  }
  lines.push("")
  lines.push("## Decision Rules")
  lines.push("- The approved_files array must contain exactly the proposed files if approved.")
  lines.push("- Reject if any file is unrelated to the current artifact or feature intent.")
  lines.push("- Reject if any file would require revising task ordering, ownership, or completed task boundaries.")
  lines.push("- Reject if you cannot confidently determine architectural fit from the artifact/file paths and workflow context.")
  lines.push("")
  lines.push("Return ONLY JSON matching this schema:")
  lines.push(JSON.stringify({
    approved: true,
    architecturally_sound: true,
    dag_safe: true,
    confidence: "high",
    reason: "The reviewed test file is within the approved TESTS artifact scope and does not affect execution DAG ownership.",
    approved_files: files,
    rejected_files: [],
  }, null, 2))
  return lines.join("\n")
}

function extractDecisionPayload(raw: unknown): unknown {
  if (typeof raw === "string") return JSON.parse(extractJsonFromText(raw))
  if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>
    if ("approved" in candidate && "architecturally_sound" in candidate && "dag_safe" in candidate) return raw
    const text = extractTextFromPromptResult(raw, "Review Artifact Allowlist Expansion")
    return JSON.parse(extractJsonFromText(text))
  }
  throw new Error(`Unsupported reviewed-artifact allowlist expansion review result: ${typeof raw}`)
}

export function parseReviewArtifactAllowlistExpansionDecision(raw: unknown): ReviewArtifactAllowlistExpansionReviewResult {
  try {
    const parsed = extractDecisionPayload(raw)
    const schema = ReviewArtifactAllowlistExpansionDecisionSchema.safeParse(parsed)
    if (!schema.success) return { success: false, error: schema.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ") }
    return { success: true, decision: schema.data, prompt: "" }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function validateReviewArtifactAllowlistExpansionDecision(args: {
  files: string[]
  decision: ReviewArtifactAllowlistExpansionDecision
  cwd: string
}): { success: true } | { success: false; error: string } {
  const files = normalizeWorkflowPaths(args.files, args.cwd)
  const approved = normalizeWorkflowPaths(args.decision.approved_files, args.cwd)
  if (!args.decision.approved || !args.decision.architecturally_sound || !args.decision.dag_safe) {
    return { success: false, error: `Scope expansion reviewer rejected the allowlist repair: ${args.decision.reason}` }
  }
  if (args.decision.confidence !== "high") {
    return { success: false, error: `Scope expansion reviewer confidence was ${args.decision.confidence}; high confidence is required for automatic allowlist repair.` }
  }
  if (!sameSet(files, approved)) {
    return { success: false, error: "Scope expansion reviewer did not approve exactly the reviewed files that failed allowlist validation." }
  }
  if (args.decision.rejected_files.length > 0) {
    return { success: false, error: `Scope expansion reviewer rejected file(s): ${args.decision.rejected_files.join(", ")}` }
  }
  return { success: true }
}

async function ephemeralScopeExpansionReviewPrompt(
  dispatcher: SubagentDispatcher,
  prompt: string,
  parentSessionId?: string,
  parentModel?: string | { modelID: string; providerID?: string },
): Promise<unknown> {
  const session = await dispatcher.createSession({
    title: "Review Artifact Allowlist Expansion",
    agent: "workflow-reviewer",
    ...(parentSessionId ? { parentId: parentSessionId } : {}),
    ...(parentModel ? { model: parentModel } : {}),
  })
  try {
    return await session.prompt(prompt, {
      responseFormat: {
        type: "json_schema",
        schema: toJsonSchema(ReviewArtifactAllowlistExpansionDecisionSchema),
      },
    })
  } finally {
    await session.destroy()
  }
}

export async function dispatchReviewArtifactAllowlistExpansionReview(
  dispatcher: SubagentDispatcher,
  req: {
    state: WorkflowState
    cwd: string
    files: string[]
    evidence: string[]
    parentSessionId?: string
    parentModel?: string | { modelID: string; providerID?: string }
  },
): Promise<ReviewArtifactAllowlistExpansionReviewResult> {
  const prompt = buildReviewArtifactAllowlistExpansionPrompt(req)
  try {
    const raw = await withTimeout(
      ephemeralScopeExpansionReviewPrompt(dispatcher, prompt, req.parentSessionId, req.parentModel),
      CHANGE_PROPOSAL_REVIEW_TIMEOUT_MS,
      "review-artifact-allowlist-expansion",
    )
    const parsed = parseReviewArtifactAllowlistExpansionDecision(raw)
    if (!parsed.success) return parsed
    return { ...parsed, prompt }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
