import { buildHermesToolContractsArtifact, HERMES_TOOL_CONTRACTS_OUTPUT_PATH, hermesToolContractCount } from "./hermes-tool-contract-artifact"

await Bun.write(HERMES_TOOL_CONTRACTS_OUTPUT_PATH, buildHermesToolContractsArtifact())
console.log(`Wrote ${hermesToolContractCount()} Hermes tool contracts to ${HERMES_TOOL_CONTRACTS_OUTPUT_PATH}`)
