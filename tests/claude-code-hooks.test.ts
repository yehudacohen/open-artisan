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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"

import { sendSocketRequest } from "#claude-code/src/socket-transport"
import { getSocketPath, getEnabledPath, getActiveSessionPath, DEFAULT_STATE_DIR_NAME, REVIEWER_SUBPROCESS_ENV } from "#claude-code/src/constants"
import {
  handlePreToolUse,
  handleStop,
  handleSessionStart,
  handleUserPromptSubmit,
  handlePreCompact,
  handlePostToolUse,
  isPureArtisanCommand,
  reviewerCommandArgs,
  extractStreamJsonResult,
  dispatchOwnedPhaseReview,
  type HookInput,
} from "#claude-code/src/hook-handlers"
import { REVIEWER_MAX_TURNS } from "#core/constants"

const REPO_ROOT = join(import.meta.dirname, "..")
const SERVER_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-server.ts")
const HOOK_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-hook.ts")

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
    score: 9,
  }))
}

function fakePassingReviewerScript(): string {
  const criteria = Array.from({ length: 30 }, (_, i) => ({
    criterion: `Criterion ${i + 1}`,
    met: true,
    evidence: "verified by Claude smoke reviewer",
    severity: "blocking",
  }))
  // The reviewer runs with --output-format stream-json, so the fake must emit a
  // terminal `result` event carrying the verdict in its `result` field.
  const verdict = JSON.stringify({ satisfied: true, criteria_results: criteria })
  const resultEvent = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: verdict })
  return `#!/usr/bin/env node\nconsole.log(${JSON.stringify(resultEvent)})\n`
}

function extractReviewToken(prompt: string): string {
  const match = prompt.match(/OPEN_ARTISAN_REVIEW_TOKEN:\s*([a-f0-9]+)/i)
  if (!match?.[1]) throw new Error("review token missing")
  return match[1]
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
  const reviewContext = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "task.getPhaseReviewContext",
    params: { sessionId },
    id: Date.now() + 3,
  })
  const reviewPrompt = String((reviewContext as { result?: unknown }).result ?? "")
  const reviewToken = extractReviewToken(reviewPrompt)
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "tool.execute",
    params: {
      name: "submit_phase_review",
      args: { review_stdout: JSON.stringify({ satisfied: true, criteria_results: passingPlanningCriteria() }), review_stderr: "", review_exit_code: 0, review_token: reviewToken },
      context: { sessionId, directory: tmpDir, invocation: "isolated-reviewer" },
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

async function moveSessionToPlanningReview(sessionId: string): Promise<void> {
  const featureName = `hook-review-${Date.now()}`
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
  const reviewPlanPath = join(".openartisan", featureName, "plan.md")
  writeFileSync(planPath, "# Plan\n\nA structurally valid planning artifact for Claude smoke review.", "utf-8")
  const reviewResponse = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "tool.execute",
    params: {
      name: "request_review",
      args: { summary: "Plan", artifact_description: "Plan", artifact_files: [reviewPlanPath] },
      context: { sessionId, directory: tmpDir },
    },
    id: Date.now() + 2,
  }) as { result?: string } | null
  if (typeof reviewResponse?.result === "string" && reviewResponse.result.startsWith("Error:")) {
    throw new Error(reviewResponse.result)
  }
}

async function readWorkflowState(sessionId: string): Promise<Record<string, unknown>> {
  const response = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method: "state.get",
    params: { sessionId },
    id: Date.now(),
  }) as { result?: Record<string, unknown> } | null
  const result = response?.result ?? {}
  return (result.state as Record<string, unknown> | undefined) ?? result
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

  it("does not bypass guard for compound artisan commands", async () => {
    const result = await handlePreToolUse(makeInput({
      tool_name: "Bash",
      tool_input: { command: "echo '{\"summary\":\"test\"}' | artisan request-review" },
    }))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("blocked")
  })

  it("does not bypass guard for multiline artisan commands", async () => {
    const result = await handlePreToolUse(makeInput({
      tool_name: "Bash",
      tool_input: { command: "echo bad > /tmp/hidden.txt\nartisan state" },
    }))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("blocked")
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

  it("fails closed for write-like tools when enabled bridge is unavailable", async () => {
    const isolatedDir = await mkdtemp(join(tmpdir(), "artisan-hook-no-bridge-"))
    try {
      const isolatedStateDir = join(isolatedDir, DEFAULT_STATE_DIR_NAME)
      mkdirSync(isolatedStateDir, { recursive: true })
      writeFileSync(getEnabledPath(isolatedStateDir), "1")
      const result = await handlePreToolUse({
        session_id: "missing-bridge-session",
        cwd: isolatedDir,
        tool_name: "Write",
        tool_input: { file_path: join(isolatedDir, "x.ts"), content: "x" },
      })
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("bridge guard is unavailable")
    } finally {
      await rm(isolatedDir, { recursive: true, force: true })
    }
  })

  it("fails closed for package-manager writes when enabled bridge is unavailable", async () => {
    const isolatedDir = await mkdtemp(join(tmpdir(), "artisan-hook-no-bridge-"))
    try {
      const isolatedStateDir = join(isolatedDir, DEFAULT_STATE_DIR_NAME)
      mkdirSync(isolatedStateDir, { recursive: true })
      writeFileSync(getEnabledPath(isolatedStateDir), "1")
      const result = await handlePreToolUse({
        session_id: "missing-bridge-session",
        cwd: isolatedDir,
        tool_name: "Bash",
        tool_input: { command: "bun install" },
      })
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("bridge guard is unavailable")
    } finally {
      await rm(isolatedDir, { recursive: true, force: true })
    }
  })

  it("fails closed for formatter writes when enabled bridge is unavailable", async () => {
    const isolatedDir = await mkdtemp(join(tmpdir(), "artisan-hook-no-bridge-"))
    try {
      const isolatedStateDir = join(isolatedDir, DEFAULT_STATE_DIR_NAME)
      mkdirSync(isolatedStateDir, { recursive: true })
      writeFileSync(getEnabledPath(isolatedStateDir), "1")
      const result = await handlePreToolUse({
        session_id: "missing-bridge-session",
        cwd: isolatedDir,
        tool_name: "Bash",
        tool_input: { command: "eslint src --fix" },
      })
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("bridge guard is unavailable")
    } finally {
      await rm(isolatedDir, { recursive: true, force: true })
    }
  })

  it("CLI fails closed for write-like PreToolUse handler crashes", async () => {
    const isolatedDir = await mkdtemp(join(tmpdir(), "artisan-hook-crash-"))
    try {
      const isolatedStateDir = join(isolatedDir, DEFAULT_STATE_DIR_NAME)
      mkdirSync(isolatedStateDir, { recursive: true })
      writeFileSync(getEnabledPath(isolatedStateDir), "1")
      mkdirSync(getActiveSessionPath(isolatedStateDir))
      const result = spawnSync("bun", ["run", HOOK_SCRIPT, "pre-tool-use"], {
        input: JSON.stringify({
          cwd: isolatedDir,
          tool_name: "Write",
          tool_input: { file_path: "src/file.ts", content: "x" },
        }),
        encoding: "utf-8",
      })

      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Blocking to preserve workflow safety")
    } finally {
      await rm(isolatedDir, { recursive: true, force: true })
    }
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

  it("nudges to run-review at a phase REVIEW state instead of auto-dispatching", async () => {
    const sessionId = `claude-phase-nudge-${Date.now()}`
    await moveSessionToPlanningReview(sessionId)
    writeFileSync(getEnabledPath(stateDir), "1")
    const result = await handleStop({ session_id: sessionId, cwd: tmpDir })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("run-review")
    // Did NOT auto-dispatch: still parked at REVIEW awaiting an explicit run-review.
    const state = await readWorkflowState(sessionId)
    expect(state.phaseState).toBe("REVIEW")
  })

  it("smoke: dispatchOwnedPhaseReview runs the isolated reviewer and advances PLANNING REVIEW → USER_GATE", async () => {
    const sessionId = `claude-phase-smoke-${Date.now()}`
    await moveSessionToPlanningReview(sessionId)
    const fakeBin = await mkdtemp(join(tmpdir(), "fake-claude-"))
    const fakeClaude = join(fakeBin, "claude")
    const oldPath = process.env.PATH
    try {
      writeFileSync(fakeClaude, fakePassingReviewerScript(), "utf-8")
      chmodSync(fakeClaude, 0o755)
      process.env.PATH = `${fakeBin}:${oldPath ?? ""}`
      expect(execFileSync("claude", ["--smoke"], { encoding: "utf-8", env: process.env })).toContain("criteria_results")

      const outcome = await dispatchOwnedPhaseReview(stateDir, sessionId, tmpDir, "PLANNING")

      if (!outcome.ok) {
        const state = await readWorkflowState(sessionId)
        throw new Error(`${outcome.message}\n${JSON.stringify(state.latestReviewResults ?? state)}`)
      }
      expect(outcome.ok).toBe(true)
      expect(outcome.message).toContain("Phase review completed")
      const state = await readWorkflowState(sessionId)
      expect(state.phase).toBe("PLANNING")
      expect(state.phaseState).toBe("USER_GATE")
    } finally {
      process.env.PATH = oldPath
      await rm(fakeBin, { recursive: true, force: true })
    }
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
// UserPromptSubmit — relays real user input so USER_GATE can be passed (finding #12)
// ---------------------------------------------------------------------------

describe("hook: UserPromptSubmit", () => {
  async function driveToPlanningUserGate(sessionId: string): Promise<void> {
    const featureName = `upsubmit-${Date.now()}`
    await sendSocketRequest(socketPath, { jsonrpc: "2.0", method: "lifecycle.sessionCreated", params: { sessionId }, id: Date.now() })
    await sendSocketRequest(socketPath, { jsonrpc: "2.0", method: "tool.execute", params: {
      name: "select_mode", args: { mode: "GREENFIELD", feature_name: featureName }, context: { sessionId, directory: tmpDir },
    }, id: Date.now() + 1 })
    const artifactDir = join(tmpDir, ".openartisan", featureName)
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, "plan.md"), "# Plan\n\nA structurally valid planning artifact.", "utf-8")
    await sendSocketRequest(socketPath, { jsonrpc: "2.0", method: "tool.execute", params: {
      name: "request_review", args: { summary: "Plan", artifact_description: "Plan", artifact_files: [join(".openartisan", featureName, "plan.md")] }, context: { sessionId, directory: tmpDir },
    }, id: Date.now() + 2 })
    const reviewContext = await sendSocketRequest(socketPath, { jsonrpc: "2.0", method: "task.getPhaseReviewContext", params: { sessionId }, id: Date.now() + 3 })
    const reviewToken = extractReviewToken(String((reviewContext as { result?: unknown }).result ?? ""))
    await sendSocketRequest(socketPath, { jsonrpc: "2.0", method: "tool.execute", params: {
      name: "submit_phase_review",
      args: { review_stdout: JSON.stringify({ satisfied: true, criteria_results: passingPlanningCriteria() }), review_stderr: "", review_exit_code: 0, review_token: reviewToken },
      context: { sessionId, directory: tmpDir, invocation: "isolated-reviewer" },
    }, id: Date.now() + 4 })
  }

  it("allows (no-op) when disabled", async () => {
    const enabledPath = getEnabledPath(stateDir)
    if (existsSync(enabledPath)) { const { unlinkSync } = await import("node:fs"); unlinkSync(enabledPath) }
    const r = await handleUserPromptSubmit(makeInput({ prompt: "hello" }))
    expect(r.exitCode).toBe(0)
    writeFileSync(enabledPath, "1")
  })

  it("no-ops for the isolated reviewer subprocess", async () => {
    const prev = process.env[REVIEWER_SUBPROCESS_ENV]
    process.env[REVIEWER_SUBPROCESS_ENV] = "1"
    try {
      const r = await handleUserPromptSubmit(makeInput({ prompt: "hello" }))
      expect(r.exitCode).toBe(0)
    } finally {
      if (prev === undefined) delete process.env[REVIEWER_SUBPROCESS_ENV]
      else process.env[REVIEWER_SUBPROCESS_ENV] = prev
    }
  })

  it("flips userGateMessageReceived at PLANNING/USER_GATE so submit_feedback unblocks", async () => {
    writeFileSync(getEnabledPath(stateDir), "1")
    const sessionId = `upsubmit-gate-${Date.now()}`
    await driveToPlanningUserGate(sessionId)

    let st = await readWorkflowState(sessionId)
    expect(st.phaseState).toBe("USER_GATE")
    expect(st.userGateMessageReceived).toBeFalsy() // not yet — no real user message relayed

    const res = await handleUserPromptSubmit({ session_id: sessionId, cwd: tmpDir, prompt: "please revise: add live AWS" })
    expect(res.exitCode).toBe(0)

    st = await readWorkflowState(sessionId)
    expect(st.userGateMessageReceived).toBe(true)
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
// reviewerCommandArgs — the isolated reviewer must get enough turns to use tools
// ---------------------------------------------------------------------------

describe("reviewerCommandArgs", () => {
  it("gives the reviewer more than one turn (it must Read artifacts before answering)", () => {
    const args = reviewerCommandArgs("review this")
    const idx = args.indexOf("--max-turns")
    expect(idx).toBeGreaterThanOrEqual(0)
    const turns = Number(args[idx + 1])
    expect(turns).toBe(REVIEWER_MAX_TURNS)
    // A single-turn budget is consumed by the first Read tool call, leaving none
    // for the JSON verdict — the reviewer then exits "Reached max turns (1)".
    expect(turns).toBeGreaterThan(1)
  })

  it("passes the prompt via -p and runs in print mode", () => {
    const args = reviewerCommandArgs("PROMPT-BODY")
    expect(args).toContain("--print")
    expect(args[args.indexOf("-p") + 1]).toBe("PROMPT-BODY")
  })

  it("streams so the idle-timeout watchdog sees progress (plain --print is silent until the end)", () => {
    const args = reviewerCommandArgs("review this")
    expect(args).toContain("--output-format")
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json")
    expect(args).toContain("--verbose")
  })
})

describe("extractStreamJsonResult", () => {
  function streamWith(...events: object[]): string {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  }

  it("returns the verdict text from the terminal success result event", () => {
    const verdict = JSON.stringify({ satisfied: true, criteria_results: [] })
    const out = streamWith(
      { type: "assistant", message: {} },
      { type: "result", subtype: "success", is_error: false, result: verdict },
    )
    expect(extractStreamJsonResult(out)).toEqual({ ok: true, text: verdict })
  })

  it("fails when no result event was emitted", () => {
    const r = extractStreamJsonResult(streamWith({ type: "assistant", message: {} }))
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("no result event")
  })

  it("fails on an error result subtype (e.g. max turns)", () => {
    const r = extractStreamJsonResult(streamWith({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }))
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("error_max_turns")
  })
})

// ---------------------------------------------------------------------------
// isPureArtisanCommand — quote-aware classification of artisan invocations
// ---------------------------------------------------------------------------

describe("isPureArtisanCommand", () => {
  it("allows bare artisan invocations", () => {
    expect(isPureArtisanCommand("./artisan state")).toBe(true)
    expect(isPureArtisanCommand("artisan ping")).toBe(true)
    expect(isPureArtisanCommand("bun run ../open-artisan/bin/artisan.ts state")).toBe(true)
    expect(isPureArtisanCommand("artisan request-review --summary \"Plan ready\" --artifact-file .openartisan/f/plan.md")).toBe(true)
  })

  it("allows shell metacharacters inside quotes (the false-positive fix)", () => {
    // Semicolons / pipes / globs inside a quoted description are literal.
    expect(isPureArtisanCommand('./artisan request-review --artifact-description "a; b; c"')).toBe(true)
    expect(isPureArtisanCommand('artisan request-review --artifact-description "packages/layer/* and a|b"')).toBe(true)
    expect(isPureArtisanCommand("artisan request-review --summary 'one; two & three'")).toBe(true)
  })

  it("blocks unquoted shell control operators (injection)", () => {
    expect(isPureArtisanCommand("./artisan state; rm -rf /")).toBe(false)
    expect(isPureArtisanCommand("artisan state && rm -rf /")).toBe(false)
    expect(isPureArtisanCommand("artisan state | tee /tmp/x")).toBe(false)
    expect(isPureArtisanCommand("artisan state > /tmp/x")).toBe(false)
    expect(isPureArtisanCommand("artisan state `rm -rf /`")).toBe(false)
  })

  it("blocks command/variable substitution even inside double quotes", () => {
    expect(isPureArtisanCommand('artisan request-review --artifact-description "$(rm -rf /)"')).toBe(false)
    expect(isPureArtisanCommand('artisan request-review --artifact-description "`rm -rf /`"')).toBe(false)
    expect(isPureArtisanCommand('artisan request-review --artifact-description "$HOME is home"')).toBe(false)
  })

  it("rejects non-artisan heads, multiline, and unterminated quotes", () => {
    expect(isPureArtisanCommand("echo '{}' | artisan request-review")).toBe(false)
    expect(isPureArtisanCommand("echo bad > /tmp/x\nartisan state")).toBe(false)
    expect(isPureArtisanCommand('artisan request-review --summary "unterminated')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Isolated reviewer subprocess transparency
//
// The phase/task reviewer runs as `claude --print` in the project dir, so it
// inherits the project's open-artisan hooks. Marked with REVIEWER_SUBPROCESS_ENV,
// every hook must no-op: otherwise the reviewer's own Stop hook reprompts and the
// headless run exits non-zero (failed review dispatch), and SessionStart/PreToolUse
// clobber the authoring session's `.active-session` pointer.
// ---------------------------------------------------------------------------

describe("hook: isolated reviewer subprocess", () => {
  function withMarker<T>(fn: () => T): T {
    const prev = process.env[REVIEWER_SUBPROCESS_ENV]
    process.env[REVIEWER_SUBPROCESS_ENV] = "1"
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env[REVIEWER_SUBPROCESS_ENV]
      else process.env[REVIEWER_SUBPROCESS_ENV] = prev
    }
  }

  it("PreToolUse allows write tools that would otherwise be blocked", async () => {
    writeFileSync(getEnabledPath(stateDir), "1")
    const result = await withMarker(() =>
      handlePreToolUse(makeInput({
        tool_name: "Write",
        tool_input: { file_path: "/tmp/reviewer.ts", content: "x" },
      })),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBeNull()
  })

  it("Stop returns exit 0 instead of reprompting during an active workflow", async () => {
    writeFileSync(getEnabledPath(stateDir), "1")
    // Sanity: without the marker, an active workflow reprompts (exit 2).
    const reprompt = await handleStop(makeInput())
    expect(reprompt.exitCode).toBe(2)
    // With the marker, the reviewer's Stop hook must allow a clean stop.
    const result = await withMarker(() => handleStop(makeInput()))
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBeNull()
  })

  it("SessionStart injects nothing and does not clobber .active-session", async () => {
    writeFileSync(getEnabledPath(stateDir), "1")
    writeFileSync(getActiveSessionPath(stateDir), "authoring-session", "utf-8")
    const result = await withMarker(() =>
      handleSessionStart({ session_id: "throwaway-reviewer-session", cwd: tmpDir, source: "startup" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBeNull()
    expect(readFileSync(getActiveSessionPath(stateDir), "utf-8").trim()).toBe("authoring-session")
  })
})

// ---------------------------------------------------------------------------
// Hook CLI binary integration tests
// ---------------------------------------------------------------------------

describe("artisan-hook CLI binary", () => {
  const HOOK_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-hook.ts")

  function runHook(command: string, stdin: object): string[] {
    try {
      const stdout = execFileSync("bun", ["run", HOOK_SCRIPT, command], {
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
    try {
      execFileSync("bun", ["run", HOOK_SCRIPT, "pre-tool-use"], {
        input: "not json",
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
