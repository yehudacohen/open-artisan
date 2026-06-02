/**
 * Tests for the artisan CLI roadmap passthrough (finding #7) and the stdin
 * no-hang fix (finding #8).
 *
 * - parseFlagArgs: pure flag parsing, --args-file skipped.
 * - Integration: spawn a real artisan-server, drive `bun run artisan.ts
 *   roadmap-*` through the socket (round-trip), and prove a no-arg command does
 *   NOT hang when stdin is an open, never-closed pipe (the hook/background env).
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"

import { sendSocketRequest } from "#claude-code/src/socket-transport"
import { getSocketPath, DEFAULT_STATE_DIR_NAME } from "#claude-code/src/constants"
import { parseFlagArgs, TOOL_COMMANDS } from "#claude-code/bin/artisan"

const REPO_ROOT = join(import.meta.dirname, "..")
const SERVER_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan-server.ts")
const CLI_SCRIPT = join(REPO_ROOT, "packages", "claude-code", "bin", "artisan.ts")

describe("parseFlagArgs", () => {
  it("parses --key value, --key=value, and boolean flags (kebab → snake)", () => {
    expect(parseFlagArgs(["--mode", "GREENFIELD", "--feature-name", "x"]))
      .toEqual({ mode: "GREENFIELD", feature_name: "x" })
    expect(parseFlagArgs(["--mode=REFACTOR"])).toEqual({ mode: "REFACTOR" })
    expect(parseFlagArgs(["--daemon"])).toEqual({ daemon: true })
    expect(parseFlagArgs([])).toEqual({})
  })

  it("skips --args-file and its value", () => {
    expect(parseFlagArgs(["--args-file", "/tmp/x.json"])).toEqual({})
    expect(parseFlagArgs(["--args-file", "/tmp/x.json", "--dry-run"]))
      .toEqual({ dry_run: true })
  })
})

describe("TOOL_COMMANDS — current-task boundary tools are CLI-exposed", () => {
  it("maps the scope-expansion and boundary-repair commands to their tool names", () => {
    // These let an active IMPLEMENTATION task add files / re-sync its boundary
    // without a destructive DAG-wide reset; they must be reachable from the CLI.
    expect(TOOL_COMMANDS["approve-current-task-scope-expansion"]).toBe("approve_current_task_scope_expansion")
    expect(TOOL_COMMANDS["repair-current-task-boundary-from-impl-plan"]).toBe("repair_current_task_boundary_from_impl_plan")
  })
})

describe("artisan CLI roadmap passthrough", () => {
  let tmpDir: string
  let socketPath: string
  let server: ChildProcess | null = null

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "artisan-cli-"))
    socketPath = getSocketPath(join(tmpDir, DEFAULT_STATE_DIR_NAME))
    server = spawn("bun", ["run", SERVER_SCRIPT, "--project-dir", tmpDir], { stdio: "ignore" })
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
  }, 15000)

  afterAll(async () => {
    if (server) {
      server.kill("SIGTERM")
      await new Promise<void>((r) => { server?.on("exit", () => r()); setTimeout(r, 2000) })
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  function cli(args: string[], opts: { input?: string } = {}): string {
    return execFileSync("bun", ["run", CLI_SCRIPT, ...args], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
      timeout: 15_000,
      // No stdin pipe — execFileSync closes stdin so it EOFs immediately.
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    }).trim()
  }

  it("upsert-item via --args-file then roadmap-read round-trips through the bridge", () => {
    const item = {
      item: { id: "slice-1", kind: "feature", title: "network-spoke", status: "todo", priority: 1,
        createdAt: "2026-05-29T00:00:00.000Z", updatedAt: "2026-05-29T00:00:00.000Z" },
    }
    const itemFile = join(tmpDir, "item.json")
    execFileSync("bash", ["-c", `cat > ${itemFile}`], { input: JSON.stringify(item) })
    const upsert = JSON.parse(cli(["roadmap-upsert-item", "--args-file", itemFile]))
    expect(upsert.ok).toBe(true)

    const read = JSON.parse(cli(["roadmap-read"]))
    expect(read.ok).toBe(true)
    expect(read.value.items.map((i: any) => i.id)).toContain("slice-1")
  })

  it("a no-arg command does not hang on an open, never-closed stdin pipe (finding #8)", async () => {
    // Mimic the hook/background environment: stdin is a pipe that never EOFs.
    const child = spawn("bun", ["run", CLI_SCRIPT, "roadmap-read"], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
      stdio: ["pipe", "pipe", "pipe"], // child.stdin left open and never written/ended
    })
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = ""
      child.stdout.on("data", (c) => (out += c))
      const kill = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, out }) }, 12_000)
      child.on("close", (code) => { clearTimeout(kill); resolve({ code, out }) })
    })
    expect(result.code).toBe(0) // completed via idle timeout instead of hanging until SIGKILL
    expect(JSON.parse(result.out).ok).toBe(true)
  }, 20000)
})
