import type { BridgeContext } from "../server"

export interface ToolContext {
  sessionId: string
  directory: string
  agent?: string
}

export type ToolHandler = (
  args: Record<string, unknown>,
  toolCtx: ToolContext,
  ctx: BridgeContext,
) => Promise<string>
