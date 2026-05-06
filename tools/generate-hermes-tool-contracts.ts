import { MCP_TOOL_CONTRACTS } from "../packages/core/tool-contracts"
import { toJsonSchema } from "../packages/core/schemas"

const outputPath = "packages/adapter-hermes/hermes_adapter/tool_contracts.json"

const contracts = MCP_TOOL_CONTRACTS.map((contract) => ({
  hermes_name: contract.mcpName ?? `oa_${contract.name}`,
  bridge_name: contract.name,
  description: contract.description,
  schema: toJsonSchema(contract.schema),
}))

await Bun.write(outputPath, `${JSON.stringify(contracts, null, 2)}\n`)
console.log(`Wrote ${contracts.length} Hermes tool contracts to ${outputPath}`)
