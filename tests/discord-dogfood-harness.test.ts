import { describe, expect, it } from "bun:test"

import {
  buildDiscordKickoffInstructions,
  buildHermesReplyCommand,
  detectBlockingDeviations,
  evaluateHarnessStatus,
  isPidAlive,
  parseSimpleEnv,
  resolveDiscordProfileSettings,
  resolveHermesSessionId,
} from "../tools/discord-dogfood-harness-lib"

describe("discord dogfood harness helpers", () => {
  it("parses simple dotenv content", () => {
    expect(parseSimpleEnv("A=1\n# comment\nB = two\n")).toEqual({ A: "1", B: "two" })
  })

  it("resolves Discord settings from env and config text", () => {
    const settings = resolveDiscordProfileSettings(
      "DISCORD_HOME_CHANNEL=123\nDISCORD_ALLOWED_USERS=1, 2\n",
      "discord:\n  require_mention: true\n",
    )

    expect(settings).toEqual({
      requireMention: true,
      homeChannel: "123",
      allowedUsers: ["1", "2"],
    })
  })

  it("prefers workflow session id when it is already concrete", () => {
    expect(resolveHermesSessionId({ workflowState: { sessionId: "20260420_abc123" } })).toBe("20260420_abc123")
  })

  it("falls back to the newest Hermes bridge client", () => {
    const sessionId = resolveHermesSessionId({
      workflowState: { sessionId: "default" },
      bridgeClients: {
        clients: [
          { clientKind: "hermes", sessionId: "20260420_old", lastSeenAt: "2026-04-20T10:00:00.000Z" },
          { clientKind: "hermes", sessionId: "20260420_new", lastSeenAt: "2026-04-20T11:00:00.000Z" },
        ],
      },
    })

    expect(sessionId).toBe("20260420_new")
  })

  it("falls back to the latest session start in the Hermes log", () => {
    const sessionId = resolveHermesSessionId({
      workflowState: { sessionId: "default::parked::feature::123" },
      agentLogText: [
        "INFO hermes_adapter: Bridge started for session default",
        "INFO hermes_adapter: Bridge started for session 20260420_real",
      ].join("\n"),
    })

    expect(sessionId).toBe("20260420_real")
  })

  it("classifies user gates and done states", () => {
    expect(evaluateHarnessStatus({ featureName: "feat", phase: "IMPLEMENTATION", phaseState: "USER_GATE", currentTaskId: "T3" }).kind).toBe("user-gate")
    expect(evaluateHarnessStatus({ featureName: "feat", phase: "DONE", phaseState: "DRAFT" }).kind).toBe("done")
  })

  it("detects missing session ids at user gate as blocking", () => {
    const issues = detectBlockingDeviations({
      workflowState: { phase: "IMPLEMENTATION", phaseState: "USER_GATE" },
      resolvedSessionId: null,
      openArtisanLogTail: "",
      hermesErrorLogTail: "",
    })

    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain("could not resolve the Hermes session ID")
  })

  it("ignores unrelated Hermes session errors when a concrete session is known", () => {
    const issues = detectBlockingDeviations({
      workflowState: { phase: "IMPLEMENTATION", phaseState: "DRAFT" },
      resolvedSessionId: "20260420_real",
      openArtisanLogTail: "",
      hermesErrorLogTail: "2026-04-20 ERROR [20260420_other] hermes_adapter: Failed to start bridge",
    })

    expect(issues).toEqual([])
  })

  it("detects stale shared bridge metadata", () => {
    const issues = detectBlockingDeviations({
      workflowState: { phase: "DISCOVERY", phaseState: "REVISE" },
      resolvedSessionId: "20260420_real",
      bridgeMeta: { pid: 12345 },
      bridgeProcessAlive: false,
      openArtisanLogTail: "",
      hermesErrorLogTail: "",
    })

    expect(issues).toEqual([
      "Shared bridge metadata points at stale PID 12345; run oa_recover_bridge before continuing.",
    ])
  })

  it("checks whether a pid is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(null)).toBe(null)
  })

  it("builds Hermes chat resume command for gate replies", () => {
    expect(buildHermesReplyCommand("openartisan", "20260427_session", "revise please")).toEqual([
      "openartisan",
      "chat",
      "-r",
      "20260427_session",
      "-Q",
      "-q",
      "revise please",
    ])
  })

  it("builds kickoff instructions with channel and mention guidance", () => {
    const instructions = buildDiscordKickoffInstructions({
      featureName: "pglite-roadmap-backend",
      kickoffText: "resume this feature",
      profileSettings: { requireMention: true, homeChannel: "123", allowedUsers: ["456"] },
    })

    expect(instructions).toContain("Target channel: 123")
    expect(instructions).toContain("Mention the Hermes bot")
    expect(instructions).toContain("fresh Discord thread/session")
    expect(instructions).toContain("resume this feature")
  })
})
