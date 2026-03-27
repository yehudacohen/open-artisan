/**
 * Tests for task-review.ts — per-task review prompt building and result parsing.
 *
 * Covers:
 * - buildTaskReviewPrompt: includes task ID, description, tests, conventions, artifact paths
 * - parseTaskReviewResult: valid JSON, pass/fail, issues extraction, error handling
 * - dispatchTaskReview: mock client, success path, failure fallback
 */
import { describe, expect, it, mock } from "bun:test"
import {
  buildTaskReviewPrompt,
  parseTaskReviewResult,
  dispatchTaskReview,
  type TaskReviewRequest,
} from "#core/task-review"
import type { TaskNode } from "#core/dag"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    description: `Implement ${overrides.id}`,
    dependencies: [],
    expectedTests: [],
    expectedFiles: [],
    estimatedComplexity: "medium",
    status: "pending",
    ...overrides,
  }
}

function makeRequest(overrides: Partial<TaskReviewRequest> = {}): TaskReviewRequest {
  return {
    task: makeTask({ id: "T1", expectedTests: ["tests/auth.test.ts"] }),
    implementationSummary: "Implemented auth service with JWT tokens",
    mode: "GREENFIELD",
    cwd: "/tmp/test-project",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildTaskReviewPrompt
// ---------------------------------------------------------------------------

describe("buildTaskReviewPrompt", () => {
  it("includes task ID and description", () => {
    const prompt = buildTaskReviewPrompt(makeRequest())
    expect(prompt).toContain("T1")
    expect(prompt).toContain("Implement T1")
  })

  it("includes implementation summary", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      implementationSummary: "Added JWT auth with refresh tokens",
    }))
    expect(prompt).toContain("Added JWT auth with refresh tokens")
  })

  it("includes expected tests when present", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      task: makeTask({ id: "T1", expectedTests: ["tests/auth.test.ts", "tests/jwt.test.ts"] }),
    }))
    expect(prompt).toContain("tests/auth.test.ts")
    expect(prompt).toContain("tests/jwt.test.ts")
  })

  it("omits expected tests section when none specified", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      task: makeTask({ id: "T1", expectedTests: [] }),
    }))
    expect(prompt).not.toContain("Expected Tests")
  })

  it("includes dependencies when present", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      task: makeTask({ id: "T2", dependencies: ["T1"] }),
    }))
    expect(prompt).toContain("T1")
    expect(prompt).toContain("Dependencies")
  })

  it("includes artifact disk paths when provided", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      artifactDiskPaths: {
        plan: "/tmp/project/.openartisan/feature/plan.md",
        interfaces: "/tmp/project/.openartisan/feature/interfaces.md",
      },
    }))
    expect(prompt).toContain("plan.md")
    expect(prompt).toContain("interfaces.md")
  })

  it("includes conventions reference when provided", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      conventions: "Use camelCase for all function names",
      artifactDiskPaths: { conventions: "/tmp/project/.openartisan/conventions.md" },
    }))
    expect(prompt).toContain("conventions")
  })

  it("includes complexity estimate", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      task: makeTask({ id: "T1", estimatedComplexity: "large" }),
    }))
    expect(prompt).toContain("large")
  })

  it("includes review instructions", () => {
    const prompt = buildTaskReviewPrompt(makeRequest())
    expect(prompt).toContain("Run the tests")
    expect(prompt).toContain("Verify interface alignment")
    expect(prompt).toContain("Check for regressions")
    expect(prompt).toContain("Check conventions alignment")
  })

  it("includes JSON response format", () => {
    const prompt = buildTaskReviewPrompt(makeRequest())
    expect(prompt).toContain("passed")
    expect(prompt).toContain("issues")
    expect(prompt).toContain("reasoning")
  })
})

// ---------------------------------------------------------------------------
// buildTaskReviewPrompt — adjacent tasks / integration seam check
// ---------------------------------------------------------------------------

describe("buildTaskReviewPrompt — integration seam check", () => {
  it("includes adjacent tasks section when adjacentTasks provided", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      adjacentTasks: [
        { id: "T0", description: "Set up database", category: "scaffold", status: "complete", direction: "upstream" },
        { id: "T2", description: "Build API layer", category: "standalone", status: "pending", direction: "downstream" },
      ],
    }))
    expect(prompt).toContain("Adjacent Tasks")
    expect(prompt).toContain("T0")
    expect(prompt).toContain("Set up database")
    expect(prompt).toContain("scaffold")
    expect(prompt).toContain("Upstream")
    expect(prompt).toContain("T2")
    expect(prompt).toContain("Build API layer")
    expect(prompt).toContain("Downstream")
  })

  it("omits adjacent tasks section when none provided", () => {
    const prompt = buildTaskReviewPrompt(makeRequest())
    expect(prompt).not.toContain("Adjacent Tasks")
    expect(prompt).not.toContain("integration seam")
  })

  it("omits adjacent tasks section when empty array", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({ adjacentTasks: [] }))
    expect(prompt).not.toContain("Adjacent Tasks")
  })

  it("includes integration seam check (#6) when adjacent tasks exist", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      adjacentTasks: [
        { id: "T0", description: "Set up database", status: "complete", direction: "upstream" },
      ],
    }))
    expect(prompt).toContain("Integration seam check")
    expect(prompt).toContain("INTEGRATION_GAP")
    expect(prompt).toContain("not my responsibility")
    expect(prompt).toContain("six checks")
  })

  it("says five checks when no adjacent tasks", () => {
    const prompt = buildTaskReviewPrompt(makeRequest())
    expect(prompt).toContain("five checks")
    expect(prompt).not.toContain("six checks")
  })

  it("separates upstream and downstream tasks", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      adjacentTasks: [
        { id: "T0", description: "Upstream task", status: "complete", direction: "upstream" },
        { id: "T2", description: "Downstream task", status: "pending", direction: "downstream" },
      ],
    }))
    // Both sections present
    expect(prompt).toContain("Upstream (this task depends on)")
    expect(prompt).toContain("Downstream (depends on this task)")
  })

  it("shows only upstream when no downstream", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      adjacentTasks: [
        { id: "T0", description: "Upstream task", status: "complete", direction: "upstream" },
      ],
    }))
    expect(prompt).toContain("Upstream")
    expect(prompt).not.toContain("Downstream (depends on this task)")
  })

  it("shows only downstream when no upstream", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      adjacentTasks: [
        { id: "T2", description: "Downstream task", status: "pending", direction: "downstream" },
      ],
    }))
    expect(prompt).toContain("Downstream")
    expect(prompt).not.toContain("Upstream (this task depends on)")
  })

  it("includes INTEGRATION_GAP in example response format when adjacent tasks present", () => {
    const prompt = buildTaskReviewPrompt(makeRequest({
      adjacentTasks: [
        { id: "T0", description: "DB setup", status: "complete", direction: "upstream" },
      ],
    }))
    expect(prompt).toContain("INTEGRATION_GAP")
  })
})

// ---------------------------------------------------------------------------
// parseTaskReviewResult
// ---------------------------------------------------------------------------

describe("parseTaskReviewResult", () => {
  it("parses a passing result", () => {
    const raw = JSON.stringify({
      passed: true,
      issues: [],
      reasoning: "All tests pass, interfaces match",
    })
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.reasoning).toContain("All tests pass")
  })

  it("parses a failing result with issues", () => {
    const raw = JSON.stringify({
      passed: false,
      issues: ["Test auth.test.ts fails", "Missing method getUser()"],
      reasoning: "Two critical issues found",
    })
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0]).toContain("auth.test.ts")
    expect(result.issues[1]).toContain("getUser")
  })

  it("handles markdown-fenced JSON", () => {
    const raw = `Here is my review:\n\`\`\`json\n${JSON.stringify({
      passed: true,
      issues: [],
      reasoning: "Looks good",
    })}\n\`\`\``
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.passed).toBe(true)
  })

  it("handles bare JSON without fences", () => {
    const raw = `Some preamble text\n${JSON.stringify({
      passed: false,
      issues: ["test failure"],
      reasoning: "Tests fail",
    })}\nSome trailing text`
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.passed).toBe(false)
  })

  it("returns error for invalid JSON", () => {
    const result = parseTaskReviewResult("not valid json at all")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Failed to parse")
  })

  it("treats truthy non-boolean passed as false", () => {
    const raw = JSON.stringify({
      passed: "yes",
      issues: [],
      reasoning: "looks good",
    })
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.passed).toBe(false) // "yes" !== true
  })

  it("filters non-string items from issues array", () => {
    const raw = JSON.stringify({
      passed: false,
      issues: ["real issue", 42, null, "another issue"],
      reasoning: "mixed types",
    })
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.issues).toEqual(["real issue", "another issue"])
  })

  it("handles missing issues array gracefully", () => {
    const raw = JSON.stringify({ passed: true, reasoning: "ok" })
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.issues).toEqual([])
  })

  it("handles missing reasoning gracefully", () => {
    const raw = JSON.stringify({ passed: true, issues: [] })
    const result = parseTaskReviewResult(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.reasoning).toBe("")
  })
})

// ---------------------------------------------------------------------------
// dispatchTaskReview — mock client
// ---------------------------------------------------------------------------

describe("dispatchTaskReview", () => {
  function makeMockDispatcher(promptText?: string) {
    const defaultText = promptText ?? JSON.stringify({
      passed: true,
      issues: [],
      reasoning: "All checks pass",
    })
    const createMock = mock(async () => ({
      id: "review-session-1",
      prompt: mock(async () => defaultText),
      destroy: mock(async () => {}),
    }))
    return {
      createSession: createMock,
      _createMock: createMock,
    }
  }

  it("returns passing result on successful review", async () => {
    const dispatcher = makeMockDispatcher()
    const result = await dispatchTaskReview(dispatcher, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.passed).toBe(true)
  })

  it("returns failing result when reviewer finds issues", async () => {
    const dispatcher2 = makeMockDispatcher(JSON.stringify({
      passed: false,
      issues: ["Test fails"],
      reasoning: "Auth test fails",
    }))
    const result = await dispatchTaskReview(dispatcher2, makeRequest())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.passed).toBe(false)
    expect(result.issues[0]).toContain("Test fails")
  })

  it("creates an ephemeral session with task-specific title", async () => {
    const dispatcher = makeMockDispatcher()
    await dispatchTaskReview(dispatcher, makeRequest({
      featureName: "auth-refactor",
    }))
    expect(dispatcher._createMock).toHaveBeenCalledTimes(1)
  })

  it("returns error when session create fails", async () => {
    const failDispatcher: import("#core/subagent-dispatcher").SubagentDispatcher = {
      createSession: mock(async () => { throw new Error("Cannot create session") }),
    }
    const result = await dispatchTaskReview(failDispatcher, makeRequest())
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Cannot create session")
  })

  it("returns error when session prompt fails", async () => {
    const failDispatcher: import("#core/subagent-dispatcher").SubagentDispatcher = {
      createSession: mock(async () => ({
        id: "review-1",
        prompt: mock(async () => { throw new Error("Network error") }),
        destroy: mock(async () => {}),
      })),
    }
    const result = await dispatchTaskReview(failDispatcher, makeRequest())
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("Network error")
  })
})
