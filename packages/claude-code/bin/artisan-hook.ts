#!/usr/bin/env bun
/**
 * artisan-hook.ts — Thin CLI for Claude Code hook scripts.
 *
 * Reads hook input from stdin, dispatches to the appropriate handler,
 * writes output to stdout/stderr, and exits with the correct code.
 *
 * Usage (in .claude/settings.json):
 *   "PreToolUse": [{ "hooks": [{ "type": "command", "command": "bun run .../artisan-hook.ts pre-tool-use" }] }]
 *   "Stop": [{ "hooks": [{ "type": "command", "command": "bun run .../artisan-hook.ts stop" }] }]
 *   "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun run .../artisan-hook.ts session-start" }] }]
 *   "PreCompact": [{ "hooks": [{ "type": "command", "command": "bun run .../artisan-hook.ts pre-compact" }] }]
 *   "PostToolUse": [{ "hooks": [{ "type": "command", "command": "bun run .../artisan-hook.ts post-tool-use" }] }]
 */

import {
  handlePreToolUse,
  handleStop,
  handleSessionStart,
  handleUserPromptSubmit,
  handlePreCompact,
  handlePostToolUse,
  isWriteLikeTool,
  type HookInput,
} from "#claude-code/src/hook-handlers"

// ---------------------------------------------------------------------------
// Read hook input from stdin
// ---------------------------------------------------------------------------

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim()
  if (!text) return {}
  try {
    return JSON.parse(text) as HookInput
  } catch {
    return {} // Malformed input — treat as empty (handlers use defaults)
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, (input: HookInput) => Promise<import("#claude-code/src/hook-handlers").HookOutput>> = {
  "pre-tool-use": handlePreToolUse,
  "stop": handleStop,
  "session-start": handleSessionStart,
  "user-prompt-submit": handleUserPromptSubmit,
  "pre-compact": handlePreCompact,
  "post-tool-use": handlePostToolUse,
}

async function main() {
  const command = process.argv[2]
  if (!command || !HANDLERS[command]) {
    // Unknown hook — exit 0 (allow) to avoid blocking Claude
    process.exit(0)
  }

  const input = await readStdin()
  const handler = HANDLERS[command]!
  let output: import("#claude-code/src/hook-handlers").HookOutput
  try {
    output = await handler(input)
  } catch (err) {
    process.stderr.write(`[artisan-hook] Error: ${err instanceof Error ? err.message : String(err)}\n`)
    if (command === "pre-tool-use" && isWriteLikeTool(input.tool_name ?? "", input.tool_input ?? {})) {
      process.stderr.write("Open Artisan hook failed while checking a write-like tool call. Blocking to preserve workflow safety.\n")
      process.exit(2)
    }
    process.exit(0)
  }

  if (output.stdout) process.stdout.write(output.stdout + "\n")
  if (output.stderr) process.stderr.write(output.stderr + "\n")
  process.exit(output.exitCode)
}

main().catch((err) => {
  // Startup/read errors cannot reliably be attributed to a tool call. Log and
  // allow rather than blocking all Claude activity.
  process.stderr.write(`[artisan-hook] Error: ${err?.message ?? err}\n`)
  process.exit(0)
})
