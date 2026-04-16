/**
 * tool-execute.ts — Bridge tool execution dispatcher.
 *
 * Routes tool.execute JSON-RPC calls to per-tool handlers. Each handler
 * implements a simplified version of the adapter's orchestration:
 * state lookup → validation → transition → store update → response.
 *
 * IMPORTANT: The authoritative tool implementations are in the OpenCode adapter
 * (.opencode/plugins/open-artisan/index.ts). The bridge handlers are simplified
 * versions that omit platform-specific features (git checkpoints, SubagentDispatcher
 * calls, design doc detection, fast-forward). A future refactor should extract
 * shared orchestration into packages/core/engine.ts so both share the same logic.
 *
 * Tools that need SubagentDispatcher (self-review, orchestrator, discovery)
 * return descriptive errors in bridge mode. Basic operations (transitions,
 * state updates, artifact writes) work without SubagentDispatcher.
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import type { MethodHandler, BridgeContext } from "../server"
import type { ToolExecuteParams } from "../protocol"
import { SESSION_NOT_FOUND, INVALID_PARAMS } from "../protocol"
import type { WorkflowState } from "../../core/types"

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { parseSelectModeArgs } from "../../core/tools/select-mode"
import { processMarkScanComplete } from "../../core/tools/mark-scan-complete"
import { processMarkTaskComplete } from "../../core/tools/mark-task-complete"
import { buildTaskReviewPrompt, parseTaskReviewResult } from "../../core/task-review"
import type { AdjacentTask } from "../../core/task-review"
import { MAX_TASK_REVIEW_ITERATIONS } from "../../core/constants"
import { processQueryParentWorkflow, processQueryChildWorkflow } from "../../core/tools/query-workflow"
import {
  computeMarkSatisfiedTransition,
  computeMarkAnalyzeCompleteTransition,
  computeSubmitFeedbackReviseTransition,
  computeProposeBacktrackTransition,
} from "../../core/tools/transitions"
import { buildAutoApprovePrompt, parseAutoApproveResult } from "../../core/auto-approve"
import { createGitCheckpoint } from "../../core/hooks/git-checkpoint"
import type { AutoApproveResult } from "../../core/auto-approve"
import { extractApprovedFileAllowlist } from "../../core/tools/plan-allowlist"
import { writeArtifact } from "../../core/artifact-store"
import { parseImplPlan } from "../../core/impl-plan-parser"
import { PHASE_TO_ARTIFACT } from "../../core/artifacts"
import { createImplDAG } from "../../core/dag"
import { nextSchedulerDecision, nextSchedulerDecisionForInput, readDecisionInput, resolveHumanGate } from "../../core/scheduler"
import {
  buildAutoApproveRequest,
  buildRobotArtisanAutoApproveFailureFeedback,
  computeAutoApproveTransition,
  isRobotArtisanSession,
} from "../../core/autonomous-user-gate"
import { activateHumanGateTasks, resolveAwaitingHumanState } from "../../core/human-gate-policy"
import { buildWorkflowSwitchMessage, parkCurrentWorkflowSession } from "../../core/session-switch"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolContext {
  sessionId: string
  directory: string
  agent?: string
}

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

function subagentError(toolName: string, feature: string): string {
  return (
    `Error: ${toolName} requires ${feature} which is not available in bridge mode. ` +
    `Use an in-process adapter or configure an LLM client.`
  )
}

function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function buildRuntimeSchedulerDecision(state: {
  implDag: import("../../core/dag").TaskNode[] | null
  concurrency: { maxParallelTasks: number }
}) {
  const input = readDecisionInput({ implDag: state.implDag, concurrency: state.concurrency })
  const evaluation = nextSchedulerDecisionForInput(input)
  const fallbackDecision =
    evaluation.decision.action === "unsupported" && evaluation.decision.fallback === "sequential"
      ? nextSchedulerDecision(input.dag)
      : evaluation.decision
  return { evaluation, fallbackDecision }
}

async function readCurrentArtifactHash(state: WorkflowState): Promise<string | null> {
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

/**
 * Builds the isolated review prompt for a given task, including adjacent
 * task context for integration seam checking.
 *
 * Shared by handleMarkTaskComplete (inline prompt) and
 * handleTaskGetReviewContext (bridge method).
 *
 * Returns null if the task is not found in the DAG.
 */
function buildReviewContextForTask(
  state: WorkflowState,
  taskId: string,
  directory: string,
  implementationSummary?: string,
): string | null {
  const task = state.implDag?.find((t) => t.id === taskId)
  if (!task) return null

  // Compute adjacent tasks for integration seam checking
  const adjacentTasks: AdjacentTask[] = []
  if (state.implDag) {
    for (const node of state.implDag) {
      if (node.id === task.id) continue
      if (task.dependencies.includes(node.id)) {
        adjacentTasks.push({
          id: node.id,
          description: node.description,
          ...(node.category ? { category: node.category } : {}),
          status: node.status,
          direction: "upstream",
        })
      }
      if (node.dependencies.includes(task.id)) {
        adjacentTasks.push({
          id: node.id,
          description: node.description,
          ...(node.category ? { category: node.category } : {}),
          status: node.status,
          direction: "downstream",
        })
      }
    }
  }

  return buildTaskReviewPrompt({
    task,
    implementationSummary: implementationSummary ?? "(see task files)",
    mode: state.mode,
    cwd: directory,
    featureName: state.featureName,
    conventions: state.conventions,
    artifactDiskPaths: state.artifactDiskPaths as Record<string, string>,
    ...(adjacentTasks.length > 0 ? { adjacentTasks } : {}),
  })
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

type ToolHandler = (
  args: Record<string, unknown>,
  toolCtx: ToolContext,
  ctx: BridgeContext,
) => Promise<string>

// ---- select_mode ----

const handleSelectMode: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const parsed = parseSelectModeArgs(args)
  if ("error" in parsed) return `Error: ${parsed.error}`

  let state = requireState(ctx, toolCtx.sessionId)

  const requestedFeatureName = ((args.feature_name ?? args.feature) as string)?.trim() ?? ""
  const switchingFeatures = state.phase !== "MODE_SELECT" && state.featureName !== null && requestedFeatureName !== "" && state.featureName !== requestedFeatureName

  if (state.phase !== "MODE_SELECT" && !switchingFeatures) {
    return `Error: select_mode can only be called during MODE_SELECT (current: ${state.phase}).`
  }

  if (switchingFeatures) {
    await parkCurrentWorkflowSession(store, state)
    await store.create(toolCtx.sessionId)
    state = requireState(ctx, toolCtx.sessionId)
  }

  // Sub-workflow sessions preserve their existing featureName
  const isSubWorkflow = state.parentWorkflow !== null
  let featureName: string
  if (isSubWorkflow && state.featureName) {
    featureName = state.featureName
  } else {
    featureName = requestedFeatureName
    if (!featureName) {
      return "Error: feature_name is required."
    }
    // Validate format (same rules as validateWorkflowState)
    if (/\.\./.test(featureName)) return "Error: feature_name must not contain '..'."
    if (/[/\\]/.test(featureName)) return "Error: feature_name must not contain path separators."
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(featureName)) {
      return "Error: feature_name must start with alphanumeric and contain only alphanumeric, dots, hyphens, and underscores."
    }
    if (featureName === "sub") return 'Error: "sub" is reserved.'
  }

  // Check for existing persisted state for this feature name.
  // If prior state exists beyond MODE_SELECT, resume it under the current sessionId.
  const priorState = await store.findPersistedByFeatureName(featureName)
  if (priorState && priorState.phase !== "MODE_SELECT" && priorState.sessionId !== toolCtx.sessionId) {
    // Migrate the prior state to the current session
    await store.migrateSession(priorState.sessionId, toolCtx.sessionId)
    if (switchingFeatures) {
      return buildWorkflowSwitchMessage({
        fromFeatureName: state.featureName,
        toFeatureName: featureName,
        toPhase: priorState.phase,
        toPhaseState: priorState.phaseState,
        resumed: true,
        preservedMode: priorState.mode !== parsed.mode ? priorState.mode : null,
      })
    }
    return (
      `Resumed prior workflow for "${featureName}" at ${priorState.phase}/${priorState.phaseState}` +
      (priorState.mode !== parsed.mode ? ` (keeping original mode ${priorState.mode}).` : ".")
    )
  }

  const outcome = sm.transition("MODE_SELECT", "DRAFT", "mode_selected", parsed.mode)
  if (!outcome.success) return `Error: ${outcome.message}`

  await store.update(toolCtx.sessionId, (draft) => {
    draft.mode = parsed.mode
    draft.featureName = featureName
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.iterationCount = 0
    draft.retryCount = 0
  })

  // policyVersion bumped automatically by setPostUpdateHook on store.update
  if (switchingFeatures) {
    return buildWorkflowSwitchMessage({
      fromFeatureName: state.featureName,
      toFeatureName: featureName,
      toPhase: outcome.nextPhase,
      toPhaseState: outcome.nextPhaseState,
      resumed: false,
    })
  }
  return `Mode set to ${parsed.mode}. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}.`
}

// ---- mark_scan_complete ----

const handleMarkScanComplete: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "DISCOVERY" || state.phaseState !== "SCAN") {
    return `Error: mark_scan_complete can only be called at DISCOVERY/SCAN (current: ${state.phase}/${state.phaseState}).`
  }

  const result = processMarkScanComplete(args as any)

  const outcome = sm.transition("DISCOVERY", "SCAN", "scan_complete", state.mode)
  if (!outcome.success) return `Error: ${outcome.message}`

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.iterationCount = 0
    draft.retryCount = 0
  })

  // policyVersion bumped automatically by setPostUpdateHook on store.update
  return result.responseMessage
}

// ---- mark_analyze_complete ----

const handleMarkAnalyzeComplete: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.capabilities.discoveryFleet !== false) {
    return subagentError("mark_analyze_complete", "the discovery fleet (SubagentDispatcher)")
  }
  const state = requireState(ctx, toolCtx.sessionId)
  const result = computeMarkAnalyzeCompleteTransition(args as any, state, ctx.engine!.sm)
  if (!result.success) return `Error: ${result.error}`
  const { nextPhase, nextPhaseState, analysisSummary, responseMessage } = result.transition
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    draft.phase = nextPhase
    draft.phaseState = nextPhaseState
    draft.discoveryReport = analysisSummary
  })
  return responseMessage
}

// ---- mark_satisfied ----

const handleMarkSatisfied: ToolHandler = async (args, toolCtx, ctx) => {
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
  const rawCriteria = (args.criteria_met ?? []) as Array<{
    criterion: string; met: boolean; evidence: string;
    severity?: "blocking" | "suggestion"; score?: string | number
  }>
  const result = computeMarkSatisfiedTransition(rawCriteria, state, ctx.engine!.sm)
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

// ---- request_review ----

const handleRequestReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  const validReviewStates = new Set(["DRAFT", "CONVENTIONS", "REVISE", "REVIEW"])
  if (!validReviewStates.has(state.phaseState)) {
    return `Error: request_review can only be called in DRAFT, CONVENTIONS, REVISE, or REVIEW state (current: ${state.phase}/${state.phaseState}).`
  }

  if (state.phaseState === "REVIEW") {
    if (!(args.artifact_content as string | undefined) && !((args.artifact_files as string[] | undefined)?.length)) {
      return (
        "Error: request_review at REVIEW state requires either artifact_content " +
        "or artifact_files so the review source of truth can be updated."
      )
    }

    const artifactContent = args.artifact_content as string | undefined
    const artifactKey = PHASE_TO_ARTIFACT[state.phase]
    let artifactDiskPath: string | null = null
    if (artifactContent && artifactKey && artifactKey !== "implementation") {
      try {
        artifactDiskPath = await writeArtifact(toolCtx.directory, artifactKey, artifactContent, state.featureName)
      } catch {
        // Non-fatal
      }
    }

    let reviewHash: string | null = null
    if (artifactDiskPath) {
      try {
        const diskContent = await readFile(artifactDiskPath, "utf-8")
        reviewHash = artifactHash(diskContent)
      } catch {
        // Non-fatal
      }
    } else if (artifactContent) {
      reviewHash = artifactHash(artifactContent)
    }

    const artifactFiles = args.artifact_files as string[] | undefined
    await store.update(toolCtx.sessionId, (draft) => {
      draft.retryCount = 0
      draft.latestReviewResults = null
      if (reviewHash) draft.reviewArtifactHash = reviewHash
      if (artifactDiskPath && artifactKey) {
        draft.artifactDiskPaths[artifactKey] = artifactDiskPath
      }
      if (artifactFiles && artifactFiles.length > 0) {
        const existing = new Set(draft.reviewArtifactFiles)
        for (const f of artifactFiles) {
          if (!existing.has(f)) draft.reviewArtifactFiles.push(f)
        }
      }
    })

    const diskMsg = artifactDiskPath ? ` Artifact updated at ${artifactDiskPath}.` : ""
    const filesMsg = artifactFiles?.length ? ` Registered ${artifactFiles.length} review file(s).` : ""
    return `Artifact re-submitted for ${state.phase} review.${diskMsg}${filesMsg}`
  }

  const event = state.phaseState === "REVISE" ? "revision_complete" : "draft_complete"
  const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
  if (!outcome.success) return `Error: ${outcome.message}`

  // Write artifact to disk if content was provided
  const artifactContent = args.artifact_content as string | undefined
  const artifactKey = PHASE_TO_ARTIFACT[state.phase]
  let artifactDiskPath: string | null = null
  if (artifactContent && artifactKey && artifactKey !== "implementation") {
    try {
      artifactDiskPath = await writeArtifact(toolCtx.directory, artifactKey, artifactContent, state.featureName)
    } catch {
      // Non-fatal — disk write failure does not block the transition
    }
  }
  let reviewHash: string | null = null
  if (artifactDiskPath) {
    try {
      const diskContent = await readFile(artifactDiskPath, "utf-8")
      reviewHash = artifactHash(diskContent)
    } catch {
      // Non-fatal
    }
  } else if (artifactContent) {
    reviewHash = artifactHash(artifactContent)
  }

  // Merge agent-provided artifact_files into reviewArtifactFiles
  const artifactFiles = args.artifact_files as string[] | undefined

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.retryCount = 0
    draft.latestReviewResults = null
    draft.reviewArtifactHash = null
    if (artifactDiskPath && artifactKey) {
      draft.artifactDiskPaths[artifactKey] = artifactDiskPath
    }
    if (artifactContent) {
      draft.reviewArtifactHash = reviewHash
    }
    if (artifactFiles && artifactFiles.length > 0) {
      const existing = new Set(draft.reviewArtifactFiles)
      for (const f of artifactFiles) {
        if (!existing.has(f)) {
          draft.reviewArtifactFiles.push(f)
        }
      }
    }
  })

  // policyVersion bumped automatically by setPostUpdateHook on store.update
  const diskMsg = artifactDiskPath ? ` Artifact written to ${artifactDiskPath}.` : ""
  return `Artifact submitted for review. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}.${diskMsg}`
}

// ---- submit_feedback ----

const handleSubmitFeedback: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)
  const cwd = toolCtx.directory || process.cwd()

  if (state.phaseState !== "USER_GATE" && state.phaseState !== "ESCAPE_HATCH") {
    return `Error: submit_feedback can only be called at USER_GATE or ESCAPE_HATCH (current: ${state.phaseState}).`
  }

  // Structural enforcement: agent cannot self-approve. The user must have
  // sent a message first (detected via message.process or session resume).
  if (!state.userGateMessageReceived) {
    return (
      "Error: Waiting for user response. Present your artifact summary and " +
      "wait for the user to respond before calling submit_feedback. " +
      "The user must review and decide — you cannot self-approve."
    )
  }

  const feedbackType = args.feedback_type as string
  if (feedbackType === "approve") {
    if (state.phaseState === "ESCAPE_HATCH") {
      return "Error: Cannot approve while an escape hatch is pending."
    }

    if (
      state.phase === "IMPLEMENTATION" &&
      state.implDag &&
      (!args.resolved_human_gates || (args.resolved_human_gates as string[]).length === 0)
    ) {
      const unresolvedGates = state.implDag.filter(
        (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
      )
      if (unresolvedGates.length > 0) {
        const gateList = unresolvedGates
          .map((t) => `  - **${t.id}:** ${t.humanGate?.whatIsNeeded ?? t.description}`)
          .join("\n")
        return (
          `Cannot approve — ${unresolvedGates.length} unresolved human gate(s):\n\n` +
          `${gateList}\n\n` +
          "Please complete the required actions above, then call `submit_feedback` with `resolved_human_gates`."
        )
      }
    }

    if (state.phase === "IMPLEMENTATION" && state.implDag && args.resolved_human_gates && (args.resolved_human_gates as string[]).length > 0) {
      const dag = createImplDAG(Array.from(state.implDag))
      const resolvedIds: string[] = []
      const errors: string[] = []

      for (const gateId of args.resolved_human_gates as string[]) {
        const resolved = resolveHumanGate(dag, gateId)
        if (resolved) {
          resolvedIds.push(gateId)
        } else {
          const task = Array.from(dag.tasks).find((t) => t.id === gateId)
          if (!task) errors.push(`Task "${gateId}" not found in DAG`)
          else if (task.status !== "human-gated") errors.push(`Task "${gateId}" is not human-gated (status: ${task.status})`)
        }
      }

      if (errors.length > 0) {
        return `Error resolving human gates:\n${errors.map((e) => `  - ${e}`).join("\n")}`
      }

      const updatedNodes = Array.from(dag.tasks).map((t) => ({
        ...t,
        ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
      }))
      const { evaluation, fallbackDecision: nextDecision } = buildRuntimeSchedulerDecision({
        implDag: updatedNodes,
        concurrency: state.concurrency,
      })

      const remainingGates = Array.from(dag.tasks).filter(
        (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
      )
      if (remainingGates.length > 0) {
        await store.update(toolCtx.sessionId, (draft) => {
          draft.implDag = updatedNodes
          draft.userGateMessageReceived = false
        })
        return (
          `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
          `**${remainingGates.length} unresolved gate(s) remain.**\n\n` +
          "Please resolve these and call `submit_feedback` again with `resolved_human_gates`."
        )
      }

      if (nextDecision.action === "dispatch") {
        await store.update(toolCtx.sessionId, (draft) => {
          draft.implDag = updatedNodes
          draft.phase = "IMPLEMENTATION"
          draft.phaseState = "DRAFT"
          draft.currentTaskId = nextDecision.task.id
          draft.iterationCount = 0
          draft.retryCount = 0
          draft.userGateMessageReceived = false
        })
        return (
          `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
          `${evaluation.decision.action === "unsupported" ? `Parallel runtime unsupported: ${evaluation.decision.reason}. Applying ${evaluation.decision.fallback} fallback.\n\n` : ""}Returning to IMPLEMENTATION/DRAFT — downstream tasks are now unblocked.`
        )
      }

      if (nextDecision.action !== "complete") {
        await store.update(toolCtx.sessionId, (draft) => {
          draft.implDag = updatedNodes
        })
        return (
          `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
          `However, the scheduler reports: ${nextDecision.message}`
        )
      }

      await store.update(toolCtx.sessionId, (draft) => {
        draft.implDag = updatedNodes
      })
    }

    if (state.phase === "IMPL_PLAN") {
      let planContent = args.artifact_content as string | undefined
      if (!planContent) {
        const diskPath = state.artifactDiskPaths["impl_plan" as keyof typeof state.artifactDiskPaths] as string | undefined
        if (diskPath) {
          try {
            planContent = readFileSync(diskPath, "utf-8")
          } catch {
            // handled below with a clear error
          }
        }
      }
      if (!planContent) {
        return (
          "Error: IMPL_PLAN approval requires `artifact_content` or a previously written implementation plan on disk " +
          "so the plan can be parsed into a DAG before entering IMPLEMENTATION."
        )
      }
      const parseCheck = parseImplPlan(planContent)
      if (!parseCheck.success) {
        return (
          `Error: Failed to parse implementation plan into DAG: ${parseCheck.errors.join("; ")}. ` +
          "Fix the plan format and re-submit approval with corrected `artifact_content`."
        )
      }
    }

    let derivedApprovedFiles: string[] | null = null
    if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && !args.approved_files) {
      let planContent = args.artifact_content as string | undefined
      if (!planContent && state.artifactDiskPaths.plan) {
        try {
          planContent = readFileSync(state.artifactDiskPaths.plan, "utf-8")
        } catch {
          // non-fatal
        }
      }
      if (planContent) {
        derivedApprovedFiles = extractApprovedFileAllowlist(planContent, cwd)
      }
    }

    const outcome = sm.transition(state.phase, state.phaseState, "user_approve", state.mode)
    if (!outcome.success) return `Error: ${outcome.message}`

    // Write artifact to disk if content provided (for approval recording)
    const artifactContent = args.artifact_content as string | undefined
    const approveArtifactKey = PHASE_TO_ARTIFACT[state.phase]
    let approveArtifactPath: string | null = null
    if (artifactContent && approveArtifactKey && approveArtifactKey !== "implementation") {
      try {
        approveArtifactPath = await writeArtifact(toolCtx.directory, approveArtifactKey, artifactContent, state.featureName)
      } catch { /* non-fatal */ }
    }

    const phaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
    await store.update(toolCtx.sessionId, (draft) => {
      draft.phase = outcome.nextPhase
      draft.phaseState = outcome.nextPhaseState
      draft.approvalCount++
      draft.phaseApprovalCounts[state.phase] = phaseCount
      draft.iterationCount = 0
      draft.retryCount = 0
      draft.userGateMessageReceived = false
      draft.reviewArtifactHash = null
      draft.latestReviewResults = null
      if (approveArtifactPath && approveArtifactKey) {
        draft.artifactDiskPaths[approveArtifactKey] = approveArtifactPath
      }
      // Capture conventions at DISCOVERY approval
      if (state.phase === "DISCOVERY" && artifactContent) {
        draft.conventions = artifactContent
      }
      // Parse IMPL_PLAN into DAG at IMPL_PLAN approval.
      // If artifact_content was not passed in the approve call, fall back to
      // reading from the disk path written by request_review. This prevents
      // the DAG from silently not being parsed when the user approves without
      // re-passing the content.
      if (state.phase === "IMPL_PLAN") {
        let planContent = artifactContent
        if (!planContent) {
          const diskPath = state.artifactDiskPaths["impl_plan" as keyof typeof state.artifactDiskPaths] as string | undefined
          if (diskPath) {
            try {
              planContent = readFileSync(diskPath, "utf-8")
            } catch { /* non-fatal — DAG just won't be parsed */ }
          }
        }
        if (planContent) {
          const parseResult = parseImplPlan(planContent)
          if (parseResult.success) {
            const nodes = Array.from(parseResult.dag.tasks).map((t) => ({ ...t }))
            draft.implDag = nodes
            const firstReady = nodes.find((t) => t.status === "pending" && t.dependencies.length === 0)
            draft.currentTaskId = firstReady?.id ?? null
          } else {
            draft.implDag = null
          }
        }
      }
      // Capture file allowlist at PLANNING approval in INCREMENTAL mode
      if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && args.approved_files) {
        const files = args.approved_files as string[]
        draft.fileAllowlist = files.map((p) =>
          p.startsWith("/") ? p : resolve(cwd, p),
        )
      } else if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && derivedApprovedFiles) {
        draft.fileAllowlist = derivedApprovedFiles
      }
      // Reset artifact file tracking for the new phase
      draft.reviewArtifactFiles = []
    })

    // policyVersion bumped automatically by setPostUpdateHook

    // Git checkpoint: tag the approval in version control (non-fatal)
    try {
      const phaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
      await createGitCheckpoint(
        { cwd: toolCtx.directory },
        {
          phase: state.phase,
          approvalCount: phaseCount,
          featureName: state.featureName,
          ...(state.mode === "INCREMENTAL" ? { fileAllowlist: state.fileAllowlist } : {}),
          ...(state.reviewArtifactFiles.length > 0 ? { expectedFiles: state.reviewArtifactFiles } : {}),
        },
      )
    } catch (err) {
      // Non-fatal — git checkpoint failure should not block the workflow
      ctx.engine?.log.warn("Git checkpoint failed", {
        detail: err instanceof Error ? err.message : String(err),
      })
    }

    return `Approved. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}.`
  }

  if (feedbackType === "revise") {
    if (ctx.capabilities.orchestrator !== false) {
      return subagentError("submit_feedback(revise)", "the orchestrator (SubagentDispatcher)")
    }
    const feedbackText = (args.feedback_text ?? "") as string
    const result = computeSubmitFeedbackReviseTransition(feedbackText, state, sm)
    if (!result.success) return `Error: ${result.error}`
    const t = result.transition
    await store.update(toolCtx.sessionId, (draft) => {
      draft.phase = t.nextPhase
      draft.phaseState = t.nextPhaseState
      draft.retryCount = 0
      draft.reviewArtifactFiles = []
      draft.pendingRevisionSteps = null
      draft.feedbackHistory.push(t.feedbackEntry)
    })
    return t.responseMessage
  }

  return `Error: feedback_type must be "approve" or "revise", got "${feedbackType}".`
}

// ---- mark_task_complete ----

const handleMarkTaskComplete: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "IMPLEMENTATION") {
    return `Error: mark_task_complete can only be called during IMPLEMENTATION (current: ${state.phase}).`
  }
  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
    return `Error: mark_task_complete can only be called in DRAFT or REVISE state (current: ${state.phase}/${state.phaseState}).`
  }

  // Re-entry guard: prevent concurrent task completions
  if (state.taskCompletionInProgress) {
    return `Error: Task "${state.taskCompletionInProgress}" is already awaiting review. Call submit_task_review first.`
  }

  const result = processMarkTaskComplete(args as any, state.implDag, state.currentTaskId)
  if ("error" in result) return `Error: ${result.error}`

  // Persist DAG changes and set review gate
  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = result.updatedNodes
    draft.currentTaskId = result.nextTaskId
    draft.taskCompletionInProgress = (args.task_id as string) ?? null
    // Orchestrator-driven artifact tracking (v22): accumulate expected files
    if (result.completedTaskFiles.length > 0) {
      const existing = new Set(draft.reviewArtifactFiles)
      for (const f of result.completedTaskFiles) {
        if (!existing.has(f)) {
          draft.reviewArtifactFiles.push(f)
        }
      }
    }
  })

  // Build the isolated review prompt for the adapter to dispatch.
  // Use the freshly-updated state (with completed task) for context.
  const updatedState = requireState(ctx, toolCtx.sessionId)
  const taskId = args.task_id as string
  const implSummary = (args.implementation_summary as string) ?? ""
  const reviewPrompt = buildReviewContextForTask(updatedState, taskId, toolCtx.directory, implSummary)
  if (!reviewPrompt) {
    // Should not happen — task was just completed. Clear guard and return.
    await store.update(toolCtx.sessionId, (draft) => {
      draft.taskCompletionInProgress = null
      draft.taskReviewCount = 0
    })
    return result.responseMessage
  }

  return (
    result.responseMessage +
    "\n\n**Per-task review required.** Spawn an isolated reviewer (e.g. `claude --print`) with the prompt below. " +
    "The reviewer must have NO access to this conversation — only the prompt and project files. " +
    "Then call `submit_task_review` with the reviewer's output.\n\n" +
    "---\n\n" +
    reviewPrompt
  )
}

// ---- submit_task_review ----

const handleSubmitTaskReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (!state.taskCompletionInProgress) {
    return "Error: No task review is pending. Call mark_task_complete first."
  }

  const reviewOutput = (args.review_output as string)?.trim()
  if (!reviewOutput) {
    return "Error: review_output is required. Pass the raw output from the isolated reviewer."
  }

  const taskId = state.taskCompletionInProgress
  const review = parseTaskReviewResult(reviewOutput)

  // Parse failure — don't accept, ask agent to retry
  if (!review.success) {
    return `Error: Failed to parse review output: ${review.error}. Re-run the isolated reviewer and submit again.`
  }

  // Check iteration cap — force accept after MAX_TASK_REVIEW_ITERATIONS
  const hitCap = state.taskReviewCount >= MAX_TASK_REVIEW_ITERATIONS
  if (hitCap && !review.passed) {
    // Force accept — too many review iterations. Full impl review will catch issues.
    await store.update(toolCtx.sessionId, (draft) => {
      draft.taskCompletionInProgress = null
      draft.taskReviewCount = 0
    })
    return (
      `Task "${taskId}" force-accepted after ${MAX_TASK_REVIEW_ITERATIONS} review iterations. ` +
      `Issues will be caught in the full implementation review. Proceeding to next task.`
    )
  }

  if (review.passed) {
    // Review passed — clear gate, advance to next task
    await store.update(toolCtx.sessionId, (draft) => {
      draft.taskCompletionInProgress = null
      draft.taskReviewCount = 0
    })
    return `Task "${taskId}" review passed. Proceeding to next task.`
  }

  // Review failed — revert task status and return issues
  await store.update(toolCtx.sessionId, (draft) => {
    const task = draft.implDag?.find((t) => t.id === taskId)
    if (task) task.status = "pending"
    draft.currentTaskId = taskId
    draft.taskCompletionInProgress = null
    draft.taskReviewCount = (draft.taskReviewCount ?? 0) + 1
  })

  const issuesList = review.issues.map((i) => `  - ${i}`).join("\n")
  return (
    `Task "${taskId}" review FAILED. ${review.issues.length} issue(s) found:\n${issuesList}\n\n` +
    `${review.reasoning ? `Reviewer reasoning: ${review.reasoning}\n\n` : ""}` +
    `Fix the issues and call mark_task_complete again. ` +
    `(Review iteration ${state.taskReviewCount + 1}/${MAX_TASK_REVIEW_ITERATIONS})`
  )
}

// ---- check_prior_workflow ----

const handleCheckPriorWorkflow: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const featureName = (args.feature_name as string)?.trim()
  if (!featureName) return "Error: feature_name is required."

  const priorState = await store.findPersistedByFeatureName(featureName)
  if (!priorState) {
    await store.update(toolCtx.sessionId, (draft) => {
      draft.priorWorkflowChecked = true
    })
    return `No prior workflow found for feature "${featureName}". Proceed with select_mode.`
  }

  await store.update(toolCtx.sessionId, (draft) => {
    draft.priorWorkflowChecked = true
    draft.cachedPriorState = {
      intentBaseline: priorState.intentBaseline,
      phase: priorState.phase,
      artifactDiskPaths: priorState.artifactDiskPaths as Record<string, string>,
      approvedArtifacts: priorState.approvedArtifacts as Record<string, string>,
    }
  })

  return `Prior workflow found for "${featureName}" at phase ${priorState.phase}. Call select_mode to continue or start fresh.`
}

// ---- resolve_human_gate ----

const handleResolveHumanGate: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "IMPLEMENTATION") {
    return `Error: resolve_human_gate can only be called during IMPLEMENTATION.`
  }

  const taskId = args.task_id as string
  if (!taskId) return "Error: task_id is required."

  if (!state.implDag) return "Error: No implementation DAG found."

  const task = state.implDag.find((t) => t.id === taskId)
  if (!task) return `Error: Task "${taskId}" not found in DAG.`

  if (task.status !== "pending" && task.status !== "human-gated") {
    return `Error: Task "${taskId}" must be pending or human-gated (current: ${task.status}).`
  }

  const activatedNodes = activateHumanGateTasks(state.implDag, taskId, {
    whatIsNeeded: (args.what_is_needed as string) || task.description,
    why: (args.why as string) || "Required for implementation.",
    verificationSteps: (args.verification_steps as string) || "Verify the setup is complete.",
    resolved: false,
  })
  const resolution = resolveAwaitingHumanState(activatedNodes, isRobotArtisanSession(state))

  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = resolution.updatedNodes
    if (resolution.action === "robot-abort") {
      draft.currentTaskId = resolution.nextTask?.id ?? null
      return
    }
    if (resolution.action === "user-gate") {
      draft.phaseState = "USER_GATE"
      draft.iterationCount = 0
      draft.retryCount = 0
      draft.userGateMessageReceived = false
      draft.currentTaskId = null
    }
  })

  if (resolution.action === "robot-abort") {
    return (
      `Human gate set for task "${taskId}".\n\n` +
      `**Robot-artisan mode:** Auto-aborted ${resolution.abortedIds.length} human-gated task(s) and dependents.\n` +
      `These tasks require human action that cannot be automated.\n\n` +
      (resolution.nextTask
        ? `**Next task ready:** ${resolution.nextTask.id} — ${resolution.nextTask.description}\nContinue with the next task.`
        : `Call \`request_review\` to submit the partial implementation for review.`)
    )
  }

  if (resolution.action === "user-gate") {
    const gateList = resolution.humanGatedTasks
      .map((gate) => `  - **${gate.id}:** ${gate.whatIsNeeded}`)
      .join("\n")
    return (
      `Human gate set for task "${taskId}".\n\n` +
      `**All remaining work is blocked behind human gates.** Auto-advancing to USER_GATE for user resolution.\n\n` +
      `**Unresolved human gates:**\n${gateList}`
    )
  }

  return `Human gate set for task "${taskId}". The user will resolve it at USER_GATE.`
}

// ---- propose_backtrack ----

const handleProposeBacktrack: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.capabilities.orchestrator !== false) {
    return subagentError("propose_backtrack", "the orchestrator (SubagentDispatcher)")
  }
  const state = requireState(ctx, toolCtx.sessionId)
  const result = computeProposeBacktrackTransition(
    { target_phase: (args.target_phase ?? "") as string, reason: (args.reason ?? "") as string },
    state,
  )
  if (!result.success) return `Error: ${result.error}`
  const t = result.transition
  await ctx.engine!.store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.targetPhase
    draft.phaseState = "DRAFT"
    draft.iterationCount = 0
    draft.retryCount = 0
    draft.userGateMessageReceived = false
    draft.reviewArtifactFiles = []
    draft.revisionBaseline = null
    draft.pendingRevisionSteps = null
    for (const key of t.clearedArtifactKeys) {
      delete draft.approvedArtifacts[key]
    }
    if (t.clearImplDag) {
      draft.implDag = null
      draft.currentTaskId = null
      draft.taskReviewCount = 0
      draft.taskCompletionInProgress = null
    }
    draft.feedbackHistory.push(t.feedbackEntry)
  })
  return t.responseMessage
}

// ---- spawn_sub_workflow ----

const handleSpawnSubWorkflow: ToolHandler = async (_args, _toolCtx, _ctx) => {
  return subagentError("spawn_sub_workflow", "SubagentDispatcher for child session creation")
}

// ---- query_parent_workflow ----

const handleQueryParentWorkflow: ToolHandler = async (_args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const parentState = state.parentWorkflow
    ? ctx.engine!.store.findByFeatureName(state.parentWorkflow.featureName)
    : null
  const result = processQueryParentWorkflow(state, parentState)
  if (result.error) return `Error: ${result.error}`
  return JSON.stringify(result, null, 2)
}

// ---- query_child_workflow ----

const handleQueryChildWorkflow: ToolHandler = async (args, toolCtx, ctx) => {
  const state = requireState(ctx, toolCtx.sessionId)
  const taskId = args.task_id as string
  if (!taskId) return "Error: task_id is required."
  const childEntry = state.childWorkflows.find((c) => c.taskId === taskId)
  const childState = childEntry
    ? ctx.engine!.store.findByFeatureName(childEntry.featureName)
    : null
  const result = processQueryChildWorkflow(state, taskId, childState)
  if (result.error) return `Error: ${result.error}`
  return JSON.stringify(result, null, 2)
}

// ---- submit_auto_approve (must be before dispatch table) ----

const handleSubmitAutoApprove: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phaseState !== "USER_GATE") {
    return "Error: submit_auto_approve can only be called at USER_GATE."
  }
  if (state.activeAgent !== "robot-artisan") {
    return "Error: submit_auto_approve requires robot-artisan mode."
  }

  const reviewOutput = (args.review_output as string)?.trim()
  if (!reviewOutput) {
    return "Error: review_output is required."
  }

  const result = parseAutoApproveResult(reviewOutput) as AutoApproveResult
  if (!result.success) {
    const feedbackText = buildRobotArtisanAutoApproveFailureFeedback(result.error)
    const reviseResult = computeSubmitFeedbackReviseTransition(feedbackText, state, sm)
    if (!reviseResult.success) return `Error: ${reviseResult.error}`
    const t = reviseResult.transition
    await store.update(toolCtx.sessionId, (draft) => {
      draft.phase = t.nextPhase
      draft.phaseState = t.nextPhaseState
      draft.retryCount = 0
      draft.reviewArtifactFiles = []
      draft.pendingRevisionSteps = null
      draft.feedbackHistory.push(t.feedbackEntry)
    })
    return `Auto-approve failed. ${t.responseMessage}`
  }

  const autoTransition = computeAutoApproveTransition(sm, state.phase, state.mode, result)
  if (!autoTransition.success) return `Error: ${autoTransition.message}`

  if (result.approve) {
    // Auto-approve: transition to next phase
    const phaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
    await store.update(toolCtx.sessionId, (draft) => {
      draft.phase = autoTransition.nextPhase
      draft.phaseState = autoTransition.nextPhaseState
      draft.approvalCount++
      draft.phaseApprovalCounts[state.phase] = phaseCount
      draft.iterationCount = 0
      draft.retryCount = 0
      draft.userGateMessageReceived = false
      draft.reviewArtifactHash = null
      draft.latestReviewResults = null
      draft.reviewArtifactFiles = []
    })
    return `Auto-approved (confidence: ${result.confidence.toFixed(2)}). Transitioning to ${autoTransition.nextPhase}/${autoTransition.nextPhaseState}.`
  }

  // Below confidence threshold — route to REVISE with feedback
  const feedbackText = result.feedback || result.reasoning || "Auto-approver rejected — needs improvement."
  const reviseResult = computeSubmitFeedbackReviseTransition(feedbackText, state, sm)
  if (!reviseResult.success) return `Error: ${reviseResult.error}`
  const t = reviseResult.transition
  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = t.nextPhase
    draft.phaseState = t.nextPhaseState
    draft.retryCount = 0
    draft.reviewArtifactFiles = []
    draft.pendingRevisionSteps = null
    draft.feedbackHistory.push(t.feedbackEntry)
  })
  return `Auto-approve rejected (confidence: ${result.confidence.toFixed(2)}). ${t.responseMessage}`
}

// ---- reset_task ----

const handleResetTask: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "IMPLEMENTATION") {
    return `Error: reset_task can only be called during IMPLEMENTATION (current: ${state.phase}).`
  }
  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
    return `Error: reset_task can only be called in DRAFT or REVISE state (current: ${state.phaseState}).`
  }
  if (state.taskCompletionInProgress) {
    return `Error: Task "${state.taskCompletionInProgress}" is awaiting review. Call submit_task_review first.`
  }

  const taskIds = args.task_ids as string[] | undefined
  const taskId = args.task_id as string | undefined
  const ids = taskIds ?? (taskId ? [taskId] : [])

  if (ids.length === 0) {
    return "Error: task_id (string) or task_ids (array) is required."
  }
  if (!state.implDag) {
    return "Error: No implementation DAG found."
  }

  // Validate all task IDs exist
  for (const id of ids) {
    if (!state.implDag.find((t) => t.id === id)) {
      return `Error: Task "${id}" not found in DAG.`
    }
  }

  // Check no downstream dependencies are in-flight or complete
  // (resetting a task that others depend on could break the DAG)
  const resetSet = new Set(ids)
  for (const node of state.implDag) {
    if (resetSet.has(node.id)) continue
    if (node.status === "complete" || node.status === "in-flight") {
      const dependsOnReset = node.dependencies.some((d) => resetSet.has(d))
      if (dependsOnReset) {
        return (
          `Error: Task "${node.id}" (${node.status}) depends on "${node.dependencies.find((d) => resetSet.has(d))}". ` +
          `Reset dependent tasks too, or reset them in dependency order.`
        )
      }
    }
  }

  await store.update(toolCtx.sessionId, (draft) => {
    for (const id of ids) {
      const task = draft.implDag?.find((t) => t.id === id)
      if (task) {
        task.status = "pending"
      }
    }
    // Set currentTaskId to the first reset task (earliest in DAG order)
    const dagOrder = draft.implDag?.map((t) => t.id) ?? []
    const firstReset = dagOrder.find((id) => ids.includes(id))
    if (firstReset) {
      draft.currentTaskId = firstReset
    }
    draft.taskReviewCount = 0
    draft.taskCompletionInProgress = null
  })

  const taskList = ids.join(", ")
  return `Reset ${ids.length} task(s) to pending: ${taskList}. Current task: ${ids[0]}.`
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  select_mode: handleSelectMode,
  mark_scan_complete: handleMarkScanComplete,
  mark_analyze_complete: handleMarkAnalyzeComplete,
  mark_satisfied: handleMarkSatisfied,
  request_review: handleRequestReview,
  submit_feedback: handleSubmitFeedback,
  mark_task_complete: handleMarkTaskComplete,
  submit_task_review: handleSubmitTaskReview,
  submit_auto_approve: handleSubmitAutoApprove,
  reset_task: handleResetTask,
  check_prior_workflow: handleCheckPriorWorkflow,
  resolve_human_gate: handleResolveHumanGate,
  propose_backtrack: handleProposeBacktrack,
  spawn_sub_workflow: handleSpawnSubWorkflow,
  query_parent_workflow: handleQueryParentWorkflow,
  query_child_workflow: handleQueryChildWorkflow,
}

// ---------------------------------------------------------------------------
// task.getReviewContext — returns review prompt for pending task review
// ---------------------------------------------------------------------------

export const handleTaskGetReviewContext: MethodHandler = async (params, ctx) => {
  const p = params as { sessionId?: string }
  if (!p.sessionId) {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  const state = ctx.engine!.store.get(p.sessionId)
  if (!state || !state.taskCompletionInProgress) return null

  return buildReviewContextForTask(state, state.taskCompletionInProgress, ctx.projectDir ?? process.cwd())
}

// ---------------------------------------------------------------------------
// task.getAutoApproveContext — returns auto-approve prompt for USER_GATE
// ---------------------------------------------------------------------------

export const handleAutoApproveContext: MethodHandler = async (params, ctx) => {
  const p = params as { sessionId?: string }
  if (!p.sessionId) {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  const state = ctx.engine!.store.get(p.sessionId)
  if (!state || state.phaseState !== "USER_GATE" || state.activeAgent !== "robot-artisan") return null

  return buildAutoApprovePrompt(buildAutoApproveRequest(state, p.sessionId))
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handleToolExecute: MethodHandler = async (params, ctx) => {
  const p = params as Partial<ToolExecuteParams>
  if (!p.name || typeof p.name !== "string") {
    throw new JSONRPCErrorException("name is required", INVALID_PARAMS)
  }
  if (!p.context?.sessionId) {
    throw new JSONRPCErrorException("context.sessionId is required", INVALID_PARAMS)
  }

  const handler = TOOL_HANDLERS[p.name]
  if (!handler) {
    return `Error: Unknown tool "${p.name}". Available: ${Object.keys(TOOL_HANDLERS).join(", ")}`
  }

  const toolCtx: ToolContext = {
    sessionId: p.context.sessionId,
    directory: p.context.directory ?? process.cwd(),
    ...(p.context.agent ? { agent: p.context.agent } : {}),
  }

  return handler(p.args ?? {}, toolCtx, ctx)
}
