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
import { execFileSync } from "node:child_process"
import { buildRobotArtisanAutoApproveFailureFeedback } from "#core/autonomous-user-gate"
import { sendSocketRequest } from "./socket-transport"
import {
  getSocketPath,
  getEnabledPath,
  getActiveSessionPath,
  DEFAULT_STATE_DIR_NAME,
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

function isWriteLikeTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  const normalized = toolName.toLowerCase()
  if (["write", "edit", "multiedit", "notebookedit"].includes(normalized)) return true
  if (normalized !== "bash") return false
  const command = String(toolInput.command ?? toolInput.cmd ?? "")
  return /(?:>>|>[^&]|\btee\b|\bsed\s+-i\b|\bdd\b.*\bof=|<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?|\b(?:python|python3|node|ruby|perl)\b.*\b(?:writeFile|open\s*\(|File\.write|fs\.write|write\s*\())/.test(command)
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
  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const toolName = input.tool_name ?? ""
  const toolInput = input.tool_input ?? {}

  // Pure artisan CLI invocations are workflow commands — always allow.
  // Compound shell commands must go through guard.check so they cannot hide
  // writes before or around an artisan invocation.
  if (toolName.toLowerCase() === "bash") {
    const command = (toolInput.command ?? toolInput.cmd ?? "") as string
    const trimmed = command.trim()
    if (!/[\r\n]/.test(trimmed) && /^(?:(?:bun\s+run\s+\S*artisan(?:\.ts)?)|\.\/artisan|artisan)(?:\s|$)[^|;&<>]*$/.test(trimmed)) {
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
  if (state?.taskCompletionInProgress) {
    // Double-dispatch guard: re-check state immediately before spawning.
    // The stop_hook_active check at the top prevents hook re-entry during
    // the subprocess wait, but verify taskCompletionInProgress hasn't been
    // cleared by a concurrent submit_task_review call.
    const freshState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
    if (!freshState?.taskCompletionInProgress) {
      // Gate was cleared between the two reads — skip dispatch
      return {
        stdout: null,
        stderr: "Per-task review completed. Continue with the next implementation task.",
        exitCode: 2,
      }
    }

    const reviewPrompt = await bridgeCall(stateDir, "task.getReviewContext", { sessionId })
    if (reviewPrompt && typeof reviewPrompt === "string") {
      const reviewToken = extractReviewToken(reviewPrompt)
      const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
      try {
        // Spawn isolated reviewer — fresh Claude session with no conversation history.
        // Omit --model so it inherits the user's default (parent) model.
        const reviewOutput = execFileSync("claude", ["--print", "--max-turns", "1", "-p", reviewPrompt], {
          timeout: 180_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
        // Submit review results to bridge
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_task_review",
          args: { review_output: reviewOutput, review_token: reviewToken },
          context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
        })
        // Re-check state to see if review passed or failed
        const newState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
        if (newState?.taskCompletionInProgress) {
          // Still pending — review parse failed or requested revisions.
          return {
            stdout: null,
            stderr: "Per-task review is still pending. Stop and let the adapter request a fresh isolated review context.",
            exitCode: 2,
          }
        }
        // Review completed — tell agent to continue
        return {
          stdout: null,
          stderr: "Per-task review completed. Continue with the next implementation task.",
          exitCode: 2,
        }
      } catch (err) {
        // claude CLI not available or timed out — graceful degradation:
        // submit a passing review to clear the gate. The full implementation
        // review at the end will catch any issues this would have found.
        const errMsg = err instanceof Error ? err.message : String(err)
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_task_review",
          args: {
            review_token: reviewToken,
            review_output: JSON.stringify({
              passed: false,
              issues: [`Review dispatch failed: ${errMsg}`],
              scores: { code_quality: 0, error_handling: 0 },
              reasoning: "Graceful degradation: reviewer subprocess failed. Task reverted to pending — full implementation review will catch issues.",
            }),
          },
          context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
        })
        return {
          stdout: null,
          stderr: "Per-task review dispatch failed — task reverted to pending. The reviewer subprocess was unavailable. Fix any issues and call mark_task_complete again.",
          exitCode: 2,
        }
      }
    }
  }

  // Phase-level isolated review: Claude Code exposes workflow tools to the
  // authoring agent, so REVIEW must be completed by an isolated subprocess that
  // submits submit_phase_review rather than by author-callable mark_satisfied.
  if (state?.phaseState === "REVIEW") {
    const reviewPrompt = await bridgeCall(stateDir, "task.getPhaseReviewContext", { sessionId })
    if (reviewPrompt && typeof reviewPrompt === "string") {
      const reviewToken = extractReviewToken(reviewPrompt)
      const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
      try {
        const reviewOutput = execFileSync("claude", ["--print", "--max-turns", "1", "-p", reviewPrompt], {
          timeout: 300_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
        const submitResult = await bridgeCall(stateDir, "tool.execute", {
          name: "submit_phase_review",
          args: { review_output: reviewOutput, review_token: reviewToken },
          context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
        })
        if (typeof submitResult === "string" && submitResult.startsWith("Error:")) {
          throw new Error(submitResult)
        }
        const nextState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
        if (nextState?.phaseState === "REVIEW") {
          throw new Error("Phase review submission did not advance the workflow out of REVIEW")
        }
        return {
          stdout: null,
          stderr: "Phase review completed. Continue with the workflow.",
          exitCode: 2,
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const failureResult = await bridgeCall(stateDir, "tool.execute", {
          name: "submit_phase_review",
          args: {
            review_token: reviewToken,
            review_error: errMsg,
            review_exit_code: 1,
          },
          context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
        })
        if (typeof failureResult === "string" && failureResult.startsWith("Error:")) {
          return {
            stdout: null,
            stderr: `Phase review dispatch failed and could not be recorded: ${failureResult}`,
            exitCode: 2,
          }
        }
        return {
          stdout: null,
          stderr: "Phase review dispatch failed and was recorded as a blocking review failure. Revise the artifact or retry review.",
          exitCode: 2,
        }
      }
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
      try {
        // First set userGateMessageReceived so submit_auto_approve works
        await bridgeCall(stateDir, "message.process", {
          sessionId,
          parts: [{ type: "text", text: "(robot-artisan auto-approval)" }],
        })
        const approveOutput = execFileSync("claude", ["--print", "--max-turns", "1", "-p", approvePrompt], {
          timeout: 120_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_auto_approve",
          args: { review_output: approveOutput },
          context: { sessionId, directory: projectDir },
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
          args: { review_output: failureOutput },
          context: { sessionId, directory: projectDir },
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
// PreCompact handler
// ---------------------------------------------------------------------------

/**
 * PreCompact: Preserves workflow state through context compression.
 *
 * - If disabled: no injection (exit 0)
 * - Returns compaction context as additional context
 */
export async function handlePreCompact(input: HookInput): Promise<HookOutput> {
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
