/**
 * orchestrator/llm-calls.ts — LLM-backed assess and diverge implementations.
 *
 * These factory functions close over `client` (the OpenCode SDK client) and
 * return async functions that match the OrchestratorDeps.assess / diverge
 * signatures from types.ts.
 *
 * Both use client.session.prompt() with JSON schema structured output so the
 * LLM returns machine-readable classification rather than free text.
 *
 * Design invariants:
 * - Both functions are pure from the orchestrator's perspective (injected as deps).
 * - Both always return a typed result — never throw — failures return error shapes.
 * - The orchestrator factory handles fallbacks when these return error shapes.
 *
 * LLM call pattern: create a dedicated ephemeral session per call (prefixed "orch-"),
 * prompt into it, then delete it. This isolates the classification context from the
 * main session conversation and prevents the workflow state block from biasing the
 * classification LLM.
 *
 * Session lifecycle per call (v1 SDK path/body style):
 *   1. client.session.create({ body: { title } }) → { data: { id } }
 *   2. client.session.prompt({ path: { id }, body: { parts } }) → { data: { info, parts } }
 *   3. client.session.delete({ path: { id } })  [best-effort, errors ignored]
 */

import type {
  ArtifactKey,
  OrchestratorAssessResult,
  OrchestratorDivergeResult,
} from "../types"
import type { PluginClient } from "../client-types"
import { extractTextFromPromptResult, extractEphemeralSessionId, extractJsonFromText, withTimeout } from "../utils"
import { createLogger } from "../logger"

/** Timeout for each orchestrator LLM call (assess / diverge). */
const ORCHESTRATOR_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Shared: JSON schema structured output helpers
// ---------------------------------------------------------------------------

const ARTIFACT_KEYS: ArtifactKey[] = [
  "design", "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation",
]

/** Valid divergence trigger criteria — module-level constant (not recreated per call). */
const VALID_DIVERGE_CRITERIA = new Set(["scope_expansion", "architectural_shift", "cascade_depth", "accumulated_drift"])

// ---------------------------------------------------------------------------
// assess — identifies which artifact(s) the feedback targets
// ---------------------------------------------------------------------------

const ASSESS_SYSTEM_PROMPT = `You are a workflow orchestrator that classifies user feedback.
Given feedback text and the current artifact being reviewed, identify:
1. Which artifact is the ROOT CAUSE that needs to change (the deepest upstream artifact the feedback points to).
2. Which artifacts are affected (the root cause artifact and all downstream artifacts that depend on it).

Artifacts in dependency order (upstream first):
- design: a user-authored design document with structural invariants (optional — may not exist)
- conventions: the codebase conventions document
- plan: the feature plan and architecture
- interfaces: TypeScript/language interfaces and data models
- tests: the test suite (failing tests)
- impl_plan: the implementation DAG
- implementation: the actual implementation code

Rules:
- Return the EARLIEST (most upstream) artifact the feedback actually targets as root_cause_artifact.
- Do NOT escalate to a more upstream artifact unless the feedback explicitly criticizes that artifact.
- "The interface is wrong" → root cause = interfaces (not plan)
- "The plan missed a requirement" → root cause = plan
- "This test case is missing" → root cause = tests
- "The implementation doesn't match the interface" → root cause = implementation
- "This violates the design document" → root cause = design (only if a design doc exists)
- If uncertain, bias toward the current artifact being reviewed.
- For affected_artifacts, ONLY include artifacts that have actually been written/approved. Do NOT
  include downstream artifacts that haven't been created yet (e.g. if we're at INTERFACES, don't
  list tests/impl_plan/implementation as affected unless they already exist).

IMPORTANT: You MUST reply with ONLY a valid JSON object — no explanation, no markdown prose, no preamble.
The JSON must have exactly these fields:
{
  "affected_artifacts": ["<artifact_key>", ...],
  "root_cause_artifact": "<artifact_key>",
  "reasoning": "<1-2 sentence explanation>"
}
Valid artifact keys: design, conventions, plan, interfaces, tests, impl_plan, implementation`

/**
 * Creates an assess() function backed by an LLM call.
 * The returned function matches OrchestratorDeps.assess.
 *
 * @param getParentSessionId Optional getter that returns the current parent session ID.
 *   Called at dispatch time so the orchestrator session appears as a child of the active session.
 */
export function createAssessFn(client: PluginClient, getParentSessionId?: () => string | undefined): (
  feedback: string,
  currentArtifact: ArtifactKey,
) => Promise<OrchestratorAssessResult> {
  return async (feedback, currentArtifact) => {
    try {
      const prompt = [
        `Current artifact under review: **${currentArtifact}**`,
        ``,
        `User feedback:`,
        `"${feedback}"`,
        ``,
        `Classify which artifact is the root cause of this feedback and which artifacts are affected.`,
      ].join("\n")

      const result = await withTimeout(
        ephemeralPrompt(client, {
          parts: [{ type: "text", text: prompt }],
          system: ASSESS_SYSTEM_PROMPT,
        }, "Orchestrator: assess feedback", getParentSessionId?.()),
        ORCHESTRATOR_TIMEOUT_MS,
        "orchestrator-assess",
      )

      // Parse structured output from the response parts
      // extractJsonFromText handles markdown fences the LLM may add
      const text = extractJsonFromText(extractTextFromPromptResult(result, "assess"))
      const parsed = JSON.parse(text) as {
        affected_artifacts: ArtifactKey[]
        root_cause_artifact: ArtifactKey
        reasoning: string
      }

      // Validate the parsed output
      if (!ARTIFACT_KEYS.includes(parsed.root_cause_artifact)) {
        return {
          success: false,
          error: `LLM returned invalid root_cause_artifact: "${parsed.root_cause_artifact}"`,
          fallbackArtifact: currentArtifact,
        }
      }

      return {
        success: true,
        affectedArtifacts: (parsed.affected_artifacts ?? []).filter((a) => ARTIFACT_KEYS.includes(a)),
        rootCauseArtifact: parsed.root_cause_artifact,
        reasoning: parsed.reasoning ?? "",
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const log = createLogger(client)
      log.warn("Orchestrator assess failed", { detail: errorMsg })
      return {
        success: false,
        error: errorMsg,
        fallbackArtifact: currentArtifact,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// diverge — classifies change as tactical vs strategic
// ---------------------------------------------------------------------------

const DIVERGE_SYSTEM_PROMPT = `You are a workflow orchestrator that classifies the severity of a proposed change.

Given information about what changed and which artifacts are affected, classify the change as:
- "tactical": small, self-contained, ≤2 artifacts affected, no scope expansion, no architectural shift.
- "strategic": requires user decision — any of these triggers:
  - scope_expansion: adds capabilities or artifacts not in the original plan
  - architectural_shift: changes fundamental data model, API structure, or system boundaries
  - cascade_depth: 3 or more artifacts need revision
  - accumulated_drift: many individual small changes have collectively changed the design significantly

When in doubt, classify as "strategic". False positives (unnecessary user escalation) are
preferable to false negatives (missing a real architectural pivot).

IMPORTANT: You MUST reply with ONLY a valid JSON object — no explanation, no markdown prose, no preamble.
The JSON must have exactly these fields:
{
  "classification": "tactical" | "strategic",
  "trigger_criterion": "scope_expansion" | "architectural_shift" | "cascade_depth" | "accumulated_drift" | null,
  "reasoning": "<1-2 sentence explanation>"
}
(trigger_criterion is required only for "strategic" classification; set to null for "tactical")`

/**
 * Creates a diverge() function backed by an LLM call.
 * The returned function matches OrchestratorDeps.diverge.
 *
 * @param getParentSessionId Optional getter for parent session ID (see createAssessFn).
 */
export function createDivergeFn(client: PluginClient, getParentSessionId?: () => string | undefined): (
  assessResult: OrchestratorAssessResult,
  approvedArtifacts: Partial<Record<ArtifactKey, string>>,
) => Promise<OrchestratorDivergeResult> {
  return async (assessResult, approvedArtifacts) => {
    try {
      // Defensive guard: route.ts normally filters out failed assess results before
      // calling diverge, but this guard protects against direct invocation.
      if (!assessResult.success) {
        return { success: true, classification: "tactical", reasoning: "assess failed; defaulting to tactical" }
      }

      const approvedKeys = new Set(Object.keys(approvedArtifacts))
      const approvedCount = approvedKeys.size

      // Filter affected artifacts to only those that actually exist (approved).
      // The LLM assess step lists all theoretically downstream artifacts, but
      // unwritten artifacts (tests, impl_plan, implementation that haven't been
      // created yet) shouldn't count toward cascade depth — there's nothing to
      // cascade to. Always include the root cause artifact itself.
      const materiallyAffected = assessResult.affectedArtifacts.filter(
        (a) => approvedKeys.has(a) || a === assessResult.rootCauseArtifact,
      )
      const affectedCount = materiallyAffected.length

      const prompt = [
        `Root cause artifact: **${assessResult.rootCauseArtifact}**`,
        `Artifacts materially affected (only counting approved/existing artifacts): ${materiallyAffected.join(", ")} (${affectedCount} total)`,
        `Assess reasoning: ${assessResult.reasoning}`,
        ``,
        `Previously approved artifacts: ${approvedCount > 0 ? [...approvedKeys].join(", ") : "none"}`,
        `LLM-reported affected (including unwritten): ${assessResult.affectedArtifacts.join(", ")}`,
        ``,
        `Classify this change: is it tactical (autonomous) or strategic (requires user decision)?`,
        ``,
        `Note: cascade_depth trigger fires when ${affectedCount} >= 3 materially affected artifacts.`,
      ].join("\n")

      const result = await withTimeout(
        ephemeralPrompt(client, {
          parts: [{ type: "text", text: prompt }],
          system: DIVERGE_SYSTEM_PROMPT,
        }, "Orchestrator: diverge classification", getParentSessionId?.()),
        ORCHESTRATOR_TIMEOUT_MS,
        "orchestrator-diverge",
      )

      // extractJsonFromText handles markdown fences the LLM may add
      const text = extractJsonFromText(extractTextFromPromptResult(result, "diverge"))
      const parsed = JSON.parse(text) as {
        classification: "tactical" | "strategic"
        trigger_criterion?: string
        reasoning: string
      }

      // Hard-code cascade_depth trigger when ≥3 materially affected artifacts
      const classification = (affectedCount >= 3 || parsed.classification === "strategic")
        ? "strategic"
        : "tactical"

      const VALID_CRITERIA = VALID_DIVERGE_CRITERIA
      const criterion: string | undefined = affectedCount >= 3
        ? "cascade_depth"
        : (VALID_CRITERIA.has(parsed.trigger_criterion ?? "") ? parsed.trigger_criterion : undefined)

      return {
        success: true,
        classification,
        ...(classification === "strategic" && criterion
          ? { triggerCriterion: criterion as "scope_expansion" | "architectural_shift" | "cascade_depth" | "accumulated_drift" }
          : {}),
        reasoning: parsed.reasoning ?? "",
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const log = createLogger(client)
      log.warn("Orchestrator diverge failed", { detail: errorMsg })
      return {
        success: false,
        error: errorMsg,
        fallback: "tactical",
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Creates an ephemeral session, calls prompt() into it, then deletes the session.
 * Returns the raw prompt result. Throws on hard failure.
 *
 * Using ephemeral sessions isolates classification context from the main
 * conversation. The "orch-" prefix makes them identifiable in logs.
 *
 * The system prompt is inlined into the parts text rather than passed as a
 * separate `system` parameter. Although the SDK type includes `system`, this
 * approach is more robust and consistent with self-review.ts.
 */
async function ephemeralPrompt(
  client: PluginClient,
  params: { parts: Array<{ type: string; text: string }>; system?: string },
  title = "Orchestrator: classify feedback",
  parentSessionId?: string,
): Promise<unknown> {
  if (!client.session) throw new Error("client.session is not available — cannot dispatch orchestrator call")
  const sessionResult = await client.session.create({
    body: {
      title,
      agent: "workflow-orchestrator",
      ...(parentSessionId ? { parentID: parentSessionId } : {}),
    },
  })

  const sessionId = extractEphemeralSessionId(sessionResult, "ephemeralPrompt")

  // Inline system prompt into the parts text for simplicity and consistency
  const parts = params.system
    ? params.parts.map((p, i) =>
        i === 0
          ? { ...p, text: `${params.system}\n\n---\n\n${p.text}` }
          : p,
      )
    : params.parts

  try {
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: { parts },
    })
    return result
  } finally {
    // Preserve child sessions for audit trail; delete orphaned sessions.
    if (!parentSessionId) {
      try {
        await client.session.delete({ path: { id: sessionId } })
      } catch { /* ignore cleanup errors */ }
    }
  }
}

// extractTextFromPromptResult and extractEphemeralSessionId are imported from ../utils
