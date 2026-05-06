import { createHash } from "node:crypto"
import { JSONRPCErrorException } from "json-rpc-2.0"

import type { BridgeContext } from "../server"
import { SESSION_NOT_FOUND } from "../protocol"
import type { WorkflowState } from "../../core/workflow-state-types"
import { ApplyDriftRepairToolSchema, PlanDriftRepairToolSchema, ReportDriftToolSchema } from "../../core/schemas"
import { parseToolArgs } from "../../core/tool-args"
import { workflowDbId } from "../../core/runtime-persistence"
import { collectWorktreeObservations } from "../../core/worktree-observation"
import { routePatchSuggestions } from "../../core/patch-suggestion-routing"
import {
  buildDriftRepairPlan,
  buildRepairToolCall,
  buildWorkflowDriftReport,
  type DriftRepairPlan,
  type DriftReport,
  type DriftToolCallPlan,
} from "../../core/drift"
import type { ToolContext, ToolHandler } from "./tool-handler-types"

type DriftToolExecutor = (
  toolCall: DriftToolCallPlan,
  toolCtx: ToolContext,
  ctx: BridgeContext,
) => Promise<string>

const driftReports = new Map<string, DriftReport>()
const driftRepairPlans = new Map<string, DriftRepairPlan>()
const latestDriftReportBySession = new Map<string, string>()

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

function driftStoreKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`
}

function requireState(ctx: BridgeContext, sessionId: string): WorkflowState {
  const state = ctx.engine!.store.get(sessionId)
  if (!state) {
    throw new JSONRPCErrorException(`Session "${sessionId}" not found`, SESSION_NOT_FOUND)
  }
  return state
}

export function createDriftToolHandlers(executeDriftToolCall: DriftToolExecutor) {
  const handleReportDrift: ToolHandler = async (args, toolCtx, ctx) => {
    const parsedArgs = parseToolArgs(ReportDriftToolSchema, args)
    if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
    const state = requireState(ctx, toolCtx.sessionId)
    const workflowId = workflowDbId(state)
    const worktreeObservations = parsedArgs.data.include_worktree === false
      ? []
      : await collectWorktreeObservations({
        cwd: toolCtx.directory,
        workflowId,
        taskOwnedFiles: state.currentTaskId ? state.implDag?.find((task) => task.id === state.currentTaskId)?.expectedFiles ?? [] : [],
        artifactFiles: Object.values(state.artifactDiskPaths).filter((item): item is string => typeof item === "string"),
        fileClaims: [],
      })
    const pendingPatchSuggestions = ctx.openArtisanServices && parsedArgs.data.include_db !== false
      ? await ctx.openArtisanServices.patchSuggestions.listSuggestions(workflowId, "pending")
      : null
    if (pendingPatchSuggestions && !pendingPatchSuggestions.ok) return `Error: ${pendingPatchSuggestions.error.message}`
    const report = buildWorkflowDriftReport({
      workflowId,
      state,
      ...(parsedArgs.data.scope === undefined ? {} : { scope: parsedArgs.data.scope }),
      ...(parsedArgs.data.drifted_artifact_keys === undefined ? {} : { artifactKeys: parsedArgs.data.drifted_artifact_keys }),
      ...(parsedArgs.data.task_ids === undefined ? {} : { taskIds: parsedArgs.data.task_ids }),
      ...(parsedArgs.data.changed_files === undefined ? {} : { changedFiles: parsedArgs.data.changed_files }),
      worktreeObservations,
      routedPatchSuggestions: pendingPatchSuggestions?.ok ? routePatchSuggestions(state, pendingPatchSuggestions.value) : [],
    })
    driftReports.set(driftStoreKey(toolCtx.sessionId, report.id), report)
    latestDriftReportBySession.set(toolCtx.sessionId, report.id)
    return JSON.stringify({ ok: true, value: report }, null, 2)
  }

  const handlePlanDriftRepair: ToolHandler = async (args, toolCtx) => {
    const parsedArgs = parseToolArgs(PlanDriftRepairToolSchema, args)
    if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
    const reportId = parsedArgs.data.drift_report_id ?? latestDriftReportBySession.get(toolCtx.sessionId)
    if (!reportId) return "Error: No drift report available. Call report_drift first or pass drift_report_id."
    const report = driftReports.get(driftStoreKey(toolCtx.sessionId, reportId))
    if (!report) return `Error: Drift report "${reportId}" was not found for this session.`
    const createdAt = new Date().toISOString()
    const plan = buildDriftRepairPlan({
      id: stableId("drift-repair-plan", report.id, parsedArgs.data.strategy ?? "minimal", createdAt),
      driftReport: report,
      strategy: parsedArgs.data.strategy ?? "minimal",
      createdAt,
    })
    driftRepairPlans.set(driftStoreKey(toolCtx.sessionId, plan.id), plan)
    return JSON.stringify({ ok: true, value: { ...plan, toolCalls: plan.actions.map((action) => ({ actionId: action.id, toolCall: buildRepairToolCall(action) })) } }, null, 2)
  }

  const handleApplyDriftRepair: ToolHandler = async (args, toolCtx, ctx) => {
    const parsedArgs = parseToolArgs(ApplyDriftRepairToolSchema, args)
    if (!parsedArgs.success) return `Error: ${parsedArgs.error}`
    const plan = driftRepairPlans.get(driftStoreKey(toolCtx.sessionId, parsedArgs.data.repair_plan_id))
    if (!plan) return `Error: Drift repair plan "${parsedArgs.data.repair_plan_id}" was not found for this session.`
    const approved = new Set(parsedArgs.data.approved_actions ?? [])
    const results: Array<{ actionId: string; skipped?: string; toolName?: string; result?: string }> = []
    for (const action of plan.actions) {
      const shouldApply = (parsedArgs.data.apply_safe_actions && action.safety === "safe-auto") || approved.has(action.id)
      if (!shouldApply) {
        results.push({ actionId: action.id, skipped: `Action safety is ${action.safety}.` })
        continue
      }
      const toolCall = buildRepairToolCall(action)
      if (!toolCall) {
        results.push({ actionId: action.id, skipped: "No schema-valid executable tool call is available for this action." })
        continue
      }
      const result = await executeDriftToolCall(toolCall, toolCtx, ctx)
      results.push({ actionId: action.id, toolName: toolCall.toolName, result })
    }
    return JSON.stringify({ ok: true, value: { repairPlanId: plan.id, results } }, null, 2)
  }

  return { handleReportDrift, handlePlanDriftRepair, handleApplyDriftRepair }
}
