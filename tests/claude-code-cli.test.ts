/**
 * Tests for the artisan CLI.
 *
 * Spawns the artisan-server, then tests the artisan CLI commands against it.
 * Tests both CLI flag mode and stdin JSON mode.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { spawn, execSync, type ChildProcess } from "node:child_process"

import { sendSocketRequest } from "#claude-code/src/socket-transport"
import { getSocketPath, getEnabledPath, getActiveSessionPath, DEFAULT_STATE_DIR_NAME } from "#claude-code/src/constants"

const REPO_ROOT = join(import.meta.dirname, "..")
const SERVER_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-server.ts")
const CLI_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan.ts")

let tmpDir: string
let stateDir: string
let socketPath: string
let serverProcess: ChildProcess | null = null

/** Run the artisan CLI with args and optional stdin. Returns stdout. */
function runCli(args: string[], stdin?: string): string {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: tmpDir,
  }
  const result = execSync(
    `bun run ${CLI_SCRIPT} ${args.join(" ")}`,
    {
      env,
      encoding: "utf-8",
      input: stdin,
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  return result.trim()
}

/** Run CLI expecting an error. Returns stderr. */
function runCliError(args: string[], stdin?: string): string {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
  try {
    execSync(`bun run ${CLI_SCRIPT} ${args.join(" ")}`, {
      env, encoding: "utf-8", input: stdin, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"],
    })
    throw new Error("Expected CLI to fail but it succeeded")
  } catch (err: any) {
    return (err.stderr ?? err.message ?? "").trim()
  }
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "artisan-cli-test-"))
  stateDir = join(tmpDir, DEFAULT_STATE_DIR_NAME)
  socketPath = getSocketPath(stateDir)

  // Start the server
  serverProcess = spawn("bun", ["run", SERVER_SCRIPT, "--project-dir", tmpDir], {
    stdio: "ignore",
  })

  // Wait for socket — fail explicitly if server doesn't start
  const deadline = Date.now() + 10_000
  let serverReady = false
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const response = await sendSocketRequest(socketPath, {
        jsonrpc: "2.0", method: "lifecycle.ping", id: 1,
      })
      if (response && (response as any).result === "pong") {
        serverReady = true
        break
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!serverReady) throw new Error("artisan-server failed to start within 10s")

  // Register a session and write active-session file
  await sendSocketRequest(socketPath, {
    jsonrpc: "2.0", method: "lifecycle.sessionCreated", params: { sessionId: "cli-test" }, id: 2,
  })
  const { mkdirSync, writeFileSync } = await import("node:fs")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(getActiveSessionPath(stateDir), "cli-test", "utf-8")
  writeFileSync(getEnabledPath(stateDir), "1", "utf-8")
}, 15000)

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      if (!serverProcess) { resolve(); return }
      serverProcess.on("exit", () => resolve())
      setTimeout(resolve, 2000)
    })
    serverProcess = null
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("artisan CLI", () => {
  it("shows help with --help", () => {
    const output = runCli(["--help"])
    expect(output).toContain("Usage: artisan")
    expect(output).toContain("select-mode")
    expect(output).toContain("mark-task-complete")
  })

  it("ping returns pong", () => {
    const output = runCli(["ping"])
    expect(output).toBe("pong")
  })

  it("state shows MODE_SELECT initially", () => {
    const output = runCli(["state"])
    expect(output).toContain("MODE_SELECT")
  })

  it("select-mode with CLI flags", () => {
    const output = runCli(["select-mode", "--mode", "GREENFIELD", "--feature-name", `cli-feat-${Date.now()}`])
    expect(output).toContain("GREENFIELD")
  })

  it("state shows PLANNING after select-mode", () => {
    const output = runCli(["state"])
    expect(output).toContain("PLANNING")
    expect(output).toContain("GREENFIELD")
  })

  it("request-review with stdin JSON", () => {
    const input = JSON.stringify({
      summary: "Plan ready",
      artifact_description: "The plan document",
      artifact_content: "# Plan\nBuild the thing step by step.",
    })
    const output = runCli(["request-review"], input)
    expect(output).toContain("REVIEW")
  })

  it("mark-satisfied with stdin JSON", () => {
    const criteria = Array.from({ length: 15 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "verified", severity: "blocking",
    }))
    const input = JSON.stringify({ criteria_met: criteria })
    const output = runCli(["mark-satisfied"], input)
    // Should advance to USER_GATE (agent-only mode passes with all met)
    expect(output.toLowerCase()).toContain("user gate")
  })

  it("enable creates .enabled file", () => {
    const output = runCli(["enable"])
    expect(output).toContain("enabled")
    expect(existsSync(getEnabledPath(stateDir))).toBe(true)
  })

  it("disable removes .enabled file", () => {
    const output = runCli(["disable"])
    expect(output).toContain("disabled")
    expect(existsSync(getEnabledPath(stateDir))).toBe(false)
    // Re-enable for subsequent tests
    runCli(["enable"])
  })

  it("errors on unknown command", () => {
    const stderr = runCliError(["bogus-command"])
    expect(stderr).toContain("Unknown command")
  })
}, { timeout: 30000 })
