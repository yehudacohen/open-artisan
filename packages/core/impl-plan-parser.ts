/**
 * impl-plan-parser.ts — Parses a free-text IMPL_PLAN artifact into an ImplDAG.
 *
 * The IMPL_PLAN artifact is produced by the agent in Markdown format.
 * This parser extracts task blocks and produces typed TaskNode objects.
 *
 * Expected IMPL_PLAN format (agent produces this during IMPL_PLAN/DRAFT):
 *
 *   ## Task T1: Set up database schema
 *   **Dependencies:** none
 *   **Expected tests:** tests/db.test.ts, tests/schema.test.ts
 *   **Files:** src/db/schema.ts, src/db/migrations/001.sql
 *   **Complexity:** small
 *   <description prose>
 *
 *   ## Task T2: Implement repository layer
 *   **Dependencies:** T1
 *   **Expected tests:** tests/repository.test.ts
 *   **Files:** src/db/repository.ts
 *   **Complexity:** medium
 *   <description prose>
 *
 * Parser is tolerant of minor formatting variations:
 * - Task IDs may be labeled ("Task T1") or use task-shaped IDs like "T1" / "task-auth"
 * - Dependencies may be comma-separated or space-separated, "none" means empty
 * - Expected tests may be absent (treated as empty array)
 * - Files may be absent (treated as empty array)
 * - Complexity defaults to "medium" if absent or unrecognized
 *
 * Returns a ParseResult with either the ImplDAG or a list of parse errors.
 */

import { resolve } from "node:path"
import { createImplDAG } from "./dag"
import type { ImplDAG, TaskNode, TaskComplexity, TaskCategory } from "./dag"
import type { WorkflowMode } from "./types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParseSuccess {
  success: true
  dag: ImplDAG
}

export interface ParseError {
  success: false
  errors: string[]
}

export type ParseResult = ParseSuccess | ParseError

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Matches task header lines:
 *   ## Task T1: description
 *   ## T1: description
 *   ## Task T1 — description
 *   ### Task T2: description
 *
 * Requires either:
 * - an explicit "Task" keyword before the ID, OR
 * - a task-shaped ID without the keyword (`T1`, `T10`, `task-auth`)
 * This prevents normal section headings like "## Goal" or "## Task List" from
 * being misparsed as DAG tasks.
 */
const TASK_HEADER_WITH_LABEL_RE = /^#{1,3}\s+Task\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s*[:.—–-]\s*|\s+)(.+)/i
const TASK_HEADER_BARE_RE = /^#{1,3}\s+((?:T\d+[A-Za-z0-9_-]*|task-[A-Za-z0-9_-]+))\s*[:.—–]\s*(.+)/i

/**
 * Matches "**Dependencies:** T1, T2" or "**Depends on:** T1".
 * The separator pattern `[*:\s]+` handles bold Markdown closing `**` before the colon.
 */
const DEPS_RE = /^\s*(?:-\s*)?\*{0,2}(?:Dep(?:endencies|ends on)|Requires?)[*:\s]+(.*)$/i

/** Matches "**Expected tests:** ..." or shorthand "**Tests:** ..." */
const TESTS_RE = /^\s*(?:-\s*)?\*{0,2}(?:Expected\s+)?tests?[*:\s]+(.*)$/i

/** Matches "**Complexity:** small" */
const COMPLEXITY_RE = /^\s*(?:-\s*)?\*{0,2}Complexity[*:\s]+(.*)$/i

/** Matches "**Category:** scaffold" or "**Category:** human-gate" */
const CATEGORY_RE = /^\s*(?:-\s*)?\*{0,2}Category[*:\s]+(.*)$/i

/** Matches "**Files:** src/foo.ts, src/bar.ts" or "**Expected files:** ..." */
const FILES_RE = /^\s*(?:-\s*)?\*{0,2}(?:Expected\s+)?files?[*:\s]+(.*)$/i

const LIST_ITEM_RE = /^\s*[-*]\s+(.+)$/

// ---------------------------------------------------------------------------
// Line-level parsers
// ---------------------------------------------------------------------------

/** Splits a comma/space-separated list, returning [] for "none"/empty/"-". */
function parseList(raw: string): string[] {
  const trimmed = raw.trim()
  if (/^none$/i.test(trimmed) || trimmed === "" || trimmed === "-") return []
  return trimmed
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^none$/i.test(s))
}

function parseComplexity(raw: string): TaskComplexity {
  const lower = raw.trim().toLowerCase()
  if (lower === "small") return "small"
  if (lower === "large") return "large"
  return "medium" // default for unknown/medium/anything else
}

/**
 * Parses a task category string. Returns undefined for absent/unrecognized values,
 * which means the task defaults to "standalone" (handled at node construction time).
 */
function parseCategory(raw: string): TaskCategory | undefined {
  const lower = raw.trim().toLowerCase().replace(/[\s_]+/g, "-")
  if (lower === "scaffold") return "scaffold"
  if (lower === "human-gate" || lower === "humangate") return "human-gate"
  if (lower === "integration") return "integration"
  if (lower === "standalone") return "standalone"
  return undefined // unknown — will default to "standalone"
}

// ---------------------------------------------------------------------------
// Block extractor
// ---------------------------------------------------------------------------

interface RawBlock {
  id: string
  description: string
  rawDeps: string
  rawTests: string
  rawFiles: string
  rawComplexity: string
  rawCategory: string
  hasDepsField: boolean
  hasTestsField: boolean
  hasFilesField: boolean
  bodyLines: string[]
}

/**
 * Splits the artifact text into raw task blocks by scanning for task headers.
 * Returns one block per task section found.
 */
function extractRawBlocks(text: string): RawBlock[] {
  const lines = text.split("\n")
  const blocks: RawBlock[] = []
  let current: RawBlock | null = null
  let inCodeBlock = false
  let pendingListField: "deps" | "tests" | "files" | null = null

  for (const line of lines) {
    // Track fenced code blocks — ignore task headers inside them
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock
      if (current) current.bodyLines.push(line)
      continue
    }

    if (inCodeBlock) {
      if (current) current.bodyLines.push(line)
      continue
    }

    const labeledMatch = TASK_HEADER_WITH_LABEL_RE.exec(line)
    const bareMatch = TASK_HEADER_BARE_RE.exec(line)
    const headerMatch = labeledMatch ?? bareMatch
    if (headerMatch) {
      if (current) blocks.push(current)
      current = {
        id: headerMatch[1]!.trim(),
        description: headerMatch[2]!.trim(),
        rawDeps: "",
        rawTests: "",
        rawFiles: "",
        rawComplexity: "",
        rawCategory: "",
        hasDepsField: false,
        hasTestsField: false,
        hasFilesField: false,
        bodyLines: [],
      }
      pendingListField = null
      continue
    }

    if (!current) continue

    const depsMatch = DEPS_RE.exec(line)
    if (depsMatch) {
      current.hasDepsField = true
      current.rawDeps = depsMatch[1]!.trim()
      pendingListField = current.rawDeps === "" ? "deps" : null
      continue
    }

    const testsMatch = TESTS_RE.exec(line)
    if (testsMatch) {
      current.hasTestsField = true
      current.rawTests = testsMatch[1]!.trim()
      pendingListField = current.rawTests === "" ? "tests" : null
      continue
    }

    const filesMatch = FILES_RE.exec(line)
    if (filesMatch) {
      current.hasFilesField = true
      current.rawFiles = filesMatch[1]!.trim()
      pendingListField = current.rawFiles === "" ? "files" : null
      continue
    }

    const complexityMatch = COMPLEXITY_RE.exec(line)
    if (complexityMatch) {
      current.rawComplexity = complexityMatch[1]!.trim()
      pendingListField = null
      continue
    }

    const categoryMatch = CATEGORY_RE.exec(line)
    if (categoryMatch) {
      current.rawCategory = categoryMatch[1]!.trim()
      pendingListField = null
      continue
    }

    const listItemMatch = pendingListField ? LIST_ITEM_RE.exec(line) : null
    if (pendingListField && listItemMatch) {
      const value = listItemMatch[1]!.trim()
      if (value.length > 0) {
        if (pendingListField === "deps") {
          current.rawDeps = current.rawDeps ? `${current.rawDeps}, ${value}` : value
        } else if (pendingListField === "tests") {
          current.rawTests = current.rawTests ? `${current.rawTests}, ${value}` : value
        } else {
          current.rawFiles = current.rawFiles ? `${current.rawFiles}, ${value}` : value
        }
      }
      continue
    }

    if (pendingListField && line.trim() === "") {
      continue
    }

    pendingListField = null

    current.bodyLines.push(line)
  }

  if (current) blocks.push(current)
  return blocks
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parses an IMPL_PLAN artifact text into a typed ImplDAG.
 *
 * Returns ParseSuccess with the validated DAG, or ParseError with a list of
 * problems found during parsing and/or DAG validation.
 */
export function parseImplPlan(artifactText: string): ParseResult {
  if (!artifactText || artifactText.trim().length === 0) {
    return { success: false, errors: ["IMPL_PLAN artifact is empty"] }
  }

  const rawBlocks = extractRawBlocks(artifactText)
  if (rawBlocks.length === 0) {
    return {
      success: false,
      errors: [
        "No task blocks found in IMPL_PLAN artifact. " +
        "Expected sections like '## Task T1: description' with Dependencies/Expected tests fields.",
      ],
    }
  }

  const parseErrors: string[] = []
  const nodes: TaskNode[] = []

  for (const block of rawBlocks) {
    if (!block.id) {
      parseErrors.push("A task block has an empty ID — skipping")
      continue
    }

    // Build description from header title + body prose
    const bodyProse = block.bodyLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(" ")
    const description = bodyProse
      ? `${block.description} — ${bodyProse}`.slice(0, 500)
      : block.description

    const category = parseCategory(block.rawCategory)
    nodes.push({
      id: block.id,
      description,
      dependencies: parseList(block.rawDeps),
      expectedTests: parseList(block.rawTests),
      expectedFiles: parseList(block.rawFiles),
      estimatedComplexity: parseComplexity(block.rawComplexity),
      status: "pending",
      // Only set category if explicitly specified; undefined = defaults to "standalone"
      // semantics in stub detection and scheduler logic
      ...(category ? { category } : {}),
    })
  }

  if (parseErrors.length > 0 && nodes.length === 0) {
    return { success: false, errors: parseErrors }
  }

  // DAG-level validation (cycles, dangling refs)
  const dag = createImplDAG(nodes)
  const validation = dag.validate()

  if (!validation.valid) {
    return { success: false, errors: [...parseErrors, ...validation.errors] }
  }

  return { success: true, dag }
}

export function validateExecutableImplPlan(
  artifactText: string,
  mode: WorkflowMode | null,
  fileAllowlist: string[],
  cwd: string,
): string[] {
  const errors: string[] = []
  const rawBlocks = extractRawBlocks(artifactText)

  for (const block of rawBlocks) {
    if (!block.hasDepsField) {
      errors.push(`Task "${block.id}" must declare **Dependencies:** explicitly.`)
    }
    if (!block.hasTestsField) {
      errors.push(`Task "${block.id}" must declare **Expected tests:** explicitly (use \`none\` if there are none).`)
    }
    if (!block.hasFilesField) {
      errors.push(`Task "${block.id}" must declare **Files:** explicitly.`)
    }
  }

  if (mode !== "INCREMENTAL") {
    return errors
  }

  const parsed = parseImplPlan(artifactText)
  if (!parsed.success) {
    return errors
  }

  const normalizedAllowlist = new Set(
    fileAllowlist.map((path) => (path.startsWith("/") ? path : resolve(cwd, path))),
  )

  for (const task of parsed.dag.tasks) {
    const scopedPaths = [...task.expectedFiles, ...task.expectedTests].map((path) =>
      path.startsWith("/") ? path : resolve(cwd, path),
    )

    if (scopedPaths.length > 0 && normalizedAllowlist.size === 0) {
      errors.push(
        `Task "${task.id}" declares executable file/test scope, but the approved INCREMENTAL allowlist is empty.`,
      )
      continue
    }

    const outOfScope = scopedPaths.filter((path) => !normalizedAllowlist.has(path))
    if (outOfScope.length > 0) {
      errors.push(
        `Task "${task.id}" references files outside the approved INCREMENTAL allowlist: ${outOfScope.join(", ")}`,
      )
    }
  }

  return errors
}
