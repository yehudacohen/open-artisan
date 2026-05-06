/**
 * self-review.ts — Isolated subagent self-review dispatcher (Layer 3).
 *
 * Design doc §4.2 + §6: Self-review runs in an isolated subagent session that
 * sees ONLY the artifact files and acceptance criteria — never the authoring
 * conversation. This eliminates anchoring bias where the authoring agent is
 * predisposed to pass its own work.
 *
 * Lifecycle per review invocation:
 *   1. Create an ephemeral session with the workflow-reviewer agent
 *   2. Prompt it with: artifact files + phase criteria (JSON schema output)
 *   3. Parse structured review result (criteria_results + satisfied boolean)
 *   4. Delete the session (best-effort cleanup)
 *   5. Return typed SelfReviewResult to the caller
 *
 * If the session lifecycle fails at any step, falls back to a SelfReviewError
 * so the caller can choose a safe fallback (e.g. treat as satisfied=false and
 * let the agent loop, or escalate to USER_GATE).
 */

import type { ArtifactKey, Phase, WorkflowMode } from "./workflow-primitives"
import type { CriterionResult, RebuttalRequest, RebuttalResult, SelfReviewResult } from "./review-types"
import type { SubagentDispatcher } from "./subagent-dispatcher"
import { withTimeout, extractJsonFromText } from "./utils"
import { SELF_REVIEW_TIMEOUT_MS, MAX_ARTIFACT_CONTENT_CHARS } from "./constants"
import { buildSelfReviewStructuralGate } from "./rubrics"

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export interface SelfReviewRequest {
  phase: Phase
  mode: WorkflowMode | null
  /** Absolute paths of artifact files to review */
  artifactPaths: string[]
  /** The acceptance criteria text block from getAcceptanceCriteria() */
  criteriaText: string
  /** Optional upstream artifact summaries for context */
  upstreamSummary?: string
  /**
   * Optional inline artifact content for phases whose artifacts live in memory
   * (PLANNING, IMPL_PLAN, DISCOVERY). When provided AND artifactPaths is empty,
   * the reviewer evaluates this text directly instead of reading files.
   */
  artifactContent?: string
  /** Parent session ID — when set, the ephemeral review session is created as a
   *  child of this session so the user can see the review in the TUI. */
  parentSessionId?: string
  /** Feature name for session title context (e.g. "cloud-cost-platform") */
  featureName?: string | null
  /** Parent model (if available) for subagent session creation */
  parentModel?: string | { modelID: string; providerID?: string }
  /** Absolute file allowlist (INCREMENTAL mode) for phase gating */
  fileAllowlist?: string[]
  /** Approved artifact hashes for state-aware allowlist review */
  approvedArtifacts?: Partial<Record<ArtifactKey, string>>
  /** Disk paths for approved artifacts (if available) */
  artifactDiskPaths?: Partial<Record<ArtifactKey, string>>
  /** Reviewed source files approved for each artifact key. */
  approvedArtifactFiles?: Partial<Record<ArtifactKey, string[]>>
  /**
   * The best available distilled statement of user intent for this workflow.
   * Prefer this over raw message history so approval/gate chatter does not
   * pollute vision-alignment review.
   */
  intentBaseline?: string | null
  /** Recent user feedback/revision history that may supersede older artifact details. */
  feedbackHistory?: Array<{ phase: Phase; feedback: string; timestamp: number }>
}

export function buildReviewPrompt(req: SelfReviewRequest): string {
  const lines: string[] = []

  lines.push(`You are reviewing the **${req.phase}** artifact produced by the workflow.`)
  lines.push("")
  lines.push("## Artifact to Review")
  if (req.phase === "INTERFACES") {
    lines.push(
      "Structural gate: every reviewed artifact must be a real interface/type/schema file in the project source tree. " +
      "Markdown plans/design docs and files under .openartisan/ are invalid for INTERFACES and must be marked unmet before content review.",
    )
    lines.push("")
  } else if (req.phase === "TESTS") {
    lines.push(
      "Structural gate: every reviewed artifact must be a real runnable test/spec file in the project test/source tree. " +
      "Markdown test plans and files under .openartisan/ are invalid for TESTS and must be marked unmet before content review.",
    )
    lines.push("")
  }
  if (req.artifactPaths.length > 0) {
    lines.push(
      "Read each of the following files before evaluating. " +
      "These are the actual artifact files in the project directory (NOT in .openartisan/ — " +
      ".openartisan/ is only for plan documents). Do NOT search .openartisan/ for these files.",
    )
    lines.push(
      "Evaluate ONLY these listed files as the reviewed artifact set. Imported modules, augmented modules, " +
      "and referenced source files may provide context, but do not mark criteria unmet because an unlisted " +
      "dependency has pre-existing issues unless the listed artifact itself introduces or relies on that issue.",
    )
    lines.push(
      "For TypeScript module augmentation, review the augmentation declarations in the listed artifact; " +
      "do not treat the original augmented module as a reviewed artifact unless it is explicitly listed below.",
    )
    for (const p of req.artifactPaths) {
      lines.push(`  - \`${p}\``)
    }
  } else if (req.artifactContent) {
    lines.push(
      "The artifact for this phase is an in-memory document (not written to disk). " +
      "Evaluate the following content directly:",
    )
    lines.push("")
    lines.push("```")
    // Cap at MAX_ARTIFACT_CONTENT_CHARS to prevent extreme prompt size
    const capped = req.artifactContent.length > MAX_ARTIFACT_CONTENT_CHARS
      ? req.artifactContent.slice(0, MAX_ARTIFACT_CONTENT_CHARS) + `\n\n[... artifact truncated at ${MAX_ARTIFACT_CONTENT_CHARS} chars — read the full file from disk for complete content ...]`
      : req.artifactContent
    lines.push(capped)
    lines.push("```")
  } else {
    // Guide the reviewer on where to find files when no explicit paths are provided.
    // For file-based phases (INTERFACES, TESTS, IMPLEMENTATION), the artifacts are
    // in the project directory structure, not in .openartisan/.
    const isFileBased = ["INTERFACES", "TESTS", "IMPLEMENTATION"].includes(req.phase)
    if (isFileBased) {
      lines.push(
        "No specific artifact file paths were resolved automatically. " +
        "Use `Glob` and `Read` tools to find the relevant files in the project directory. " +
        `For the **${req.phase}** phase, look in the project source tree (src/, packages/, test/, tests/, __tests__/) — ` +
        "NOT in .openartisan/ (that directory only holds plan/convention documents). " +
        "If you cannot find any relevant files, mark criteria as unmet with evidence explaining what's missing.",
      )
    } else {
      lines.push(
        "No specific artifact file paths or content were provided. " +
        "Evaluate based on the acceptance criteria only — mark criteria as unmet if evidence cannot be verified.",
      )
    }
  }
  lines.push("")

  lines.push("## Acceptance Criteria")
  lines.push(req.criteriaText)
  lines.push("")
  lines.push(buildSelfReviewStructuralGate(req.phase))
  lines.push("")

  // Add the user's original intent for context.
  if (req.intentBaseline && req.intentBaseline.trim().length > 0) {
    lines.push("## User's Original Request")
    lines.push("Use this to evaluate Vision alignment:")
    lines.push("")
    lines.push(`- ${req.intentBaseline.trim()}`)
    lines.push("")
  }

  if (req.feedbackHistory && req.feedbackHistory.length > 0) {
    const recentFeedback = req.feedbackHistory.slice(-5)
    lines.push("## Recent User Feedback / Approved Direction")
    lines.push("Use this to resolve conflicts between older artifacts and the latest approved intent.")
    lines.push("Do not resurrect requirements that the user explicitly superseded in later feedback.")
    lines.push("")
    for (const entry of recentFeedback) {
      lines.push(`- **${entry.phase}**: ${entry.feedback}`)
    }
    lines.push("")
  }

  if (req.upstreamSummary) {
    lines.push("## Upstream Artifacts (for reference)")
    lines.push(req.upstreamSummary)
    lines.push("")
  }

  // Always show artifact disk paths so the reviewer can cross-reference
  // the plan, conventions, interfaces, etc. regardless of mode.
  if (req.artifactDiskPaths && Object.keys(req.artifactDiskPaths).length > 0) {
    lines.push("## Approved Artifact Locations")
    lines.push("These are the disk paths for artifacts approved in prior phases. Read them for context.")
    lines.push("")
    for (const [key, value] of Object.entries(req.artifactDiskPaths)) {
      if (value) lines.push(`- **${key}**: \`${value}\``)
    }
    lines.push("")
  }

  if (req.approvedArtifactFiles && Object.keys(req.approvedArtifactFiles).length > 0) {
    lines.push("## Approved Artifact Source Files")
    lines.push("These are the exact source files reviewed and approved for prior file-based phases. Prefer these over legacy markdown mirrors if they conflict.")
    lines.push("")
    for (const [key, paths] of Object.entries(req.approvedArtifactFiles)) {
      if (!paths || paths.length === 0) continue
      lines.push(`- **${key}**:`)
      for (const path of paths) {
        lines.push(`  - \`${path}\``)
      }
    }
    lines.push("")
  }

  if (req.fileAllowlist && req.fileAllowlist.length > 0) {
    lines.push("## Allowlist Review (State-Aware)")
    lines.push("The file allowlist governs which phases can be executed in INCREMENTAL mode.")
    lines.push("Verify it includes all files needed for unfinished phases, considering what is already approved.")
    lines.push("")
    lines.push("**Allowlist:**")
    for (const p of req.fileAllowlist) {
      lines.push(`- ${p}`)
    }
    if (req.approvedArtifacts && Object.keys(req.approvedArtifacts).length > 0) {
      lines.push("")
      lines.push("**Approved artifacts (already complete):**")
      for (const [key, value] of Object.entries(req.approvedArtifacts)) {
        if (value) lines.push(`- ${key}`)
      }
    }
    lines.push("")
    lines.push("Allowlist adequacy rule (blocking): If the allowlist omits files needed for unfinished phases (e.g. TESTS or IMPL_PLAN), add a blocking criterion named `Allowlist adequacy` and mark it unmet with evidence.")
    lines.push("If the relevant phases are already complete and unchanged, you may mark allowlist adequacy as met.")
    lines.push("")
  }

  lines.push("## Instructions")
  lines.push("1. Read every artifact file listed above before forming any opinion.")
  lines.push("2. Evaluate each acceptance criterion independently.")
  lines.push("3. Reconcile criteria against the latest approved user direction. If older plans or prior artifacts conflict with newer feedback, treat the newer feedback as authoritative unless a design-invariant criterion explicitly says otherwise.")
  lines.push("4. Do not require concrete fields, files, APIs, or behavior that were explicitly rejected or superseded by recent user feedback. Mark only real gaps against the current approved intent.")
  lines.push("5. For standard criteria: state met (true/false), provide evidence (quote or file:line), and mark severity.")
  lines.push("6. For [Q] quality criteria: provide a numeric `score` (1-10) and evidence justifying the score. score >= 9 means met, < 9 means not met.")
  lines.push("7. Use the full 1-10 range honestly. Reward excellence just as clearly as you punish flaws; do not compress scores into a narrow band.")
  lines.push("8. Scoring guide: 1-2 = fundamentally broken, 3-4 = major gaps, 5-6 = mixed/adequate but clearly incomplete, 7-8 = strong with meaningful improvement still needed, 9 = excellent and ready to advance, 10 = exceptional work that materially exceeds the normal quality bar for this phase.")
  lines.push("9. Set `satisfied` to true ONLY if ALL blocking criteria are met AND ALL [Q] scores are >= 9.")
  lines.push("10. Return your assessment as a JSON object. IMPORTANT: reply with ONLY the JSON — no preamble, no explanation.")
  lines.push("")
  lines.push("The JSON must match this structure:")
  lines.push("```json")
  lines.push(JSON.stringify({
    satisfied: false,
    criteria_results: [
      { criterion: "<standard criterion>", met: false, evidence: "<quote or file:line>", severity: "blocking" },
      { criterion: "[Q] Design excellence — <description>", met: true, evidence: "<justification for score>", severity: "blocking", score: 9 },
    ],
  }, null, 2))
  lines.push("```")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Ephemeral session helper — uses SubagentDispatcher for platform abstraction
// ---------------------------------------------------------------------------

async function ephemeralReviewPrompt(
  dispatcher: SubagentDispatcher,
  prompt: string,
  parentSessionId?: string,
  parentModel?: string | { modelID: string; providerID?: string },
  title = "workflow-review",
): Promise<string> {
  const session = await dispatcher.createSession({
    title,
    agent: "workflow-reviewer",
    ...(parentSessionId ? { parentId: parentSessionId } : {}),
    ...(parentModel ? { model: parentModel } : {}),
  })
  try {
    return await session.prompt(prompt)
  } finally {
    await session.destroy()
  }
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

export function parseReviewResult(raw: string): SelfReviewResult {
  const parsed = JSON.parse(raw) as {
    satisfied: boolean
    criteria_results: Array<{
      criterion: string
      met: boolean
      evidence: string
      severity: string
      score?: number
    }>
  }

  const criteriaResults: CriterionResult[] = (parsed.criteria_results ?? []).map((c) => {
    const criterionText = c.criterion ?? ""
    const isQuality = criterionText.startsWith("[Q]")
    const isDesignInvariant = criterionText.startsWith("[D]")
    const score = typeof c.score === "number" ? c.score : undefined
    // For [Q] criteria with a score, derive `met` from score threshold (same logic as mark-satisfied.ts)
    const met = (isQuality && score !== undefined)
      ? score >= 9
      : (c.met ?? false)
    // Determine severity: [D] = design-invariant (blocking + non-rebuttable),
    // [S] = suggestion, everything else = blocking
    const severity: CriterionResult["severity"] = isDesignInvariant
      ? "design-invariant"
      : c.severity === "suggestion" ? "suggestion" : "blocking"
    return {
      criterion: criterionText || "unknown",
      met,
      evidence: (isQuality && score !== undefined)
        ? `${c.evidence ?? ""} (score: ${score}/10)`
        : (c.evidence ?? ""),
      severity,
      ...(score !== undefined ? { score } : {}),
    }
  })

  // Recompute `satisfied` from criteria to guard against LLM inconsistency:
  // satisfied must be false if any blocking or design-invariant criterion is not met.
  const hasUnmetBlocking = criteriaResults.some(
    (c) => !c.met && (c.severity === "blocking" || c.severity === "design-invariant"),
  )
  const satisfied = !hasUnmetBlocking

  return { success: true, satisfied, criteriaResults }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Dispatches an isolated reviewer subagent for the given phase artifact.
 * Returns SelfReviewSuccess with per-criterion results, or SelfReviewError
 * if the session lifecycle fails.
 *
 * The reviewer sees only the artifact files and acceptance criteria — never
 * the authoring conversation. This enforces the isolation invariant.
 */
export async function dispatchSelfReview(
  dispatcher: SubagentDispatcher,
  req: SelfReviewRequest,
): Promise<SelfReviewResult> {
  try {
    const prompt = buildReviewPrompt(req)
    const featureSlug = req.featureName ? ` (${req.featureName})` : ""
    const title = `Review: ${req.phase}${featureSlug}`
    const text = await withTimeout(
      ephemeralReviewPrompt(dispatcher, prompt, req.parentSessionId, req.parentModel, title),
      SELF_REVIEW_TIMEOUT_MS,
      "self-review",
    )
    return parseReviewResult(extractJsonFromText(text))
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: errorMsg,
    }
  }
}

// ---------------------------------------------------------------------------
// Agent rebuttal — pre-escalation negotiation with the reviewer
// ---------------------------------------------------------------------------

/**
 * Builds the rebuttal prompt sent to a fresh reviewer session.
 * The reviewer sees its own prior verdict and the agent's counterarguments,
 * and must either revise scores upward or maintain its position.
 */
export function buildRebuttalPrompt(req: RebuttalRequest): string {
  const lines: string[] = []

  lines.push(`You are re-evaluating specific criteria for the **${req.phase}** artifact.`)
  lines.push("")
  lines.push("## Context")
  lines.push(
    "A previous review found the following criteria unmet. The authoring agent has provided " +
    "counterarguments explaining why it believes these criteria are either met or out of scope " +
    "for this phase. You must evaluate each counterargument on its merits.",
  )
  lines.push("")

  lines.push("## Previous Review Verdict (unmet criteria)")
  for (const c of req.reviewerVerdict) {
    const scoreNote = typeof c.score === "number" ? ` (score: ${c.score}/10)` : ""
    lines.push(`- **${c.criterion}**${scoreNote}: ${c.evidence}`)
  }
  lines.push("")

  lines.push("## Agent's Counterarguments")
  for (const a of req.agentAssessment) {
    const scoreNote = typeof a.score === "number" ? ` (agent claims score: ${a.score}/10)` : ""
    lines.push(`- **${a.criterion}**${scoreNote}: ${a.evidence}`)
  }
  lines.push("")

  if (req.artifactPaths.length > 0) {
    lines.push("## Artifact Files (re-check if needed)")
    for (const p of req.artifactPaths) {
      lines.push(`  - \`${p}\``)
    }
    lines.push("")
  }

  lines.push("## Acceptance Criteria (for reference)")
  lines.push(req.criteriaText)
  lines.push("")

  lines.push("## Instructions")
  lines.push("1. For each disputed criterion, evaluate the agent's counterargument independently.")
  lines.push("2. A valid counterargument includes: the concern is genuinely out of scope for this phase,")
  lines.push("   OR the concern is addressed elsewhere in the artifact, OR the concern misinterprets the criterion.")
  lines.push("3. An INVALID counterargument includes: 'we'll fix it later', 'it's good enough', or vague dismissals.")
  lines.push("4. If you accept the rebuttal, revise the score to >= 9. If you reject it, keep the original score.")
  lines.push("5. Be fair but rigorous — accept valid scope arguments, reject handwaving.")
  lines.push("6. Return ONLY the disputed criteria (not all criteria) with your revised assessment.")
  lines.push("")
  lines.push("Return your assessment as a JSON object. IMPORTANT: reply with ONLY the JSON — no preamble.")
  lines.push("```json")
  lines.push(JSON.stringify({
    criteria_results: [
      {
        criterion: "<criterion text>",
        met: true,
        evidence: "<why you accepted or rejected the rebuttal>",
        severity: "blocking",
        score: 9,
        rebuttal_accepted: true,
      },
    ],
  }, null, 2))
  lines.push("```")

  return lines.join("\n")
}

/**
 * Dispatches an agent rebuttal to a fresh reviewer session.
 * Returns RebuttalSuccess with revised criteria, or RebuttalError on failure.
 *
 * This is called when the review loop is one iteration from escalation and
 * there are unmet criteria scoring 7-8 (close enough to threshold that a
 * scope argument could be valid).
 */
export async function dispatchRebuttal(
  dispatcher: SubagentDispatcher,
  req: RebuttalRequest,
): Promise<RebuttalResult> {
  try {
    const prompt = buildRebuttalPrompt(req)
    const featureSlug = req.featureName ? ` (${req.featureName})` : ""
    const title = `Rebuttal: ${req.phase}${featureSlug}`
    const rawText = await withTimeout(
      ephemeralReviewPrompt(dispatcher, prompt, req.parentSessionId, req.parentModel, title),
      SELF_REVIEW_TIMEOUT_MS,
      "rebuttal",
    )
    const text = extractJsonFromText(rawText)
    const parsed = JSON.parse(text) as {
      criteria_results: Array<{
        criterion: string
        met: boolean
        evidence: string
        severity: string
        score?: number
        rebuttal_accepted?: boolean
      }>
    }

    const revisedResults: CriterionResult[] = (parsed.criteria_results ?? []).map((c) => {
      const isQuality = (c.criterion ?? "").startsWith("[Q]")
      const score = typeof c.score === "number" ? c.score : undefined
      const met = (isQuality && score !== undefined) ? score >= 9 : (c.met ?? false)
      return {
        criterion: c.criterion ?? "unknown",
        met,
        evidence: (isQuality && score !== undefined)
          ? `${c.evidence ?? ""} (score: ${score}/10)`
          : (c.evidence ?? ""),
        severity: c.severity === "suggestion" ? "suggestion" as const : "blocking" as const,
        ...(score !== undefined ? { score } : {}),
      }
    })

    const allResolved = revisedResults.every((c) => c.met || c.severity === "suggestion")

    return { success: true, revisedResults, allResolved }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { success: false, error: errorMsg }
  }
}
