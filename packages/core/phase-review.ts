import { extractJsonFromText } from "./utils"

export const PHASE_REVIEW_FAILURE_PREFIX = "ISOLATED_PHASE_REVIEW_FAILED:"

export interface PhaseReviewProcessResult {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  error?: string | null
}

function formatFailedReviewOutput(reason: string, stdout = "", stderr = ""): string {
  const details = [reason]
  if (stdout.trim()) details.push(`stdout: ${stdout.trim()}`)
  if (stderr.trim()) details.push(`stderr: ${stderr.trim()}`)
  return `${PHASE_REVIEW_FAILURE_PREFIX} ${details.join(" | ")}`
}

function validatePhaseReviewJson(output: string): string | null {
  if (!output.trim()) return "Empty reviewer output"

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonFromText(output))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `Reviewer output was not valid phase-review JSON: ${message}`
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Reviewer output JSON must be an object"
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.satisfied !== "boolean") {
    return "Reviewer output JSON must include boolean satisfied"
  }
  if (!Array.isArray(value.criteria_results)) {
    return "Reviewer output JSON must include criteria_results array"
  }

  return null
}

export function normalizePhaseReviewOutput(result: PhaseReviewProcessResult): string {
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  const exitCode = result.exitCode ?? 0

  if (result.error?.trim()) {
    return formatFailedReviewOutput(result.error.trim(), stdout, stderr)
  }

  if (exitCode !== 0) {
    return formatFailedReviewOutput(`reviewer command exited with code ${exitCode}`, stdout, stderr)
  }

  const validationError = validatePhaseReviewJson(stdout)
  if (validationError) {
    return formatFailedReviewOutput(validationError, stdout, stderr)
  }

  return stdout
}

export function buildInvalidPhaseReviewJsonReason(reviewOutput: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const excerpt = reviewOutput.length > 500 ? `${reviewOutput.slice(0, 500)}...` : reviewOutput
  return `Reviewer output was not valid phase-review JSON: ${message}; raw output: ${excerpt}`
}
