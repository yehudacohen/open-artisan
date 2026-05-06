import type { ArtifactKey, Phase, WorkflowMode } from "./workflow-primitives"

export interface ArtifactGraph {
  /**
   * Returns all artifacts that depend on the given artifact (directly or transitively),
   * in topological order (nearest dependents first, farthest last).
   * In GREENFIELD mode, "conventions" is excluded from all results.
   */
  getDependents(artifact: ArtifactKey, mode: WorkflowMode): ArtifactKey[]

  /**
   * Returns the direct upstream dependencies of the given artifact.
   * In GREENFIELD mode, "conventions" is excluded.
   */
  getDependencies(artifact: ArtifactKey, mode: WorkflowMode): ArtifactKey[]

  /**
   * Returns the Phase that owns and produces the given artifact.
   */
  getOwningPhase(artifact: ArtifactKey): Phase

  /**
   * Returns the REVISE PhaseState target for the given artifact.
   * Always returns "REVISE" - but the Phase differs per artifact.
   */
  getReviseTarget(artifact: ArtifactKey): { phase: Phase; phaseState: "REVISE" }
}
