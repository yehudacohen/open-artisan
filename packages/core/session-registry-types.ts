/**
 * Tracks active session lifecycle and parent-child relationships.
 *
 * Replaces the ad-hoc `activeSession` wrapper and `childSessionParents` Map
 * with a single cohesive interface. Feature mapping is NOT in the registry -
 * use `store.get(sessionId)?.featureName` for that.
 *
 * Primary sessions get their own WorkflowState. Child sessions (subagent
 * reviewers, orchestrator, discovery fleet) inherit the parent's tool policy.
 */
export interface SessionRegistry {
  /**
   * Register a primary session (will get its own WorkflowState).
   * @throws SessionRegistryError when the session graph is malformed or duplicated.
   */
  registerPrimary(sessionId: string): void

  /**
   * Register a child session that inherits from a parent.
   * @throws SessionRegistryError when parent/child invariants are violated.
   */
  registerChild(sessionId: string, parentId: string): void

  /**
   * Unregister any session (primary or child).
   * @throws SessionRegistryError when internal registry state is inconsistent.
   */
  unregister(sessionId: string): void

  /**
   * Get the parent ID for a child session. null if primary or unknown.
   * Error contract: never throws for ordinary lookup misses.
   */
  getParent(sessionId: string): string | null

  /**
   * True if the session is a registered child session.
   * Error contract: never throws for ordinary lookup misses.
   */
  isChild(sessionId: string): boolean

  /**
   * Mark a session as the most recently active (updated on each tool call).
   * @throws SessionRegistryError when the target session is unknown.
   */
  setActive(sessionId: string): void

  /**
   * Get the most recently active primary session ID.
   * Error contract: never throws when there is no active primary session.
   */
  getActiveId(): string | undefined

  /** Count of all tracked sessions (primary + child). Error contract: never throws. */
  count(): number
}

/**
 * Structured thrown error contract for SessionRegistry mutations.
 */
export interface SessionRegistryError {
  code: "SESSION_ALREADY_REGISTERED" | "PARENT_SESSION_NOT_FOUND" | "SESSION_REGISTRY_INCONSISTENT" | "ACTIVE_SESSION_NOT_FOUND"
  message: string
  retryable: boolean
}
