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

import type {
  Phase,
  WorkflowMode,
  SelfReviewResult,
  CriterionResult,
} from "./types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

// ---------------------------------------------------------------------------
// JSON schema for the structured review output
// ---------------------------------------------------------------------------

const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    satisfied: {
      type: "boolean",
      description: "true if ALL blocking criteria are met; false otherwise",
    },
    criteria_results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          evidence: { type: "string", description: "Quote or file reference supporting the verdict" },
          severity: { type: "string", enum: ["blocking", "suggestion"] },
        },
        required: ["criterion", "met", "evidence", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["satisfied", "criteria_results"],
  additionalProperties: false,
}

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
}

function buildReviewPrompt(req: SelfReviewRequest): string {
  const lines: string[] = []

  lines.push(`You are reviewing the **${req.phase}** artifact produced by the workflow.`)
  lines.push("")
  lines.push("## Artifact Files to Review")
  if (req.artifactPaths.length > 0) {
    lines.push("Read each of the following files before evaluating:")
    for (const p of req.artifactPaths) {
      lines.push(`  - \`${p}\``)
    }
  } else {
    lines.push(
      "No specific artifact file paths were provided. Review the artifact from the conversation above.",
    )
  }
  lines.push("")

  lines.push("## Acceptance Criteria")
  lines.push(req.criteriaText)
  lines.push("")

  if (req.upstreamSummary) {
    lines.push("## Upstream Artifacts (for reference)")
    lines.push(req.upstreamSummary)
    lines.push("")
  }

  lines.push("## Instructions")
  lines.push("1. Read every artifact file listed above before forming any opinion.")
  lines.push("2. Evaluate each acceptance criterion independently.")
  lines.push("3. For each criterion: state met (true/false), provide evidence (quote or file:line), and mark severity.")
  lines.push("4. Set `satisfied` to true ONLY if ALL blocking criteria are met.")
  lines.push("5. Return your assessment as JSON matching the schema.")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Ephemeral session helper (same pattern as llm-calls.ts)
// ---------------------------------------------------------------------------

async function ephemeralReviewSession(
  client: Client,
  prompt: string,
): Promise<unknown> {
  const created = await client.session.create({
    body: { title: "workflow-review", agent: "workflow-reviewer" },
  }) as Record<string, unknown>

  const sessionId =
    (created["id"] as string | undefined) ??
    (created["sessionId"] as string | undefined)

  if (!sessionId) {
    throw new Error("self-review: could not extract session ID from session.create() response")
  }

  try {
    return await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
        format: {
          type: "json_schema",
          schema: REVIEW_OUTPUT_SCHEMA,
        },
      },
    })
  } finally {
    try { await client.session.delete({ path: { id: sessionId } }) } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") throw new Error("Empty review result")
  const r = result as Record<string, unknown>
  if (Array.isArray(r["parts"])) {
    for (const p of r["parts"] as Array<{ type?: string; text?: string }>) {
      if (p.type === "text" && typeof p.text === "string") return p.text
    }
  }
  if (typeof r["text"] === "string") return r["text"]
  if (typeof r["content"] === "string") return r["content"]
  if (typeof r["output"] === "string") return r["output"]
  throw new Error(`Cannot extract text from review result: ${JSON.stringify(result).slice(0, 200)}`)
}

function parseReviewResult(raw: string): SelfReviewResult {
  const parsed = JSON.parse(raw) as {
    satisfied: boolean
    criteria_results: Array<{
      criterion: string
      met: boolean
      evidence: string
      severity: string
    }>
  }

  const criteriaResults: CriterionResult[] = (parsed.criteria_results ?? []).map((c) => ({
    criterion: c.criterion ?? "unknown",
    met: c.met ?? false,
    evidence: c.evidence ?? "",
    severity: c.severity === "suggestion" ? "suggestion" : "blocking",
  }))

  // Recompute `satisfied` from criteria to guard against LLM inconsistency:
  // satisfied must be false if any blocking criterion is not met.
  const hasUnmetBlocking = criteriaResults.some((c) => !c.met && c.severity === "blocking")
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
  client: Client,
  req: SelfReviewRequest,
): Promise<SelfReviewResult> {
  try {
    const prompt = buildReviewPrompt(req)
    const raw = await ephemeralReviewSession(client, prompt)
    const text = extractText(raw)
    return parseReviewResult(text)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
