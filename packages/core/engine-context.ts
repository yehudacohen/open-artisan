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

import type { SessionStateStore } from "./workflow-state-types"
import type { ArtifactGraph } from "./artifact-types"
import type { SessionRegistry } from "./session-registry-types"
import type { StateMachine } from "./state-machine-types"
import type { Orchestrator } from "./orchestrator-types"
import type { SubagentDispatcher } from "./subagent-dispatcher"
import type { Logger, NotificationSink } from "./logger"
import type { OpenArtisanServices } from "./open-artisan-services"

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
  /** Optional DB-backed services when the runtime is configured with the unified DB backend. */
  openArtisanServices?: OpenArtisanServices

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

  /** Session lifecycle and parent-child tracking. */
  sessions: SessionRegistry
  /** Last reprompt timestamps per session (for idle handler debouncing). */
  lastRepromptTimestamps: Map<string, number>
}
