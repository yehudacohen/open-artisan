/**
 * orchestrator-types.ts — Feedback routing and revision-cascade contracts.
 */

import type { ArtifactGraph } from "./artifact-types"
import type { ArtifactKey, Phase, PhaseState, WorkflowMode } from "./workflow-primitives"

/**
 * The Orchestrator routes user feedback through the artifact dependency graph
 * to determine which artifacts need revision and in what order.
 */
export interface Orchestrator {
  route(input: OrchestratorRouteInput): Promise<OrchestratorPlanResult>
}

/** Successful result from the orchestrator's assess stage. */
export interface OrchestratorAssessSuccess {
  success: true
  affectedArtifacts: ArtifactKey[]
  rootCauseArtifact: ArtifactKey
  reasoning: string
}

/** Structured failure result from the orchestrator's assess stage. */
export interface OrchestratorAssessError {
  success: false
  error: string
  code?: "ORCHESTRATOR_ASSESS_FAILED"
  message?: string
  /** Fall back to treating it as affecting the current phase's artifact only */
  fallbackArtifact: ArtifactKey
}

export type OrchestratorAssessResult = OrchestratorAssessSuccess | OrchestratorAssessError

export type DivergenceClass = "tactical" | "strategic" | "backtrack"

/** Successful result from the orchestrator's divergence/classification stage. */
export interface OrchestratorDivergeSuccess {
  success: true
  classification: DivergenceClass
  triggerCriterion?: "scope_expansion" | "architectural_shift" | "cascade_depth" | "accumulated_drift" | "upstream_root_cause"
  reasoning: string
}

/** Structured failure result from the orchestrator's divergence/classification stage. */
export interface OrchestratorDivergeError {
  success: false
  error: string
  code?: "ORCHESTRATOR_DIVERGE_FAILED"
  message?: string
  /** Fall back to "tactical" on classification failure */
  fallback: "tactical"
}

export type OrchestratorDivergeResult = OrchestratorDivergeSuccess | OrchestratorDivergeError

export interface RevisionStep {
  artifact: ArtifactKey
  phase: Phase
  phaseState: "REVISE" | "DRAFT" | "REDRAFT"
  instructions: string
}

export interface OrchestratorPlanResult {
  /** Ordered revision steps, earliest upstream artifact first */
  revisionSteps: RevisionStep[]
  /**
   * Whether the orchestrator classified this change as tactical, strategic, or backtrack.
   * tactical → agent proceeds autonomously to REVISE.
   * strategic → escape hatch is presented to the user before proceeding.
   * backtrack → route to an earlier phase's REDRAFT state (scope change detected).
   * Callers MUST use this field rather than re-deriving from revisionSteps.length.
   */
  classification: "tactical" | "strategic" | "backtrack"
}

/**
 * Input to the orchestrator's route() method.
 * approvedArtifacts is passed through to the diverge call so it can detect
 * accumulated drift across multiple approved artifacts.
 */
export interface OrchestratorRouteInput {
  feedback: string
  currentPhase: Phase
  currentPhaseState: PhaseState
  mode: WorkflowMode
  /** Hashes of last-approved artifact content, for drift detection */
  approvedArtifacts: Partial<Record<ArtifactKey, string>>
}

/**
 * Dependencies injected into the orchestrator factory.
 * assess and diverge are async functions (LLM-backed) with explicit signatures
 * so they can be mocked cleanly in tests.
 */
export interface OrchestratorDeps {
  assess: (
    feedback: string,
    currentArtifact: ArtifactKey,
  ) => Promise<OrchestratorAssessResult>

  /**
   * approvedArtifacts is passed as second arg so the diverge implementation
   * can compute accumulated drift without needing the full WorkflowState.
   */
  diverge: (
    assessResult: OrchestratorAssessResult,
    approvedArtifacts: Partial<Record<ArtifactKey, string>>,
  ) => Promise<OrchestratorDivergeResult>

  graph: ArtifactGraph
}

export type EscapeHatchChoice =
  | "accept_drift"
  | "alternative_direction"
  | "new_direction"
  | "abort_change"
