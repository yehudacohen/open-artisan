import { MCP_TOOL_CONTRACTS } from "../packages/core/tool-contracts"
import { toJsonSchema } from "../packages/core/schemas"

export const HERMES_TOOL_CONTRACTS_OUTPUT_PATH = "packages/adapter-hermes/hermes_adapter/tool_contracts.json"

export function buildHermesToolContractsArtifact(): string {
  const contracts = MCP_TOOL_CONTRACTS.map((contract) => ({
    hermes_name: contract.mcpName ?? `oa_${contract.name}`,
    bridge_name: contract.name,
    description: contract.description,
    schema: toJsonSchema(contract.schema),
  }))
  return `${JSON.stringify(contracts, null, 2)}\n`
}

export function hermesToolContractCount(): number {
  return MCP_TOOL_CONTRACTS.length
}
