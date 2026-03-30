#!/usr/bin/env bun
/**
 * artisan.ts — Workflow CLI for Claude Code.
 *
 * Claude calls this via Bash to execute workflow commands. Each invocation
 * connects to the running artisan-server via Unix socket, sends a JSON-RPC
 * request, prints the result, and exits.
 *
 * Simple commands use CLI flags:
 *   artisan select-mode --mode GREENFIELD --feature-name cloud-cost
 *   artisan state
 *   artisan ping
 *   artisan enable
 *   artisan disable
 *
 * Complex commands accept JSON on stdin:
 *   echo '{"summary":"Plan ready","artifact_content":"..."}' | artisan request-review
 *   echo '{"task_id":"T1","implementation_summary":"Built auth","tests_passing":true}' | artisan mark-task-complete
 *   echo '{"criteria_met":[...]}' | artisan mark-satisfied
 *   echo '{"feedback_type":"approve","feedback_text":"LGTM"}' | artisan submit-feedback
 */

import { join, resolve } from "node:path"
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { sendSocketRequest } from "#claude-code/src/socket-transport"
import {
  DEFAULT_STATE_DIR_NAME,
  getSocketPath,
  getActiveSessionPath,
  getEnabledPath,
} from "#claude-code/src/constants"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProjectDir(): string {
  return process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
}

function getStateDir(): string {
  return join(getProjectDir(), DEFAULT_STATE_DIR_NAME)
}

function getSessionId(): string {
  const sessionPath = getActiveSessionPath(getStateDir())
  if (existsSync(sessionPath)) {
    const id = readFileSync(sessionPath, "utf-8").trim()
    if (id) return id
  }
  return "default"
}

/** Read JSON from stdin if piped, otherwise return null. */
async function readStdinJson(): Promise<Record<string, unknown> | null> {
  // Check if stdin is a TTY (interactive) — if so, no piped input
  if (process.stdin.isTTY) return null

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    console.error(`Error: Invalid JSON on stdin: ${text.slice(0, 200)}`)
    process.exit(1)
  }
}

/** Send a JSON-RPC request to the artisan server. */
async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const socketPath = getSocketPath(getStateDir())
  const response = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method,
    params,
    id: Date.now(),
  })

  if (!response) {
    console.error("Error: artisan server is not running. Start it with: artisan enable")
    process.exit(1)
  }

  const r = response as { result?: unknown; error?: { message?: string; code?: number } }
  if (r.error) {
    console.error(`Error: ${r.error.message ?? "Unknown error"} (code ${r.error.code ?? "?"})`)
    process.exit(1)
  }

  return r.result
}

/** Ensure the session is registered with the bridge (idempotent). */
async function ensureSession(): Promise<void> {
  const socketPath = getSocketPath(getStateDir())
  const sessionId = getSessionId()
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "lifecycle.sessionCreated",
    params: { sessionId },
    id: Date.now(),
  })
}

/** Call tool.execute with the given tool name and args. */
async function execTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  await ensureSession()

  // For submit_feedback: the CLI is invoked directly by the user, so we
  // must call message.process first to set userGateMessageReceived = true.
  // Without this, submit_feedback is structurally blocked because the bridge
  // thinks no user message has been received at USER_GATE.
  if (name === "submit_feedback") {
    await call("message.process", {
      sessionId: getSessionId(),
      parts: [{ type: "text", text: "(user invoked submit_feedback via CLI)" }],
    })
  }

  const result = await call("tool.execute", {
    name,
    args,
    context: {
      sessionId: getSessionId(),
      directory: getProjectDir(),
    },
  })
  return typeof result === "string" ? result : JSON.stringify(result, null, 2)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const TOOL_COMMANDS: Record<string, string> = {
  "select-mode": "select_mode",
  "submit-task-review": "submit_task_review",
  "mark-scan-complete": "mark_scan_complete",
  "mark-analyze-complete": "mark_analyze_complete",
  "mark-satisfied": "mark_satisfied",
  "mark-task-complete": "mark_task_complete",
  "request-review": "request_review",
  "submit-feedback": "submit_feedback",
  "check-prior-workflow": "check_prior_workflow",
  "resolve-human-gate": "resolve_human_gate",
  "propose-backtrack": "propose_backtrack",
  "spawn-sub-workflow": "spawn_sub_workflow",
  "query-parent-workflow": "query_parent_workflow",
  "query-child-workflow": "query_child_workflow",
}

async function handleState(): Promise<void> {
  await ensureSession()
  const result = await call("state.get", { sessionId: getSessionId() })
  if (!result) {
    console.log("No active workflow session.")
    return
  }
  const s = result as Record<string, unknown>
  console.log(`Phase:    ${s.phase}/${s.phaseState}`)
  console.log(`Mode:     ${s.mode ?? "(not selected)"}`)
  console.log(`Feature:  ${s.featureName ?? "(none)"}`)
  if (s.currentTaskId) console.log(`Task:     ${s.currentTaskId}`)
  if (s.iterationCount) console.log(`Iteration: ${s.iterationCount}`)
  const approved = s.approvedArtifacts as Record<string, string> | undefined
  if (approved && Object.keys(approved).length > 0) {
    console.log(`Approved: ${Object.keys(approved).join(", ")}`)
  }
}

async function handlePing(): Promise<void> {
  const result = await call("lifecycle.ping")
  console.log(result)
}

async function handleEnable(): Promise<void> {
  const stateDir = getStateDir()
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(getEnabledPath(stateDir), "1", "utf-8")
  console.log("open-artisan enabled.")

  // Check if server is running
  const socketPath = getSocketPath(stateDir)
  if (!existsSync(socketPath)) {
    console.log("Server not running. Start it with:")
    console.log(`  bun run packages/claude-code/bin/artisan-server.ts --project-dir "${getProjectDir()}" --daemon`)
    return
  }

  // Show current state
  try {
    await handleState()
  } catch {
    console.log("(could not read state)")
  }
}

async function handleDisable(): Promise<void> {
  const enabledPath = getEnabledPath(getStateDir())
  if (existsSync(enabledPath)) {
    unlinkSync(enabledPath)
  }
  console.log("open-artisan disabled. Hooks are now dormant.")
}

async function handleToolCommand(command: string, cliArgs: string[]): Promise<void> {
  const toolName = TOOL_COMMANDS[command]
  if (!toolName) {
    console.error(`Unknown command: ${command}`)
    console.error(`Valid commands: ${Object.keys(TOOL_COMMANDS).join(", ")}, state, ping, enable, disable`)
    process.exit(1)
  }

  // Try --args-file first (bypass all shell escaping), then stdin JSON, then CLI flags
  let args: Record<string, unknown> | null = null
  const argsFileIdx = cliArgs.indexOf("--args-file")
  if (argsFileIdx !== -1 && cliArgs[argsFileIdx + 1]) {
    const argsFilePath = cliArgs[argsFileIdx + 1]!
    try {
      args = JSON.parse(readFileSync(argsFilePath, "utf-8"))
    } catch (err) {
      console.error(`Error: Cannot read/parse args file "${argsFilePath}": ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  if (!args) {
    args = await readStdinJson()
  }

  if (!args) {
    // Parse CLI flags into args object
    args = {}
    for (let i = 0; i < cliArgs.length; i++) {
      const flag = cliArgs[i]!
      if (flag.startsWith("--")) {
        // Handle --key=value syntax
        const eqIdx = flag.indexOf("=")
        let key: string
        let value: unknown
        if (eqIdx !== -1) {
          key = flag.slice(2, eqIdx).replace(/-/g, "_")
          value = parseValue(flag.slice(eqIdx + 1))
        } else {
          key = flag.slice(2).replace(/-/g, "_")
          const next = cliArgs[i + 1]
          if (next && !next.startsWith("--")) {
            value = parseValue(next)
            i++
          } else {
            value = true // boolean flag
          }
        }
        args[key] = value
      }
    }
  }

  // Resolve --artifact-file: read file content into artifact_content.
  // This avoids shell escaping issues when passing multiline content via stdin/flags.
  const artifactFile = args.artifact_file as string | undefined
  if (artifactFile) {
    try {
      args.artifact_content = readFileSync(artifactFile, "utf-8")
    } catch (err) {
      console.error(`Error: Cannot read artifact file "${artifactFile}": ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    delete args.artifact_file
  }

  const result = await execTool(toolName, args)
  // Tool-level errors start with "Error:" — print to stderr and exit 1
  if (result.startsWith("Error:")) {
    console.error(result)
    process.exit(1)
  }
  console.log(result)
}

/** Parse a CLI value — handle booleans only. Everything else stays a string.
 *  Tool handlers handle their own type coercion (parseInt, etc.). */
function parseValue(value: string): unknown {
  if (value === "true") return true
  if (value === "false") return false
  return value
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === "--help" || command === "-h") {
    console.log(`Usage: artisan <command> [options]

Commands:
  state                    Show current workflow state
  ping                     Check if server is running
  enable                   Enable open-artisan hooks
  disable                  Disable open-artisan hooks

Workflow tools (accepts --flags or JSON on stdin):
  select-mode              Select workflow mode
  mark-scan-complete       Complete discovery scan
  mark-analyze-complete    Complete discovery analysis
  mark-satisfied           Submit self-review criteria
  mark-task-complete       Complete a DAG task
  request-review           Submit artifact for review
  submit-feedback          Approve or request revision
  check-prior-workflow     Check for prior workflow state
  resolve-human-gate       Set human gate on a task
  propose-backtrack        Propose going to an earlier phase
  spawn-sub-workflow       Delegate a DAG task to a child workflow
  query-parent-workflow    Read parent workflow state
  query-child-workflow     Read child workflow state

Options:
  --artifact-file <path>   Read file content into artifact_content (avoids shell escaping)

Examples:
  artisan select-mode --mode GREENFIELD --feature-name my-feature
  artisan state
  artisan request-review --summary "Plan ready" --artifact-file .openartisan/feat/plan.md
  echo '{"task_id":"T1","implementation_summary":"Built it","tests_passing":true}' | artisan mark-task-complete`)
    process.exit(0)
  }

  switch (command) {
    case "state":
      await handleState()
      break
    case "ping":
      await handlePing()
      break
    case "enable":
      await handleEnable()
      break
    case "disable":
      await handleDisable()
      break
    default:
      await handleToolCommand(command, rest)
      break
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
