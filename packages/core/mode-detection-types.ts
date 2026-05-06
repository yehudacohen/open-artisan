import type { WorkflowMode } from "./workflow-primitives"

export interface ModeDetectionResult {
  suggestedMode: WorkflowMode
  hasGitHistory: boolean
  /** Number of source files (non-gitignored, non-hidden) found */
  sourceFileCount: number
  reasoning: string
}
