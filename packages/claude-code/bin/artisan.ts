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
 *   echo '{"summary":"Plan ready","artifact_files":[".openartisan/feat/plan.md"]}' | artisan request-review
 *   echo '{"task_id":"T1","implementation_summary":"Built auth","tests_passing":true}' | artisan mark-task-complete
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
import { dispatchOwnedPhaseReview, dispatchOwnedTaskReview } from "#claude-code/src/hook-handlers"

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
/**
 * Read a JSON args object piped on stdin, or null if none.
 *
 * Hooks, background processes, and agent shells leave stdin as an open pipe that
 * never reaches EOF, so a naive read-to-EOF blocks forever for any command that
 * isn't given piped data. We arm a short idle timer: if no data arrives before it
 * fires, we treat stdin as empty (no piped args). Once data starts arriving, we
 * read to natural EOF so genuinely-piped JSON is never truncated.
 */
async function readStdinJson(idleTimeoutMs = 1000): Promise<Record<string, unknown> | null> {
  // A TTY is interactive — no piped input.
  if (process.stdin.isTTY) return null

  const text = await new Promise<string>((resolveText) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.removeListener("data", onData)
      // Release stdin so an open, never-closed pipe (hooks/background shells)
      // can't keep the event loop alive and stall process exit after the work.
      process.stdin.pause()
      process.stdin.unref?.()
      resolveText(Buffer.concat(chunks).toString("utf-8").trim())
    }
    // Fires only if NO data has arrived yet — guards against a never-EOF empty pipe.
    const timer = setTimeout(finish, idleTimeoutMs)
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      clearTimeout(timer) // data is flowing — wait for the real EOF
    }
    process.stdin.on("data", onData)
    process.stdin.once("end", finish)
    process.stdin.once("error", finish)
  })

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
  if (name === "mark_satisfied" || name === "submit_task_review" || name === "submit_phase_review" || name === "submit_auto_approve") {
    return `Error: ${name} is reserved for isolated reviewers. Use request_review/mark_task_complete and let the Claude Code hook submit reviewer results.`
  }

  await ensureSession()

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

export const TOOL_COMMANDS: Record<string, string> = {
  "select-mode": "select_mode",
  "reset-task": "reset_task",
  "mark-scan-complete": "mark_scan_complete",
  "mark-analyze-complete": "mark_analyze_complete",
  "mark-task-complete": "mark_task_complete",
  "request-review": "request_review",
  "submit-feedback": "submit_feedback",
  "check-prior-workflow": "check_prior_workflow",
  "resolve-human-gate": "resolve_human_gate",
  "propose-backtrack": "propose_backtrack",
  "query-parent-workflow": "query_parent_workflow",
  "query-child-workflow": "query_child_workflow",
  "analyze-task-boundary-change": "analyze_task_boundary_change",
  "apply-task-boundary-change": "apply_task_boundary_change",
  "approve-current-task-scope-expansion": "approve_current_task_scope_expansion",
  "repair-current-task-boundary-from-impl-plan": "repair_current_task_boundary_from_impl_plan",
  "route-patch-suggestions": "route_patch_suggestions",
  "resolve-patch-suggestion": "resolve_patch_suggestion",
  "apply-patch-suggestion": "apply_patch_suggestion",
  "report-drift": "report_drift",
  "plan-drift-repair": "plan_drift_repair",
  "apply-drift-repair": "apply_drift_repair",
  // Roadmap — durable cross-workflow plan (DAG of items + depends-on edges).
  // Complex payloads (items/edges) are best passed via --args-file <json>.
  "roadmap-read": "roadmap_read",
  "roadmap-query": "roadmap_query",
  "roadmap-derive-execution-slice": "roadmap_derive_execution_slice",
  "roadmap-upsert-item": "roadmap_upsert_item",
  "roadmap-update-item-status": "roadmap_update_item_status",
  "roadmap-delete-item": "roadmap_delete_item",
  "roadmap-upsert-edge": "roadmap_upsert_edge",
  "roadmap-delete-edge": "roadmap_delete_edge",
  "roadmap-replace": "roadmap_replace",
  "roadmap-delete": "roadmap_delete",
}

async function handleRunReview(): Promise<void> {
  await ensureSession()
  const sessionId = getSessionId()
  const stateDir = getStateDir()
  const projectDir = getProjectDir()
  const result = await call("state.get", { sessionId })
  if (!result) {
    console.error("No active workflow session.")
    process.exit(1)
  }
  const s = result as Record<string, unknown>
  let outcome: { ok: boolean; message: string; partial?: boolean }
  if (s.taskCompletionInProgress) {
    outcome = await dispatchOwnedTaskReview(stateDir, sessionId, projectDir)
  } else if (s.phaseState === "REVIEW") {
    outcome = await dispatchOwnedPhaseReview(stateDir, sessionId, projectDir, s.phase)
  } else {
    console.log(`Nothing to review — at ${s.phase}/${s.phaseState}. run-review applies at a phase REVIEW state or when a task awaits review.`)
    return
  }
  console.log(outcome.message)
  // A partial pass is NOT a failure: the review is being covered across multiple
  // bounded passes. Surface the "run again to continue" guidance and exit 0 so the
  // agent treats it as progress and re-invokes `./artisan run-review`.
  if (outcome.partial) {
    console.log("The review is being covered across multiple bounded passes. Run `./artisan run-review` again to continue until it reports a final verdict.")
    return
  }
  if (!outcome.ok) process.exit(1)
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

  // Resolve args in priority order: --args-file (bypasses shell escaping), then
  // CLI flags, then JSON piped on stdin. Flags are parsed BEFORE stdin so a
  // flag/file-driven command never consults (and never blocks on) stdin.
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
    const flagArgs = parseFlagArgs(cliArgs)
    if (Object.keys(flagArgs).length > 0) args = flagArgs
  }

  if (!args) {
    args = await readStdinJson()
  }

  if (!args) args = {}

  // Resolve --artifact-file: pass the path as the review artifact source.
  const artifactFile = args.artifact_file as string | undefined
  if (artifactFile) {
    args.artifact_files = [artifactFile]
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

/**
 * Parse `--key value` / `--key=value` / boolean `--flag` pairs into an args
 * object (kebab keys → snake_case). `--args-file` is consumed elsewhere and
 * skipped here. Returns {} when no flags are present.
 */
export function parseFlagArgs(cliArgs: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (let i = 0; i < cliArgs.length; i++) {
    const flag = cliArgs[i]!
    if (!flag.startsWith("--")) continue
    const eqIdx = flag.indexOf("=")
    if (eqIdx !== -1) {
      const key = flag.slice(2, eqIdx).replace(/-/g, "_")
      args[key] = parseValue(flag.slice(eqIdx + 1))
      continue
    }
    const key = flag.slice(2).replace(/-/g, "_")
    if (key === "args_file") { i++; continue } // value consumed by --args-file handling
    const next = cliArgs[i + 1]
    if (next && !next.startsWith("--")) {
      args[key] = parseValue(next)
      i++
    } else {
      args[key] = true // boolean flag
    }
  }
  return args
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
  run-review               Dispatch the pending isolated review (phase or task) and print the verdict
  submit-feedback          Approve or request revision
  check-prior-workflow     Check for prior workflow state
  resolve-human-gate       Set human gate on a task
  propose-backtrack        Propose going to an earlier phase
  spawn-sub-workflow       Delegate a DAG task to a child workflow
  query-parent-workflow    Read parent workflow state
  query-child-workflow     Read child workflow state
  analyze-task-boundary-change
                           Preview a localized DAG task-boundary change
  apply-task-boundary-change
                           Apply a localized DAG task-boundary change
  approve-current-task-scope-expansion
                           Add file(s)/tests to the ACTIVE task's boundary (one USER_GATE approval, no task reset)
  repair-current-task-boundary-from-impl-plan
                           Re-sync the active task boundary with the approved IMPL_PLAN metadata
  route-patch-suggestions  Classify pending reviewer patch suggestions
  resolve-patch-suggestion Record patch suggestion disposition
  apply-patch-suggestion   Apply a pending reviewer patch suggestion
  report-drift             Report workflow drift
  plan-drift-repair        Build a drift repair plan
  apply-drift-repair       Apply approved drift repair actions

Roadmap tools (durable cross-workflow plan; use --args-file <json> for items/edges):
  roadmap-read             Read the full roadmap document
  roadmap-query            Query roadmap items by kind/status
  roadmap-upsert-item      Create or update a roadmap item
  roadmap-update-item-status  Update a roadmap item's status
  roadmap-delete-item      Delete a roadmap item
  roadmap-upsert-edge      Create or update a depends-on edge
  roadmap-delete-edge      Delete a depends-on edge
  roadmap-derive-execution-slice  Derive an execution slice from items
  roadmap-replace          Replace the entire roadmap document
  roadmap-delete           Delete the roadmap document

Options:
  --artifact-file <path>   Add a file path to artifact_files for request-review
  --args-file <path>       Read tool args as JSON from a file (bypasses shell escaping)

Examples:
  artisan select-mode --mode GREENFIELD --feature-name my-feature
  artisan state
  artisan request-review --summary "Plan ready" --artifact-file .openartisan/feat/plan.md
  artisan roadmap-upsert-item --args-file /tmp/item.json
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
    case "run-review":
      await handleRunReview()
      break
    default:
      await handleToolCommand(command, rest)
      break
  }
}

// Only run when invoked as a script — importing for tests must not execute main().
if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
