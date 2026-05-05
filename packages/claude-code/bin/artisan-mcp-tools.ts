/**
 * artisan-mcp-tools.ts — side-effect-free MCP tool definitions.
 */

import { toJsonSchema } from "#core/schemas"
import { MCP_TOOL_CONTRACTS } from "#core/tool-contracts"

export const TOOLS = MCP_TOOL_CONTRACTS.map((contract) => ({
  name: contract.mcpName ?? `oa_${contract.name}`,
  description: contract.description,
  bridgeName: contract.name,
  inputSchema: toJsonSchema(contract.schema),
}))
