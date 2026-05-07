/**
 * workflow-template.ts — Centralized workflow instruction template generator.
 *
 * Generates adapter-specific static workflow instructions from a shared source.
 * This ensures CLAUDE-WORKFLOW.md and .hermes.md.tmpl stay in sync.
 *
 * Each adapter has a different tool invocation style:
 * - Claude Code: `./artisan <command>` via Bash (or MCP tools)
 * - Hermes: `oa_<tool_name>` via registered tools
 * - Future adapters: custom invocation patterns
 *
 * Integration note: adapter setup scripts may call this generator when they want
 * generated static instructions instead of checked-in templates.
 */

export interface TemplateConfig {
  /** How to invoke workflow tools (e.g. "./artisan select-mode" or "oa_select_mode") */
  toolPrefix: string
  /** Separator between tool and args (e.g. " --" for CLI, " " for tool calls) */
  argStyle: "cli" | "tool"
  /** Header text for the template */
  header?: string
}

const PHASES = [
  { name: "MODE_SELECT", desc: "Choose GREENFIELD, REFACTOR, or INCREMENTAL" },
  { name: "DISCOVERY", desc: "(REFACTOR/INCREMENTAL only) Analyze the existing codebase" },
  { name: "PLANNING", desc: "Produce a detailed plan document" },
  { name: "INTERFACES", desc: "Define all types, interfaces, and data models (no implementation)" },
  { name: "TESTS", desc: "Write a comprehensive failing test suite" },
  { name: "IMPL_PLAN", desc: "Produce a DAG of implementation tasks" },
  { name: "IMPLEMENTATION", desc: "Implement one task at a time from the DAG" },
  { name: "DONE", desc: "All phases approved" },
]

const TOOLS = [
  { cli: "select-mode", tool: "select_mode", desc: "Choose GREENFIELD, REFACTOR, or INCREMENTAL + set feature name" },
  { cli: "mark-scan-complete", tool: "mark_scan_complete", desc: "Complete discovery scan (REFACTOR/INCREMENTAL)" },
  { cli: "mark-analyze-complete", tool: "mark_analyze_complete", desc: "Complete discovery analysis" },
  { cli: "mark-satisfied", tool: "mark_satisfied", desc: "OpenCode/self-review compatibility only; bridge adapters use isolated review submission" },
  { cli: "request-review", tool: "request_review", desc: "Submit review artifacts (`artifact_files`, or markdown via `artifact_markdown`)" },
  { cli: "submit-feedback", tool: "submit_feedback", desc: "Approve or request revision at USER_GATE" },
  { cli: "mark-task-complete", tool: "mark_task_complete", desc: "Complete a DAG task during IMPLEMENTATION" },
  { cli: "check-prior-workflow", tool: "check_prior_workflow", desc: "Check for existing workflow state" },
  { cli: "resolve-human-gate", tool: "resolve_human_gate", desc: "Flag a task requiring manual action" },
  { cli: "propose-backtrack", tool: "propose_backtrack", desc: "Go back to an earlier phase" },
  { cli: "spawn-sub-workflow", tool: "spawn_sub_workflow", desc: "Delegate a DAG task to a child workflow" },
  { cli: "query-parent-workflow", tool: "query_parent_workflow", desc: "Read parent workflow state (sub-workflows)" },
  { cli: "query-child-workflow", tool: "query_child_workflow", desc: "Read child workflow state (sub-workflows)" },
  { cli: "state", tool: "state", desc: "Show current workflow state" },
]

function formatToolName(tool: typeof TOOLS[0], config: TemplateConfig): string {
  if (config.argStyle === "cli") {
    return `\`${config.toolPrefix.trimEnd()} ${tool.cli}\``
  }
  return `\`${config.toolPrefix}${tool.tool}\``
}

/**
 * Generate the complete workflow instructions template.
 * Shared content, adapter-specific formatting.
 */
export function generateWorkflowTemplate(config: TemplateConfig): string {
  const lines: string[] = []

  // Header
  lines.push(config.header ?? "# Open Artisan — Workflow Instructions")
  lines.push("")
  lines.push("You are operating under the **Open Artisan** phased workflow. Every coding task goes through sequential phases with structural enforcement. The tool guard blocks operations that don't belong in the current phase — this is not advisory, it is enforced.")
  lines.push("")

  // Phases
  lines.push("## Phases")
  lines.push("")
  lines.push("8 sequential phases, each with sub-states:")
  lines.push("")
  lines.push("```")
  lines.push(PHASES.map((p) => p.name).join(" → "))
  lines.push("```")
  lines.push("")
  lines.push("Each phase follows: **DRAFT → REVIEW → USER_GATE → (optional REVISE)**")
  lines.push("")

  // Tools
  lines.push("## Available Workflow Tools")
  lines.push("")
  lines.push("| Tool | Purpose |")
  lines.push("|------|---------|")
  for (const tool of TOOLS) {
    lines.push(`| ${formatToolName(tool, config)} | ${tool.desc} |`)
  }
  lines.push("")

  // Sub-state behavior — use configured tool names
  const tn = (tool: string) => {
    const t = TOOLS.find((x) => x.tool === tool)
    return t ? formatToolName(t, config) : `\`${tool}\``
  }

  lines.push("## Expected Behavior Per Sub-State")
  lines.push("")
  lines.push("### DRAFT")
  lines.push(`Do the work for this phase. When done, call ${tn("request_review")}.`)
  lines.push("")
  lines.push("### REVIEW")
  lines.push(`Stop authoring and let the adapter dispatch an isolated reviewer. Do NOT call ${tn("mark_satisfied")}; bridge adapters submit isolated reviews through adapter-only review submission.`)
  lines.push("")
  lines.push("### USER_GATE")
  lines.push(`Present a clear artifact summary to the user. **STOP and wait for their response.** Do NOT call ${tn("submit_feedback")} until the user responds. Not every user message is artifact feedback — casual conversation is fine.`)
  lines.push("")
  lines.push("### REVISE")
  lines.push(`Address ALL feedback points. Call ${tn("request_review")} when done. No check-ins, no partial revisions.`)
  lines.push("")

  // Blocked per phase table
  lines.push("## What's Blocked Per Phase")
  lines.push("")
  lines.push("| Phase / Sub-State | Allowed | Blocked |")
  lines.push("|-------------------|---------|---------|")
  lines.push("| MODE_SELECT | Workflow tools, read-only shell | File writes (edit_file, write_file, create_file) |")
  lines.push("| DISCOVERY/SCAN | Read-only tools, workflow tools | File writes, shell execution |")
  lines.push("| DISCOVERY/ANALYZE | Read-only tools, workflow tools | File writes, shell execution |")
  lines.push("| DISCOVERY/CONVENTIONS | `.openartisan/` writes only | Project source writes, shell execution |")
  lines.push("| PLANNING/DRAFT | `.openartisan/` artifact writes only | Project source writes, shell execution |")
  lines.push("| PLANNING/REVIEW | `.openartisan/` writes, read-only shell | Project source writes |")
  lines.push("| PLANNING/USER_GATE | Read-only shell, workflow tools | File writes |")
  lines.push("| PLANNING/REVISE | `.openartisan/` writes, read-only shell | Project source writes |")
  lines.push("| INTERFACES | Interface/type files only (.py, .ts, .d.ts, .proto, etc.) | Implementation files |")
  lines.push("| TESTS | Test files only | Implementation files |")
  lines.push("| IMPL_PLAN/DRAFT | `.openartisan/` artifact writes only | Project source writes, shell execution |")
  lines.push("| IMPL_PLAN/REVIEW | `.openartisan/` writes, read-only shell | Project source writes |")
  lines.push("| IMPL_PLAN/USER_GATE | Read-only shell, workflow tools | File writes |")
  lines.push("| IMPL_PLAN/REVISE | `.openartisan/` writes, read-only shell | Project source writes |")
  lines.push("| IMPLEMENTATION | Files listed in current task's `**Files:**` | Files belonging to other tasks |")
  lines.push("| DONE | Read-only tools, workflow tools | File writes |")
  lines.push("")
  lines.push("`.env` writes are **always blocked** regardless of phase.")
  lines.push("")

  // Implementation rules
  lines.push("## IMPLEMENTATION Phase Rules")
  lines.push("")
  lines.push("- One task at a time from the DAG. The current task is shown in the per-turn prompt injection.")
  lines.push(`- Call ${tn("mark_task_complete")} after each task.`)
  lines.push("- The IMPL_PLAN must include `**Files:**` per task — these are enforced by the guard.")
  lines.push("- You cannot write to files belonging to a different task.")
  lines.push("")

  // Mode-specific rules
  lines.push("## Mode-Specific Rules")
  lines.push("")
  lines.push("### GREENFIELD")
  lines.push("No constraints beyond the standard phases. Discovery is skipped.")
  lines.push("")
  lines.push("### REFACTOR")
  lines.push("Full discovery. Existing tests must pass after each implementation task.")
  lines.push("")
  lines.push("### INCREMENTAL")
  lines.push("Full discovery. File allowlist enforced — you can only modify files explicitly approved during PLANNING. Do-no-harm policy: bash write operators (>, >>, tee, sed -i) are blocked.")
  lines.push("")

  // Self-review
  lines.push("## Review Responsibility")
  lines.push("")
  lines.push(`Phase review is handled by an isolated reviewer subprocess with no access to the authoring conversation. Wait for the adapter hook to submit the review result, then continue according to the next prompt.`)

  return lines.join("\n")
}
