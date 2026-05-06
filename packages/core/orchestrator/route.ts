/**
 * orchestrator/route.ts — Wires assess + diverge into a routing decision.
 *
 * Given user feedback and the current phase, the orchestrator:
 * 1. Calls assess() to identify which artifact(s) are affected and the root cause.
 * 2. Calls diverge() to classify the change as tactical or strategic.
 * 3. Builds an ordered list of RevisionStep entries:
 *    - Tactical: only the root-cause artifact → REVISE
 *    - Strategic: root-cause artifact + all downstream dependents → REVISE (topo order)
 * 4. Falls back gracefully when assess or diverge fails.
 */
import type { ArtifactKey, Phase } from "../workflow-primitives"
import type { Orchestrator } from "../orchestrator-types"
import type { OrchestratorAssessResult, OrchestratorDeps, OrchestratorPlanResult, OrchestratorRouteInput, RevisionStep } from "../orchestrator-types"
import { PHASE_TO_ARTIFACT } from "../artifacts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentArtifactFor(phase: Phase): ArtifactKey {
  const artifact = PHASE_TO_ARTIFACT[phase]
  if (!artifact) {
    throw new Error(`No artifact mapped for phase "${phase}" — orchestrator cannot route from this phase`)
  }
  return artifact
}

function buildRevisionSteps(
  rootCause: ArtifactKey,
  classification: "tactical" | "strategic" | "backtrack",
  deps: OrchestratorDeps,
  mode: OrchestratorRouteInput["mode"],
  currentPhase: Phase,
): RevisionStep[] {
  if (classification === "tactical") {
    // Only the root-cause artifact itself
    const target = deps.graph.getReviseTarget(rootCause)
    return [
      {
        artifact: rootCause,
        phase: target.phase,
        phaseState: "REVISE",
        instructions: `Revise the ${rootCause} artifact based on user feedback.`,
      },
    ]
  }

  if (classification === "backtrack") {
    // Backtrack: route to the root cause artifact's owning phase in DRAFT state.
    // This restarts that phase from scratch. Downstream artifacts are invalidated.
    let targetPhase: Phase
    try {
      targetPhase = deps.graph.getOwningPhase(rootCause)
    } catch {
      // "design" has no owning phase — fall back to PLANNING (nearest agent-controlled
      // phase that depends on design). Matches getReviseTarget() pattern in artifacts.ts.
      targetPhase = "PLANNING"
    }

    // If the target phase is the same as the current phase, treat as tactical —
    // no point backtracking to where we already are.
    if (targetPhase === currentPhase) {
      const target = deps.graph.getReviseTarget(rootCause)
      return [
        {
          artifact: rootCause,
          phase: target.phase,
          phaseState: "REVISE",
          instructions: `Revise the ${rootCause} artifact based on user feedback.`,
        },
      ]
    }

    return [
      {
        artifact: rootCause,
        phase: targetPhase,
        phaseState: "DRAFT",
        instructions: `Scope change detected — backtracking to ${targetPhase} phase. Restart the ${rootCause} artifact from scratch, incorporating the new requirements from user feedback.`,
      },
    ]
  }

  // Strategic: root cause + all downstream dependents in topo order
  const dependents = deps.graph.getDependents(rootCause, mode)
  const chain: ArtifactKey[] = [rootCause, ...dependents]

  return chain.map((artifact) => {
    const target = deps.graph.getReviseTarget(artifact)
    return {
      artifact,
      phase: target.phase,
      phaseState: "REVISE",
      instructions:
        artifact === rootCause
          ? `Revise the ${artifact} artifact (root cause of feedback).`
          : `Re-align the ${artifact} artifact with the updated ${rootCause}.`,
    }
  })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Re-export the Orchestrator interface from types.ts for backward compatibility
export type { Orchestrator }

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  return {
    async route(input: OrchestratorRouteInput): Promise<OrchestratorPlanResult> {
      const currentArtifact = currentArtifactFor(input.currentPhase)

      // ---- Step 1: Assess ---------------------------------------------------
      let assessResult: OrchestratorAssessResult
      try {
        assessResult = await deps.assess(input.feedback, currentArtifact)
      } catch (err) {
        // Hard failure — default to tactical revision of current artifact
        const target = deps.graph.getReviseTarget(currentArtifact)
        return {
          revisionSteps: [
            {
              artifact: currentArtifact,
              phase: target.phase,
              phaseState: "REVISE",
              instructions: "Revise based on user feedback (assess failed, falling back to current artifact).",
            },
          ],
          classification: "tactical",
        }
      }

      // Assess failed with structured error — use fallbackArtifact, classify tactical
      if (!assessResult.success) {
        const fallback = assessResult.fallbackArtifact
        const target = deps.graph.getReviseTarget(fallback)
        return {
          revisionSteps: [
            {
              artifact: fallback,
              phase: target.phase,
              phaseState: "REVISE",
              instructions: `Revise ${fallback} based on user feedback (assess error: ${assessResult.error}).`,
            },
          ],
          classification: "tactical",
        }
      }

      const rootCause = assessResult.rootCauseArtifact

      // ---- Step 2: Diverge --------------------------------------------------
      let classification: "tactical" | "strategic" | "backtrack" = "tactical"
      try {
        const divergeResult = await deps.diverge(assessResult, input.approvedArtifacts)
        if (divergeResult.success) {
          classification = divergeResult.classification
        }
        // If diverge fails, default to tactical
      } catch {
        // Default to tactical
      }

      // ---- Step 3: Build revision plan --------------------------------------
      const revisionSteps = buildRevisionSteps(rootCause, classification, deps, input.mode, input.currentPhase)

      return { revisionSteps, classification }
    },
  }
}
