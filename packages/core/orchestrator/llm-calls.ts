/**
 * orchestrator/llm-calls.ts — LLM-backed assess and diverge implementations.
 *
 * These factory functions accept a SubagentDispatcher and return async
 * functions that match the OrchestratorDeps.assess / diverge signatures.
 *
 * Design invariants:
 * - Both functions are pure from the orchestrator's perspective (injected as deps).
 * - Both always return a typed result — never throw — failures return error shapes.
 * - The orchestrator factory handles fallbacks when these return error shapes.
 *
 * LLM call pattern: create a dedicated ephemeral session per call via the dispatcher,
 * prompt into it, then destroy it. This isolates the classification context from the
 * main session conversation.
 */

import type { ArtifactKey } from "../workflow-primitives"
import type {
  OrchestratorAssessResult,
  OrchestratorDivergeResult,
} from "../orchestrator-types"
import type { SubagentDispatcher } from "../subagent-dispatcher"
import { extractJsonFromText, withTimeout } from "../utils"

/** Timeout for each orchestrator LLM call (assess / diverge). */
const ORCHESTRATOR_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Shared: JSON schema structured output helpers
// ---------------------------------------------------------------------------

const ARTIFACT_KEYS: ArtifactKey[] = [
  "design", "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation",
]

/** Valid divergence trigger criteria — module-level constant (not recreated per call). */
const VALID_DIVERGE_CRITERIA = new Set(["scope_expansion", "architectural_shift", "cascade_depth", "accumulated_drift", "upstream_root_cause"])

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
export function createAssessFn(
  dispatcher: SubagentDispatcher,
  getParentSessionId?: () => string | undefined,
  getParentModel?: () => string | { modelID: string; providerID?: string } | undefined,
): (
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

      const rawText = await withTimeout(
        ephemeralOrchestratorPrompt(
          dispatcher,
          prompt,
          ASSESS_SYSTEM_PROMPT,
          "Orchestrator: assess feedback",
          getParentSessionId?.(),
          getParentModel?.(),
        ),
        ORCHESTRATOR_TIMEOUT_MS,
        "orchestrator-assess",
      )

      const text = extractJsonFromText(rawText)
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
- "tactical": small, self-contained, current artifact only needs revision. The feedback is about fixing/improving the current artifact within its existing scope.
- "backtrack": feedback requires changing an upstream artifact — the current artifact can't be properly addressed without revising something that was already approved earlier. The root cause is upstream.
- "strategic": requires user decision — any of these triggers:
  - scope_expansion: adds capabilities or artifacts not in the original plan
  - architectural_shift: changes fundamental data model, API structure, or system boundaries
  - cascade_depth: 3 or more artifacts need revision
  - accumulated_drift: many individual small changes have collectively changed the design significantly

Examples:
- "test 3 categories instead of 1" → backtrack. The interfaces define what categories exist. Changing the count means the interfaces need revision, not just the tests.
- "add a null check to the config parser" → tactical. This is a fix within the current artifact.
- "rethink the data model" → backtrack. The plan defines the data model — revising it means going back to PLANNING.
- "fix the assertion in test line 42" → tactical. This is a refinement of the current test artifact.
- "we need to support a completely different architecture" → strategic. This is a fundamental pivot that the user should weigh in on.

Rules:
- If the feedback requires re-approving an upstream artifact to address → backtrack
- If the root cause artifact (from assess) is upstream of the current phase → backtrack
- If the feedback is about the current artifact's content only (fixes, additions within existing scope) → tactical
- If the change is so large it needs user confirmation → strategic
- When in doubt between tactical and backtrack, prefer backtrack — it's better to revisit upstream than to patch downstream.
- When in doubt between backtrack and strategic, prefer strategic — user escalation is safer.

IMPORTANT: You MUST reply with ONLY a valid JSON object — no explanation, no markdown prose, no preamble.
The JSON must have exactly these fields:
{
  "classification": "tactical" | "backtrack" | "strategic",
  "trigger_criterion": "scope_expansion" | "architectural_shift" | "cascade_depth" | "accumulated_drift" | "upstream_root_cause" | null,
  "reasoning": "<1-2 sentence explanation>"
}
(trigger_criterion is required for "strategic" and "backtrack" classification; set to null for "tactical".
For "backtrack", trigger_criterion should be "upstream_root_cause".)`

/**
 * Creates a diverge() function backed by an LLM call.
 * The returned function matches OrchestratorDeps.diverge.
 *
 * @param getParentSessionId Optional getter for parent session ID (see createAssessFn).
 */
export function createDivergeFn(
  dispatcher: SubagentDispatcher,
  getParentSessionId?: () => string | undefined,
  getParentModel?: () => string | { modelID: string; providerID?: string } | undefined,
): (
  assessResult: OrchestratorAssessResult,
  approvedArtifacts: Partial<Record<ArtifactKey, string>>,
) => Promise<OrchestratorDivergeResult> {
  return async (assessResult, approvedArtifacts) => {
    try {
      // Defensive guard: route.ts normally filters out failed assess results before
      // calling diverge, but this guard protects against direct invocation.
      if (!assessResult.success) {
        return { success: false, error: "assess result was not successful", fallback: "tactical" }
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

      const rawText = await withTimeout(
        ephemeralOrchestratorPrompt(
          dispatcher,
          prompt,
          DIVERGE_SYSTEM_PROMPT,
          "Orchestrator: diverge classification",
          getParentSessionId?.(),
          getParentModel?.(),
        ),
        ORCHESTRATOR_TIMEOUT_MS,
        "orchestrator-diverge",
      )

      const text = extractJsonFromText(rawText)
      const parsed = JSON.parse(text) as {
        classification: "tactical" | "backtrack" | "strategic"
        trigger_criterion?: string
        reasoning: string
      }

      // Hard-code cascade_depth trigger when ≥3 materially affected artifacts
      // (overrides even "backtrack" — 3+ artifacts is always strategic)
      let classification: "tactical" | "backtrack" | "strategic"
      if (affectedCount >= 3) {
        classification = "strategic"
      } else if (parsed.classification === "strategic") {
        classification = "strategic"
      } else if (parsed.classification === "backtrack") {
        classification = "backtrack"
      } else {
        classification = "tactical"
      }

      const VALID_CRITERIA = VALID_DIVERGE_CRITERIA
      const criterion: string | undefined = affectedCount >= 3
        ? "cascade_depth"
        : (VALID_CRITERIA.has(parsed.trigger_criterion ?? "") ? parsed.trigger_criterion : undefined)

      return {
        success: true,
        classification,
        ...((classification === "strategic" || classification === "backtrack") && criterion
          ? { triggerCriterion: criterion as "scope_expansion" | "architectural_shift" | "cascade_depth" | "accumulated_drift" | "upstream_root_cause" }
          : {}),
        reasoning: parsed.reasoning ?? "",
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
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
 * Low-level ephemeral prompt helper — shared between assess and diverge.
 * Uses SubagentDispatcher for platform abstraction.
 *
 * The system prompt is inlined as a prefix to the prompt text because
 * the v1 SDK's session.prompt() does not reliably surface a top-level
 * separate `system` parameter.
 */
async function ephemeralOrchestratorPrompt(
  dispatcher: SubagentDispatcher,
  promptText: string,
  systemPrompt: string | undefined,
  title: string,
  parentSessionId?: string,
  parentModel?: string | { modelID: string; providerID?: string },
): Promise<string> {
  const fullText = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${promptText}`
    : promptText

  const session = await dispatcher.createSession({
    title,
    agent: "workflow-orchestrator",
    ...(parentSessionId ? { parentId: parentSessionId } : {}),
    ...(parentModel ? { model: parentModel } : {}),
  })
  try {
    return await session.prompt(fullText)
  } finally {
    await session.destroy()
  }
}
