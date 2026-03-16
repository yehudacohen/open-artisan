/**
 * auto-approve.ts — Auto-approval dispatcher for robot-artisan mode (Part C).
 *
 * When the active agent is "robot-artisan" and the workflow reaches USER_GATE,
 * this module dispatches an isolated auto-approver subagent that evaluates
 * whether the artifact is ready for approval. The auto-approver:
 *
 *   1. Receives the artifact summary, disk paths, and workflow context
 *   2. Evaluates quality against phase-specific criteria (lighter than full review)
 *   3. Returns a structured decision: { approve: boolean, confidence: number, feedback?: string }
 *   4. If confidence >= 0.7: approves automatically
 *   5. If confidence < 0.7: returns revision feedback for the agent to address
 *
 * The auto-approver uses `agent: "auto-approver"` and is created with `hidden: true`
 * in the agent file, so it doesn't appear in the Tab UI.
 *
 * This replaces the human gate at USER_GATE when in robot-artisan mode. The human
 * can still intervene by switching to the artisan agent or sending a message.
 */

import type { Phase, WorkflowMode, ArtifactKey } from "./types"
import type { PluginClient } from "./client-types"
import { extractTextFromPromptResult, extractEphemeralSessionId, extractJsonFromText } from "./utils"
import { createLogger } from "./logger"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum wall-clock time for the auto-approver subagent (ms).
 * Set to 2 minutes — the auto-approver does a lighter evaluation than full review.
 */
export const AUTO_APPROVE_TIMEOUT_MS = 120_000

/**
 * Minimum confidence threshold for auto-approval.
 * Below this, the auto-approver must revise instead of approving.
 */
export const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.7

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoApproveRequest {
  phase: Phase
  mode: WorkflowMode | null
  /** Absolute paths of artifact files to evaluate */
  artifactDiskPaths: Partial<Record<ArtifactKey, string>>
  /** Summary of what was built in this phase (from request_review) */
  phaseSummary?: string
  /** Feature name for context */
  featureName?: string | null
  /** Conventions text or path for alignment checking */
  conventionsPath?: string | null
  /** Parent session ID for TUI session tree */
  parentSessionId?: string
  /** Whether this is an escalation (review cap hit) — approver should be more lenient */
  isEscalation?: boolean
}

export interface AutoApproveSuccess {
  success: true
  approve: boolean
  confidence: number
  reasoning: string
  /** Specific revision feedback if approve === false */
  feedback?: string
}

export interface AutoApproveError {
  success: false
  error: string
}

export type AutoApproveResult = AutoApproveSuccess | AutoApproveError

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildAutoApprovePrompt(req: AutoApproveRequest): string {
  const lines: string[] = []

  lines.push("# Auto-Approval Evaluation")
  lines.push("")
  lines.push("You are an automated quality gate evaluating a workflow artifact.")
  lines.push("Your job is to determine whether this artifact is ready for approval")
  lines.push("or needs revision before proceeding.")
  lines.push("")
  lines.push(`**Phase:** ${req.phase}`)
  lines.push(`**Mode:** ${req.mode ?? "unknown"}`)
  if (req.featureName) lines.push(`**Feature:** ${req.featureName}`)
  lines.push("")

  // Artifact paths
  const paths = Object.entries(req.artifactDiskPaths).filter(([, v]) => v)
  if (paths.length > 0) {
    lines.push("## Artifacts to Evaluate")
    lines.push("")
    for (const [key, path] of paths) {
      lines.push(`- **${key}**: \`${path}\``)
    }
    lines.push("")
    lines.push("Read each artifact file listed above before making your assessment.")
    lines.push("")
  }

  if (req.conventionsPath) {
    lines.push(`## Conventions Document`)
    lines.push(`Read the conventions at \`${req.conventionsPath}\` and verify the artifact follows them.`)
    lines.push("")
  }

  if (req.phaseSummary) {
    lines.push("## Phase Summary")
    lines.push(req.phaseSummary)
    lines.push("")
  }

  if (req.isEscalation) {
    lines.push("## Note: Escalation Review")
    lines.push("The self-review loop hit its iteration cap. The artifact may have minor")
    lines.push("quality issues that the reviewer flagged repeatedly. Focus on whether the")
    lines.push("artifact is **functional and complete** rather than stylistically perfect.")
    lines.push("Be more lenient on quality scores but strict on correctness and completeness.")
    lines.push("")
  }

  lines.push("## Evaluation Criteria")
  lines.push("")
  lines.push("Assess the artifact on these dimensions:")
  lines.push("1. **Completeness** — Does the artifact cover all required elements for this phase?")
  lines.push("2. **Correctness** — Are there any factual errors, contradictions, or invalid content?")
  lines.push("3. **Alignment** — Does the artifact align with the user's intent and upstream artifacts?")
  lines.push("4. **Quality** — Is the artifact well-structured, clear, and production-ready?")
  lines.push("")
  lines.push("## Response Format")
  lines.push("")
  lines.push("Respond with a JSON block (and nothing else):")
  lines.push("```json")
  lines.push(JSON.stringify({
    approve: true,
    confidence: 0.85,
    reasoning: "Brief explanation of your assessment",
    feedback: "Only include this field if approve is false — specific revision instructions",
  }, null, 2))
  lines.push("```")
  lines.push("")
  lines.push("Rules:")
  lines.push("- `confidence` is a float from 0.0 to 1.0")
  lines.push(`- If confidence >= ${AUTO_APPROVE_CONFIDENCE_THRESHOLD}, set approve: true`)
  lines.push(`- If confidence < ${AUTO_APPROVE_CONFIDENCE_THRESHOLD}, set approve: false and provide feedback`)
  lines.push("- Be honest about quality — do not rubber-stamp artifacts with real issues")
  lines.push("- Focus on blocking issues, not style preferences")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Ephemeral session dispatch
// ---------------------------------------------------------------------------

async function ephemeralAutoApproveSession(
  client: PluginClient,
  prompt: string,
  parentSessionId?: string,
): Promise<unknown> {
  if (!client.session) throw new Error("client.session is not available — cannot dispatch auto-approver")

  const created = await client.session.create({
    body: {
      title: "auto-approve",
      agent: "auto-approver",
      ...(parentSessionId ? { parentID: parentSessionId } : {}),
    },
  })

  const sessionId = extractEphemeralSessionId(created, "auto-approve")

  try {
    return await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
      },
    })
  } finally {
    // Skip delete for child sessions — cleaned up with parent
    if (!parentSessionId) {
      try { await client.session.delete({ path: { id: sessionId } }) } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

function parseAutoApproveResult(raw: string): AutoApproveResult {
  const parsed = JSON.parse(raw) as {
    approve: boolean
    confidence: number
    reasoning: string
    feedback?: string
  }

  if (typeof parsed.approve !== "boolean") {
    return { success: false, error: "Missing or invalid 'approve' field in auto-approver response" }
  }
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
    return { success: false, error: `Invalid 'confidence' value: ${parsed.confidence} (must be 0.0-1.0)` }
  }

  // Override approve based on confidence threshold — don't trust the model's self-assessment
  const shouldApprove = parsed.confidence >= AUTO_APPROVE_CONFIDENCE_THRESHOLD

  return {
    success: true,
    approve: shouldApprove,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning ?? "",
    ...(shouldApprove ? {} : { feedback: parsed.feedback ?? parsed.reasoning ?? "Revision needed" }),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatches an auto-approval evaluation for the current USER_GATE.
 * Returns an AutoApproveResult indicating whether to approve or revise.
 *
 * On any failure (dispatch error, timeout, parse error), returns an
 * AutoApproveError — the caller should treat this as "cannot auto-approve"
 * and either fall back to manual approval or request revision.
 */
export async function dispatchAutoApproval(
  client: PluginClient,
  req: AutoApproveRequest,
): Promise<AutoApproveResult> {
  const log = createLogger(client)

  try {
    const prompt = buildAutoApprovePrompt(req)

    // Dispatch with timeout
    const resultPromise = ephemeralAutoApproveSession(client, prompt, req.parentSessionId)
    const rawResult = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Auto-approve timeout")), AUTO_APPROVE_TIMEOUT_MS),
      ),
    ])

    // Extract text from the prompt result
    const responseText = extractTextFromPromptResult(rawResult)
    if (!responseText) {
      return { success: false, error: "Auto-approver returned empty response" }
    }

    // Extract JSON from response (may be wrapped in markdown code fences)
    const jsonText = extractJsonFromText(responseText)
    if (!jsonText) {
      return { success: false, error: "Could not extract JSON from auto-approver response" }
    }

    const result = parseAutoApproveResult(jsonText)

    if (result.success) {
      log.info(
        result.approve
          ? `Auto-approve: APPROVED (confidence: ${result.confidence.toFixed(2)})`
          : `Auto-approve: REVISION NEEDED (confidence: ${result.confidence.toFixed(2)})`,
      )
    }

    return result
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log.warn("Auto-approval dispatch failed", { detail: errMsg })
    return { success: false, error: errMsg }
  }
}
