import type { SessionStateStore, WorkflowState } from "./workflow-state-types"

function buildParkedSessionId(sessionId: string, featureName: string | null): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const featurePart = featureName ? featureName.replace(/[^a-zA-Z0-9._-]/g, "-") : "workflow"
  return `${sessionId}::parked::${featurePart}::${suffix}`
}

export async function parkCurrentWorkflowSession(
  store: SessionStateStore,
  state: WorkflowState,
): Promise<string | null> {
  if (state.phase === "MODE_SELECT") return null

  const parkedSessionId = buildParkedSessionId(state.sessionId, state.featureName)
  await store.migrateSession(state.sessionId, parkedSessionId)
  return parkedSessionId
}

export function buildWorkflowSwitchMessage(options: {
  fromFeatureName: string | null
  toFeatureName: string
  toPhase: string
  toPhaseState: string
  resumed: boolean
  preservedMode?: string | null
}): string {
  const fromFeature = options.fromFeatureName ?? "current workflow"
  const preservedMode = options.preservedMode ? ` (keeping original mode ${options.preservedMode})` : ""
  const action = options.resumed ? "Resumed existing workflow" : "Switched to new workflow"
  return (
    `Parked workflow "${fromFeature}". ` +
    `${action} "${options.toFeatureName}" at ${options.toPhase}/${options.toPhaseState}${preservedMode}. ` +
    `To return later, call select_mode with feature_name "${fromFeature}".`
  )
}
