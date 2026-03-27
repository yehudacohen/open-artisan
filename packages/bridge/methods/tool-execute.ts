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

import { resolve } from "node:path"
import { parseSelectModeArgs } from "../../core/tools/select-mode"
import { processMarkScanComplete } from "../../core/tools/mark-scan-complete"
import { processMarkTaskComplete } from "../../core/tools/mark-task-complete"
import { evaluateMarkSatisfied, countExpectedBlockingCriteria } from "../../core/tools/mark-satisfied"
import { processMarkAnalyzeComplete } from "../../core/tools/mark-analyze-complete"
import { processQueryParentWorkflow, processQueryChildWorkflow } from "../../core/tools/query-workflow"
import { writeArtifact } from "../../core/artifact-store"
import { parseImplPlan } from "../../core/impl-plan-parser"
import { PHASE_TO_ARTIFACT } from "../../core/artifacts"
import { getAcceptanceCriteria } from "../../core/hooks/system-transform"
import { MAX_REVIEW_ITERATIONS } from "../../core/constants"

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
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "MODE_SELECT") {
    return `Error: select_mode can only be called during MODE_SELECT (current: ${state.phase}).`
  }

  const parsed = parseSelectModeArgs(args)
  if ("error" in parsed) return `Error: ${parsed.error}`

  // Sub-workflow sessions preserve their existing featureName
  const isSubWorkflow = state.parentWorkflow !== null
  let featureName: string
  if (isSubWorkflow && state.featureName) {
    featureName = state.featureName
  } else {
    featureName = (args.feature_name as string)?.trim() ?? ""
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
  if (ctx.selfReviewMode !== "agent-only") {
    return subagentError("mark_analyze_complete", "the discovery fleet (SubagentDispatcher)")
  }

  // Agent-only mode: accept the agent's scan summary directly
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phase !== "DISCOVERY" || state.phaseState !== "ANALYZE") {
    return `Error: mark_analyze_complete can only be called in DISCOVERY/ANALYZE (current: ${state.phase}/${state.phaseState}).`
  }

  const result = processMarkAnalyzeComplete(args as any)

  const outcome = sm.transition(state.phase, state.phaseState, "analyze_complete", state.mode)
  if (!outcome.success) return `Error: ${outcome.message}`

  const analysisSummary = ((args as Record<string, unknown>).analysis_summary as string | undefined)?.trim() ?? null
  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.discoveryReport = analysisSummary
  })

  return result.responseMessage
}

// ---- mark_satisfied ----

const handleMarkSatisfied: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.selfReviewMode !== "agent-only") {
    return subagentError("mark_satisfied", "the self-review subagent (SubagentDispatcher)")
  }

  // Agent-only mode: evaluate the agent's criteria directly (no isolated reviewer)
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phaseState !== "REVIEW") {
    return `Error: mark_satisfied can only be called in REVIEW state (current: ${state.phaseState}).`
  }

  // Structural gate: file-based phases require reviewArtifactFiles
  const isFileBased = ["INTERFACES", "TESTS", "IMPLEMENTATION"].includes(state.phase)
  if (isFileBased && state.reviewArtifactFiles.length === 0) {
    return (
      `Error: No artifact files registered for the ${state.phase} review.\n\n` +
      `Call \`request_review\` with \`artifact_files\` listing the files to review, then call \`mark_satisfied\` again.`
    )
  }

  // Parse criteria — handle string scores (JSON-RPC params may send scores as strings)
  const rawCriteria = (args.criteria_met ?? []) as Array<{
    criterion: string; met: boolean; evidence: string;
    severity?: "blocking" | "suggestion"; score?: string | number
  }>
  const criteriaMet = rawCriteria.map((c) => ({
    criterion: c.criterion,
    met: c.met,
    evidence: c.evidence,
    ...(c.severity ? { severity: c.severity } : {}),
    ...(c.score !== undefined ? { score: typeof c.score === "string" ? parseInt(c.score, 10) : c.score } : {}),
  }))

  // INCREMENTAL allowlist criterion: ensure the agent assessed allowlist adequacy at PLANNING
  if (state.mode === "INCREMENTAL" && state.phase === "PLANNING" && state.fileAllowlist.length > 0) {
    const hasAllowlist = criteriaMet.some((c) => c.criterion.toLowerCase().includes("allowlist adequacy"))
    if (!hasAllowlist) {
      criteriaMet.push({
        criterion: "Allowlist adequacy",
        met: false,
        evidence: "Agent did not assess allowlist adequacy. Add this criterion.",
        severity: "blocking" as const,
      })
    }
  }

  const criteriaText = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, state.artifactDiskPaths?.design ?? null)
  const expectedBlocking = countExpectedBlockingCriteria(criteriaText)
  const iterationInfo = { current: state.iterationCount + 1, max: MAX_REVIEW_ITERATIONS }
  const result = evaluateMarkSatisfied({ criteria_met: criteriaMet }, expectedBlocking, iterationInfo)

  const nextIterationCount = result.passed ? 0 : state.iterationCount + 1
  const hitCap = !result.passed && nextIterationCount >= MAX_REVIEW_ITERATIONS
  const event = result.passed ? "self_review_pass" : hitCap ? "escalate_to_user" : "self_review_fail"
  const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
  if (!outcome.success) return `Error: ${outcome.message}`

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.iterationCount = nextIterationCount
    draft.retryCount = 0
    draft.latestReviewResults = criteriaMet.map((c) => ({
      criterion: c.criterion,
      met: c.met,
      evidence: c.evidence,
      ...(c.score !== undefined ? { score: String(c.score) } : {}),
    }))
    if (outcome.nextPhaseState !== "REVIEW") {
      draft.reviewArtifactHash = null
    }
    if (outcome.nextPhaseState === "USER_GATE") {
      draft.userGateMessageReceived = false
    }
    if (outcome.nextPhaseState === "REVISE") {
      draft.revisionBaseline = null
    }
  })

  return result.responseMessage
}

// ---- request_review ----

const handleRequestReview: ToolHandler = async (args, toolCtx, ctx) => {
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
    return `Error: request_review can only be called in DRAFT or REVISE state (current: ${state.phase}/${state.phaseState}).`
  }

  const outcome = sm.transition(state.phase, state.phaseState, "draft_complete", state.mode)
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

  // Merge agent-provided artifact_files into reviewArtifactFiles
  const artifactFiles = args.artifact_files as string[] | undefined

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = outcome.nextPhase
    draft.phaseState = outcome.nextPhaseState
    draft.retryCount = 0
    if (artifactDiskPath && artifactKey) {
      draft.artifactDiskPaths[artifactKey] = artifactDiskPath
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

  if (state.phaseState !== "USER_GATE" && state.phaseState !== "ESCAPE_HATCH") {
    return `Error: submit_feedback can only be called at USER_GATE or ESCAPE_HATCH (current: ${state.phaseState}).`
  }

  const feedbackType = args.feedback_type as string
  if (feedbackType === "approve") {
    if (state.phaseState === "ESCAPE_HATCH") {
      return "Error: Cannot approve while an escape hatch is pending."
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
      // Parse IMPL_PLAN into DAG at IMPL_PLAN approval
      if (state.phase === "IMPL_PLAN" && artifactContent) {
        const parseResult = parseImplPlan(artifactContent)
        if (parseResult.success) {
          const nodes = Array.from(parseResult.dag.tasks).map((t) => ({ ...t }))
          draft.implDag = nodes
          const firstReady = nodes.find((t) => t.status === "pending" && t.dependencies.length === 0)
          draft.currentTaskId = firstReady?.id ?? null
        } else {
          draft.implDag = null
        }
      }
      // Capture file allowlist at PLANNING approval in INCREMENTAL mode
      if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && args.approved_files) {
        const files = args.approved_files as string[]
        draft.fileAllowlist = files.map((p) =>
          p.startsWith("/") ? p : resolve(toolCtx.directory, p),
        )
      }
      // Reset artifact file tracking for the new phase
      draft.reviewArtifactFiles = []
    })

    // policyVersion bumped automatically by setPostUpdateHook
    return `Approved. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}.`
  }

  if (feedbackType === "revise") {
    if (ctx.selfReviewMode !== "agent-only") {
      return subagentError("submit_feedback(revise)", "the orchestrator (SubagentDispatcher)")
    }

    // Agent-only mode: route directly to REVISE (skip orchestrator classification)
    const feedbackText = (args.feedback_text ?? "") as string
    const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
    if (!outcome.success) return `Error: ${outcome.message}`

    await store.update(toolCtx.sessionId, (draft) => {
      draft.phase = outcome.nextPhase
      draft.phaseState = outcome.nextPhaseState
      draft.retryCount = 0
      draft.reviewArtifactFiles = []
      draft.pendingRevisionSteps = null
      draft.feedbackHistory.push({
        phase: state.phase,
        feedback: feedbackText.slice(0, 2000),
        timestamp: Date.now(),
      })
    })

    return `Revision requested. Transitioning to ${outcome.nextPhase}/${outcome.nextPhaseState}. Apply the feedback and call \`request_review\` when done.`
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

  const result = processMarkTaskComplete(args as any, state.implDag, state.currentTaskId)
  if ("error" in result) return `Error: ${result.error}`

  // Skip per-task review in bridge mode (requires SubagentDispatcher)
  await store.update(toolCtx.sessionId, (draft) => {
    draft.implDag = result.updatedNodes
    draft.currentTaskId = result.nextTaskId
    draft.taskReviewCount = 0
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

  // policyVersion bumped automatically by setPostUpdateHook on store.update
  return result.responseMessage + "\n\n_Note: Per-task review skipped in bridge mode (requires SubagentDispatcher)._"
}

// ---- check_prior_workflow ----

const handleCheckPriorWorkflow: ToolHandler = async (args, toolCtx, ctx) => {
  const { store } = ctx.engine!
  const featureName = (args.feature_name as string)?.trim()
  if (!featureName) return "Error: feature_name is required."

  const priorState = store.findByFeatureName(featureName)
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

  await store.update(toolCtx.sessionId, (draft) => {
    const dagTask = draft.implDag?.find((t) => t.id === taskId)
    if (dagTask) {
      dagTask.status = "human-gated"
      dagTask.humanGate = {
        whatIsNeeded: (args.what_is_needed as string) || task.description,
        why: (args.why as string) || "Required for implementation.",
        verificationSteps: (args.verification_steps as string) || "Verify the setup is complete.",
        resolved: false,
      }
    }
  })

  return `Human gate set for task "${taskId}". The user will resolve it at USER_GATE.`
}

// ---- propose_backtrack ----

const handleProposeBacktrack: ToolHandler = async (args, toolCtx, ctx) => {
  if (ctx.selfReviewMode !== "agent-only") {
    return subagentError("propose_backtrack", "the orchestrator (SubagentDispatcher)")
  }

  // Agent-only mode: accept the backtrack without orchestrator validation.
  // Route directly to the target phase's DRAFT state.
  const { store, sm } = ctx.engine!
  const state = requireState(ctx, toolCtx.sessionId)

  if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
    return `Error: propose_backtrack can only be called from DRAFT or REVISE state (current: ${state.phase}/${state.phaseState}).`
  }
  if (state.phase === "MODE_SELECT" || state.phase === "DISCOVERY" || state.phase === "DONE") {
    return `Error: propose_backtrack cannot be called from ${state.phase} — there is no earlier phase to backtrack to.`
  }

  const targetPhase = (args.target_phase ?? "") as string
  const reason = (args.reason ?? "") as string
  if (!targetPhase) return "Error: target_phase is required."
  if (!reason || reason.length < 20) return "Error: reason must be at least 20 characters."

  const PHASE_ORDER = ["MODE_SELECT", "DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION", "DONE"]
  const currentIdx = PHASE_ORDER.indexOf(state.phase)
  const targetIdx = PHASE_ORDER.indexOf(targetPhase)
  if (targetIdx === -1) return `Error: "${targetPhase}" is not a valid phase.`
  if (targetIdx >= currentIdx) return `Error: target_phase "${targetPhase}" is not earlier than current phase "${state.phase}".`

  await store.update(toolCtx.sessionId, (draft) => {
    draft.phase = targetPhase as any
    draft.phaseState = "DRAFT"
    draft.iterationCount = 0
    draft.retryCount = 0
    draft.userGateMessageReceived = false
    draft.reviewArtifactFiles = []
    draft.revisionBaseline = null
    draft.pendingRevisionSteps = null
    // Clear approved status of the target artifact AND all downstream artifacts
    for (let i = targetIdx; i < PHASE_ORDER.length; i++) {
      const phaseKey = PHASE_ORDER[i] as keyof typeof PHASE_TO_ARTIFACT
      const artifactKey = PHASE_TO_ARTIFACT[phaseKey]
      if (artifactKey) {
        delete draft.approvedArtifacts[artifactKey]
      }
    }
    // Clear IMPLEMENTATION-specific state when backtracking from or past IMPLEMENTATION
    if (state.phase === "IMPLEMENTATION" || targetIdx <= PHASE_ORDER.indexOf("IMPL_PLAN")) {
      draft.implDag = null
      draft.currentTaskId = null
      draft.taskReviewCount = 0
      draft.taskCompletionInProgress = null
    }
    draft.feedbackHistory.push({
      phase: state.phase,
      feedback: `[propose_backtrack → ${targetPhase}] ${reason.slice(0, 1950)}`,
      timestamp: Date.now(),
    })
  })

  return `Backtrack accepted. Moved to ${targetPhase}/DRAFT. ${reason}`
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
  check_prior_workflow: handleCheckPriorWorkflow,
  resolve_human_gate: handleResolveHumanGate,
  propose_backtrack: handleProposeBacktrack,
  spawn_sub_workflow: handleSpawnSubWorkflow,
  query_parent_workflow: handleQueryParentWorkflow,
  query_child_workflow: handleQueryChildWorkflow,
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handleToolExecute: MethodHandler = async (params, ctx) => {
  const p = params as ToolExecuteParams
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
    agent: p.context.agent,
  }

  return handler(p.args ?? {}, toolCtx, ctx)
}
