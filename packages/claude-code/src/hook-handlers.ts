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

  // Prevent infinite re-prompt loops
  if (input.stop_hook_active) return ALLOW

  const sessionId = getSessionId(stateDir)
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
