import { buildHermesPluginManifestArtifact, buildHermesToolContractsArtifact, HERMES_PLUGIN_MANIFEST_OUTPUT_PATH, HERMES_TOOL_CONTRACTS_OUTPUT_PATH, hermesToolContractCount } from "./hermes-tool-contract-artifact"

await Bun.write(HERMES_TOOL_CONTRACTS_OUTPUT_PATH, buildHermesToolContractsArtifact())
await Bun.write(HERMES_PLUGIN_MANIFEST_OUTPUT_PATH, buildHermesPluginManifestArtifact())
console.log(`Wrote ${hermesToolContractCount()} Hermes tool contracts to ${HERMES_TOOL_CONTRACTS_OUTPUT_PATH}`)
console.log(`Wrote Hermes plugin manifest to ${HERMES_PLUGIN_MANIFEST_OUTPUT_PATH}`)
