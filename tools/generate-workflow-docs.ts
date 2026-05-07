import { writeFile } from "node:fs/promises"

import { generateWorkflowTemplate } from "../packages/core/workflow-template"

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

await writeFile("packages/adapter-hermes/.hermes.md.tmpl", hermesWorkflowTemplate)
await writeFile(".hermes.md", hermesWorkflowTemplate)
await writeFile("CLAUDE-WORKFLOW.md", claudeWorkflowTemplate)
await writeFile("packages/claude-code/templates/CLAUDE-WORKFLOW.md", claudeWorkflowTemplate)
