/**
 * reviewer-result-tools.ts - OpenCode isolated reviewer result-capture tools.
 */

import type { ToolContext } from "@opencode-ai/plugin"
import {
  AutoApproveOutputSchema,
  ChangeProposalReviewOutputSchema,
  IntentComparisonOutputSchema,
  OrchestratorAssessOutputSchema,
  OrchestratorDivergeOutputSchema,
  RebuttalReviewOutputSchema,
  SubmitReviewRubricItemToolSchema,
  TaskDriftReviewOutputSchema,
  TaskReviewOutputSchema,
  formatZodError,
} from "../../../packages/core/schemas"
import { resolveSessionId } from "../../../packages/core/utils"

type ToolExecuteContext = ToolContext & { sessionId?: string; session_id?: string; session?: { id: string }; [key: string]: unknown }

export interface ReviewerResultSubmissionStore {
  record(sessionId: string, toolName: string, payload: string): { success: true } | { success: false; error: string }
  recordRubricItem(sessionId: string, item: { criterion: string; status: "pending" | "passed" | "failed" | "unknown"; evidence?: string; score?: number }): Promise<{ success: true } | { success: false; error: string }> | { success: true } | { success: false; error: string }
}

function scoreValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function createReviewerResultTools(tool: any, ctx: { reviewerToolSubmissions: ReviewerResultSubmissionStore }) {
  const { reviewerToolSubmissions } = ctx

  return {
    submit_review_rubric_item: tool({
      description: "Reviewer-only: persist one rubric item immediately while evaluating an active task or phase review. Normal workflow agents must not call this tool.",
      args: {
        review_token: tool.schema.string().optional().describe("Bridge reviewer token; ignored by OpenCode local reviewer sessions."),
        criterion: tool.schema.string().describe("The exact rubric criterion being evaluated."),
        status: tool.schema.enum(["pending", "passed", "failed", "unknown"]).describe("Current evaluation status for this criterion."),
        evidence: tool.schema.string().optional().describe("Concrete evidence for the status, with file:line or command output where useful."),
        severity: tool.schema.enum(["blocking", "suggestion", "design-invariant"]).optional(),
        score: tool.schema.string().optional().describe("Quality score, 1-10, for [Q] criteria."),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine reviewer session ID."
        const parsed = SubmitReviewRubricItemToolSchema.safeParse({
          criterion: args["criterion"],
          status: args["status"],
          evidence: args["evidence"],
          severity: args["severity"],
          score: args["score"],
        })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const score = scoreValue(parsed.data.score)
        const recorded = await reviewerToolSubmissions.recordRubricItem(sessionId, {
          criterion: parsed.data.criterion,
          status: parsed.data.status,
          ...(parsed.data.evidence ? { evidence: parsed.data.evidence } : {}),
          ...(score !== undefined ? { score } : {}),
        })
        return recorded.success ? "Review rubric item recorded." : `Error: ${recorded.error}`
      },
    }),

    submit_task_review_result: tool({
      description: "Reviewer-only: submit structured per-task isolated review results for the active reviewer session. Normal workflow agents must not call this tool.",
      args: {
        passed: tool.schema.boolean().describe("Whether the task passes all task-review checks."),
        issues: tool.schema.array(tool.schema.string()).optional().describe("Specific blocking issues with file:line evidence where possible."),
        reasoning: tool.schema.string().optional().describe("Short explanation of the verdict."),
        code_quality_score: tool.schema.string().optional().describe("Code quality score, 1-10."),
        error_handling_score: tool.schema.string().optional().describe("Error handling score, 1-10."),
        patch_suggestions: tool.schema.array(tool.schema.object({
          target_path: tool.schema.string(),
          summary: tool.schema.string(),
          suggested_patch: tool.schema.string(),
        })).optional().describe("Optional localized patch suggestions."),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine reviewer session ID."
        const codeQualityScore = scoreValue(args["code_quality_score"])
        const errorHandlingScore = scoreValue(args["error_handling_score"])
        const scores = codeQualityScore !== undefined || errorHandlingScore !== undefined
          ? {
              ...(codeQualityScore !== undefined ? { code_quality: codeQualityScore } : {}),
              ...(errorHandlingScore !== undefined ? { error_handling: errorHandlingScore } : {}),
            }
          : undefined
        const normalized = {
          passed: args["passed"],
          issues: Array.isArray(args["issues"]) ? args["issues"] : [],
          ...(scores ? { scores } : {}),
          patch_suggestions: Array.isArray(args["patch_suggestions"]) ? args["patch_suggestions"] : [],
          reasoning: typeof args["reasoning"] === "string" ? args["reasoning"] : "",
        }
        const parsed = TaskReviewOutputSchema.safeParse(normalized)
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_task_review_result", JSON.stringify(parsed.data))
        return recorded.success ? "Task review result submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_phase_review_result: tool({
      description: "Reviewer-only: submit structured phase isolated review results for the active reviewer session. Normal workflow agents must not call this tool.",
      args: {
        satisfied: tool.schema.boolean().describe("Whether all required blocking, design-invariant, and quality criteria are satisfied."),
        criteria_results: tool.schema.array(tool.schema.object({
          criterionId: tool.schema.string().optional(),
          criterion_id: tool.schema.string().optional(),
          criterion: tool.schema.string(),
          met: tool.schema.boolean(),
          evidence: tool.schema.string(),
          severity: tool.schema.enum(["blocking", "suggestion", "design-invariant"]).optional(),
          score: tool.schema.string().optional().describe("Quality score, 1-10, for [Q] criteria."),
        })).describe("Independent assessment for every required blocking/design-invariant/[Q] criterion, including criteria that are met. Do not submit only failed criteria or only allowlist findings."),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine reviewer session ID."
        const criteria = Array.isArray(args["criteria_results"]) ? args["criteria_results"] : []
        const normalizedCriteria = criteria.map((item) => {
          const record = item && typeof item === "object" ? item as Record<string, unknown> : {}
          const rawScore = record["score"]
          const parsedScore = typeof rawScore === "string" && rawScore.trim().length > 0 ? Number(rawScore) : rawScore
          return {
            ...(typeof record["criterionId"] === "string" ? { criterionId: record["criterionId"] } : {}),
            ...(typeof record["criterion_id"] === "string" ? { criterion_id: record["criterion_id"] } : {}),
            criterion: typeof record["criterion"] === "string" ? record["criterion"] : "unknown",
            met: record["met"] === true,
            evidence: typeof record["evidence"] === "string" ? record["evidence"] : "No evidence provided by reviewer tool submission.",
            severity: record["severity"] === "suggestion" || record["severity"] === "design-invariant" ? record["severity"] : "blocking",
            ...(typeof parsedScore === "number" && Number.isFinite(parsedScore) ? { score: parsedScore } : {}),
          }
        })
        const payload = JSON.stringify({
          satisfied: args["satisfied"] === true,
          criteria_results: normalizedCriteria,
        })
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_phase_review_result", payload)
        return recorded.success ? "Phase review result submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_change_proposal_review_result: tool({
      description: "Reviewer-only: submit structured change-proposal routing results for the active reviewer session.",
      args: {
        approved: tool.schema.boolean(),
        route: tool.schema.string().describe("One of the approved change proposal routes."),
        confidence: tool.schema.string().describe("high, medium, or low."),
        reason: tool.schema.string(),
        required_actions: tool.schema.array(tool.schema.string()).optional(),
        allowed_files: tool.schema.array(tool.schema.string()).optional(),
        rejected_files: tool.schema.array(tool.schema.string()).optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine reviewer session ID."
        const parsed = ChangeProposalReviewOutputSchema.safeParse({
          approved: args["approved"],
          route: args["route"],
          confidence: args["confidence"],
          reason: args["reason"],
          required_actions: Array.isArray(args["required_actions"]) ? args["required_actions"] : [],
          allowed_files: Array.isArray(args["allowed_files"]) ? args["allowed_files"] : [],
          rejected_files: Array.isArray(args["rejected_files"]) ? args["rejected_files"] : [],
        })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_change_proposal_review_result", JSON.stringify(parsed.data))
        return recorded.success ? "Change proposal review result submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_task_drift_review_result: tool({
      description: "Reviewer-only: submit structured task drift check results for the active orchestrator session.",
      args: {
        drift_detected: tool.schema.boolean(),
        updated_descriptions: tool.schema.array(tool.schema.object({
          task_id: tool.schema.string(),
          description: tool.schema.string(),
        })).optional(),
        reasoning: tool.schema.string().optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine reviewer session ID."
        const updates: Record<string, string> = {}
        for (const item of Array.isArray(args["updated_descriptions"]) ? args["updated_descriptions"] : []) {
          const record = item && typeof item === "object" ? item as Record<string, unknown> : {}
          if (typeof record["task_id"] === "string" && typeof record["description"] === "string") updates[record["task_id"]] = record["description"]
        }
        const parsed = TaskDriftReviewOutputSchema.safeParse({
          drift_detected: args["drift_detected"],
          updated_descriptions: updates,
          reasoning: typeof args["reasoning"] === "string" ? args["reasoning"] : "",
        })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_task_drift_review_result", JSON.stringify(parsed.data))
        return recorded.success ? "Task drift review result submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_orchestrator_assess_result: tool({
      description: "Orchestrator-only: submit structured feedback artifact assessment for the active orchestrator session.",
      args: {
        affected_artifacts: tool.schema.array(tool.schema.string()),
        root_cause_artifact: tool.schema.string(),
        reasoning: tool.schema.string().optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine orchestrator session ID."
        const parsed = OrchestratorAssessOutputSchema.safeParse({
          affected_artifacts: Array.isArray(args["affected_artifacts"]) ? args["affected_artifacts"] : [],
          root_cause_artifact: args["root_cause_artifact"],
          reasoning: typeof args["reasoning"] === "string" ? args["reasoning"] : "",
        })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_orchestrator_assess_result", JSON.stringify(parsed.data))
        return recorded.success ? "Orchestrator assessment submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_orchestrator_diverge_result: tool({
      description: "Orchestrator-only: submit structured feedback divergence classification for the active orchestrator session.",
      args: {
        classification: tool.schema.string().describe("tactical, backtrack, or strategic."),
        trigger_criterion: tool.schema.string().optional(),
        reasoning: tool.schema.string().optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine orchestrator session ID."
        const parsed = OrchestratorDivergeOutputSchema.safeParse({
          classification: args["classification"],
          trigger_criterion: typeof args["trigger_criterion"] === "string" ? args["trigger_criterion"] : null,
          reasoning: typeof args["reasoning"] === "string" ? args["reasoning"] : "",
        })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_orchestrator_diverge_result", JSON.stringify(parsed.data))
        return recorded.success ? "Orchestrator divergence submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_auto_approve_result: tool({
      description: "Auto-approver-only: submit structured auto-approval result for the active auto-approver session.",
      args: {
        approve: tool.schema.boolean(),
        confidence: tool.schema.string().describe("Numeric confidence from 0.0 to 1.0."),
        reasoning: tool.schema.string().optional(),
        feedback: tool.schema.string().optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine auto-approver session ID."
        const confidence = typeof args["confidence"] === "string" ? Number(args["confidence"]) : args["confidence"]
        const parsed = AutoApproveOutputSchema.safeParse({
          approve: args["approve"],
          confidence,
          reasoning: typeof args["reasoning"] === "string" ? args["reasoning"] : "",
          ...(typeof args["feedback"] === "string" ? { feedback: args["feedback"] } : {}),
        })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_auto_approve_result", JSON.stringify(parsed.data))
        return recorded.success ? "Auto-approval result submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_rebuttal_review_result: tool({
      description: "Reviewer-only: submit structured rebuttal review results for the active reviewer session.",
      args: {
        criteria_results: tool.schema.array(tool.schema.object({
          criterion: tool.schema.string(),
          met: tool.schema.boolean(),
          evidence: tool.schema.string(),
          severity: tool.schema.enum(["blocking", "suggestion", "design-invariant"]).optional(),
          score: tool.schema.string().optional(),
          rebuttal_accepted: tool.schema.boolean().optional(),
        })),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine reviewer session ID."
        const criteria = Array.isArray(args["criteria_results"]) ? args["criteria_results"] : []
        const normalizedCriteria = criteria.map((item) => {
          const record = item && typeof item === "object" ? item as Record<string, unknown> : {}
          const rawScore = record["score"]
          const score = typeof rawScore === "string" && rawScore.trim().length > 0 ? Number(rawScore) : rawScore
          return {
            criterion: record["criterion"],
            met: record["met"],
            evidence: record["evidence"],
            severity: record["severity"] ?? "blocking",
            ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
            ...(typeof record["rebuttal_accepted"] === "boolean" ? { rebuttal_accepted: record["rebuttal_accepted"] } : {}),
          }
        })
        const parsed = RebuttalReviewOutputSchema.safeParse({ criteria_results: normalizedCriteria })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_rebuttal_review_result", JSON.stringify(parsed.data))
        return recorded.success ? "Rebuttal review result submitted." : `Error: ${recorded.error}`
      },
    }),

    submit_intent_comparison_result: tool({
      description: "Reviewer-only: submit structured prior-workflow intent comparison for the active intent-check session.",
      args: {
        classification: tool.schema.string().describe("FULL, PARTIAL, DIFFERENT, or ERROR."),
        explanation: tool.schema.string().optional(),
      },
      async execute(args: Record<string, unknown>, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine reviewer session ID."
        const parsed = IntentComparisonOutputSchema.safeParse({
          classification: args["classification"],
          explanation: typeof args["explanation"] === "string" ? args["explanation"] : "",
        })
        if (!parsed.success) return `Error: ${formatZodError(parsed.error)}`
        const recorded = reviewerToolSubmissions.record(sessionId, "submit_intent_comparison_result", JSON.stringify(parsed.data))
        return recorded.success ? "Intent comparison result submitted." : `Error: ${recorded.error}`
      },
    }),
  }
}
