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
 * Session lifecycle per call:
 *   1. client.session.create({ body: { ... } }) → { id }
 *   2. client.session.prompt({ path: { id }, body: { ... } }) → result
 *   3. client.session.delete({ path: { id } })  [best-effort, errors ignored]
 */

import type {
  ArtifactKey,
  OrchestratorAssessResult,
  OrchestratorDivergeResult,
} from "../types"
import { extractTextFromPromptResult, extractEphemeralSessionId, withTimeout } from "../utils"

/** Timeout for each orchestrator LLM call (assess / diverge). */
const ORCHESTRATOR_TIMEOUT_MS = 60_000

// The OpenCode SDK client shape (minimal surface we actually use)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

// ---------------------------------------------------------------------------
// Shared: JSON schema structured output helpers
// ---------------------------------------------------------------------------

const ARTIFACT_KEYS: ArtifactKey[] = [
  "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation",
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
- If uncertain, bias toward the current artifact being reviewed.`

const ASSESS_JSON_SCHEMA = {
  type: "object",
  properties: {
    affected_artifacts: {
      type: "array",
      items: { type: "string", enum: ARTIFACT_KEYS },
      description: "The root cause artifact plus all downstream artifacts that need revision.",
    },
    root_cause_artifact: {
      type: "string",
      enum: ARTIFACT_KEYS,
      description: "The single most-upstream artifact the feedback actually targets.",
    },
    reasoning: {
      type: "string",
      description: "1-2 sentences explaining why this artifact is the root cause.",
    },
  },
  required: ["affected_artifacts", "root_cause_artifact", "reasoning"],
  additionalProperties: false,
}

/**
 * Creates an assess() function backed by an LLM call.
 * The returned function matches OrchestratorDeps.assess.
 */
export function createAssessFn(client: Client): (
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
          format: {
            type: "json_schema",
            schema: ASSESS_JSON_SCHEMA,
          },
        }),
        ORCHESTRATOR_TIMEOUT_MS,
        "orchestrator-assess",
      )

      // Parse structured output from the response parts
      const text = extractTextFromPromptResult(result, "assess")
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
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
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
preferable to false negatives (missing a real architectural pivot).`

const DIVERGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    classification: {
      type: "string",
      enum: ["tactical", "strategic"],
      description: "Whether this is a tactical (autonomous) or strategic (user decision required) change.",
    },
    trigger_criterion: {
      type: "string",
      enum: ["scope_expansion", "architectural_shift", "cascade_depth", "accumulated_drift"],
      description: "For strategic changes: which criterion triggered escalation.",
    },
    reasoning: {
      type: "string",
      description: "1-2 sentences explaining the classification.",
    },
  },
  required: ["classification", "reasoning"],
  additionalProperties: false,
}

/**
 * Creates a diverge() function backed by an LLM call.
 * The returned function matches OrchestratorDeps.diverge.
 */
export function createDivergeFn(client: Client): (
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

      const approvedCount = Object.keys(approvedArtifacts).length
      const affectedCount = assessResult.affectedArtifacts.length

      const prompt = [
        `Root cause artifact: **${assessResult.rootCauseArtifact}**`,
        `Artifacts affected: ${assessResult.affectedArtifacts.join(", ")} (${affectedCount} total)`,
        `Assess reasoning: ${assessResult.reasoning}`,
        ``,
        `Previously approved artifacts: ${approvedCount > 0 ? Object.keys(approvedArtifacts).join(", ") : "none"}`,
        ``,
        `Classify this change: is it tactical (autonomous) or strategic (requires user decision)?`,
        ``,
        `Note: cascade_depth trigger fires automatically when ${affectedCount} >= 3 artifacts are affected.`,
      ].join("\n")

      const result = await withTimeout(
        ephemeralPrompt(client, {
          parts: [{ type: "text", text: prompt }],
          system: DIVERGE_SYSTEM_PROMPT,
          format: {
            type: "json_schema",
            schema: DIVERGE_JSON_SCHEMA,
          },
        }),
        ORCHESTRATOR_TIMEOUT_MS,
        "orchestrator-diverge",
      )

      const text = extractTextFromPromptResult(result, "diverge")
      const parsed = JSON.parse(text) as {
        classification: "tactical" | "strategic"
        trigger_criterion?: string
        reasoning: string
      }

      // Hard-code cascade_depth trigger when ≥3 artifacts affected
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
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
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
 */
async function ephemeralPrompt(
  client: Client,
  body: Record<string, unknown>,
): Promise<unknown> {
  // Create short-lived session
  const sessionResult = await client.session.create({
    body: { title: "orch-classify" },
  })

  const sessionId = extractEphemeralSessionId(sessionResult, "ephemeralPrompt")

  try {
    const result = await client.session.prompt({
      path: { id: sessionId },
      body,
    })
    return result
  } finally {
    // Best-effort cleanup — never throw from delete()
    try {
      await client.session.delete({ path: { id: sessionId } })
    } catch {
      // Ignore cleanup errors
    }
  }
}

// extractTextFromPromptResult and extractEphemeralSessionId are imported from ../utils
