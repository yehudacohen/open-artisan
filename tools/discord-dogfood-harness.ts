#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  buildDiscordKickoffInstructions,
  buildHermesReplyCommand,
  detectBlockingDeviations,
  evaluateHarnessStatus,
  isPidAlive,
  resolveDiscordProfileSettings,
  resolveHermesSessionId,
  type BridgeMetaSnapshotLite,
  type BridgeClientsSnapshotLite,
  type WorkflowStateLite,
} from "./discord-dogfood-harness-lib"

type Command = "status" | "run" | "approve"

interface Options {
  command: Command
  feature: string
  profile: string
  pollMs: number
  autoApprove: boolean
  approvalText: string
  kickoffText: string
  sessionId: string | null
}

function parseArgs(argv: string[]): Options {
  const [commandRaw, ...rest] = argv
  const command = (commandRaw || "status") as Command
  const values = new Map<string, string>()
  const flags = new Set<string>()

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith("--")) {
      flags.add(key)
      continue
    }
    values.set(key, next)
    index += 1
  }

  const feature = values.get("feature") || "pglite-roadmap-backend"
  const approvalText = values.get("approval-text") || "approve"
  const kickoffText = values.get("kickoff-text") ||
    `Use Open Artisan to resume the existing feature ${feature} from its persisted workflow state in /Users/yehudac/workspace/open-artisan. If your current session is attached to a different repository, first call \`oa_list_projects\` and then \`oa_select_project\` to bind this session to /Users/yehudac/workspace/open-artisan before using any other oa_* workflow tools. Continue the real workflow from its current state, keep progressing autonomously until a truthful stop condition, and stop only at a USER_GATE, unresolved human gate, explicit safety stop, or real runtime/framework failure.`

  return {
    command,
    feature,
    profile: values.get("profile") || "openartisan",
    pollMs: Number(values.get("poll-ms") || 5000),
    autoApprove: flags.has("auto-approve"),
    approvalText,
    kickoffText,
    sessionId: values.get("session-id") || null,
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return ""
  }
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T
  } catch {
    return null
  }
}

function runCommand(command: string[], workdir: string): { success: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(command, {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  })
  return {
    success: proc.exitCode === 0,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

function gatewayLooksHealthy(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`
  if (/Gateway is running/i.test(text)) return true
  return /Gateway service is loaded/i.test(text) && /"PID"\s*=\s*\d+;/.test(text)
}

async function collectSnapshot(options: Options, root: string) {
  const stateDir = join(root, ".openartisan")
  const featureDir = join(stateDir, options.feature)
  const workflowState = await readJsonIfExists<WorkflowStateLite>(join(featureDir, "workflow-state.json"))
  const bridgeMeta = await readJsonIfExists<BridgeMetaSnapshotLite>(join(stateDir, ".bridge-meta.json"))
  const bridgeClients = await readJsonIfExists<BridgeClientsSnapshotLite>(join(stateDir, ".bridge-clients.json"))
  const agentLogText = await readTextIfExists(join(process.env.HOME || "", ".hermes/profiles", options.profile, "logs/agent.log"))
  const hermesErrorLogText = await readTextIfExists(join(process.env.HOME || "", ".hermes/profiles", options.profile, "logs/errors.log"))
  const openArtisanLogText = await readTextIfExists(join(stateDir, "openartisan-errors.log"))
  const envText = await readTextIfExists(join(process.env.HOME || "", ".hermes/profiles", options.profile, ".env"))
  const configText = await readTextIfExists(join(process.env.HOME || "", ".hermes/profiles", options.profile, "config.yaml"))

  const sessionId = options.sessionId || resolveHermesSessionId({ workflowState, bridgeClients, agentLogText })
  const status = evaluateHarnessStatus(workflowState)
  const deviations = detectBlockingDeviations({
    workflowState,
    resolvedSessionId: sessionId,
    bridgeMeta,
    bridgeProcessAlive: isPidAlive(bridgeMeta?.pid),
    hermesErrorLogTail: hermesErrorLogText.split(/\r?\n/).slice(-40).join("\n"),
    openArtisanLogTail: openArtisanLogText.split(/\r?\n/).slice(-40).join("\n"),
  })

  return {
    workflowState,
    bridgeClients,
    sessionId,
    status,
    deviations,
    kickoffInstructions: buildDiscordKickoffInstructions({
      featureName: options.feature,
      kickoffText: options.kickoffText,
      profileSettings: resolveDiscordProfileSettings(envText, configText),
    }),
  }
}

function ensureGatewayRunning(options: Options, root: string): void {
  const status = runCommand([options.profile, "gateway", "status"], root)
  if (status.success && gatewayLooksHealthy(status.stdout, status.stderr)) {
    return
  }

  const start = runCommand([options.profile, "gateway", "start"], root)
  if (start.success) {
    const recheck = runCommand([options.profile, "gateway", "status"], root)
    if (recheck.success && gatewayLooksHealthy(recheck.stdout, recheck.stderr)) {
      return
    }
  }

  throw new Error(
    "Hermes gateway is not running for the openartisan profile. Start it with `openartisan gateway start` or `openartisan gateway run` before using the Discord dogfood harness.",
  )
}

function sendHermesReply(options: Options, root: string, sessionId: string, text: string): void {
  const result = runCommand(buildHermesReplyCommand(options.profile, sessionId, text), root)
  if (!result.success) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Failed to send Hermes reply into session ${sessionId}`)
  }
}

async function commandStatus(options: Options, root: string): Promise<void> {
  const snapshot = await collectSnapshot(options, root)
  console.log(snapshot.kickoffInstructions)
  console.log("")
  console.log(snapshot.status.summary)
  console.log(`- Resolved Hermes session: ${snapshot.sessionId || "(unresolved)"}`)
  if (snapshot.deviations.length > 0) {
    console.log("- Blocking deviations:")
    for (const issue of snapshot.deviations) {
      console.log(`  - ${issue}`)
    }
  }
}

async function commandApprove(options: Options, root: string): Promise<void> {
  const snapshot = await collectSnapshot(options, root)
  if (!snapshot.sessionId) {
    throw new Error("Could not resolve the Hermes session ID needed to send approval into the same session.")
  }
  sendHermesReply(options, root, snapshot.sessionId, options.approvalText)
  console.log(`Sent ${JSON.stringify(options.approvalText)} to Hermes session ${snapshot.sessionId}.`)
}

async function commandRun(options: Options, root: string): Promise<void> {
  await mkdir(join(root, ".openartisan"), { recursive: true })
  ensureGatewayRunning(options, root)

  const initial = await collectSnapshot(options, root)
  console.log(initial.kickoffInstructions)
  console.log("")
  console.log("Monitoring workflow state. Press Ctrl+C to stop.\n")

  let lastSummary = ""
  let lastDeviationKey = ""

  for (;;) {
    const snapshot = await collectSnapshot(options, root)
    if (snapshot.status.summary !== lastSummary) {
      console.log(`[status] ${snapshot.status.summary}`)
      if (snapshot.sessionId) {
        console.log(`[status] Hermes session ${snapshot.sessionId}`)
      }
      lastSummary = snapshot.status.summary
    }

    if (snapshot.deviations.length > 0) {
      const deviationKey = snapshot.deviations.join("\n")
      if (deviationKey !== lastDeviationKey) {
        console.log("[deviation] Blocking runtime issue detected:")
        for (const issue of snapshot.deviations) {
          console.log(`- ${issue}`)
        }
        lastDeviationKey = deviationKey
      }
      return
    }

    if (snapshot.status.kind === "user-gate") {
      if (options.autoApprove && snapshot.sessionId) {
        console.log(`[gate] Auto-approving via Hermes session ${snapshot.sessionId}`)
        sendHermesReply(options, root, snapshot.sessionId, options.approvalText)
      } else {
        console.log("[gate] USER_GATE reached.")
        console.log(`- Hermes session: ${snapshot.sessionId || "(unresolved)"}`)
        console.log(`- Approve manually with: bun run dogfood:discord approve --feature ${options.feature}${snapshot.sessionId ? ` --session-id ${snapshot.sessionId}` : ""}`)
        return
      }
    }

    if (snapshot.status.kind === "done") {
      console.log("[done] Workflow completed.")
      return
    }

    await Bun.sleep(options.pollMs)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = process.cwd()
  if (!existsSync(join(root, "package.json"))) {
    throw new Error("Run the Discord dogfood harness from the repository root.")
  }

  if (options.command === "status") {
    await commandStatus(options, root)
    return
  }

  if (options.command === "approve") {
    await commandApprove(options, root)
    return
  }

  await commandRun(options, root)
}

await main()
