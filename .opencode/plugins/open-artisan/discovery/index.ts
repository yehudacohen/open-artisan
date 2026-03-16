/**
 * discovery/index.ts — Parallel subagent fleet for the DISCOVERY phase (Design doc §3.3).
 *
 * Dispatches 6 explorer subagents in parallel, each in an isolated ephemeral session
 * that sees only a specific scan task. Results are assembled into a single DiscoveryReport
 * and injected into the CONVENTIONS drafting prompt.
 *
 * Subagents:
 *   1. Structure scanner  — file tree, module boundaries, package structure
 *   2. Convention detector — coding style, naming patterns, import conventions
 *   3. Architecture analyzer — module dependency graph, key abstractions
 *   4. Test pattern scanner — test framework, organization, naming conventions
 *   5. History analyzer  — commit patterns, active areas, recent changes
 *   6. Docs reader       — AGENTS.md, README.md, CONTRIBUTING.md, docs/
 *
 * Each subagent uses the workflow-reviewer agent (read-only, no writes).
 * If any individual scan fails, its result is included as a best-effort error note
 * so the CONVENTIONS draft can still proceed with partial information.
 *
 * Wiring: called from `mark_analyze_complete` execute path when transitioning to
 * DISCOVERY/CONVENTIONS. The returned DiscoveryReport is injected into the
 * CONVENTIONS drafting prompt via the system-transform hook.
 */

import type { WorkflowMode } from "../types"
import type { PluginClient } from "../client-types"
import { withTimeout, extractTextFromPromptResult, extractEphemeralSessionId } from "../utils"
import { SCANNER_TIMEOUT_MS, MIN_SCANNERS_THRESHOLD } from "../constants"
import { createLogger } from "../logger"

// Re-export for consumers that import from this module
export { MIN_SCANNERS_THRESHOLD }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScannerResult {
  scanner: string
  success: boolean
  /** Markdown-formatted output from the scanner subagent */
  output: string
}

export interface DiscoveryReport {
  /** True if at least one scanner completed successfully */
  hasResults: boolean
  /**
   * True when fewer than MIN_SCANNERS_THRESHOLD scanners succeeded.
   * The conventions draft should proceed but with a prominent warning.
   */
  lowConfidence: boolean
  /** Per-scanner results (success or error note) */
  scanners: ScannerResult[]
  /**
   * Combined markdown report suitable for injection into the CONVENTIONS prompt.
   * Aggregates all scanner outputs under named sections.
   */
  combinedReport: string
}

// ---------------------------------------------------------------------------
// Scanner definitions
// ---------------------------------------------------------------------------

interface ScannerDef {
  name: string
  prompt: (cwd: string, mode: WorkflowMode) => string
}

/**
 * Returns a mode-specific focus preamble for scanner prompts.
 * REFACTOR: emphasize identifying problems and improvement opportunities.
 * INCREMENTAL: emphasize documenting constraints the agent must follow.
 */
function modeFocus(mode: WorkflowMode): string {
  if (mode === "REFACTOR") {
    return "You are in REFACTOR mode. Focus on identifying problems, anti-patterns, and improvement opportunities alongside documenting what exists. Call out what is wrong and why."
  }
  return "You are in INCREMENTAL mode (do-no-harm). Focus on documenting the rules and constraints the existing code follows. The goal is to produce a constraint list that ensures new code is indistinguishable from existing code."
}

const SCANNERS: ScannerDef[] = [
  {
    name: "Structure Scanner",
    prompt: (cwd, mode) => `You are scanning a codebase to produce a structural overview.
Working directory: ${cwd}
${modeFocus(mode)}

Your task:
1. Use glob/list tools to enumerate all source files, grouping by type (e.g. .ts, .py, .go, .rs)
2. Identify top-level modules, packages, or directories that form the major structural boundaries
3. Estimate file counts and lines of code per major area (use bash "wc -l" or similar)
4. Identify entry points (main files, index files, CLI entry points)
5. Note any monorepo or multi-package structure
${mode === "REFACTOR" ? "6. Flag any structural problems: overly large modules, unclear boundaries, circular directory dependencies" : "6. Document the file placement rules: where do new source files, tests, and configs go?"}

Return a concise Markdown report with:
- Directory tree (2-3 levels deep max)
- Module/package breakdown with file counts
- Entry points
- Total source file count by extension
${mode === "REFACTOR" ? "- Structural issues identified (if any)" : "- File placement rules for new code"}`,
  },
  {
    name: "Convention Detector",
    prompt: (cwd, mode) => `You are scanning a codebase to detect coding conventions and style rules.
Working directory: ${cwd}
${modeFocus(mode)}

Your task:
1. Read config files: .editorconfig, .eslintrc*, tsconfig.json, pyproject.toml, .prettierrc, etc.
2. Read 3-5 representative source files to observe actual naming patterns in use
3. Identify: indentation style (tabs vs spaces, width), quote style, semicolons, line length limit
4. Identify naming conventions: camelCase/snake_case/PascalCase for files, functions, classes, constants
5. Identify import patterns: relative vs absolute, barrel files, path aliases
6. Identify error handling patterns: throw vs return, typed errors, Result types
${mode === "REFACTOR" ? "7. Flag any inconsistencies: places where the codebase violates its own conventions" : "7. For each convention, provide a concrete example that new code must match exactly"}

Return a concise Markdown report with one section per convention category.
Use concrete examples quoted from the actual files.`,
  },
  {
    name: "Architecture Analyzer",
    prompt: (cwd, mode) => `You are analyzing the architecture of a codebase.
Working directory: ${cwd}
${modeFocus(mode)}

Your task:
1. Read key source files (interfaces, types, main modules, public APIs)
2. Identify the primary abstractions: what are the core types/interfaces/classes?
3. Map dependencies between modules: which module imports from which?
   Use grep to trace import/require statements. If LSP tools are available (e.g. go-to-definition,
   find-references), prefer those for more accurate dependency resolution; fall back to grep/read.
4. Identify layering: is there a clear separation of concerns (e.g. domain/infra/presentation)?
5. Identify communication patterns: function calls, events, queues, HTTP, shared state
6. Note any dependency injection, plugin systems, or factory patterns
${mode === "REFACTOR" ? "7. Identify architectural problems: tight coupling, layering violations, missing abstractions, overly complex patterns" : "7. Document the dependency direction rules: which modules are allowed to import from which?"}

Return a concise Markdown report with:
- Core abstractions list with one-line descriptions
- Dependency map (module A → module B → ...)
- Layer diagram if applicable
- Key architectural patterns in use
${mode === "REFACTOR" ? "- Architectural issues and improvement opportunities" : "- Rules for extending the architecture without violating existing patterns"}`,
  },
  {
    name: "Test Pattern Scanner",
    prompt: (cwd, mode) => `You are scanning a codebase to understand its test patterns.
Working directory: ${cwd}
${modeFocus(mode)}

Your task:
1. Use glob to find all test files (*.test.*, *.spec.*, test_*.*, *_test.*)
2. Read the test runner config (package.json scripts, pytest.ini, .mocharc, etc.)
3. Read 2-3 representative test files to observe test structure
4. Identify: test framework (Jest/Vitest/Bun/pytest/etc.), assertion style, mock patterns
5. Identify test file naming and directory conventions
6. Check if tests are colocated with source or in a separate directory
7. Identify test helper/fixture patterns if any
${mode === "REFACTOR" ? "8. Flag test quality issues: missing coverage areas, fragile tests, test anti-patterns" : "8. Document the exact test structure pattern new tests must follow (copy the pattern, don't invent)"}

Return a concise Markdown report with:
- Test framework and runner
- File naming and directory conventions
- Test structure pattern (describe/it nesting, etc.)
- Mock/stub approach
- Total test file count
${mode === "REFACTOR" ? "- Test quality issues identified" : "- Template for writing new tests that match existing style"}`,
  },
  {
    name: "History Analyzer",
    prompt: (cwd, mode) => `You are analyzing the git history of a codebase to identify patterns.
Working directory: ${cwd}
${modeFocus(mode)}

Your task — use bash commands to run git queries:
1. git log --oneline -20 to see recent commit messages (identify message style, scope conventions)
2. git shortlog -sn --no-merges -10 to identify top contributors
3. git diff --stat HEAD~10 HEAD to see recently changed files (hot areas)
4. Pick 2-3 key files you identified (e.g. main entry point, core modules) and run git log --oneline --follow on them to see their change frequency
5. Note any branch naming conventions from recent branch names if visible
${mode === "REFACTOR" ? "6. Identify areas with high churn that may benefit from refactoring" : "6. Identify areas that are actively maintained vs. stable (to avoid disturbing stable code)"}

Return a concise Markdown report with:
- Commit message style (conventional commits? issue numbers? etc.)
- Hot areas (most frequently changed files/directories)
- Recent focus areas (what has changed in the last 20 commits)
- Contributor note (number of contributors, solo vs team)
${mode === "REFACTOR" ? "- High-churn areas that may indicate design problems" : "- Stable areas that should not be touched without strong reason"}

If the directory has no git history, report that clearly.`,
  },
  {
    name: "Docs Reader",
    prompt: (cwd, mode) => `You are reading existing documentation files in a codebase.
Working directory: ${cwd}
${modeFocus(mode)}

Your task:
1. Look for and read (if they exist): AGENTS.md, README.md, CONTRIBUTING.md, DEVELOPMENT.md, docs/, .github/
2. Extract: setup instructions, architecture decisions, documented conventions, DO NOT TOUCH lists
3. Extract any explicitly stated rules for AI agents (AGENTS.md content is highest priority)
4. Note any "do not modify" or "owned by" annotations in source comments
${mode === "REFACTOR" ? "5. Check if existing docs are outdated or inconsistent with the actual codebase" : "5. Reproduce all agent-specific rules and constraints verbatim — these are binding"}

Return a concise Markdown report with:
- Summary of AGENTS.md (if exists) — reproduce any agent-specific rules verbatim
- Documented conventions from CONTRIBUTING.md
- Key setup/development instructions from README
- Any explicit "DO NOT TOUCH" or ownership constraints found
${mode === "REFACTOR" ? "- Docs that appear outdated or inconsistent" : "- Complete constraint list for AI agents (binding)"}`,
  },
]

// ---------------------------------------------------------------------------
// Ephemeral session helper
// ---------------------------------------------------------------------------

async function runScannerSession(
  client: PluginClient,
  scannerName: string,
  prompt: string,
  parentSessionId?: string,
  featureName?: string | null,
): Promise<ScannerResult> {
  let sessionId: string | undefined

  try {
    if (!client.session) throw new Error("client.session is not available — cannot dispatch scanner")
    const featureSlug = featureName ? ` (${featureName})` : ""
    const created = await client.session.create({
      body: {
        title: `Discovery: ${scannerName}${featureSlug}`,
        agent: "workflow-reviewer",
        ...(parentSessionId ? { parentID: parentSessionId } : {}),
      },
    })

    sessionId = extractEphemeralSessionId(created, scannerName)

    const raw = await withTimeout(
      client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: prompt }],
        },
      }) as Promise<Record<string, unknown>>,
      SCANNER_TIMEOUT_MS,
      `discovery scanner "${scannerName}"`,
    )

    const text = extractTextFromPromptResult(raw, scannerName)
    return { scanner: scannerName, success: true, output: text }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const log = createLogger(client)
    log.warn("Discovery scanner failed", { detail: msg })
    return {
      scanner: scannerName,
      success: false,
      output: `*Scanner failed: ${msg}*\n\nThis section could not be completed during discovery.`,
    }
  } finally {
    // Skip delete for child sessions — OpenCode's SQLite FK constraints can
    // reject the delete. Child sessions are cleaned up with the parent.
    if (sessionId && !parentSessionId) {
      try { await client.session?.delete({ path: { id: sessionId } }) } catch { /* ignore */ }
    }
  }
}

// extractTextFromPromptResult and extractEphemeralSessionId are imported from ../utils

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function buildCombinedReport(scanners: ScannerResult[], lowConfidence: boolean): string {
  const lines: string[] = []
  lines.push("# Discovery Report")
  lines.push("")
  lines.push("*Generated by parallel subagent scanners. Use this as input for the conventions document draft.*")
  lines.push("")

  if (lowConfidence) {
    lines.push("**WARNING: Low confidence report.** Fewer than the minimum required scanners succeeded.")
    lines.push("The conventions document produced from this report may be incomplete. Consider re-running discovery or filling gaps manually.")
    lines.push("")
  }

  for (const s of scanners) {
    lines.push(`## ${s.scanner}`)
    lines.push("")
    lines.push(s.output)
    lines.push("")
    if (!s.success) {
      lines.push("---")
      lines.push("")
    }
  }

  const successCount = scanners.filter((s) => s.success).length
  lines.push(`---`)
  lines.push(`*${successCount}/${scanners.length} scanners completed successfully.*`)

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Dispatches all 6 scanner subagents in parallel and assembles a DiscoveryReport.
 *
 * All scanners run concurrently via Promise.all — total wall time is bounded by
 * the slowest scanner rather than their sum. Failures are captured as best-effort
 * error notes; the report still proceeds with whatever partial results are available.
 *
 * @param client - OpenCode client (session.create/prompt/delete)
 * @param cwd - Absolute path to the project root directory
 * @param mode - Workflow mode (currently unused, reserved for future mode-specific scan adjustments)
 */
export async function runDiscoveryFleet(
  client: PluginClient,
  cwd: string,
  mode: WorkflowMode,
  parentSessionId?: string,
  featureName?: string | null,
): Promise<DiscoveryReport> {
  const scannerRuns = SCANNERS.map((def) =>
    runScannerSession(client, def.name, def.prompt(cwd, mode), parentSessionId, featureName),
  )

  const results = await Promise.all(scannerRuns)

  const successCount = results.filter((r) => r.success).length
  const hasResults = successCount > 0
  const lowConfidence = successCount < MIN_SCANNERS_THRESHOLD
  const combinedReport = buildCombinedReport(results, lowConfidence)

  return { hasResults, lowConfidence, scanners: results, combinedReport }
}

// Re-export scanner names for consumers who need to reference them
export const SCANNER_NAMES = SCANNERS.map((s) => s.name)
