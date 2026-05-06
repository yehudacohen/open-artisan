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
import { writeArtifact } from "../../core/artifact-store"
import { validateFileBasedReviewArtifacts } from "../../core/tools/file-artifact-validation"
import { parseToolArgs } from "../../core/tool-args"
import { MarkSatisfiedToolSchema, RequestReviewToolSchema } from "../../core/schemas"
import { computeMarkSatisfiedTransition, computeRequestReviewTransition } from "../../core/tools/transitions"

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

function artifactFilesHash(files: string[], cwd: string): string | null {
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

async function readCurrentArtifactHash(state: WorkflowState): Promise<string | null> {
  if (state.reviewArtifactFiles.length > 0) {
    return artifactFilesHash(state.reviewArtifactFiles, process.cwd())
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

export const handleMarkSatisfied: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.capabilities.selfReview !== "agent-only") {
    return subagentError("mark_satisfied", "the self-review subagent (SubagentDispatcher)")
  }
  const state = requireState(ctx, toolCtx.sessionId)
  const currentArtifactHash = await readCurrentArtifactHash(state)
  if (state.reviewArtifactHash && currentArtifactHash && state.reviewArtifactHash !== currentArtifactHash) {
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

  const validReviewStates = new Set(["DRAFT", "CONVENTIONS", "REVISE", "REVIEW"])
  if (!validReviewStates.has(state.phaseState)) {
    return `Error: request_review can only be called in DRAFT, CONVENTIONS, REVISE, or REVIEW state (current: ${state.phase}/${state.phaseState}).`
  }
  if (Object.prototype.hasOwnProperty.call(args, "artifact_content")) {
    return "Error: request_review no longer accepts artifact_content; write the artifact to disk and pass artifact_files instead."
  }
  const parsedArgs = parseToolArgs(RequestReviewToolSchema, args)
  if (!parsedArgs.success) return `Error: ${parsedArgs.error}`

  if (state.phaseState === "REVIEW") {
    let artifactFiles = parsedArgs.data.artifact_files.map((file) =>
      file.startsWith("/") ? file : resolve(toolCtx.directory, file),
    )
    const artifactKey = PHASE_TO_ARTIFACT[state.phase]
    const artifactMarkdown = parsedArgs.data.artifact_markdown
    if (artifactMarkdown?.trim()) {
      if (!artifactKey || !["DISCOVERY", "PLANNING", "IMPL_PLAN"].includes(state.phase)) {
        return "Error: artifact_markdown is only supported for DISCOVERY, PLANNING, and IMPL_PLAN markdown artifacts."
      }
      artifactFiles = [await writeArtifact(toolCtx.directory, artifactKey, artifactMarkdown, state.featureName)]
    }
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

    const artifactDiskPath = artifactKey && artifactKey !== "implementation" ? artifactFiles[0] ?? null : null
    const reviewHash = artifactFilesHash(artifactFiles, toolCtx.directory)

    await store.update(toolCtx.sessionId, (draft) => {
      draft.retryCount = 0
      draft.latestReviewResults = null
      if (reviewHash) draft.reviewArtifactHash = reviewHash
      if (artifactDiskPath && artifactKey) {
        draft.artifactDiskPaths[artifactKey] = artifactDiskPath
      }
      draft.reviewArtifactFiles = artifactFiles
    })

    const diskMsg = artifactDiskPath ? ` Artifact updated at ${artifactDiskPath}.` : ""
    const filesMsg = artifactFiles.length ? ` Registered ${artifactFiles.length} review file(s).` : ""
    return `Artifact re-submitted for ${state.phase} review.${diskMsg}${filesMsg}`
  }

  const transition = computeRequestReviewTransition(state, ctx.engine!.sm)
  if (!transition.success) return `Error: ${transition.error}`
  const t = transition.transition

  const artifactKey = PHASE_TO_ARTIFACT[state.phase]
  let artifactFiles = parsedArgs.data.artifact_files.map((file) =>
    file.startsWith("/") ? file : resolve(toolCtx.directory, file),
  )
  const artifactMarkdown = parsedArgs.data.artifact_markdown
  if (artifactMarkdown?.trim()) {
    if (!artifactKey || !["DISCOVERY", "PLANNING", "IMPL_PLAN"].includes(state.phase)) {
      return "Error: artifact_markdown is only supported for DISCOVERY, PLANNING, and IMPL_PLAN markdown artifacts."
    }
    artifactFiles = [await writeArtifact(toolCtx.directory, artifactKey, artifactMarkdown, state.featureName)]
  }
  const artifactValidationError = validateFileBasedReviewArtifacts({
    phase: state.phase,
    artifactFiles,
    cwd: toolCtx.directory,
    featureName: state.featureName,
  })
  if (artifactValidationError) return `Error: ${artifactValidationError}`
  const artifactDiskPath = artifactKey && artifactKey !== "implementation" ? artifactFiles[0] ?? null : null
  const reviewHash = artifactFilesHash(artifactFiles, toolCtx.directory)

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.retryCount = 0
    draft.latestReviewResults = null
    draft.reviewArtifactHash = null
    if (artifactDiskPath && artifactKey) {
      draft.artifactDiskPaths[artifactKey] = artifactDiskPath
    }
    if (reviewHash) {
      draft.reviewArtifactHash = reviewHash
    }
    draft.reviewArtifactFiles = artifactFiles
  })

  const diskMsg = artifactDiskPath ? ` Artifact written to ${artifactDiskPath}.` : ""
  return `Artifact submitted for review. Transitioning to ${t.nextPhase}/${t.nextPhaseState}.${diskMsg}`
}
