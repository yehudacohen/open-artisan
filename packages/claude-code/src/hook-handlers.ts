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
import { execSync } from "node:child_process"
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

// ---------------------------------------------------------------------------
// PreToolUse handler
// ---------------------------------------------------------------------------

/**
 * PreToolUse: Enforces the tool guard on every tool call.
 *
 * - If disabled or server unavailable: allow all (exit 0)
 * - If Bash tool with `artisan` command: always allow (workflow commands bypass guard)
 * - Otherwise: call guard.check, block if not allowed
 */
export async function handlePreToolUse(input: HookInput): Promise<HookOutput> {
  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const toolName = input.tool_name ?? ""
  const toolInput = input.tool_input ?? {}

  // Bash commands invoking the artisan CLI are workflow commands — always allow.
  // Match: artisan at command position (start of line, after pipe, semicolon, &&, ||)
  // Also matches: echo '...' | artisan ..., bun run .../artisan.ts ...
  if (toolName.toLowerCase() === "bash") {
    const command = (toolInput.command ?? toolInput.cmd ?? "") as string
    if (/(?:^|[|;&]\s*)(?:bun\s+run\s+\S*|\.\/)?artisan\s/m.test(command.trimStart())) {
      return ALLOW
    }
  }

  const sessionId = getSessionId(stateDir)

  // Ensure the session is registered (idempotent — handles mid-session enable).
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  const result = await bridgeCall(stateDir, "guard.check", {
    toolName,
    args: toolInput,
    sessionId,
  })

  if (!result) return ALLOW // Server unavailable — graceful fallback

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

  const sessionId = getSessionId(stateDir)

  // Ensure session exists (handles mid-session enable).
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  // When the agent stops at USER_GATE, the next interaction will be from the
  // user. Set userGateMessageReceived so submit_feedback becomes allowed.
  // (No-op if not at USER_GATE — processUserMessage only intercepts at gates.)
  await bridgeCall(stateDir, "message.process", {
    sessionId,
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
      const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
      try {
        // Spawn isolated reviewer — fresh Claude session with no conversation history.
        // Omit --model so it inherits the user's default (parent) model.
        const reviewOutput = execSync(
          `claude --print --max-turns 1 -p ${JSON.stringify(reviewPrompt)}`,
          { timeout: 180_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        )
        // Submit review results to bridge
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_task_review",
          args: { review_output: reviewOutput },
          context: { sessionId, directory: projectDir },
        })
        // Re-check state to see if review passed or failed
        const newState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
        if (newState?.taskCompletionInProgress) {
          // Still pending — review parse failed, ask agent to handle manually
          return {
            stdout: null,
            stderr: "Per-task review could not be completed automatically. Call submit_task_review manually.",
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
            review_output: JSON.stringify({
              passed: false,
              issues: [`Review dispatch failed: ${errMsg}`],
              scores: { code_quality: 0, error_handling: 0 },
              reasoning: "Graceful degradation: reviewer subprocess failed. Task reverted to pending — full implementation review will catch issues.",
            }),
          },
          context: { sessionId, directory: projectDir },
        })
        return {
          stdout: null,
          stderr: "Per-task review dispatch failed — task reverted to pending. The reviewer subprocess was unavailable. Fix any issues and call mark_task_complete again.",
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
        const approveOutput = execSync(
          `claude --print --max-turns 1 -p ${JSON.stringify(approvePrompt)}`,
          { timeout: 120_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        )
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
        // Auto-approval failed — fall through to normal idle check
        // Agent will see USER_GATE prompt and can present to user
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
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(getActiveSessionPath(stateDir), sessionId, "utf-8")

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

  const sessionId = getSessionId(stateDir)
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
