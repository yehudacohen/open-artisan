#!/usr/bin/env bun
/**
 * artisan-mcp.ts — MCP server that exposes open-artisan workflow tools.
 *
 * Connects to the running bridge server via Unix socket and exposes all
 * workflow tools as proper MCP tools with schemas. This gives Claude Code
 * native tool invocation (no shell escaping, proper parameter validation)
 * while preserving all structural guarantees from the bridge.
 *
 * Structural guarantees:
 * - File write guards remain in the PreToolUse hook (intercepts built-in tools)
 * - Workflow tools go through bridge tool.execute (validates state transitions)
 * - submit_feedback calls message.process first (USER_GATE enforcement)
 * - The MCP server is a thin relay — all logic is in the bridge
 *
 * Usage:
 *   Configured in .mcp.json — Claude Code starts it automatically.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { sendSocketRequest } from "#claude-code/src/socket-transport"
import {
  DEFAULT_STATE_DIR_NAME,
  getSocketPath,
  getActiveSessionPath,
} from "#claude-code/src/constants"
import { TOOLS } from "./artisan-mcp-tools"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProjectDir(): string {
  return process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
}

function getStateDir(): string {
  return join(getProjectDir(), DEFAULT_STATE_DIR_NAME)
}

function getSessionId(): string {
  const sessionPath = getActiveSessionPath(getStateDir())
  if (existsSync(sessionPath)) {
    const id = readFileSync(sessionPath, "utf-8").trim()
    if (id) return id
  }
  return "default"
}

async function bridgeCall(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const socketPath = getSocketPath(getStateDir())
  const response = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method,
    params,
    id: Date.now(),
  })
  if (!response) return null
  const r = response as { result?: unknown; error?: { message?: string } }
  if (r.error) throw new Error(r.error.message ?? "Bridge error")
  return r.result
}

async function execTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  if (name === "mark_satisfied") {
    return "Error: mark_satisfied is reserved for isolated reviewers. Use request_review and let the Claude Code hook submit submit_phase_review."
  }

  // Ensure session is registered
  const sessionId = getSessionId()
  await bridgeCall("lifecycle.sessionCreated", { sessionId })

  // For submit_feedback: call message.process first (USER_GATE structural enforcement)
  if (name === "submit_feedback") {
    await bridgeCall("message.process", {
      sessionId,
      parts: [{ type: "text", text: "(user invoked submit_feedback via MCP tool)" }],
    })
  }

  const result = await bridgeCall("tool.execute", {
    name,
    args,
    context: {
      sessionId,
      directory: getProjectDir(),
    },
  })
  return typeof result === "string" ? result : JSON.stringify(result, null, 2)
}

// ---------------------------------------------------------------------------
// Tool definitions (matching bridge tool schemas)
// ---------------------------------------------------------------------------

// Bridge name → tool name lookup
const BRIDGE_NAME_MAP = new Map(TOOLS.map((t) => [t.name, t.bridgeName]))

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "open-artisan", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const bridgeName = BRIDGE_NAME_MAP.get(name)

  if (!bridgeName) {
    return {
      content: [{ type: "text" as const, text: `Error: Unknown tool "${name}"` }],
      isError: true,
    }
  }

  try {
    let result: string
    if (bridgeName === "_state_get") {
      // oa_state calls state.get directly
      const sessionId = getSessionId()
      await bridgeCall("lifecycle.sessionCreated", { sessionId })
      const state = await bridgeCall("state.get", { sessionId })
      result = state ? JSON.stringify(state, null, 2) : "No active workflow session."
    } else {
      result = await execTool(bridgeName, (args ?? {}) as Record<string, unknown>)
    }

    const isError = result.startsWith("Error:")
    return {
      content: [{ type: "text" as const, text: result }],
      isError,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      isError: true,
    }
  }
})

// Start
const transport = new StdioServerTransport()
await server.connect(transport)
