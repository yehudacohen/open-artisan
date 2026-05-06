import { readFile } from "node:fs/promises"

import { buildHermesToolContractsArtifact, HERMES_TOOL_CONTRACTS_OUTPUT_PATH } from "./hermes-tool-contract-artifact"

const actual = await readFile(HERMES_TOOL_CONTRACTS_OUTPUT_PATH, "utf-8")
const expected = buildHermesToolContractsArtifact()

if (actual !== expected) {
  process.stderr.write(
    `Generated artifact is stale. Run \`bun run generate:hermes-tools\` and commit ${HERMES_TOOL_CONTRACTS_OUTPUT_PATH}.\n`,
  )
  process.exit(1)
}
