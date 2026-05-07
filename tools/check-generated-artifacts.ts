import { readFile } from "node:fs/promises"

import { buildHermesToolContractsArtifact, HERMES_TOOL_CONTRACTS_OUTPUT_PATH } from "./hermes-tool-contract-artifact"
import { generateWorkflowTemplate } from "../packages/core/workflow-template"

async function checkGeneratedFile(path: string, expected: string, command: string): Promise<boolean> {
  const actual = await readFile(path, "utf-8")
  if (actual === expected) return true
  process.stderr.write(`Generated artifact is stale. Run \`${command}\` and commit ${path}.\n`)
  return false
}

let ok = true
ok = await checkGeneratedFile(HERMES_TOOL_CONTRACTS_OUTPUT_PATH, buildHermesToolContractsArtifact(), "bun run generate:hermes-tools") && ok

const hermesWorkflowTemplate = generateWorkflowTemplate({
  toolPrefix: "oa_",
  argStyle: "tool",
  header: "# Open Artisan — Workflow Instructions",
}) + "\n"
const claudeWorkflowTemplate = generateWorkflowTemplate({
  toolPrefix: "./artisan ",
  argStyle: "cli",
  header: "# Open Artisan — Workflow Instructions",
}) + "\n"

ok = await checkGeneratedFile("packages/adapter-hermes/.hermes.md.tmpl", hermesWorkflowTemplate, "bun run generate:workflow-docs") && ok
ok = await checkGeneratedFile(".hermes.md", hermesWorkflowTemplate, "bun run generate:workflow-docs") && ok
ok = await checkGeneratedFile("CLAUDE-WORKFLOW.md", claudeWorkflowTemplate, "bun run generate:workflow-docs") && ok
ok = await checkGeneratedFile("packages/claude-code/templates/CLAUDE-WORKFLOW.md", claudeWorkflowTemplate, "bun run generate:workflow-docs") && ok

if (!ok) {
  process.exit(1)
}
