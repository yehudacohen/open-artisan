/**
 * engine-context.ts — Shared dependency bag for all tool and hook handlers.
 *
 * Instead of capturing variables in closures inside the plugin factory function,
 * all shared dependencies are collected into an EngineContext object that is
 * passed explicitly to handler factories.
 *
 * This enables platform-agnostic core modules to be tested and used without
 * the OpenCode plugin factory.
 */

import type { SessionStateStore, StateMachine, Orchestrator, ArtifactGraph } from "./types"
import type { SubagentDispatcher } from "./subagent-dispatcher"
import type { Logger, NotificationSink } from "./logger"

/**
 * All shared dependencies needed by tool and hook handlers.
 * Created once at plugin init and passed to handler factories.
 */
export interface EngineContext {
  store: SessionStateStore
  sm: StateMachine
  orchestrator: Orchestrator
  subagentDispatcher: SubagentDispatcher
  log: Logger
  notify: NotificationSink
  graph: ArtifactGraph

  /** Design document path (null if not detected) */
  designDocPath: string | null

  /**
   * Send a message to an existing session (used for idle re-prompts).
   * Unlike SubagentDispatcher (which creates new sessions), this prompts
   * an already-running session. Platform-specific — the adapter provides
   * the implementation.
   */
  promptExistingSession(sessionId: string, text: string): Promise<void>

  // ── Mutable session tracking ────────────────────────────────────────
  // Maps are shared by reference. The activeSessionId uses a wrapper
  // because primitives can't be shared by reference.

  /** Most recently active primary session ID. Updated on every tool call. */
  activeSession: { id: string | undefined }
  /** Maps child session IDs to their parent session IDs (for tool guard policy inheritance). */
  childSessionParents: Map<string, string>
  /** Last reprompt timestamps per session (for idle handler debouncing). */
  lastRepromptTimestamps: Map<string, number>
}
