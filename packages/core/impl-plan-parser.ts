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
 * - Task IDs may be bare ("T1"), labeled ("Task T1"), or slugified ("task-auth")
 * - Dependencies may be comma-separated or space-separated, "none" means empty
 * - Expected tests may be absent (treated as empty array)
 * - Files may be absent (treated as empty array)
 * - Complexity defaults to "medium" if absent or unrecognized
 *
 * Returns a ParseResult with either the ImplDAG or a list of parse errors.
 */

import { createImplDAG } from "./dag"
import type { ImplDAG, TaskNode, TaskComplexity, TaskCategory } from "./dag"

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
 * Requires: starts with # marks, optional "Task" keyword, then an alphanumeric ID
 * (no *, no whitespace in ID), then a separator.
 * Using a strict ID pattern [A-Za-z][A-Za-z0-9_-]* prevents matching bold Markdown
 * like "**Dependencies:**" as a task header.
 */
const TASK_HEADER_RE = /^#{1,3}\s+(?:Task\s+)?([A-Za-z][A-Za-z0-9_-]*)[:\s—–-]+(.+)/i

/**
 * Matches "**Dependencies:** T1, T2" or "**Depends on:** T1".
 * The separator pattern `[*:\s]+` handles bold Markdown closing `**` before the colon.
 */
const DEPS_RE = /^\*{0,2}(?:Dep(?:endencies|ends on)|Requires?)[*:\s]+(.+)/i

/** Matches "**Expected tests:** tests/foo.test.ts, tests/bar.test.ts" */
const TESTS_RE = /^\*{0,2}Expected\s+tests?[*:\s]+(.+)/i

/** Matches "**Complexity:** small" */
const COMPLEXITY_RE = /^\*{0,2}Complexity[*:\s]+(.+)/i

/** Matches "**Category:** scaffold" or "**Category:** human-gate" */
const CATEGORY_RE = /^\*{0,2}Category[*:\s]+(.+)/i

/** Matches "**Files:** src/foo.ts, src/bar.ts" or "**Expected files:** ..." */
const FILES_RE = /^\*{0,2}(?:Expected\s+)?files?[*:\s]+(.+)/i

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

    const headerMatch = TASK_HEADER_RE.exec(line)
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
        bodyLines: [],
      }
      continue
    }

    if (!current) continue

    const depsMatch = DEPS_RE.exec(line)
    if (depsMatch) {
      current.rawDeps = depsMatch[1]!.trim()
      continue
    }

    const testsMatch = TESTS_RE.exec(line)
    if (testsMatch) {
      current.rawTests = testsMatch[1]!.trim()
      continue
    }

    const filesMatch = FILES_RE.exec(line)
    if (filesMatch) {
      current.rawFiles = filesMatch[1]!.trim()
      continue
    }

    const complexityMatch = COMPLEXITY_RE.exec(line)
    if (complexityMatch) {
      current.rawComplexity = complexityMatch[1]!.trim()
      continue
    }

    const categoryMatch = CATEGORY_RE.exec(line)
    if (categoryMatch) {
      current.rawCategory = categoryMatch[1]!.trim()
      continue
    }

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
