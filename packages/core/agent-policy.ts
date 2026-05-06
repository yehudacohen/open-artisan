import type { SessionStateStore, WorkflowState } from "./workflow-state-types"

/** Known workflow-active agent names. */
export const ARTISAN_AGENT_NAMES = new Set(["artisan", "robot-artisan", "build-artisan"])

export function normalizeAgentName(agent: unknown): string | null {
  if (typeof agent !== "string") return null
  const normalized = agent.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

export function isArtisanAgent(agent: unknown): boolean {
  const normalized = normalizeAgentName(agent)
  return normalized !== null && ARTISAN_AGENT_NAMES.has(normalized)
}

export function extractAgentName(source: unknown, depth = 0): string | null {
  if (!source || typeof source !== "object" || depth > 2) return null

  const record = source as Record<string, unknown>
  for (const key of ["agent", "agentName", "agentID", "agentId"]) {
    const direct = normalizeAgentName(record[key])
    if (direct) return direct
  }

  for (const key of ["info", "properties", "body", "meta", "path", "session"]) {
    const nested = extractAgentName(record[key], depth + 1)
    if (nested) return nested
  }

  return null
}

export async function persistActiveAgent(
  store: SessionStateStore,
  sessionId: string,
  agentName: string,
): Promise<string> {
  const normalized = normalizeAgentName(agentName)
  if (!normalized) return agentName

  const state = store.get(sessionId)
  if (!state) return normalized
  if (isArtisanAgent(state.activeAgent) && !isArtisanAgent(normalized)) {
    return normalizeAgentName(state.activeAgent) ?? normalized
  }
  if (state.activeAgent === normalized) return normalized

  await store.update(sessionId, (draft) => {
    draft.activeAgent = normalized
  })

  return normalized
}

export function isWorkflowSessionActive(state: WorkflowState, agentOverride?: unknown): boolean {
  const persistedAgent = normalizeAgentName(state.activeAgent)
  if (persistedAgent && isArtisanAgent(persistedAgent)) return true
  if (persistedAgent && !isArtisanAgent(persistedAgent)) return false

  const overrideAgent = normalizeAgentName(agentOverride)
  if (overrideAgent) return isArtisanAgent(overrideAgent)

  return (
    state.mode !== null ||
    state.phase !== "MODE_SELECT" ||
    state.phaseState !== "DRAFT" ||
    state.featureName !== null ||
    Object.keys(state.approvedArtifacts).length > 0
  )
}
