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
  handlePreCompact,
  handlePostToolUse,
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
  const output = await handler(input)

  if (output.stdout) process.stdout.write(output.stdout + "\n")
  if (output.stderr) process.stderr.write(output.stderr + "\n")
  process.exit(output.exitCode)
}

main().catch((err) => {
  // Log error for debugging, but exit 0 to avoid blocking Claude
  process.stderr.write(`[artisan-hook] Error: ${err?.message ?? err}\n`)
  process.exit(0)
})
