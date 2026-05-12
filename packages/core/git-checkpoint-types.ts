export interface GitCheckpointSuccess {
  success: true
  skipped?: false
  tag: string
  commitHash: string
  /**
   * Non-fatal warnings, e.g. unexpected files staged in INCREMENTAL mode.
   * Present only when there is something to warn about.
   */
  warnings?: string[]
}

export interface GitCheckpointSkipped {
  success: true
  skipped: true
  reason: "not-a-git-repository"
  tag: null
  commitHash: null
  warnings: string[]
}

export interface GitCheckpointError {
  success: false
  error: string
  code?: "GIT_CHECKPOINT_FAILED"
  message?: string
}

export type GitCheckpointResult = GitCheckpointSuccess | GitCheckpointSkipped | GitCheckpointError
