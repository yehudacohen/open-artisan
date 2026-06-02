/**
 * hook-handlers.ts — Maps Claude Code hook events to bridge JSON-RPC calls.
 *
 * Each handler receives the raw hook input (JSON from stdin), sends the
 * appropriate JSON-RPC request to the bridge via Unix socket, and returns
 * the hook output (JSON for stdout + exit code).
 *
 * Hook scripts call these handlers via artisan-hook.ts CLI.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { buildRobotArtisanAutoApproveFailureFeedback } from "#core/autonomous-user-gate"
import { IMPLEMENTATION_REVIEW_PROGRESS_IDLE_TIMEOUT_MS, REVIEW_PROGRESS_HARD_TIMEOUT_MS, REVIEW_PROGRESS_IDLE_TIMEOUT_MS, REVIEW_PROGRESS_SHUTDOWN_GRACE_MS, REVIEWER_MAX_TURNS } from "#core/constants"
import { sendSocketRequest } from "./socket-transport"
import {
  getSocketPath,
  getEnabledPath,
  getActiveSessionPath,
  DEFAULT_STATE_DIR_NAME,
  REVIEWER_SUBPROCESS_ENV,
} from "./constants"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claude Code hook input (subset of fields we use). */
export interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  stop_hook_active?: boolean
  source?: string // SessionStart matcher: "startup" | "resume" | "clear" | "compact"
  prompt?: string // UserPromptSubmit: the text the user just submitted
}

/** Hook output — determines what Claude Code does with the result. */
export interface HookOutput {
  /** JSON to write to stdout (null = no output). */
  stdout: string | null
  /** Text to write to stderr (null = no output). */
  stderr: string | null
  /** Exit code: 0 = allow/continue, 2 = block/inject. */
  exitCode: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStateDir(input: HookInput): string {
  const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
  return join(projectDir, DEFAULT_STATE_DIR_NAME)
}

function isEnabled(stateDir: string): boolean {
  return existsSync(getEnabledPath(stateDir))
}

/**
 * True when this hook is running inside an isolated reviewer/approver subprocess
 * spawned by runOwnedReviewerCommand. Such subprocesses run in the project dir
 * and therefore inherit the project's open-artisan hooks; they must be fully
 * transparent to the workflow — not gated, never re-dispatching a review from
 * their own Stop hook, never clobbering the `.active-session` pointer, and never
 * receiving injected workflow context. Every handler short-circuits on this.
 */
function isReviewerSubprocess(): boolean {
  return process.env[REVIEWER_SUBPROCESS_ENV] === "1"
}

function getSessionId(stateDir: string): string {
  const sessionPath = getActiveSessionPath(stateDir)
  if (existsSync(sessionPath)) {
    const id = readFileSync(sessionPath, "utf-8").trim()
    if (id) return id
  }
  return "default"
}

function resolveSessionId(input: HookInput, stateDir: string): string {
  return input.session_id ?? getSessionId(stateDir)
}

function persistActiveSessionId(stateDir: string, sessionId: string): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(getActiveSessionPath(stateDir), sessionId, "utf-8")
}

/** Recognised artisan invocation heads: `./artisan …`, `artisan …`, `bun run …artisan[.ts] …`. */
const ARTISAN_HEAD = /^(?:(?:bun\s+run\s+\S*artisan(?:\.ts)?)|\.\/artisan|artisan)(?:\s|$)/

/**
 * True when `command` is a single, pure `artisan` workflow invocation that cannot
 * smuggle extra commands around it. Workflow tools are invoked as bash, so the
 * guard must distinguish a bare `artisan …` call (always allowed, even in phases
 * where general bash is blocked) from a compound shell command.
 *
 * Crucially, shell metacharacters that appear INSIDE quotes are literal — e.g. a
 * `;` or `*` in an `--artifact-description "…"` value — and must NOT disqualify
 * the command. Only unquoted control operators (`| ; & < > ( ) { }`), and
 * command/variable substitution (`$`, backtick) even inside double quotes, route
 * the call to the full guard. Single-quoted spans are fully literal.
 */
export function isPureArtisanCommand(command: string): boolean {
  const trimmed = command.trim()
  if (/[\r\n]/.test(trimmed)) return false
  if (!ARTISAN_HEAD.test(trimmed)) return false

  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (quote === "'") {
      // Single quotes: everything literal until the closing quote.
      if (c === "'") quote = null
      continue
    }
    if (quote === '"') {
      // Double quotes: literal except backslash escapes and $/backtick expansion.
      if (c === "\\") { i++; continue }
      if (c === '"') { quote = null; continue }
      if (c === "$" || c === "`") return false
      continue
    }
    // Unquoted context.
    if (c === "\\") { i++; continue } // escaped next char — literal
    if (c === "'") { quote = "'"; continue }
    if (c === '"') { quote = '"'; continue }
    if (c === "|" || c === ";" || c === "&" || c === "<" || c === ">" ||
        c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
      return false
    }
  }
  // Unterminated quote is ambiguous — route to the guard.
  return quote === null
}

/** Send a JSON-RPC request to the bridge. Returns null if unavailable. */
async function bridgeCall(
  stateDir: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const socketPath = getSocketPath(stateDir)
  const response = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method,
    params,
    id: Date.now(),
  })
  if (!response) return null
  const r = response as { result?: unknown; error?: { message?: string } }
  if (r.error) return null // Treat bridge errors as unavailable for hooks
  return r.result
}

/** Permissive default — allow everything when disabled or server unavailable. */
const ALLOW: HookOutput = { stdout: null, stderr: null, exitCode: 0 }

export function isWriteLikeTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  const normalized = toolName.toLowerCase()
  if (["write", "edit", "multiedit", "notebookedit"].includes(normalized)) return true
  if (normalized !== "bash") return false
  const command = String(toolInput.command ?? toolInput.cmd ?? "")
  return /(?:>>|>[^&]|\btee\b|\bsed\s+-i\b|\bdd\b.*\bof=|<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?|(?:^|[;&|]\s*)(?:touch|mkdir|cp|mv|rm|rmdir|install|chmod|chown|ln|truncate|rsync|patch|cpio|unzip|tar\s+(?:-[A-Za-z]*x[A-Za-z]*|x[A-Za-z]*|--extract)|git\s+(?:add|commit|checkout|restore|reset|clean|mv|rm|apply|am)|(?:curl|wget)\b(?=.*\s(?:-o|-O|--output(?:=|\s)|--output-document(?:=|\s)))|(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|x)|(?:prettier|eslint|ruff|black|isort)\b.*(?:^|\s)(?:--write|--fix|--apply))\b|\b(?:python|python3|node|ruby|perl)\b.*\b(?:writeFile|open\s*\(|File\.write|fs\.write|write\s*\(|write_text\s*\(|write_bytes\s*\(|append_text\s*\(|append_bytes\s*\())/.test(command)
}

function bridgeUnavailableDecision(toolName: string, toolInput: Record<string, unknown>): HookOutput {
  if (!isWriteLikeTool(toolName, toolInput)) return ALLOW
  return {
    stdout: null,
    stderr: "Open Artisan is enabled but the bridge guard is unavailable. Blocking write-like tool call to preserve workflow safety.",
    exitCode: 2,
  }
}

function extractReviewToken(reviewPrompt: string): string | null {
  return reviewPrompt.match(/OPEN_ARTISAN_REVIEW_TOKEN:\s*([a-f0-9]+)/i)?.[1] ?? null
}

/**
 * Build the `claude` argv for the isolated reviewer.
 *
 * - `--max-turns > 1`: the prompt tells the reviewer to Read/Glob artifact (and
 *   source) files before answering; the first tool call consumes a turn, so a
 *   single-turn budget exits with "Reached max turns (1)" before it can answer.
 * - `--output-format stream-json --verbose`: a plain `--print` reviewer emits NO
 *   output until it finishes, so the progress idle-timeout watchdog (which resets
 *   only on output) kills any review whose silent work exceeds the idle window.
 *   Streaming emits events throughout the run, keeping the watchdog satisfied;
 *   the final verdict is carried in the terminal `result` event.
 */
export function reviewerCommandArgs(reviewPrompt: string): string[] {
  return ["--print", "--output-format", "stream-json", "--verbose", "--max-turns", String(REVIEWER_MAX_TURNS), "-p", reviewPrompt]
}

/**
 * Extract the reviewer's final answer from a `stream-json` transcript. The CLI
 * emits one JSON event per line; the terminal `{ type: "result" }` event carries
 * the assistant's final text in its `result` field. Returns ok=false (with a
 * detail) when no successful result event was emitted (e.g. max-turns, error).
 */
export function extractStreamJsonResult(stdout: string): { ok: boolean; text: string; detail?: string } {
  let resultEvent: Record<string, unknown> | null = null
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      if (event && event.type === "result") resultEvent = event
    } catch { /* non-JSON line (shouldn't occur in stream-json) — ignore */ }
  }
  if (!resultEvent) return { ok: false, text: "", detail: "reviewer stream produced no result event" }
  const text = typeof resultEvent.result === "string" ? resultEvent.result : ""
  if (resultEvent.is_error === true || resultEvent.subtype !== "success") {
    return { ok: false, text, detail: `reviewer ended with subtype=${String(resultEvent.subtype)}` }
  }
  return { ok: true, text }
}

async function runOwnedReviewerCommand(reviewPrompt: string, cwd: string, label: string, phase?: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", reviewerCommandArgs(reviewPrompt), {
      cwd,
      // Mark the child so the project's inherited open-artisan hooks no-op:
      // the reviewer must be transparent to the workflow it is reviewing.
      env: { ...process.env, [REVIEWER_SUBPROCESS_ENV]: "1" },
      // stdin must be closed (not an open, never-written pipe): claude in print
      // mode otherwise waits ~3s for stdin EOF, warns on stderr, and the stall
      // can leave the headless run exiting non-zero with no output.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const idleTimeoutMs = phase === "IMPLEMENTATION" ? IMPLEMENTATION_REVIEW_PROGRESS_IDLE_TIMEOUT_MS : REVIEW_PROGRESS_IDLE_TIMEOUT_MS

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
      if (killTimer) clearTimeout(killTimer)
      idleTimer = null
      hardTimer = null
      killTimer = null
    }
    const terminateOwnedChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, REVIEW_PROGRESS_SHUTDOWN_GRACE_MS)
    }
    const rejectOnce = (message: string) => {
      if (settled) return
      settled = true
      clearTimers()
      terminateOwnedChild()
      reject(new Error(`${message}${stderr.trim() ? ` | stderr: ${stderr.trim()}` : ""}${stdout.trim() ? ` | stdout: ${stdout.trim()}` : ""}`))
    }
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => rejectOnce(`${label} idle timeout after ${idleTimeoutMs}ms`), idleTimeoutMs)
    }

    hardTimer = setTimeout(() => rejectOnce(`${label} hard timeout after ${REVIEW_PROGRESS_HARD_TIMEOUT_MS}ms`), REVIEW_PROGRESS_HARD_TIMEOUT_MS)
    armIdleTimer()
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8")
      armIdleTimer()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8")
      armIdleTimer()
    })
    child.on("error", (error) => rejectOnce(`${label} failed to start: ${error.message}`))
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimers()
      // Reviewer runs in stream-json: pull the verdict out of the terminal
      // result event so callers receive the same clean JSON they did under
      // plain --print. A missing/error result event is a failed review.
      const parsed = extractStreamJsonResult(stdout)
      if (!parsed.ok) {
        const detail = parsed.detail ? ` | ${parsed.detail}` : ""
        resolve({ stdout: parsed.text, stderr: `${stderr}${detail}`.trim(), exitCode: code && code !== 0 ? code : 1 })
        return
      }
      resolve({ stdout: parsed.text, stderr, exitCode: 0 })
    })
  })
}

// ---------------------------------------------------------------------------
// Explicit review dispatch (invoked by `./artisan run-review`)
//
// These run the isolated reviewer and submit its verdict via the one-time token.
// They are called EXPLICITLY by the agent (a visible, awaited Bash command) rather
// than fired invisibly by the Stop hook on turn-end — which was fragile (no dispatch
// + no notification when the turn didn't end the way the hook expected). The Stop
// hook now only nudges the agent to run this. Isolation is unchanged: still a fresh
// marker-isolated `claude`, token-submitted.
// ---------------------------------------------------------------------------

export interface ReviewDispatchResult {
  ok: boolean
  message: string
}

/** Dispatch the pending PHASE review for a session at <phase>/REVIEW. */
export async function dispatchOwnedPhaseReview(
  stateDir: string,
  sessionId: string,
  projectDir: string,
  phase?: unknown,
): Promise<ReviewDispatchResult> {
  const reviewPrompt = await bridgeCall(stateDir, "task.getPhaseReviewContext", { sessionId })
  if (!reviewPrompt || typeof reviewPrompt !== "string") {
    return { ok: false, message: "No phase-review context available — is the session at a <phase>/REVIEW with a submitted artifact?" }
  }
  const reviewToken = extractReviewToken(reviewPrompt)
  try {
    const result = await runOwnedReviewerCommand(reviewPrompt, projectDir, "phase-review", phase)
    if (result.exitCode !== 0) throw new Error(`reviewer command exited with code ${result.exitCode}${result.stderr.trim() ? ` | stderr: ${result.stderr.trim()}` : ""}`)
    const submitResult = await bridgeCall(stateDir, "tool.execute", {
      name: "submit_phase_review",
      args: { review_output: result.stdout, review_token: reviewToken },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    if (typeof submitResult === "string" && submitResult.startsWith("Error:")) throw new Error(submitResult)
    const nextState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
    if (nextState?.phaseState === "REVIEW") throw new Error("Phase review submission did not advance the workflow out of REVIEW")
    return { ok: true, message: `Phase review completed. Now at ${nextState?.phase ?? "?"}/${nextState?.phaseState ?? "?"}.` }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await bridgeCall(stateDir, "tool.execute", {
      name: "submit_phase_review",
      args: { review_token: reviewToken, review_error: errMsg, review_exit_code: 1 },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    return { ok: false, message: `Phase review failed and was recorded: ${errMsg}` }
  }
}

/** Dispatch the pending per-task review for a session with taskCompletionInProgress set. */
export async function dispatchOwnedTaskReview(
  stateDir: string,
  sessionId: string,
  projectDir: string,
): Promise<ReviewDispatchResult> {
  const reviewPrompt = await bridgeCall(stateDir, "task.getReviewContext", { sessionId })
  if (!reviewPrompt || typeof reviewPrompt !== "string") {
    return { ok: false, message: "No task-review context available — is a task awaiting review (taskCompletionInProgress)?" }
  }
  const reviewToken = extractReviewToken(reviewPrompt)
  try {
    const result = await runOwnedReviewerCommand(reviewPrompt, projectDir, "task-review")
    if (result.exitCode !== 0) throw new Error(`reviewer command exited with code ${result.exitCode}${result.stderr.trim() ? ` | stderr: ${result.stderr.trim()}` : ""}`)
    await bridgeCall(stateDir, "tool.execute", {
      name: "submit_task_review",
      args: { review_output: result.stdout, review_token: reviewToken },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    const newState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
    if (newState?.taskCompletionInProgress) {
      return { ok: false, message: "Per-task review is still pending (parse failed or revisions requested). Address feedback or re-run ./artisan run-review." }
    }
    return { ok: true, message: "Per-task review completed. Continue with the next implementation task." }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await bridgeCall(stateDir, "tool.execute", {
      name: "submit_task_review",
      args: {
        review_token: reviewToken,
        review_output: JSON.stringify({ passed: false, issues: [`Review dispatch failed: ${errMsg}`], scores: { code_quality: 0, error_handling: 0 }, reasoning: "Reviewer subprocess failed; task reverted to pending." }),
      },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    return { ok: false, message: `Per-task review dispatch failed — task reverted to pending: ${errMsg}` }
  }
}

// ---------------------------------------------------------------------------
// PreToolUse handler
// ---------------------------------------------------------------------------

/**
 * PreToolUse: Enforces the tool guard on every tool call.
 *
 * - If disabled: allow all (exit 0)
 * - If server unavailable: fail closed for write-like tools, allow read-only tools
 * - If Bash tool with `artisan` command: always allow (workflow commands bypass guard)
 * - Otherwise: call guard.check, block if not allowed
 */
export async function handlePreToolUse(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: never gate its tool calls.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const toolName = input.tool_name ?? ""
  const toolInput = input.tool_input ?? {}

  // Pure artisan CLI invocations are workflow commands — always allow.
  // Compound shell commands must go through guard.check so they cannot hide
  // writes before or around an artisan invocation.
  if (toolName.toLowerCase() === "bash") {
    const command = (toolInput.command ?? toolInput.cmd ?? "") as string
    if (isPureArtisanCommand(command)) {
      return ALLOW
    }
  }

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)

  // Ensure the session is registered (idempotent — handles mid-session enable).
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  const result = await bridgeCall(stateDir, "guard.check", {
    toolName,
    args: toolInput,
    sessionId,
  })

  if (!result) return bridgeUnavailableDecision(toolName, toolInput) // Server unavailable — fail closed for writes

  const guard = result as { allowed: boolean; reason?: string; phase?: string; phaseState?: string }
  if (guard.allowed) {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          additionalContext: `[Workflow: ${guard.phase ?? "?"}/${guard.phaseState ?? "?"}]`,
        },
      }),
      stderr: null,
      exitCode: 0,
    }
  }

  // Blocked — exit 2 with reason on stderr
  return {
    stdout: null,
    stderr: guard.reason ?? `Tool "${toolName}" is blocked by the workflow guard.`,
    exitCode: 2,
  }
}

// ---------------------------------------------------------------------------
// Stop handler
// ---------------------------------------------------------------------------

/**
 * Stop: Re-prompts idle agents.
 *
 * - If disabled or server unavailable: allow stop (exit 0)
 * - reprompt/escalate: exit 2 with message on stderr (prevents stop)
 * - ignore: exit 0 (Claude stops normally)
 */
export async function handleStop(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: must stop cleanly. If its own Stop hook
  // reprompted (exit 2), the headless `claude --print` reviewer cannot continue
  // and exits non-zero, which the parent records as a failed review dispatch.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)

  // Ensure session exists (handles mid-session enable).
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  // When the agent stops at USER_GATE, the next interaction will be from the
  // user. Set userGateMessageReceived so submit_feedback becomes allowed.
  // (No-op if not at USER_GATE — processUserMessage only intercepts at gates.)
  await bridgeCall(stateDir, "message.process", {
    sessionId,
    source: "synthetic",
    parts: [{ type: "text", text: "(agent stopped — next message is from user)" }],
  })

  // Prevent infinite re-prompt loops
  if (input.stop_hook_active) return ALLOW

  // -----------------------------------------------------------------------
  // Per-task isolated review: if taskCompletionInProgress is set, the agent
  // just completed a task and review is pending. Dispatch an isolated
  // reviewer subprocess (claude --print) — the agent never touches the
  // review, ensuring no context pollution.
  // -----------------------------------------------------------------------
  const state = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
  // Per-task review pending: nudge the agent to dispatch it explicitly via
  // `./artisan run-review` (visible + awaited) rather than dispatching invisibly here.
  if (state?.taskCompletionInProgress) {
    return {
      stdout: null,
      stderr: "A completed task is awaiting review. Run `./artisan run-review` to dispatch the isolated per-task reviewer — it runs the review, submits the verdict, and prints the result. Do not proceed until it passes.",
      exitCode: 2,
    }
  }

  // Phase review pending: nudge the agent to dispatch it explicitly via
  // `./artisan run-review` (a visible, awaited Bash command) rather than dispatching
  // invisibly here on turn-end — which silently stalled when the turn didn't end the
  // way the hook expected, with no result and no notification.
  if (state?.phaseState === "REVIEW") {
    return {
      stdout: null,
      stderr: `At ${state.phase}/REVIEW. Run \`./artisan run-review\` to dispatch the isolated reviewer — it runs the review, submits the verdict, and prints whether the phase passed (→ USER_GATE) or needs revision (→ REVISE). Do not approve or proceed until it has run.`,
      exitCode: 2,
    }
  }

  // -----------------------------------------------------------------------
  // Robot-artisan auto-approval: when at USER_GATE with activeAgent
  // "robot-artisan", dispatch an isolated auto-approver subprocess instead
  // of waiting for human input.
  // -----------------------------------------------------------------------
  if (state?.phaseState === "USER_GATE" && state?.activeAgent === "robot-artisan") {
    const approvePrompt = await bridgeCall(stateDir, "task.getAutoApproveContext", { sessionId })
    if (approvePrompt && typeof approvePrompt === "string") {
      const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
      const autoApproveToken = extractReviewToken(approvePrompt)
      if (!autoApproveToken) return ALLOW
      try {
        const result = await runOwnedReviewerCommand(approvePrompt, projectDir, "auto-approve")
        if (result.exitCode !== 0) throw new Error(`auto-approval command exited with code ${result.exitCode}${result.stderr.trim() ? ` | stderr: ${result.stderr.trim()}` : ""}`)
        const approveOutput = result.stdout
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_auto_approve",
          args: { review_output: approveOutput, review_token: autoApproveToken },
          context: { sessionId, directory: projectDir, invocation: "auto-approver" },
        })
        return {
          stdout: null,
          stderr: "Robot-artisan auto-approval completed. Continue with the workflow.",
          exitCode: 2,
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const failureOutput = JSON.stringify({
          approve: false,
          confidence: 0,
          reasoning: `Auto-approval subprocess failed: ${errMsg}`,
          feedback: buildRobotArtisanAutoApproveFailureFeedback(errMsg),
        })
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_auto_approve",
          args: { review_output: failureOutput, review_token: autoApproveToken },
          context: { sessionId, directory: projectDir, invocation: "auto-approver" },
        })
        return {
          stdout: null,
          stderr: "Robot-artisan auto-approval failed and was routed back to revision work. Continue autonomously.",
          exitCode: 2,
        }
      }
    }
  }

  const result = await bridgeCall(stateDir, "idle.check", { sessionId })

  if (!result) return ALLOW

  const idle = result as { action: string; message?: string }
  if (idle.action === "reprompt" || idle.action === "escalate") {
    return {
      stdout: null,
      stderr: idle.message ?? "Continue working on the current workflow task.",
      exitCode: 2,
    }
  }

  return ALLOW
}

// ---------------------------------------------------------------------------
// SessionStart handler
// ---------------------------------------------------------------------------

/**
 * SessionStart: Registers session and injects workflow prompt.
 *
 * - If disabled: no injection (exit 0)
 * - Registers session with the bridge
 * - Writes session_id to .active-session
 * - Returns workflow system prompt as additional context
 * - On "compact" source: re-injects state context
 */
export async function handleSessionStart(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: inject nothing (no context pollution) and,
  // critically, do NOT persist its throwaway session id as the active session —
  // doing so would clobber the authoring session's `.active-session` pointer and
  // make `artisan state` resolve the wrong (empty) session.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = input.session_id ?? "default"

  // Write session_id to .active-session for CLI to read
  persistActiveSessionId(stateDir, sessionId)

  // Register session with the bridge (no-op if already registered)
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  // On resume: user sent a message. If at USER_GATE, mark that the user has
  // responded so submit_feedback becomes allowed (structural gate enforcement).
  if (input.source === "resume") {
    await bridgeCall(stateDir, "message.process", {
      sessionId,
      parts: [{ type: "text", text: "(user resumed session)" }],
    })
  }

  // Build the workflow system prompt
  const prompt = await bridgeCall(stateDir, "prompt.build", { sessionId })
  if (!prompt || typeof prompt !== "string") return ALLOW

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: prompt,
      },
    }),
    stderr: null,
    exitCode: 0,
  }
}

// ---------------------------------------------------------------------------
// UserPromptSubmit handler
// ---------------------------------------------------------------------------

/**
 * UserPromptSubmit: relays the user's submitted prompt to the bridge as a
 * NON-synthetic message.
 *
 * This is the structural "a human responded" signal. At a workflow gate
 * (e.g. PLANNING/USER_GATE) the bridge flips `userGateMessageReceived` only for
 * a non-synthetic message (message.ts), which is what unblocks `submit_feedback`.
 * The Stop hook's message is synthetic and the SessionStart=resume relay only
 * fires on an actual session resume — so without this hook a continuous Claude
 * Code session never delivers user input to the bridge and NO USER_GATE can be
 * passed (neither approve nor revise). It also captures the intent baseline from
 * the first user message. We never alter the prompt (exit 0, no injection).
 */
export async function handleUserPromptSubmit(input: HookInput): Promise<HookOutput> {
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)
  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  await bridgeCall(stateDir, "message.process", {
    sessionId,
    parts: [{ type: "text", text: input.prompt ?? "" }],
  })

  return ALLOW
}

// ---------------------------------------------------------------------------
// PreCompact handler
// ---------------------------------------------------------------------------

/**
 * PreCompact: Preserves workflow state through context compression.
 *
 * - If disabled: no injection (exit 0)
 * - Returns compaction context as additional context
 */
export async function handlePreCompact(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: inject nothing and don't clobber active-session.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)
  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)
  const context = await bridgeCall(stateDir, "prompt.compaction", { sessionId })
  if (!context || typeof context !== "string") return ALLOW

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: context,
      },
    }),
    stderr: null,
    exitCode: 0,
  }
}

// ---------------------------------------------------------------------------
// PostToolUse handler
// ---------------------------------------------------------------------------

/**
 * PostToolUse: Logging only. Always exits 0.
 */
export async function handlePostToolUse(_input: HookInput): Promise<HookOutput> {
  return ALLOW
}
