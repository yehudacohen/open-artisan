import type { ArtifactKey, Phase } from "../workflow-primitives"
import type { ReviewArtifactSubmission, WorkflowState } from "../workflow-state-types"

const MAX_REVIEW_ARTIFACT_SUBMISSIONS = 20

export function buildReviewArtifactSubmission(input: {
  phase: Phase
  artifactKey?: ArtifactKey | undefined
  summary: string
  artifactDescription: string
  artifactFiles: string[]
  artifactData: unknown | null
  submittedAt?: number
}): ReviewArtifactSubmission {
  return {
    phase: input.phase,
    ...(input.artifactKey ? { artifactKey: input.artifactKey } : {}),
    summary: input.summary,
    artifactDescription: input.artifactDescription,
    artifactFiles: [...input.artifactFiles],
    artifactData: input.artifactData,
    submittedAt: input.submittedAt ?? Date.now(),
  }
}

export function recordReviewArtifactSubmission(
  state: Pick<WorkflowState, "reviewArtifactSubmissions">,
  submission: ReviewArtifactSubmission,
): void {
  state.reviewArtifactSubmissions = [submission, ...state.reviewArtifactSubmissions].slice(MAX_REVIEW_ARTIFACT_SUBMISSIONS)
}
