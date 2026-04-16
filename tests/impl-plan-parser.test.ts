/**
 * Tests for impl-plan-parser.ts — parses free-text IMPL_PLAN into an ImplDAG.
 *
 * Covers:
 * - Happy path: well-formed plan with multiple tasks
 * - Dependency parsing: none, single, multiple, comma/space-separated
 * - Expected tests parsing: none, single, multiple paths
 * - Complexity parsing: small/medium/large; default to medium for unknown
 * - Empty input → ParseError
 * - No task headers found → ParseError
 * - DAG-level errors surface as ParseError (cycles, missing deps)
 * - Partial tasks (missing optional fields) still parse
 */
import { describe, expect, it } from "bun:test"
import { parseImplPlan, validateExecutableImplPlan } from "#core/impl-plan-parser"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIMPLE_PLAN = `
## Task T1: Set up database schema
**Dependencies:** none
**Expected tests:** tests/db.test.ts
**Complexity:** small

Create the initial database schema with users and sessions tables.

## Task T2: Implement repository layer
**Dependencies:** T1
**Expected tests:** tests/repository.test.ts, tests/user-repo.test.ts
**Complexity:** medium

Implement the repository abstraction on top of the schema from T1.

## Task T3: Add HTTP handlers
**Dependencies:** T2
**Expected tests:** tests/handlers.test.ts
**Complexity:** medium

Wire up the HTTP handlers using the repository from T2.
`

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("parseImplPlan — happy path", () => {
  it("returns success=true for a well-formed plan", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    expect(result.success).toBe(true)
  })

  it("extracts all 3 tasks", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(result.dag.tasks).toHaveLength(3)
  })

  it("extracts correct task IDs", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    if (!result.success) throw new Error(result.errors.join("; "))
    const ids = Array.from(result.dag.tasks).map((t) => t.id)
    expect(ids).toContain("T1")
    expect(ids).toContain("T2")
    expect(ids).toContain("T3")
  })

  it("parses T1 with no dependencies", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.dependencies).toHaveLength(0)
  })

  it("parses T2 with dependency on T1", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t2 = Array.from(result.dag.tasks).find((t) => t.id === "T2")!
    expect(t2.dependencies).toEqual(["T1"])
  })

  it("parses expected tests correctly", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t2 = Array.from(result.dag.tasks).find((t) => t.id === "T2")!
    expect(t2.expectedTests).toContain("tests/repository.test.ts")
    expect(t2.expectedTests).toContain("tests/user-repo.test.ts")
  })

  it("parses complexity correctly", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.estimatedComplexity).toBe("small")
  })

  it("all parsed tasks start with status=pending", () => {
    const result = parseImplPlan(SIMPLE_PLAN)
    if (!result.success) throw new Error(result.errors.join("; "))
    for (const t of result.dag.tasks) {
      expect(t.status).toBe("pending")
    }
  })

  it("strips markdown backticks from files and expected tests", () => {
    const plan = `
## Task T1: Backticked paths
**Dependencies:** none
**Files:** \`src/a.ts\`, \`src/b.ts\`
**Expected tests:** \`tests/a.test.ts\`, \`tests/b.test.ts\`
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const task = Array.from(result.dag.tasks)[0]!
    expect(task.expectedFiles).toEqual(["src/a.ts", "src/b.ts"])
    expect(task.expectedTests).toEqual(["tests/a.test.ts", "tests/b.test.ts"])
  })
})

describe("parseImplPlan — ignores non-task section headings", () => {
  it("does not parse plan section headings as DAG tasks", () => {
    const plan = `
# Shared Bridge Service Implementation Plan

## Goal

Build a shared local bridge.

## Task List

### T1 - not a valid task header without colon

## Task T1: Bridge metadata and discovery
**Dependencies:** none

Implement metadata and discovery.

## Validation Summary

Only T1 should be parsed.
`

    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const tasks = Array.from(result.dag.tasks)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.id).toBe("T1")
  })
})

// ---------------------------------------------------------------------------
// Dependency parsing variants
// ---------------------------------------------------------------------------

describe("parseImplPlan — dependency parsing", () => {
  it("handles multiple comma-separated dependencies", () => {
    const plan = `
## Task T1: First task
**Dependencies:** none

## Task T2: Second task
**Dependencies:** none

## Task T3: Third task
**Dependencies:** T1, T2
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t3 = Array.from(result.dag.tasks).find((t) => t.id === "T3")!
    expect(t3.dependencies).toContain("T1")
    expect(t3.dependencies).toContain("T2")
    expect(t3.dependencies).toHaveLength(2)
  })

  it("handles 'none' as empty dependencies", () => {
    const plan = `## Task T1: A task\n**Dependencies:** none\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.dependencies).toHaveLength(0)
  })

  it("handles missing Dependencies field (defaults to empty)", () => {
    const plan = `## Task T1: A task\n**Complexity:** small\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.dependencies).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Complexity parsing
// ---------------------------------------------------------------------------

describe("parseImplPlan — complexity parsing", () => {
  it("parses 'small' complexity", () => {
    const plan = `## Task T1: task\n**Dependencies:** none\n**Complexity:** small\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.estimatedComplexity).toBe("small")
  })

  it("parses 'large' complexity", () => {
    const plan = `## Task T1: task\n**Dependencies:** none\n**Complexity:** large\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.estimatedComplexity).toBe("large")
  })

  it("defaults unknown complexity to 'medium'", () => {
    const plan = `## Task T1: task\n**Dependencies:** none\n**Complexity:** unknown-value\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.estimatedComplexity).toBe("medium")
  })

  it("defaults missing complexity to 'medium'", () => {
    const plan = `## Task T1: task\n**Dependencies:** none\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.estimatedComplexity).toBe("medium")
  })
})

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("parseImplPlan — error cases", () => {
  it("returns ParseError for empty input", () => {
    const result = parseImplPlan("")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("returns ParseError for whitespace-only input", () => {
    const result = parseImplPlan("   \n\n  ")
    expect(result.success).toBe(false)
  })

  it("returns ParseError when no task headers are found", () => {
    const result = parseImplPlan("This is just some text without any task headers.\n\n- Bullet\n- Another bullet")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.some((e) => e.toLowerCase().includes("no task"))).toBe(true)
  })

  it("returns ParseError when a dependency references a nonexistent task", () => {
    const plan = `
## Task T1: first task
**Dependencies:** T99
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.some((e) => e.includes("T99"))).toBe(true)
  })

  it("returns ParseError for a cyclic dependency", () => {
    const plan = `
## Task T1: first
**Dependencies:** T2

## Task T2: second
**Dependencies:** T1
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.some((e) => e.toLowerCase().includes("circular"))).toBe(true)
  })
})

describe("validateExecutableImplPlan", () => {
  it("requires explicit dependency, file, and test metadata for every task", () => {
    const plan = `
## Task T1: Missing metadata
**Complexity:** medium
`

    const errors = validateExecutableImplPlan(plan, "GREENFIELD", [], "/project")
    expect(errors).toContain('Task "T1" must declare **Dependencies:** explicitly.')
    expect(errors).toContain('Task "T1" must declare **Expected tests:** explicitly (use `none` if there are none).')
    expect(errors).toContain('Task "T1" must declare **Files:** explicitly.')
  })

  it("rejects INCREMENTAL task scope outside the approved allowlist", () => {
    const plan = `
## Task T1: Scoped work
**Dependencies:** none
**Files:** src/out-of-scope.ts
**Expected tests:** tests/out-of-scope.test.ts
**Complexity:** medium
`

    const errors = validateExecutableImplPlan(
      plan,
      "INCREMENTAL",
      ["/project/src/allowed.ts", "/project/tests/allowed.test.ts"],
      "/project",
    )

    expect(errors.some((error) => error.includes("outside the approved INCREMENTAL allowlist"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Alternative header formats
// ---------------------------------------------------------------------------

describe("parseImplPlan — alternative header formats", () => {
  it("parses '### Task T1: description' (level 3 header)", () => {
    const plan = `### Task T1: My task\n**Dependencies:** none\n`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Array.from(result.dag.tasks)[0]!.id).toBe("T1")
  })

  it("parses '## T1: description' (no 'Task' keyword)", () => {
    const plan = `## T1: My task\n**Dependencies:** none\n`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Array.from(result.dag.tasks)[0]!.id).toBe("T1")
  })

  it("parses '### T1. description' with period separator", () => {
    const plan = `### T1. My task\n**Dependencies:** none\n`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Array.from(result.dag.tasks)[0]!.id).toBe("T1")
  })

  it("parses 'Depends on' as an alias for Dependencies", () => {
    const plan = `
## Task T1: base
**Dependencies:** none

## Task T2: derived
**Depends on:** T1
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) return
    const t2 = Array.from(result.dag.tasks).find((t) => t.id === "T2")!
    expect(t2.dependencies).toContain("T1")
  })
})

// ---------------------------------------------------------------------------
// Edge cases — malformed Markdown
// ---------------------------------------------------------------------------

describe("parseImplPlan — malformed Markdown edge cases", () => {
  it("handles task with no heading (body text only) — no tasks extracted", () => {
    const plan = `This is just some text explaining what to do.\n\nImplement the auth service.`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(false)
  })

  it("handles duplicate task IDs — DAG validation catches it", () => {
    const plan = `
## Task T1: First version
**Dependencies:** none

## Task T1: Second version with same ID
**Dependencies:** none
`
    const result = parseImplPlan(plan)
    // Should fail because duplicate IDs are invalid in a DAG
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true)
    }
  })

  it("handles task header with bold markers in description", () => {
    const plan = `## Task T1: **Bold** description here\n**Dependencies:** none\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.id).toBe("T1")
  })

  it("handles task with only a header line and nothing else", () => {
    const plan = `## Task T1: Solo task\n`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(true)
    if (!result.success) return
    const t1 = Array.from(result.dag.tasks)[0]!
    expect(t1.id).toBe("T1")
    expect(t1.dependencies).toHaveLength(0)
    expect(t1.expectedTests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Expected tests field
// ---------------------------------------------------------------------------

describe("parseImplPlan — expected tests field", () => {
  it("handles 'none' as empty test list", () => {
    const plan = `## Task T1: task\n**Dependencies:** none\n**Expected tests:** none\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.expectedTests).toHaveLength(0)
  })

  it("handles missing Expected tests field as empty array", () => {
    const plan = `## Task T1: task\n**Dependencies:** none\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    expect(Array.from(result.dag.tasks)[0]!.expectedTests).toHaveLength(0)
  })

  it("parses multiple test paths", () => {
    const plan = `## Task T1: task\n**Dependencies:** none\n**Expected tests:** tests/a.test.ts, tests/b.test.ts\n`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const tests = Array.from(result.dag.tasks)[0]!.expectedTests
    expect(tests).toContain("tests/a.test.ts")
    expect(tests).toContain("tests/b.test.ts")
  })
})

// ---------------------------------------------------------------------------
// Code block awareness — task headers inside code blocks should be ignored
// ---------------------------------------------------------------------------

describe("parseImplPlan — code block awareness", () => {
  it("ignores task headers inside fenced code blocks", () => {
    const plan = `
## Task T1: Real task
**Dependencies:** none
**Expected tests:** tests/a.test.ts
**Complexity:** small

Here is an example of the format:

\`\`\`markdown
## Task FAKE: This should be ignored
**Dependencies:** T1
**Expected tests:** tests/fake.test.ts
**Complexity:** large
\`\`\`

## Task T2: Also real
**Dependencies:** T1
**Expected tests:** tests/b.test.ts
**Complexity:** medium
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const ids = Array.from(result.dag.tasks).map((t) => t.id)
    expect(ids).toContain("T1")
    expect(ids).toContain("T2")
    expect(ids).not.toContain("FAKE")
    expect(result.dag.tasks.length).toBe(2)
  })

  it("handles plan with only code-block tasks (no real tasks)", () => {
    const plan = `
Some intro text.

\`\`\`
## Task T1: Inside code block
**Dependencies:** none
\`\`\`
`
    const result = parseImplPlan(plan)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0]).toContain("No task blocks found")
    }
  })
})

// ---------------------------------------------------------------------------
// Expected files parsing (v22)
// ---------------------------------------------------------------------------

describe("parseImplPlan — expectedFiles", () => {
  it("parses Files: field into expectedFiles array", () => {
    const plan = `
## Task T1: Build page
**Dependencies:** none
**Files:** pages/01.html, css/page.css
**Complexity:** small

Build the first page.
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.expectedFiles).toEqual(["pages/01.html", "css/page.css"])
  })

  it("parses Expected files: variant", () => {
    const plan = `
## Task T1: Build page
**Dependencies:** none
**Expected files:** src/index.ts
**Complexity:** small
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.expectedFiles).toEqual(["src/index.ts"])
  })

  it("defaults to empty array when Files: is absent", () => {
    const plan = `
## Task T1: Build page
**Dependencies:** none
**Complexity:** small

Build the page without specifying files.
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.expectedFiles).toEqual([])
  })

  it("handles none as empty files list", () => {
    const plan = `
## Task T1: Config task
**Dependencies:** none
**Files:** none
**Complexity:** small
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.expectedFiles).toEqual([])
  })

  it("parses multiple tasks with different files", () => {
    const plan = `
## Task T1: Create types
**Dependencies:** none
**Files:** src/types.ts
**Complexity:** small

## Task T2: Implement logic
**Dependencies:** T1
**Files:** src/logic.ts, src/helpers.ts
**Expected tests:** tests/logic.test.ts
**Complexity:** medium
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const tasks = Array.from(result.dag.tasks)
    const t1 = tasks.find((t) => t.id === "T1")!
    const t2 = tasks.find((t) => t.id === "T2")!
    expect(t1.expectedFiles).toEqual(["src/types.ts"])
    expect(t2.expectedFiles).toEqual(["src/logic.ts", "src/helpers.ts"])
    expect(t2.expectedTests).toEqual(["tests/logic.test.ts"])
  })

  it("parses bullet-list Files and Expected tests fields", () => {
    const plan = `
## Task T1: Bridge parity
- **Dependencies:** none
- **Files:**
  - packages/bridge/methods/tool-execute.ts
  - tests/bridge-tool-execute.test.ts
- **Expected tests:**
  - tests/bridge-tool-execute.test.ts
- **Complexity:** medium

Tighten bridge parity behavior.
`
    const result = parseImplPlan(plan)
    if (!result.success) throw new Error(result.errors.join("; "))
    const t1 = Array.from(result.dag.tasks).find((t) => t.id === "T1")!
    expect(t1.expectedFiles).toEqual([
      "packages/bridge/methods/tool-execute.ts",
      "tests/bridge-tool-execute.test.ts",
    ])
    expect(t1.expectedTests).toEqual(["tests/bridge-tool-execute.test.ts"])
    expect(t1.description).toContain("Tighten bridge parity behavior")
  })
})
