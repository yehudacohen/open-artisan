export interface WorkflowDagTaskLite {
  id?: string
  status?: string
}

export interface WorkflowStateLite {
  featureName?: string | null
  sessionId?: string | null
  phase?: string | null
  phaseState?: string | null
  currentTaskId?: string | null
  taskCompletionInProgress?: string | null
  activeAgent?: string | null
  userGateMessageReceived?: boolean
  implDag?: WorkflowDagTaskLite[] | null
}

export interface BridgeClientLeaseLite {
  clientId?: string
  clientKind?: string
  sessionId?: string
  attachedAt?: string
  lastSeenAt?: string
}

export interface BridgeClientsSnapshotLite {
  clients?: BridgeClientLeaseLite[]
}

export interface BridgeMetaSnapshotLite {
  pid?: number
  socketPath?: string
}

export interface DiscordProfileSettings {
  requireMention: boolean
  homeChannel: string | null
  allowedUsers: string[]
}

export interface HarnessStatus {
  kind: "awaiting-kickoff" | "running" | "user-gate" | "done" | "unknown"
  summary: string
}

const HERMES_SESSION_REGEX = /Bridge started for session ([^\s]+)/

export function parseSimpleEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eqIndex = line.indexOf("=")
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1).trim()
    values[key] = value
  }
  return values
}

export function resolveDiscordProfileSettings(envText: string, configText: string): DiscordProfileSettings {
  const env = parseSimpleEnv(envText)
  const requireMention = /require_mention:\s*true/.test(configText)
  const homeChannel = env["DISCORD_HOME_CHANNEL"]?.trim() || null
  const allowedUsers = (env["DISCORD_ALLOWED_USERS"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  return { requireMention, homeChannel, allowedUsers }
}

function isDefaultWorkflowSessionId(sessionId: string | null | undefined): boolean {
  if (!sessionId) return true
  return sessionId === "default" || sessionId.startsWith("default::parked::")
}

function parseIsoTime(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function resolveHermesSessionId(input: {
  workflowState?: WorkflowStateLite | null
  bridgeClients?: BridgeClientsSnapshotLite | null
  agentLogText?: string | null
}): string | null {
  const workflowSessionId = input.workflowState?.sessionId ?? null
  if (!isDefaultWorkflowSessionId(workflowSessionId)) {
    return workflowSessionId
  }

  const hermesClients = (input.bridgeClients?.clients || [])
    .filter((client) => client.clientKind === "hermes" && !isDefaultWorkflowSessionId(client.sessionId))
    .sort((left, right) => {
      const leftTime = Math.max(parseIsoTime(left.lastSeenAt), parseIsoTime(left.attachedAt))
      const rightTime = Math.max(parseIsoTime(right.lastSeenAt), parseIsoTime(right.attachedAt))
      return rightTime - leftTime
    })
  if (hermesClients.length > 0) {
    return hermesClients[0]?.sessionId || null
  }

  const logText = input.agentLogText || ""
  const lines = logText.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line) continue
    const match = line.match(HERMES_SESSION_REGEX)
    const sessionId = match?.[1]?.trim()
    if (sessionId && !isDefaultWorkflowSessionId(sessionId)) {
      return sessionId
    }
  }

  return null
}

export function evaluateHarnessStatus(workflowState?: WorkflowStateLite | null): HarnessStatus {
  if (!workflowState?.phase || !workflowState.phaseState) {
    return {
      kind: "awaiting-kickoff",
      summary: "No active persisted workflow state yet. Send the kickoff message on Discord to start or resume the Hermes driver session.",
    }
  }

  if (workflowState.phase === "DONE") {
    return {
      kind: "done",
      summary: `Workflow ${workflowState.featureName || "(unknown feature)"} is DONE.`,
    }
  }

  if (workflowState.phaseState === "USER_GATE") {
    const taskSuffix = workflowState.currentTaskId ? ` at ${workflowState.currentTaskId}` : ""
    return {
      kind: "user-gate",
      summary: `Workflow paused at truthful USER_GATE during ${workflowState.phase}${taskSuffix}.`,
    }
  }

  const taskSuffix = workflowState.currentTaskId ? ` task=${workflowState.currentTaskId}` : ""
  return {
    kind: "running",
    summary: `Workflow running at ${workflowState.phase}/${workflowState.phaseState}${taskSuffix}.`,
  }
}

export function isPidAlive(pid: number | null | undefined): boolean | null {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    return null
  }
}

export function buildHermesReplyCommand(profile: string, sessionId: string, text: string): string[] {
  return [profile, "chat", "-r", sessionId, "-Q", "-q", text]
}

export function detectBlockingDeviations(input: {
  workflowState?: WorkflowStateLite | null
  resolvedSessionId?: string | null
  bridgeMeta?: BridgeMetaSnapshotLite | null
  bridgeProcessAlive?: boolean | null
  openArtisanLogTail?: string
  hermesErrorLogTail?: string
}): string[] {
  const issues: string[] = []
  const hermesText = (input.hermesErrorLogTail || "")
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false
      if (!input.resolvedSessionId) return true
      if (!/\[[0-9]{8}_/.test(line)) return true
      return line.includes(input.resolvedSessionId)
    })
    .join("\n")
  const combined = [input.openArtisanLogTail || "", hermesText].join("\n")
  const blockingPatterns = [
    /Failed to start bridge/i,
    /not found for migration/i,
    /socket missing/i,
    /Connection refused/i,
    /Shared bridge socket returned no response/i,
    /Another bridge process is already running/i,
  ]

  if (blockingPatterns.some((pattern) => pattern.test(combined))) {
    issues.push("Recent logs show a bridge/runtime failure that should be investigated before continuing.")
  }

  if (input.bridgeMeta?.pid && input.bridgeProcessAlive === false) {
    issues.push(
      `Shared bridge metadata points at stale PID ${input.bridgeMeta.pid}; run oa_recover_bridge before continuing.`,
    )
  }

  if (input.workflowState?.phaseState === "USER_GATE" && !input.resolvedSessionId) {
    issues.push("Workflow reached USER_GATE but the harness could not resolve the Hermes session ID needed to reply into the same session.")
  }

  return issues
}

export function buildDiscordKickoffInstructions(input: {
  featureName: string
  kickoffText: string
  profileSettings: DiscordProfileSettings
}): string {
  const lines = [
    `Discord dogfood kickoff for \`${input.featureName}\`:`,
    input.profileSettings.homeChannel
      ? `- Target channel: ${input.profileSettings.homeChannel}`
      : "- Target channel: use the configured Hermes Discord surface or DM the bot directly",
    input.profileSettings.requireMention
      ? "- Mention the Hermes bot in the message (or DM it directly) because Discord require_mention is enabled."
      : "- Mention is optional for this profile.",
    "- Start in a fresh Discord thread/session after gateway or plugin changes; old sessions keep their saved tool list.",
  ]

  if (input.profileSettings.allowedUsers.length > 0) {
    lines.push(`- Allowed Discord user IDs: ${input.profileSettings.allowedUsers.join(", ")}`)
  }

  lines.push("- Send this exact kickoff message from Discord:")
  lines.push(input.kickoffText)
  return lines.join("\n")
}
