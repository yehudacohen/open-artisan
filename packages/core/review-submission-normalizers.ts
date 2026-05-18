import { normalizePhaseReviewOutput } from "./phase-review"

export type ReviewSubmissionNormalizationResult =
  | { success: true; reviewOutput: string }
  | { success: false; error: string }

function normalizeReviewScore(value: string | number | undefined, fieldName: string): { score?: number; error?: string } {
  if (value === undefined) return {}
  const score = typeof value === "number" ? value : Number(value.trim())
  if (!Number.isFinite(score)) return { error: `${fieldName} must be a finite number.` }
  return { score }
}

export function buildTaskReviewOutputFromSubmission(input: {
  review_output?: string | undefined
  passed?: boolean | undefined
  issues?: string[] | undefined
  reasoning?: string | undefined
  code_quality_score?: string | number | undefined
  error_handling_score?: string | number | undefined
  patch_suggestions?: Array<{ target_path: string; summary: string; suggested_patch: string }> | undefined
}): ReviewSubmissionNormalizationResult {
  const rawOutput = input.review_output?.trim()
  if (rawOutput) return { success: true, reviewOutput: rawOutput }

  if (input.passed === undefined) {
    return { success: false, error: "review_output or passed is required for submit_task_review." }
  }

  const codeQuality = normalizeReviewScore(input.code_quality_score, "code_quality_score")
  if (codeQuality.error) return { success: false, error: codeQuality.error }
  const errorHandling = normalizeReviewScore(input.error_handling_score, "error_handling_score")
  if (errorHandling.error) return { success: false, error: errorHandling.error }

  const scores: { code_quality?: number; error_handling?: number } = {}
  if (codeQuality.score !== undefined) scores.code_quality = codeQuality.score
  if (errorHandling.score !== undefined) scores.error_handling = errorHandling.score

  const output: {
    passed: boolean
    issues: string[]
    reasoning: string
    patch_suggestions: Array<{ target_path: string; summary: string; suggested_patch: string }>
    scores?: { code_quality?: number; error_handling?: number }
  } = {
    passed: input.passed,
    issues: input.issues ?? [],
    reasoning: input.reasoning ?? "",
    patch_suggestions: input.patch_suggestions ?? [],
  }
  if (Object.keys(scores).length > 0) output.scores = scores

  return { success: true, reviewOutput: JSON.stringify(output) }
}

export function buildPhaseReviewOutputFromSubmission(input: {
  review_output?: string | undefined
  satisfied?: boolean | undefined
  criteria_results?: Array<{
    criterionId?: string | undefined
    criterion_id?: string | undefined
    criterion: string
    met: boolean
    evidence: string
    severity: "blocking" | "suggestion" | "design-invariant"
    score?: string | number | undefined
  }> | undefined
  review_stdout?: string | undefined
  review_stderr?: string | undefined
  review_exit_code?: number | null | undefined
  review_error?: string | null | undefined
}): ReviewSubmissionNormalizationResult {
  const rawOutput = input.review_output?.trim()
  if (rawOutput) return { success: true, reviewOutput: rawOutput }

  if (input.satisfied !== undefined || input.criteria_results !== undefined) {
    if (input.satisfied === undefined) {
      return { success: false, error: "satisfied is required when criteria_results is provided." }
    }
    if (!input.criteria_results) {
      return { success: false, error: "criteria_results is required when satisfied is provided." }
    }
    const criteriaResults = []
    for (const criterion of input.criteria_results) {
      const normalizedScore = normalizeReviewScore(criterion.score, "criteria_results.score")
      if (normalizedScore.error) return { success: false, error: normalizedScore.error }
      criteriaResults.push({
        ...(criterion.criterionId ? { criterionId: criterion.criterionId } : {}),
        ...(criterion.criterion_id ? { criterion_id: criterion.criterion_id } : {}),
        criterion: criterion.criterion,
        met: criterion.met,
        evidence: criterion.evidence,
        severity: criterion.severity,
        ...(normalizedScore.score !== undefined ? { score: normalizedScore.score } : {}),
      })
    }
    return { success: true, reviewOutput: JSON.stringify({ satisfied: input.satisfied, criteria_results: criteriaResults }) }
  }

  const normalizedProcessOutput = normalizePhaseReviewOutput({
    ...(input.review_stdout !== undefined ? { stdout: input.review_stdout } : {}),
    ...(input.review_stderr !== undefined ? { stderr: input.review_stderr } : {}),
    ...(input.review_exit_code !== undefined ? { exitCode: input.review_exit_code } : {}),
    ...(input.review_error !== undefined ? { error: input.review_error } : {}),
  }).trim()

  if (!normalizedProcessOutput) {
    return { success: false, error: "review_output, typed review fields, or raw reviewer process result is required." }
  }
  return { success: true, reviewOutput: normalizedProcessOutput }
}

export function buildAutoApproveOutputFromSubmission(input: {
  review_output?: string | undefined
  approve?: boolean | undefined
  confidence?: string | number | undefined
  reasoning?: string | undefined
  feedback?: string | undefined
}): ReviewSubmissionNormalizationResult {
  const rawOutput = input.review_output?.trim()
  if (rawOutput) return { success: true, reviewOutput: rawOutput }

  if (input.approve === undefined) {
    return { success: false, error: "review_output or approve is required for submit_auto_approve." }
  }
  const confidence = normalizeReviewScore(input.confidence, "confidence")
  if (confidence.error) return { success: false, error: confidence.error }
  if (confidence.score === undefined) return { success: false, error: "confidence is required when approve is provided." }
  if (confidence.score < 0 || confidence.score > 1) return { success: false, error: "confidence must be between 0 and 1." }

  return {
    success: true,
    reviewOutput: JSON.stringify({
      approve: input.approve,
      confidence: confidence.score,
      reasoning: input.reasoning ?? "",
      ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
    }),
  }
}
