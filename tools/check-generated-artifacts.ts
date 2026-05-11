import { readFile } from "node:fs/promises"

import { buildHermesToolContractsArtifact, HERMES_TOOL_CONTRACTS_OUTPUT_PATH } from "./hermes-tool-contract-artifact"
import { generateWorkflowTemplate } from "../packages/core/workflow-template"

async function checkGeneratedFile(path: string, expected: string, command: string): Promise<boolean> {
  const actual = await readFile(path, "utf-8")
  if (actual === expected) return true
  process.stderr.write(`Generated artifact is stale. Run \`${command}\` and commit ${path}.\n`)
  return false
}

async function checkFileDoesNotContain(path: string, forbidden: string, replacement: string): Promise<boolean> {
  const actual = await readFile(path, "utf-8")
  if (!actual.includes(forbidden)) return true
  process.stderr.write(`Runtime docs contain stale text in ${path}: ${forbidden}. Use ${replacement} instead.\n`)
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

ok = await checkFileDoesNotContain("README.md", ".opencode/openartisan-errors.log", ".openartisan/openartisan-errors.log") && ok
ok = await checkFileDoesNotContain("CONTRIBUTING.md", ".opencode/openartisan-errors.log", ".openartisan/openartisan-errors.log") && ok
ok = await checkFileDoesNotContain("docs/structured-workflow-design.md", ".opencode/openartisan-errors.log", ".openartisan/openartisan-errors.log") && ok
ok = await checkFileDoesNotContain(".opencode/skills/open-artisan-dogfood/SKILL.md", ".opencode/openartisan-errors.log", ".openartisan/openartisan-errors.log") && ok
ok = await checkFileDoesNotContain(".opencode/skills/open-artisan-dogfood-opencode/SKILL.md", ".opencode/openartisan-errors.log", ".openartisan/openartisan-errors.log") && ok
ok = await checkFileDoesNotContain("README.md", "Full design specification (v14)", "current runtime/design references") && ok
ok = await checkFileDoesNotContain("CLAUDE.md", ".openartisan/open-artisan.db", ".openartisan/workflow-db/") && ok
ok = await checkFileDoesNotContain("docs/current-runtime-reference.md", "open-artisan.pg", ".openartisan/workflow-db/") && ok
ok = await checkFileDoesNotContain("docs/structured-workflow-design.md", ".openartisan/open-artisan.db", ".openartisan/workflow-db/") && ok
ok = await checkFileDoesNotContain("packages/claude-code/README.md", "open-artisan.pg", ".openartisan/workflow-db/") && ok
ok = await checkFileDoesNotContain("CONTRIBUTING.md", "SCHEMA_VERSION` in `constants.ts", "SCHEMA_VERSION` in `workflow-state-types.ts") && ok

if (!ok) {
  process.exit(1)
}
