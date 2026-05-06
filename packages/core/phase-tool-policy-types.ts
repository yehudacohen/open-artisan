export interface PhaseToolPolicy {
  /** Tool names that are completely blocked in this phase */
  blocked: string[]

  /**
   * For write/edit tools: an optional predicate on the absolute file path.
   * If provided, the write/edit is only allowed when predicate returns true.
   * If not provided, write/edit follows the `blocked` list.
   */
  writePathPredicate?: (filePath: string) => boolean

  /**
   * For bash/shell tools: an optional predicate on the command string.
   * If provided, the bash command is only allowed when predicate returns true.
   * Used in INCREMENTAL mode to block bash-based file writes (>, >>, tee, sed -i).
   */
  bashCommandPredicate?: (command: string) => boolean

  /** Human-readable description of what IS allowed, for error messages */
  allowedDescription: string
}
