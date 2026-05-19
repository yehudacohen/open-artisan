import { JSONRPCErrorException } from "json-rpc-2.0"

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import type { ToolHandler } from "./tool-handler-types"
import { PHASE_TO_ARTIFACT } from "../../core/artifacts"
import { validateFileBasedReviewArtifacts } from "../../core/tools/file-artifact-validation"
import { validatePlannedReviewedInterfaceArtifacts } from "../../core/tools/planning-interface-artifacts"
import { extractApprovedFileAllowlist } from "../../core/tools/plan-allowlist"
import { parseToolArgs } from "../../core/tool-args"
import { MarkSatisfiedToolSchema, RequestReviewToolSchema } from "../../core/schemas"
import { computeMarkSatisfiedTransition, computeRequestReviewTransition } from "../../core/tools/transitions"
import { createImplDAG } from "../../core/dag"
import { parseImplPlan, validateExecutableImplPlan } from "../../core/impl-plan-parser"
import { parseRequestReviewArtifactData } from "../../core/tools/request-review"
import { buildReviewArtifactSubmission, recordReviewArtifactSubmission } from "../../core/tools/review-artifact-submissions"

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

function subagentError(toolName: string, feature: string): string {
  return (
    `Error: ${toolName} requires ${feature}. ` +
    `Use the bridge context/review submission flow or an adapter that declares this capability.`
  )
}

function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export function artifactFilesHash(files: string[], cwd: string): string | null {
  if (files.length === 0) return null
  try {
    const payload = files
      .map((file) => {
        const resolvedPath = file.startsWith("/") ? file : resolve(cwd, file)
        return `${resolvedPath}\n${readFileSync(resolvedPath, "utf-8")}`
      })
      .join("\n---\n")
    return artifactHash(payload)
  } catch {
    return null
  }
}

async function readCurrentArtifactHash(state: WorkflowState, cwd: string): Promise<string | null> {
  if (state.reviewArtifactFiles.length > 0) {
    return artifactFilesHash(state.reviewArtifactFiles, cwd)
  }
  const artifactKey = PHASE_TO_ARTIFACT[state.phase]
  if (!artifactKey) return null
  const artifactPath = state.artifactDiskPaths[artifactKey]
  if (!artifactPath) return null
  try {
    const content = await readFile(artifactPath, "utf-8")
    return artifactHash(content)
  } catch {
    return null
  }
}

function classifyReviewResubmission(previousHash: string | null, nextHash: string | null): "changed" | "unchanged" | "unknown" {
  if (!previousHash || !nextHash) return "unknown"
  return previousHash === nextHash ? "unchanged" : "changed"
}

function resolveReviewFile(file: string, cwd: string): string {
  return file.startsWith("/") ? file : resolve(cwd, file)
}

function deriveImplPlanExecutableAllowlist(state: WorkflowState, cwd: string): string[] {
  if (state.mode !== "INCREMENTAL" || state.fileAllowlist.length > 0) return state.fileAllowlist
  const planPath = state.artifactDiskPaths.plan
  if (!planPath) return state.fileAllowlist
  try {
    return extractApprovedFileAllowlist(readFileSync(planPath, "utf-8"), cwd)
  } catch {
    return state.fileAllowlist
  }
}

function validateImplPlanExecutableContract(state: WorkflowState, planContent: string, cwd: string): string[] {
  const errors: string[] = []
  const parseCheck = parseImplPlan(planContent)
  if (!parseCheck.success) {
    errors.push(`Failed to parse implementation plan into DAG: ${parseCheck.errors.join("; ")}`)
  }
  errors.push(...validateExecutableImplPlan(
    planContent,
    state.mode,
    deriveImplPlanExecutableAllowlist(state, cwd),
    cwd,
  ))
  return errors
}

function readImplPlanReviewArtifact(state: WorkflowState, cwd: string, artifactFiles?: string[]): { source: string; content: string } | { error: string } {
  const source = artifactFiles?.[0] ?? state.reviewArtifactFiles[0] ?? state.artifactDiskPaths.impl_plan
  if (!source) return { error: "IMPL_PLAN review requires a concrete impl-plan.md artifact file." }
  const resolvedPath = resolveReviewFile(source, cwd)
  try {
    return { source: resolvedPath, content: readFileSync(resolvedPath, "utf-8") }
  } catch (error) {
    return { error: `Unable to read IMPL_PLAN artifact ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function validateImplPlanReviewArtifact(state: WorkflowState, cwd: string, artifactFiles?: string[]): string | null {
  if (state.phase !== "IMPL_PLAN") return null
  const artifact = readImplPlanReviewArtifact(state, cwd, artifactFiles)
  if ("error" in artifact) return artifact.error
  const errors = validateImplPlanExecutableContract(state, artifact.content, cwd)
  if (errors.length === 0) return null
  return `${artifact.source}: ${errors.join("; ")}`
}

function validatePlanningReviewArtifact(state: WorkflowState, cwd: string, artifactFiles?: string[]): string | null {
  if (state.phase !== "PLANNING") return null
  const source = artifactFiles?.[0] ?? state.reviewArtifactFiles[0] ?? state.artifactDiskPaths.plan
  if (!source) return "PLANNING review requires a concrete plan.md artifact file."
  const resolvedPath = resolveReviewFile(source, cwd)
  let content: string
  try {
    content = readFileSync(resolvedPath, "utf-8")
  } catch (error) {
    return `Unable to read PLANNING artifact ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`
  }
  const errors = validatePlannedReviewedInterfaceArtifacts(content)
  if (errors.length === 0) return null
  return `${resolvedPath}: ${errors.join("; ")}`
}

export function buildImplPlanExecutableContractFailureCriterion(state: WorkflowState, cwd: string): {
  criterion: string
  met: boolean
  evidence: string
  severity: "blocking"
} | null {
  const error = validateImplPlanReviewArtifact(state, cwd)
  if (!error) return null
  return {
    criterion: "IMPL_PLAN executable-contract validation",
    met: false,
    evidence: error,
    severity: "blocking",
  }
}

export const handleMarkSatisfied: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.capabilities.selfReview !== "agent-only") {
    return subagentError("mark_satisfied", "the self-review subagent (SubagentDispatcher)")
  }
  const state = requireState(ctx, toolCtx.sessionId)
  const currentArtifactHash = await readCurrentArtifactHash(state, toolCtx.directory)
  if (state.reviewArtifactHash && (!currentArtifactHash || state.reviewArtifactHash !== currentArtifactHash)) {
    return (
      "Error: The artifact changed after it was submitted for review. " +
      "Call `request_review` again so the reviewer evaluates the current artifact instead of stale content."
    )
  }
  const parsedArgs = parseToolArgs(MarkSatisfiedToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const criteria = parsedArgs.data.criteria_met.map((item) => ({
    criterion: item.criterion,
    met: item.met,
    evidence: item.evidence,
    ...(item.severity !== undefined ? { severity: item.severity } : {}),
    ...(item.score !== undefined ? { score: item.score } : {}),
  }))
  const implPlanContractFailure = buildImplPlanExecutableContractFailureCriterion(state, toolCtx.directory)
  if (implPlanContractFailure) criteria.push(implPlanContractFailure)
  const result = computeMarkSatisfiedTransition(criteria, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  const t = result.transition
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.iterationCount = t.nextIterationCount
    draft.retryCount = 0
    draft.latestReviewResults = t.latestReviewResults
    if (t.clearReviewArtifactHash) draft.reviewArtifactHash = null
    if (t.resetUserGateMessage) draft.userGateMessageReceived = false
    if (t.clearRevisionBaseline) draft.revisionBaseline = null
  })
  return t.responseMessage
}

export const handleRequestReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  const validReviewStates = new Set(["DRAFT", "REDRAFT", "CONVENTIONS", "REVISE", "REVIEW"])
  if (!validReviewStates.has(state.phaseState)) {
    return `Error: request_review can only be called in DRAFT, REDRAFT, CONVENTIONS, REVISE, or REVIEW state (current: ${state.phase}/${state.phaseState}).`
  }
  if (Object.prototype.hasOwnProperty.call(args, "artifact_content")) {
    return "Error: request_review no longer accepts artifact_content; write the artifact to disk and pass artifact_files instead."
  }
  if (Object.prototype.hasOwnProperty.call(args, "artifact_markdown")) {
    return "Error: request_review no longer accepts artifact_markdown; write the markdown artifact to disk and pass artifact_files instead."
  }
  const parsedArgs = parseToolArgs(RequestReviewToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
  const artifactData = parseRequestReviewArtifactData(parsedArgs.data)
  if (!artifactData.success) return `Error: ${artifactData.error}`

  if (state.phaseState === "REVIEW") {
    let artifactFiles = parsedArgs.data.artifact_files.map((file) =>
      file.startsWith("/") ? file : resolve(toolCtx.directory, file),
    )
    const artifactKey = PHASE_TO_ARTIFACT[state.phase]
    if (artifactFiles.length === 0) {
      return "Error: request_review at REVIEW state requires artifact_files so the review source of truth can be updated."
    }

    const artifactValidationError = validateFileBasedReviewArtifacts({
      phase: state.phase,
      artifactFiles,
      cwd: toolCtx.directory,
      featureName: state.featureName,
    })
    if (artifactValidationError) return `Error: ${artifactValidationError}`
    const planningContractError = validatePlanningReviewArtifact(state, toolCtx.directory, artifactFiles)
    if (planningContractError) {
      return `Error: PLANNING review failed interface-artifact validation: ${planningContractError}. Fix the plan so reviewed INTERFACES artifacts are phase-legal, or label non-interface files as supporting dependencies before re-submitting request_review.`
    }
    const implPlanContractError = validateImplPlanReviewArtifact(state, toolCtx.directory, artifactFiles)
    if (implPlanContractError) {
      return `Error: IMPL_PLAN review failed executable-contract validation: ${implPlanContractError}. Fix the plan metadata and re-submit request_review with corrected artifact_files.`
    }

    const artifactDiskPath = artifactKey && artifactKey !== "implementation" ? artifactFiles[0] ?? null : null
    const reviewHash = artifactFilesHash(artifactFiles, toolCtx.directory)
    const resubmissionKind = classifyReviewResubmission(state.reviewArtifactHash, reviewHash)

    await store.update(toolCtx.sessionId, (draft) => {
      draft.retryCount = 0
      draft.latestReviewResults = null
      if (resubmissionKind === "changed") draft.iterationCount = 0
      if (reviewHash) draft.reviewArtifactHash = reviewHash
      if (artifactDiskPath && artifactKey) {
        draft.artifactDiskPaths[artifactKey] = artifactDiskPath
      }
      draft.reviewArtifactFiles = artifactFiles
      recordReviewArtifactSubmission(draft, buildReviewArtifactSubmission({
        phase: state.phase,
        ...(artifactKey ? { artifactKey } : {}),
        summary: parsedArgs.data.summary,
        artifactDescription: parsedArgs.data.artifact_description,
        artifactFiles,
        artifactData: artifactData.artifactData,
      }))
    })

    const diskMsg = artifactDiskPath ? ` Artifact updated at ${artifactDiskPath}.` : ""
    const filesMsg = artifactFiles.length ? ` Registered ${artifactFiles.length} review file(s).` : ""
    const kindMsg = resubmissionKind === "changed" ? " Content changed; review iteration count reset." : ""
    return `Artifact re-submitted for ${state.phase} review.${diskMsg}${filesMsg}${kindMsg}`
  }

  if (state.phase === "IMPLEMENTATION" && state.implDag && state.implDag.length > 0) {
    const dag = createImplDAG(Array.from(state.implDag))
    if (!dag.isComplete()) {
      const tasks = Array.from(dag.tasks)
      const agentIncomplete = tasks.filter((task) => task.status !== "complete" && task.status !== "aborted")
      if (agentIncomplete.length > 0) {
        const complete = tasks.filter((task) => task.status === "complete").length
        const pendingList = agentIncomplete.map((task) => `  - ${task.id}: ${task.description} (${task.status})`).join("\n")
        return (
          `Error: Cannot request review — ${complete}/${tasks.length} DAG tasks are complete. ` +
          "All DAG tasks must be complete or explicitly aborted before requesting final implementation review.\n\n" +
          `**Remaining tasks:**\n${pendingList}\n\n` +
          "Complete agent tasks with `mark_task_complete`; resolve human-gated tasks before requesting final review."
        )
      }
    }
  }

  const transition = computeRequestReviewTransition(state, ctx.engine!.sm)
  if (!transition.success) return `Error: ${transition.error}`
  const t = transition.transition

  const artifactKey = PHASE_TO_ARTIFACT[state.phase]
  let artifactFiles = parsedArgs.data.artifact_files.map((file) =>
    file.startsWith("/") ? file : resolve(toolCtx.directory, file),
  )
  const artifactValidationError = validateFileBasedReviewArtifacts({
    phase: state.phase,
    artifactFiles,
    cwd: toolCtx.directory,
    featureName: state.featureName,
  })
  if (artifactValidationError) return `Error: ${artifactValidationError}`
  const planningContractError = validatePlanningReviewArtifact(state, toolCtx.directory, artifactFiles)
  if (planningContractError) {
    return `Error: PLANNING review failed interface-artifact validation: ${planningContractError}. Fix the plan so reviewed INTERFACES artifacts are phase-legal, or label non-interface files as supporting dependencies before re-submitting request_review.`
  }
  const implPlanContractError = validateImplPlanReviewArtifact(state, toolCtx.directory, artifactFiles)
  if (implPlanContractError) {
    return `Error: IMPL_PLAN review failed executable-contract validation: ${implPlanContractError}. Fix the plan metadata and re-submit request_review with corrected artifact_files.`
  }
  const artifactDiskPath = artifactKey && artifactKey !== "implementation" ? artifactFiles[0] ?? null : null
  const reviewHash = artifactFilesHash(artifactFiles, toolCtx.directory)

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.retryCount = 0
    draft.latestReviewResults = null
    draft.backtrackContext = null
    draft.reviewArtifactHash = null
    if (artifactDiskPath && artifactKey) {
      draft.artifactDiskPaths[artifactKey] = artifactDiskPath
    }
    if (reviewHash) {
      draft.reviewArtifactHash = reviewHash
    }
    draft.reviewArtifactFiles = artifactFiles
    recordReviewArtifactSubmission(draft, buildReviewArtifactSubmission({
      phase: state.phase,
      ...(artifactKey ? { artifactKey } : {}),
      summary: parsedArgs.data.summary,
      artifactDescription: parsedArgs.data.artifact_description,
      artifactFiles,
      artifactData: artifactData.artifactData,
    }))
  })

  const diskMsg = artifactDiskPath ? ` Artifact written to ${artifactDiskPath}.` : ""
  return `Artifact submitted for review. Transitioning to ${t.nextPhase}/${t.nextPhaseState}.${diskMsg}`
}
