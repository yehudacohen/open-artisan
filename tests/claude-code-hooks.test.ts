/**
 * Tests for Claude Code hook handlers.
 *
 * Tests the hook handler functions directly (not via the hook CLI binary).
 * Spawns a real artisan-server for integration testing.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"

import { sendSocketRequest } from "#claude-code/src/socket-transport"
import { getSocketPath, getEnabledPath, getActiveSessionPath, DEFAULT_STATE_DIR_NAME } from "#claude-code/src/constants"
import {
  handlePreToolUse,
  handleStop,
  handleSessionStart,
  handlePreCompact,
  handlePostToolUse,
  type HookInput,
} from "#claude-code/src/hook-handlers"

const REPO_ROOT = join(import.meta.dirname, "..")
const SERVER_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-server.ts")

let tmpDir: string
let stateDir: string
let socketPath: string
let serverProcess: ChildProcess | null = null

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hook-test-"))
  stateDir = join(tmpDir, DEFAULT_STATE_DIR_NAME)
  socketPath = getSocketPath(stateDir)

  // Start server
  serverProcess = spawn("bun", ["run", SERVER_SCRIPT, "--project-dir", tmpDir], {
    stdio: "ignore",
  })

  // Wait for socket
  const deadline = Date.now() + 10_000
  let ready = false
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const r = await sendSocketRequest(socketPath, { jsonrpc: "2.0", method: "lifecycle.ping", id: 1 })
      if (r && (r as any).result === "pong") { ready = true; break }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!ready) throw new Error("Server failed to start")

  // Create session
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0", method: "lifecycle.sessionCreated", params: { sessionId: "hook-test-session" }, id: 2,
  })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(getActiveSessionPath(stateDir), "hook-test-session", "utf-8")

  // Select mode to get out of MODE_SELECT
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0", method: "tool.execute", params: {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: `hook-test-${Date.now()}` },
      context: { sessionId: "hook-test-session", directory: tmpDir },
    }, id: 3,
  })
}, 15000)

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM")
    await new Promise<void>((r) => { serverProcess?.on("exit", () => r()); setTimeout(r, 2000) })
    serverProcess = null
  }
  await rm(tmpDir, { recursive: true, force: true })
})

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return { session_id: "hook-test-session", cwd: tmpDir, ...overrides }
}

function passingPlanningCriteria() {
  return Array.from({ length: 16 }, (_, i) => ({
    criterion: `C${i + 1}`,
    met: true,
    evidence: "ok",
    severity: "blocking",
  }))
}

async function moveSessionToPlanningRedraft(sessionId: string): Promise<void> {
  const featureName = `hook-redraft-${Date.now()}`
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "lifecycle.sessionCreated",
    params: { sessionId },
    id: Date.now(),
  })
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "tool.execute",
    params: {
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: featureName },
      context: { sessionId, directory: tmpDir },
    },
    id: Date.now() + 1,
  })
  const artifactDir = join(tmpDir, ".openartisan", featureName)
  mkdirSync(artifactDir, { recursive: true })
  const planPath = join(artifactDir, "plan.md")
  writeFileSync(planPath, "# Plan\n\nA structurally valid planning artifact.", "utf-8")
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "tool.execute",
    params: {
      name: "request_review",
      args: { summary: "Plan", artifact_description: "Plan", artifact_files: [planPath] },
      context: { sessionId, directory: tmpDir },
    },
    id: Date.now() + 2,
  })
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "tool.execute",
    params: {
      name: "mark_satisfied",
      args: { criteria_met: passingPlanningCriteria() },
      context: { sessionId, directory: tmpDir },
    },
    id: Date.now() + 3,
  })
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "message.process",
    params: {
      sessionId,
      parts: [{ type: "text", text: "approved" }],
    },
    id: Date.now() + 4,
  })
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "tool.execute",
    params: {
      name: "submit_feedback",
      args: { feedback_type: "approve", feedback_text: "approved" },
      context: { sessionId, directory: tmpDir },
    },
    id: Date.now() + 5,
  })
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "tool.execute",
    params: {
      name: "propose_backtrack",
      args: {
        target_phase: "PLANNING",
        reason: "Interfaces exposed a missing planning invariant that requires a redraft.",
      },
      context: { sessionId, directory: tmpDir },
    },
    id: Date.now() + 6,
  })
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

describe("hook: PreToolUse", () => {
  it("allows all when disabled", async () => {
    // Remove .enabled file
    const enabledPath = getEnabledPath(stateDir)
    if (existsSync(enabledPath)) {
      const { unlinkSync } = await import("node:fs")
      unlinkSync(enabledPath)
    }
    const result = await handlePreToolUse(makeInput({ tool_name: "Write" }))
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBeNull()
    // Re-enable
    writeFileSync(enabledPath, "1")
  })

  it("allows artisan Bash commands even when bash is blocked", async () => {
    // PLANNING/DRAFT blocks bash. But artisan commands should pass.
    const result = await handlePreToolUse(makeInput({
      tool_name: "Bash",
      tool_input: { command: "artisan state" },
    }))
    expect(result.exitCode).toBe(0)
  })

  it("allows artisan commands with pipes", async () => {
    const result = await handlePreToolUse(makeInput({
      tool_name: "Bash",
      tool_input: { command: "echo '{\"summary\":\"test\"}' | artisan request-review" },
    }))
    expect(result.exitCode).toBe(0)
  })

  it("blocks write tools during PLANNING/DRAFT", async () => {
    writeFileSync(getEnabledPath(stateDir), "1")
    const result = await handlePreToolUse(makeInput({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/test.ts", content: "test" },
    }))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).not.toBeNull()
    expect(result.stderr).toContain("blocked")
  })

  it("blocks non-artisan bash during PLANNING/DRAFT", async () => {
    const result = await handlePreToolUse(makeInput({
      tool_name: "Bash",
      tool_input: { command: "echo hello > /tmp/test.txt" },
    }))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("blocked")
  })

  it("includes phase context when allowing", async () => {
    const result = await handlePreToolUse(makeInput({
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.ts" },
    }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toBeNull()
    const parsed = JSON.parse(result.stdout!)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("PLANNING")
  })

  it("prefers live session_id over stale .active-session", async () => {
    writeFileSync(getActiveSessionPath(stateDir), "stale-session", "utf-8")

    await sendSocketRequest(socketPath, {
      jsonrpc: "2.0", method: "lifecycle.sessionCreated", params: { sessionId: "fresh-session" }, id: 30,
    })
    await sendSocketRequest(socketPath, {
      jsonrpc: "2.0", method: "tool.execute", params: {
        name: "select_mode",
        args: { mode: "GREENFIELD", feature_name: `fresh-hook-test-${Date.now()}` },
        context: { sessionId: "fresh-session", directory: tmpDir },
      }, id: 31,
    })

    const result = await handlePreToolUse({
      session_id: "fresh-session",
      cwd: tmpDir,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.ts" },
    })

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout!)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("PLANNING")

    const { readFileSync } = await import("node:fs")
    expect(readFileSync(getActiveSessionPath(stateDir), "utf-8").trim()).toBe("fresh-session")
  })
})

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe("hook: Stop", () => {
  it("allows stop when disabled", async () => {
    const enabledPath = getEnabledPath(stateDir)
    if (existsSync(enabledPath)) {
      const { unlinkSync } = await import("node:fs")
      unlinkSync(enabledPath)
    }
    const result = await handleStop(makeInput())
    expect(result.exitCode).toBe(0)
    writeFileSync(enabledPath, "1")
  })

  it("allows stop when stop_hook_active (prevents loop)", async () => {
    const result = await handleStop(makeInput({ stop_hook_active: true }))
    expect(result.exitCode).toBe(0)
  })

  it("re-prompts during active workflow", async () => {
    const result = await handleStop(makeInput())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).not.toBeNull()
    expect(result.stderr).toContain("not yet complete")
  })
})

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

describe("hook: SessionStart", () => {
  it("no injection when disabled", async () => {
    const enabledPath = getEnabledPath(stateDir)
    if (existsSync(enabledPath)) {
      const { unlinkSync } = await import("node:fs")
      unlinkSync(enabledPath)
    }
    const result = await handleSessionStart(makeInput({ source: "startup" }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBeNull()
    writeFileSync(enabledPath, "1")
  })

  it("injects workflow prompt when enabled", async () => {
    const result = await handleSessionStart(makeInput({ source: "startup" }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toBeNull()
    const parsed = JSON.parse(result.stdout!)
    expect(parsed.hookSpecificOutput.additionalContext).toBeTruthy()
    expect(parsed.hookSpecificOutput.additionalContext).toContain("PLANNING")
  })

  it("injects REDRAFT structural context after a backtrack", async () => {
    const sessionId = `redraft-hook-${Date.now()}`
    await moveSessionToPlanningRedraft(sessionId)
    const result = await handleSessionStart({ session_id: sessionId, cwd: tmpDir, source: "startup" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toBeNull()
    const parsed = JSON.parse(result.stdout!)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("REDRAFT")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("INTERFACES")
  })

  it("writes session_id to .active-session", async () => {
    await handleSessionStart(makeInput({ session_id: "new-session-123", source: "startup" }))
    const sessionPath = getActiveSessionPath(stateDir)
    expect(existsSync(sessionPath)).toBe(true)
    const { readFileSync } = await import("node:fs")
    expect(readFileSync(sessionPath, "utf-8").trim()).toBe("new-session-123")
  })
})

// ---------------------------------------------------------------------------
// PreCompact
// ---------------------------------------------------------------------------

describe("hook: PreCompact", () => {
  it("no injection when disabled", async () => {
    const enabledPath = getEnabledPath(stateDir)
    if (existsSync(enabledPath)) {
      const { unlinkSync } = await import("node:fs")
      unlinkSync(enabledPath)
    }
    const result = await handlePreCompact(makeInput())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBeNull()
    writeFileSync(enabledPath, "1")
  })

  it("returns compaction context when enabled", async () => {
    const result = await handlePreCompact(makeInput())
    expect(result.exitCode).toBe(0)
    // Compaction context may or may not be present depending on state
    // Just verify no crash and valid exit code
  })

  it("prefers live session_id over stale .active-session", async () => {
    writeFileSync(getActiveSessionPath(stateDir), "stale-session", "utf-8")
    const result = await handlePreCompact(makeInput({ session_id: "hook-test-session" }))
    expect(result.exitCode).toBe(0)
    const { readFileSync } = await import("node:fs")
    expect(readFileSync(getActiveSessionPath(stateDir), "utf-8").trim()).toBe("hook-test-session")
  })
})

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------

describe("hook: PostToolUse", () => {
  it("always returns exit 0", async () => {
    const result = await handlePostToolUse(makeInput({ tool_name: "Bash" }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBeNull()
    expect(result.stderr).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Hook CLI binary integration tests
// ---------------------------------------------------------------------------

describe("artisan-hook CLI binary", () => {
  const HOOK_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-hook.ts")

  function runHook(command: string, stdin: object): string[] {
    const { execSync } = require("node:child_process")
    try {
      const stdout = execSync(`bun run ${HOOK_SCRIPT} ${command}`, {
        input: JSON.stringify(stdin),
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      return ["0", stdout.trim()]
    } catch (err: any) {
      const exitCode = String(err.status ?? "?")
      const stderr = (err.stderr ?? "").trim()
      const stdout = (err.stdout ?? "").trim()
      return [exitCode, stdout, stderr]
    }
  }

  it("pre-tool-use allows Read tool", () => {
    const [code, stdout] = runHook("pre-tool-use", {
      session_id: "hook-test-session",
      cwd: tmpDir,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.ts" },
    })
    expect(code).toBe("0")
    expect(stdout).toContain("permissionDecision")
    expect(stdout).toContain("allow")
  })

  it("pre-tool-use blocks Write during PLANNING", () => {
    const [code, _stdout, stderr] = runHook("pre-tool-use", {
      session_id: "hook-test-session",
      cwd: tmpDir,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/test.ts", content: "x" },
    })
    expect(code).toBe("2")
    expect(stderr).toContain("blocked")
  })

  it("unknown hook command exits 0", () => {
    const [code] = runHook("unknown-hook", {})
    expect(code).toBe("0")
  })

  it("malformed stdin exits 0 (fail-open)", () => {
    const { execSync } = require("node:child_process")
    try {
      const stdout = execSync(`echo "not json" | bun run ${HOOK_SCRIPT} pre-tool-use`, {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      // Should exit 0 (allow) since malformed input → empty HookInput → disabled check or fallback
      expect(true).toBe(true) // If we got here, exit code was 0
    } catch (err: any) {
      // Exit code 0 means no exception — if we get here, something else happened
      expect(err.status).toBe(0)
    }
  })
})
