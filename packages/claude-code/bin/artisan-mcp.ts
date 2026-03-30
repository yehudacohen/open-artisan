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

const TOOLS = [
  {
    name: "oa_select_mode",
    description: "Select the workflow mode (GREENFIELD, REFACTOR, or INCREMENTAL) and set the feature name.",
    bridgeName: "select_mode",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: { type: "string", enum: ["GREENFIELD", "REFACTOR", "INCREMENTAL"], description: "Workflow mode." },
        feature_name: { type: "string", description: "Short identifier for this feature." },
      },
      required: ["mode", "feature_name"],
    },
  },
  {
    name: "oa_request_review",
    description: "Submit the current artifact for review.",
    bridgeName: "request_review",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "Brief summary of the artifact." },
        artifact_description: { type: "string", description: "Description of what was produced." },
        artifact_content: { type: "string", description: "Text content (for text-based phases)." },
        artifact_files: { type: "array", items: { type: "string" }, description: "File paths (for file-based phases)." },
      },
      required: ["summary", "artifact_description"],
    },
  },
  {
    name: "oa_mark_satisfied",
    description: "Submit self-review criteria assessment for the current artifact.",
    bridgeName: "mark_satisfied",
    inputSchema: {
      type: "object" as const,
      properties: {
        criteria_met: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion: { type: "string" },
              met: { type: "boolean" },
              evidence: { type: "string" },
              severity: { type: "string", enum: ["blocking", "suggestion"] },
              score: { type: "number" },
            },
            required: ["criterion", "met", "evidence"],
          },
          description: "Array of criteria assessments.",
        },
      },
      required: ["criteria_met"],
    },
  },
  {
    name: "oa_submit_feedback",
    description: "Approve or request revision of the current artifact at USER_GATE.",
    bridgeName: "submit_feedback",
    inputSchema: {
      type: "object" as const,
      properties: {
        feedback_type: { type: "string", enum: ["approve", "revise"], description: "Approve or revise." },
        feedback_text: { type: "string", description: "Feedback details (required for revise)." },
        artifact_content: { type: "string", description: "Artifact content to persist on approve." },
      },
      required: ["feedback_type"],
    },
  },
  {
    name: "oa_mark_task_complete",
    description: "Mark the current implementation DAG task as complete.",
    bridgeName: "mark_task_complete",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "The task ID (e.g. T1)." },
        implementation_summary: { type: "string", description: "What was implemented." },
        tests_passing: { type: "boolean", description: "Whether all tests pass." },
      },
      required: ["task_id", "implementation_summary", "tests_passing"],
    },
  },
  {
    name: "oa_mark_scan_complete",
    description: "Mark the discovery scan phase as complete.",
    bridgeName: "mark_scan_complete",
    inputSchema: {
      type: "object" as const,
      properties: { scan_summary: { type: "string" } },
      required: ["scan_summary"],
    },
  },
  {
    name: "oa_mark_analyze_complete",
    description: "Mark the discovery analysis phase as complete.",
    bridgeName: "mark_analyze_complete",
    inputSchema: {
      type: "object" as const,
      properties: { analysis_summary: { type: "string" } },
      required: ["analysis_summary"],
    },
  },
  {
    name: "oa_check_prior_workflow",
    description: "Check if a prior workflow exists for a feature name.",
    bridgeName: "check_prior_workflow",
    inputSchema: {
      type: "object" as const,
      properties: { feature_name: { type: "string" } },
      required: ["feature_name"],
    },
  },
  {
    name: "oa_propose_backtrack",
    description: "Propose going back to an earlier workflow phase.",
    bridgeName: "propose_backtrack",
    inputSchema: {
      type: "object" as const,
      properties: {
        target_phase: { type: "string", description: "Phase to backtrack to." },
        reason: { type: "string", description: "Why backtracking is necessary." },
      },
      required: ["target_phase", "reason"],
    },
  },
  {
    name: "oa_resolve_human_gate",
    description: "Set a human gate on a DAG task that requires manual action.",
    bridgeName: "resolve_human_gate",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" },
        what_is_needed: { type: "string" },
        why: { type: "string" },
        verification_steps: { type: "string" },
      },
      required: ["task_id", "what_is_needed"],
    },
  },
  {
    name: "oa_spawn_sub_workflow",
    description: "Delegate a DAG task to a child sub-workflow.",
    bridgeName: "spawn_sub_workflow",
    inputSchema: {
      type: "object" as const,
      properties: { task_id: { type: "string" }, feature_name: { type: "string" } },
      required: ["task_id", "feature_name"],
    },
  },
  {
    name: "oa_query_parent_workflow",
    description: "Read-only inspection of the parent workflow state.",
    bridgeName: "query_parent_workflow",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "oa_query_child_workflow",
    description: "Read-only inspection of a child workflow state.",
    bridgeName: "query_child_workflow",
    inputSchema: {
      type: "object" as const,
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "oa_submit_task_review",
    description: "Submit per-task isolated review results.",
    bridgeName: "submit_task_review",
    inputSchema: {
      type: "object" as const,
      properties: {
        review_output: { type: "string", description: "Raw JSON output from the isolated reviewer subprocess." },
      },
      required: ["review_output"],
    },
  },
  {
    name: "oa_submit_auto_approve",
    description: "Submit auto-approval results for robot-artisan mode at USER_GATE.",
    bridgeName: "submit_auto_approve",
    inputSchema: {
      type: "object" as const,
      properties: {
        review_output: { type: "string", description: "Raw JSON output from the auto-approver subprocess." },
      },
      required: ["review_output"],
    },
  },
  {
    name: "oa_reset_task",
    description: "Reset specific task(s) to pending for re-implementation and re-review.",
    bridgeName: "reset_task",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Single task ID to reset." },
        task_ids: { type: "array", items: { type: "string" }, description: "Multiple task IDs to reset." },
      },
    },
  },
  {
    name: "oa_state",
    description: "Show the current workflow state (phase, mode, task, approved artifacts).",
    bridgeName: "_state_get",
    inputSchema: { type: "object" as const, properties: {} },
  },
]

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
