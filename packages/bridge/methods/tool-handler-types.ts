import type { BridgeContext } from "../server"

export interface ToolContext {
  sessionId: string
  directory: string
  agent?: string
  invocation?: "author" | "isolated-reviewer" | "system"
}

export type ToolHandler = (
  args: Record<string, unknown>,
  toolCtx: ToolContext,
  ctx: BridgeContext,
) => Promise<string>
