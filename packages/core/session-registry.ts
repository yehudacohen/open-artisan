/**
 * session-registry.ts — Tracks active session lifecycle and parent-child relationships.
 *
 * Primary sessions get their own WorkflowState.
 * Child sessions (subagent reviewers, orchestrator, discovery fleet) inherit
 * the parent's tool policy and do NOT get their own state.
 */
import type { SessionRegistry } from "./types"

/**
 * Create a new in-memory session registry.
 */
export function createSessionRegistry(): SessionRegistry {
  /** Maps child sessionId → parent sessionId. */
  const childToParent = new Map<string, string>()

  /** Set of registered primary session IDs. */
  const primarySessions = new Set<string>()

  /** Most recently active primary session ID. */
  let activeId: string | undefined

  return {
    registerPrimary(sessionId: string): void {
      primarySessions.add(sessionId)
    },

    registerChild(sessionId: string, parentId: string): void {
      childToParent.set(sessionId, parentId)
    },

    unregister(sessionId: string): void {
      primarySessions.delete(sessionId)
      childToParent.delete(sessionId)
      if (activeId === sessionId) {
        activeId = undefined
      }
    },

    getParent(sessionId: string): string | null {
      return childToParent.get(sessionId) ?? null
    },

    isChild(sessionId: string): boolean {
      return childToParent.has(sessionId)
    },

    setActive(sessionId: string): void {
      activeId = sessionId
    },

    getActiveId(): string | undefined {
      return activeId
    },

    count(): number {
      return primarySessions.size + childToParent.size
    },
  }
}
