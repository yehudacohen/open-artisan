export interface GitCheckpointSuccess {
  success: true
  tag: string
  commitHash: string
  /**
   * Non-fatal warnings, e.g. unexpected files staged in INCREMENTAL mode.
   * Present only when there is something to warn about.
   */
  warnings?: string[]
}

export interface GitCheckpointError {
  success: false
  error: string
  code?: "GIT_CHECKPOINT_FAILED"
  message?: string
}

export type GitCheckpointResult = GitCheckpointSuccess | GitCheckpointError
