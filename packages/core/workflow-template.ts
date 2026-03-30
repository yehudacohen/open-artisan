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
 * TODO: Integrate into adapter setup scripts (artisan-setup.ts, hermes __main__.py)
 * so templates are generated from this source instead of maintained separately.
 * Currently exported but not called — will be wired in when setup scripts are
 * refactored to use shared generation.
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
  { cli: "select-mode", tool: "select_mode", desc: "Choose mode + set feature name" },
  { cli: "mark-scan-complete", tool: "mark_scan_complete", desc: "Complete discovery scan" },
  { cli: "mark-analyze-complete", tool: "mark_analyze_complete", desc: "Complete discovery analysis" },
  { cli: "mark-satisfied", tool: "mark_satisfied", desc: "Submit self-review criteria" },
  { cli: "request-review", tool: "request_review", desc: "Submit artifact for review" },
  { cli: "submit-feedback", tool: "submit_feedback", desc: "Approve or request revision" },
  { cli: "mark-task-complete", tool: "mark_task_complete", desc: "Complete a DAG task" },
  { cli: "check-prior-workflow", tool: "check_prior_workflow", desc: "Check for prior state" },
  { cli: "resolve-human-gate", tool: "resolve_human_gate", desc: "Set human gate on task" },
  { cli: "propose-backtrack", tool: "propose_backtrack", desc: "Go back to earlier phase" },
  { cli: "spawn-sub-workflow", tool: "spawn_sub_workflow", desc: "Delegate task to child" },
  { cli: "query-parent-workflow", tool: "query_parent_workflow", desc: "Read parent state" },
  { cli: "query-child-workflow", tool: "query_child_workflow", desc: "Read child state" },
  { cli: "state", tool: "state", desc: "Show current workflow state" },
]

function formatToolName(tool: typeof TOOLS[0], config: TemplateConfig): string {
  if (config.argStyle === "cli") {
    return `\`${config.toolPrefix} ${tool.cli}\``
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

  // Sub-state behavior
  lines.push("## Expected Behavior Per Sub-State")
  lines.push("")
  lines.push("### DRAFT")
  lines.push("Do the work for this phase. When done, call `request_review`.")
  lines.push("")
  lines.push("### REVIEW")
  lines.push("Self-evaluate against the acceptance criteria. Evaluate each criterion independently. Call `mark_satisfied` with your per-criterion assessment. Be honest — the user reviews at USER_GATE.")
  lines.push("")
  lines.push("### USER_GATE")
  lines.push("Present a clear artifact summary to the user. **STOP and wait for their response.** Do NOT call `submit_feedback` until the user responds.")
  lines.push("")
  lines.push("### REVISE")
  lines.push("Address ALL feedback points. Call `request_review` when done. No check-ins, no partial revisions.")
  lines.push("")

  // Blocked per phase table
  lines.push("## What's Blocked Per Phase")
  lines.push("")
  lines.push("| Phase / Sub-State | Allowed | Blocked |")
  lines.push("|-------------------|---------|---------|")
  lines.push("| MODE_SELECT | Workflow tools, read-only shell | File writes |")
  lines.push("| DISCOVERY/SCAN | Read-only tools, workflow tools | File writes, shell execution |")
  lines.push("| DISCOVERY/ANALYZE | Read-only tools, workflow tools | File writes, shell execution |")
  lines.push("| DISCOVERY/CONVENTIONS | `.openartisan/` writes only | Project source writes, shell execution |")
  lines.push("| PLANNING/DRAFT | Workflow tools only | File writes, shell execution |")
  lines.push("| PLANNING/REVIEW | `.openartisan/` writes, read-only shell | Project source writes |")
  lines.push("| PLANNING/USER_GATE | Read-only shell, workflow tools | File writes |")
  lines.push("| PLANNING/REVISE | `.openartisan/` writes, read-only shell | Project source writes |")
  lines.push("| INTERFACES | Interface/type files only | Implementation files |")
  lines.push("| TESTS | Test files only | Implementation files |")
  lines.push("| IMPL_PLAN/DRAFT | Workflow tools only | File writes, shell execution |")
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
  lines.push("- One task at a time from the DAG. The current task is shown in the per-turn prompt.")
  lines.push("- Call `mark_task_complete` after each task.")
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
  lines.push("## Self-Review Responsibility")
  lines.push("")
  lines.push("`mark_satisfied` evaluates YOUR criteria. There is no isolated reviewer in agent-only mode — you are responsible for honest self-assessment. The user reviews at USER_GATE.")

  return lines.join("\n")
}
