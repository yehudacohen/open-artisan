/**
 * template-sync.test.ts — Validates that adapter templates stay in sync
 * with the centralized workflow-template.ts generator.
 *
 * This test ensures that .hermes.md.tmpl and CLAUDE-WORKFLOW.md contain
 * the same structural content (phases, tools, blocked-per-phase rules)
 * as the centralized generator. When the generator is updated, these
 * templates must be regenerated.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { generateWorkflowTemplate } from "#core/workflow-template"

const ROOT = join(import.meta.dirname, "..")

describe("Workflow template sync", () => {
  const hermesTemplate = join(ROOT, "packages/adapter-hermes/.hermes.md.tmpl")
  const claudeWorkflow = join(ROOT, "CLAUDE-WORKFLOW.md")

  // Generate reference templates
  const hermesGenerated = generateWorkflowTemplate({
    toolPrefix: "oa_",
    argStyle: "tool",
    header: "# Open Artisan — Workflow Instructions",
  })

  it("Hermes template contains all phases from generator", () => {
    if (!existsSync(hermesTemplate)) return // skip if template not present
    const content = readFileSync(hermesTemplate, "utf-8")
    const phases = ["MODE_SELECT", "DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION", "DONE"]
    for (const phase of phases) {
      expect(content).toContain(phase)
    }
  })

  it("Hermes template contains all oa_ tools from generator", () => {
    if (!existsSync(hermesTemplate)) return
    const content = readFileSync(hermesTemplate, "utf-8")
    const tools = [
      "oa_select_mode", "oa_mark_scan_complete", "oa_mark_analyze_complete",
      "oa_mark_satisfied", "oa_request_review", "oa_submit_feedback",
      "oa_mark_task_complete", "oa_check_prior_workflow", "oa_resolve_human_gate",
      "oa_propose_backtrack", "oa_spawn_sub_workflow", "oa_query_parent_workflow",
      "oa_query_child_workflow", "oa_state",
    ]
    for (const tool of tools) {
      expect(content).toContain(tool)
    }
  })

  it("Hermes template blocked-per-phase table includes all sub-states", () => {
    if (!existsSync(hermesTemplate)) return
    const content = readFileSync(hermesTemplate, "utf-8")
    // Must have sub-state rows for PLANNING and IMPL_PLAN
    expect(content).toContain("PLANNING/DRAFT")
    expect(content).toContain("PLANNING/REVIEW")
    expect(content).toContain("PLANNING/USER_GATE")
    expect(content).toContain("PLANNING/REVISE")
    expect(content).toContain("IMPL_PLAN/DRAFT")
    expect(content).toContain("IMPL_PLAN/REVIEW")
  })

  it("CLAUDE-WORKFLOW.md contains all phases", () => {
    if (!existsSync(claudeWorkflow)) return
    const content = readFileSync(claudeWorkflow, "utf-8")
    const phases = ["MODE_SELECT", "DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION", "DONE"]
    for (const phase of phases) {
      expect(content).toContain(phase)
    }
  })

  it("Generator output contains all phases and sub-states", () => {
    const phases = ["MODE_SELECT", "DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION", "DONE"]
    for (const phase of phases) {
      expect(hermesGenerated).toContain(phase)
    }
    expect(hermesGenerated).toContain("PLANNING/DRAFT")
    expect(hermesGenerated).toContain("USER_GATE")
    expect(hermesGenerated).toContain("REVISE")
  })

  it("Generator output contains all tool names for Hermes config", () => {
    expect(hermesGenerated).toContain("oa_select_mode")
    expect(hermesGenerated).toContain("oa_request_review")
    expect(hermesGenerated).toContain("oa_mark_satisfied")
    expect(hermesGenerated).toContain("oa_state")
  })
})
