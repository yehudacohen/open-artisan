/**
 * submit-feedback.ts — The `submit_feedback` tool definition.
 *
 * The agent calls this when a user response has been received at a USER_GATE.
 * The plugin's chat-message hook provides routing hints to the agent; the agent
 * then calls this tool to formally record the user's decision.
 *
 * - feedback_type="approve": triggers `user_approve` event → advances to next phase
 *   (+ git checkpoint)
 * - feedback_type="revise": triggers `user_feedback` event → orchestrator routes
 *   to appropriate REVISE state
 */
import type { WorkflowState } from "../workflow-state-types"
import type { PhaseState, WorkflowMode } from "../workflow-primitives"
import type { SubmitFeedbackArgs } from "../tool-types"
import { looksLikeUserGateMetaQuestion } from "../hooks/chat-message"
import { createImplDAG, type TaskNode } from "../dag"
import { nextSchedulerDecisionForInput, readDecisionInput, resolveHumanGate, type SchedulerDecision } from "../scheduler"
import { resolve } from "node:path"
import { parseImplPlan, validateExecutableImplPlan } from "../impl-plan-parser"

export const SUBMIT_FEEDBACK_DESCRIPTION = `
Call this tool to record the user's response at a review gate.

- feedback_type="approve": the user approved the artifact — this creates a git checkpoint
  and advances to the next phase.
- feedback_type="revise": the user wants changes — the feedback will be routed through the
  orchestrator to identify which artifacts need revision.

Only call this tool in USER_GATE state, after the user has provided their response.
Do NOT call this tool to simulate approval — only after the user has actually responded.
`.trim()

export interface SubmitFeedbackResult {
  feedbackType: "approve" | "revise"
  responseMessage: string
  /** The user's raw feedback text, for passing to the orchestrator on revise */
  feedbackText: string
}

export function stripWorkflowRoutingNotes(text: string): string {
  return text
    .replace(/\[WORKFLOW (?:GATE|ESCAPE HATCH) — IMMEDIATE ACTION REQUIRED\][\s\S]*?(?=(?:\n\s*){2,}|$)/g, "")
    .replace(/The user has (?:approved|provided feedback on)[\s\S]*?Do NOT (?:do anything else first|do research or analysis first)\.?/g, "")
    .trim()
}

export function isUserGateMetaFeedback(text: string): boolean {
  return looksLikeUserGateMetaQuestion(stripWorkflowRoutingNotes(text))
}

export function isEscapeHatchClarificationFeedback(text: string): boolean {
  const normalized = stripWorkflowRoutingNotes(text).trim().toLowerCase().replace(/\s+/g, " ")
  return (
    /\bwhat\s+(is|does)\s+(the\s+)?escape\s+hatch\b/.test(normalized) ||
    /\bwhat\s+are\s+(my|the)\s+options\b/.test(normalized) ||
    /\b(can|could)\s+you\s+(explain|summarize)\s+(the\s+)?escape\s+hatch\b/.test(normalized) ||
    /\bwhat\s+happens\s+if\b/.test(normalized)
  )
}

export function validateSubmitFeedbackGate(phaseState: PhaseState): string | null {
  if (phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH" || phaseState === "HUMAN_GATE") {
    return null
  }
  return `submit_feedback can only be called at USER_GATE, ESCAPE_HATCH, or HUMAN_GATE (current: ${phaseState}).`
}

export function buildSubmitFeedbackClarificationMessage(
  feedbackType: "approve" | "revise",
  phaseState: PhaseState,
  feedbackText: string,
): string | null {
  if (feedbackType === "revise" && phaseState === "USER_GATE" && isUserGateMetaFeedback(feedbackText)) {
    return (
      "That message looks like a clarification/status question, not artifact revision feedback. " +
      "Do not change workflow state; answer the user's question normally and continue waiting at USER_GATE for an explicit approval or revision request."
    )
  }
  if (feedbackType === "revise" && phaseState === "ESCAPE_HATCH" && isEscapeHatchClarificationFeedback(feedbackText)) {
    return (
      "That message looks like an escape-hatch clarification question, not an escape-hatch decision. " +
      "Do not change workflow state; explain the options normally and continue waiting at ESCAPE_HATCH for an explicit decision."
    )
  }
  return null
}

export function buildSelfApprovalBlockedMessage(): string {
  return (
    "Error: Waiting for user response. Present your artifact summary and " +
    "wait for the user to respond before calling submit_feedback. " +
    "The user must review and decide — you cannot self-approve."
  )
}

export function normalizeApprovalFilePaths(paths: string[] | undefined, cwd: string): string[] {
  return (paths ?? []).map((path) => (path.startsWith("/") ? path : resolve(cwd, path)))
}

export function findReviewedArtifactFilesOutsideAllowlist(args: {
  reviewArtifactFiles: string[]
  artifactDiskPaths: WorkflowState["artifactDiskPaths"]
  allowlist: string[]
  cwd: string
}): string[] {
  if (args.reviewArtifactFiles.length === 0) return []
  const normalizedAllowlist = new Set(normalizeApprovalFilePaths(args.allowlist, args.cwd))
  const artifactPaths = new Set(
    Object.values(args.artifactDiskPaths)
      .filter((path): path is string => typeof path === "string"),
  )
  return args.reviewArtifactFiles
    .map((path) => (path.startsWith("/") ? path : resolve(args.cwd, path)))
    .filter((path) => !artifactPaths.has(path))
    .filter((path) => !normalizedAllowlist.has(path))
}

export function validateSubmitFeedbackImplPlanApproval(args: {
  planContent: string
  mode: WorkflowMode | null
  effectiveAllowlist: string[]
  cwd: string
  parseFixInstruction: string
}): string | null {
  const parseCheck = parseImplPlan(args.planContent)
  if (!parseCheck.success) {
    return `Failed to parse implementation plan into DAG: ${parseCheck.errors.join("; ")}. ${args.parseFixInstruction}`
  }
  const contractErrors = validateExecutableImplPlan(args.planContent, args.mode, args.effectiveAllowlist, args.cwd)
  if (contractErrors.length > 0) {
    return (
      `IMPL_PLAN approval failed executable-contract validation: ${contractErrors.join("; ")}. ` +
      "Fix the plan metadata or expand the approved allowlist before approving this implementation plan."
    )
  }
  return null
}

export function materializeImplPlanDag(planContent: string): { nodes: TaskNode[]; currentTaskId: string | null } | null {
  const parseResult = parseImplPlan(planContent)
  if (!parseResult.success) return null
  const nodes = Array.from(parseResult.dag.tasks).map((task) => ({ ...task }))
  const firstReady = nodes.find((task) => task.status === "pending" && task.dependencies.length === 0)
  return { nodes, currentTaskId: firstReady?.id ?? null }
}

export function findUnresolvedHumanGates(state: Pick<WorkflowState, "implDag">): TaskNode[] {
  return (state.implDag ?? []).filter(
    (task) => task.status === "human-gated" && (!task.humanGate || !task.humanGate.resolved),
  )
}

export interface SubmitFeedbackHumanGateResolution {
  resolvedIds: string[]
  updatedNodes: TaskNode[]
  remainingGates: TaskNode[]
  nextDecision: SchedulerDecision
}

export function resolveSubmitFeedbackHumanGates(
  state: Pick<WorkflowState, "implDag" | "concurrency">,
  resolvedHumanGates: string[],
): { success: true; resolution: SubmitFeedbackHumanGateResolution } | { success: false; error: string } {
  if (!state.implDag) {
    return { success: false, error: "No implementation DAG found while resolving human gates." }
  }

  const dag = createImplDAG(Array.from(state.implDag))
  const resolvedIds: string[] = []
  const errors: string[] = []

  for (const gateId of resolvedHumanGates) {
    const resolved = resolveHumanGate(dag, gateId)
    if (resolved) {
      resolvedIds.push(gateId)
    } else {
      const task = Array.from(dag.tasks).find((candidate) => candidate.id === gateId)
      if (!task) errors.push(`Task "${gateId}" not found in DAG`)
      else if (task.status !== "human-gated") errors.push(`Task "${gateId}" is not human-gated (status: ${task.status})`)
    }
  }

  if (errors.length > 0) {
    return { success: false, error: `Error resolving human gates:\n${errors.map((error) => `  - ${error}`).join("\n")}` }
  }

  const updatedNodes = Array.from(dag.tasks).map((task) => ({
    ...task,
    ...(task.humanGate ? { humanGate: { ...task.humanGate } } : {}),
  }))
  const remainingGates = updatedNodes.filter(
    (task) => task.status === "human-gated" && (!task.humanGate || !task.humanGate.resolved),
  )
  const evaluation = nextSchedulerDecisionForInput(readDecisionInput({
    implDag: updatedNodes,
    concurrency: state.concurrency,
  }))

  return {
    success: true,
    resolution: {
      resolvedIds,
      updatedNodes,
      remainingGates,
      nextDecision: evaluation.decision,
    },
  }
}

/**
 * Processes and validates the submit_feedback arguments.
 */
export function processSubmitFeedback(args: SubmitFeedbackArgs): SubmitFeedbackResult {
  const feedbackText = stripWorkflowRoutingNotes(args.feedback_text)
  // Validate feedback_type — unknown values should not silently fall through to "revise"
  if (args.feedback_type !== "approve" && args.feedback_type !== "revise") {
    return {
      feedbackType: "revise",
      feedbackText,
      responseMessage: `Warning: Unknown feedback_type "${args.feedback_type}" — treating as "revise". Valid values: "approve", "revise".`,
    }
  }

  if (args.feedback_type === "approve") {
    return {
      feedbackType: "approve",
      feedbackText,
      responseMessage: buildApproveMessage(),
    }
  }

  return {
    feedbackType: "revise",
    feedbackText,
    responseMessage: buildReviseMessage(feedbackText),
  }
}

function buildApproveMessage(): string {
  return (
    `Approval recorded. Creating git checkpoint... ` +
    `Once the checkpoint is created, the workflow will advance to the next phase. ` +
    `Begin the next phase immediately; do not stop, summarize, or wait for user input unless the next state is a user-facing gate or terminal state.`
  )
}

function buildReviseMessage(feedbackText: string): string {
  return (
    `Feedback recorded: "${feedbackText.slice(0, 200)}${feedbackText.length > 200 ? "..." : ""}"\n\n` +
    `Transitioning to REVISE state. Begin revision work now based on the feedback above.`
  )
}
