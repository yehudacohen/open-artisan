import type { Logger, NotificationSink } from "./logger"
import type { SessionStateStore, WorkflowState } from "./types"
import { extractAgentName, persistActiveAgent } from "./agent-policy"

export interface AgentAwareToolContext {
  agent?: string
  [key: string]: unknown
}

/** Lazily create workflow state when a session-created event was missed. */
export async function ensureState(
  store: SessionStateStore,
  sessionId: string,
  notify?: NotificationSink,
): Promise<WorkflowState> {
  const existing = store.get(sessionId)
  if (existing) return existing
  try {
    notify?.toast("Workflow initialized", "Session state created (missed startup event)", "info")
  } catch {
    // ignore notification failures
  }
  return store.create(sessionId)
}

/**
 * Persist the active agent for workflow tool calls. If the runtime does not
 * surface agent metadata, a workflow tool invocation is treated as explicit
 * opt-in to the artisan workflow.
 */
export async function detectActiveAgent(
  store: SessionStateStore,
  sessionId: string,
  context: AgentAwareToolContext,
): Promise<void> {
  const detectedAgent = extractAgentName(context)
  if (detectedAgent) {
    await persistActiveAgent(store, sessionId, detectedAgent)
    return
  }

  const state = store.get(sessionId)
  if (!state || state.activeAgent) return
  await persistActiveAgent(store, sessionId, "artisan")
}

export function safeToolExecute<A, C>(
  toolName: string,
  fn: (args: A, context: C) => Promise<string>,
  logFn: Logger,
): (args: A, context: C) => Promise<string> {
  return async (args: A, context: C): Promise<string> => {
    try {
      return await fn(args, context)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const stack = e instanceof Error ? e.stack : undefined
      logFn.error(`Unexpected error in ${toolName}`, { detail: stack ?? message })
      return `Error: Unexpected internal error in ${toolName}: ${message}`
    }
  }
}

export function wrapExecuteMap<T extends Record<string, { execute: (...args: any[]) => Promise<string>; [key: string]: unknown }>>(
  tools: T,
  logFn: Logger,
): T {
  for (const [name, def] of Object.entries(tools)) {
    const original = def.execute
    def.execute = safeToolExecute(name, original.bind(def), logFn)
  }
  return tools
}
