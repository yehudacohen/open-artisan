import { HERMES_AUTHOR_TOOL_CONTRACTS } from "../packages/core/tool-contracts"
import { toJsonSchema } from "../packages/core/schemas"

export const HERMES_TOOL_CONTRACTS_OUTPUT_PATH = "packages/adapter-hermes/hermes_adapter/tool_contracts.json"
export const HERMES_PLUGIN_MANIFEST_OUTPUT_PATH = "packages/adapter-hermes/plugin.yaml"
export const HERMES_LOCAL_TOOL_NAMES = ["oa_list_projects", "oa_select_project", "oa_recover_bridge"] as const

export function buildHermesToolContractsArtifact(): string {
  const contracts = HERMES_AUTHOR_TOOL_CONTRACTS.map((contract) => ({
    hermes_name: contract.mcpName ?? `oa_${contract.name}`,
    bridge_name: contract.name,
    description: contract.description,
    schema: toJsonSchema(contract.schema),
  }))
  return `${JSON.stringify(contracts, null, 2)}\n`
}

export function hermesToolContractCount(): number {
  return HERMES_AUTHOR_TOOL_CONTRACTS.length
}

export function buildHermesPluginManifestArtifact(): string {
  const toolNames = [
    ...HERMES_AUTHOR_TOOL_CONTRACTS.map((contract) => contract.mcpName ?? `oa_${contract.name}`),
    ...HERMES_LOCAL_TOOL_NAMES,
  ]
  return [
    "name: open-artisan",
    "version: 0.1.0",
    "description: Phased workflow enforcement for Hermes agents",
    "entry_point: hermes_adapter",
    "author: Open Artisan",
    "",
    "tools:",
    ...toolNames.map((name) => `  - ${name}`),
    "",
    "hooks:",
    "  - on_session_start",
    "  - on_session_end",
    "  - pre_llm_call",
    "",
    "dependencies:",
    "  runtime:",
    "    - python >= 3.10",
    "    - bun  # for bridge server subprocess",
    "  python: []  # stdlib only",
    "",
  ].join("\n")
}
