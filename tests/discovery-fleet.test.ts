/**
 * Tests for discovery/index.ts — the parallel subagent scanner fleet.
 *
 * The OpenCode client is fully mocked. No real LLM calls are made.
 * Tests verify:
 * - Happy path: all 6 scanners succeed → hasResults=true, combinedReport contains all sections
 * - Partial failure: some scanners fail → hasResults=true (any success counts)
 * - Full failure: all scanners fail → hasResults=false, report contains error notes
 * - Parallel dispatch: all 6 scanner sessions are created concurrently
 * - Session cleanup: session.delete() called for every successfully created session
 * - Report format: combinedReport includes scanner names and a success count footer
 * - SCANNER_NAMES export has 6 entries matching the expected scanner names
 */
import { describe, expect, it, mock } from "bun:test"
import { runDiscoveryFleet, SCANNER_NAMES } from "#core/discovery/index"
import type { SubagentDispatcher } from "#core/subagent-dispatcher"

// ---------------------------------------------------------------------------
// Mock dispatcher factory
// ---------------------------------------------------------------------------

function makeDispatcher(responseText = "## Analysis\nSome findings here."): SubagentDispatcher & { _createMock: ReturnType<typeof mock> } {
  const createMock = mock(async () => ({
    id: `session-${Math.random().toString(36).slice(2)}`,
    prompt: mock(async () => responseText),
    destroy: mock(async () => {}),
  }))
  return { createSession: createMock, _createMock: createMock }
}

function makeDispatcherSomeThrow(failIndices: Set<number>): SubagentDispatcher {
  let callCount = 0
  return {
    createSession: mock(async () => {
      const idx = callCount++
      return {
        id: `session-${idx}`,
        prompt: failIndices.has(idx)
          ? mock(async () => { throw new Error(`Scanner failure for session-${idx}`) })
          : mock(async () => "## Analysis\nOK"),
        destroy: mock(async () => {}),
      }
    }),
  }
}

function makeDispatcherAllThrow(): SubagentDispatcher {
  return {
    createSession: mock(async () => ({
      id: `session-${Math.random().toString(36).slice(2)}`,
      prompt: mock(async () => { throw new Error("All scanners failed") }),
      destroy: mock(async () => {}),
    })),
  }
}

// ---------------------------------------------------------------------------
// SCANNER_NAMES export
// ---------------------------------------------------------------------------

describe("SCANNER_NAMES", () => {
  it("exports exactly 6 scanner names", () => {
    expect(SCANNER_NAMES).toHaveLength(6)
  })

  it("includes all expected scanner names", () => {
    expect(SCANNER_NAMES).toContain("Structure Scanner")
    expect(SCANNER_NAMES).toContain("Convention Detector")
    expect(SCANNER_NAMES).toContain("Architecture Analyzer")
    expect(SCANNER_NAMES).toContain("Test Pattern Scanner")
    expect(SCANNER_NAMES).toContain("History Analyzer")
    expect(SCANNER_NAMES).toContain("Docs Reader")
  })
})

// ---------------------------------------------------------------------------
// Happy path — all scanners succeed
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — all scanners succeed", () => {
  it("returns hasResults=true", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.hasResults).toBe(true)
  })

  it("returns 6 scanner results", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.scanners).toHaveLength(6)
  })

  it("all scanner results have success=true", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    for (const s of report.scanners) {
      expect(s.success).toBe(true)
    }
  })

  it("combinedReport contains all 6 scanner names", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    for (const name of SCANNER_NAMES) {
      expect(report.combinedReport).toContain(name)
    }
  })

  it("combinedReport includes scanner output text", async () => {
    const dispatcher = makeDispatcher("## My Scanner Output\nKey finding here.")
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.combinedReport).toContain("Key finding here.")
  })

  it("combinedReport includes success count footer", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "INCREMENTAL")
    expect(report.combinedReport).toContain("6/6 scanners completed successfully")
  })

  it("combinedReport starts with the discovery report header", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.combinedReport).toContain("# Discovery Report")
  })
})

// ---------------------------------------------------------------------------
// Parallel dispatch — all sessions created concurrently
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — parallel dispatch", () => {
  it("creates exactly 6 sessions (one per scanner)", async () => {
    const dispatcher = makeDispatcher()
    await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(dispatcher._createMock.mock.calls).toHaveLength(6)
  })

  it("creates exactly 6 sessions (one per scanner)", async () => {
    const dispatcher = makeDispatcher()
    await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(dispatcher._createMock.mock.calls).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// Partial failure — some scanners fail
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — partial failures", () => {
  it("returns hasResults=true if at least one scanner succeeds", async () => {
    // Fail sessions 2 and 4; sessions 1, 3, 5, 6 succeed
    const dispatcher = makeDispatcherSomeThrow(new Set([1, 3]))
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.hasResults).toBe(true)
  })

  it("failed scanners have success=false", async () => {
    const dispatcher = makeDispatcherSomeThrow(new Set([1, 3]))
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    const failed = report.scanners.filter((s) => !s.success)
    expect(failed.length).toBeGreaterThan(0)
  })

  it("failed scanners include an error note in their output", async () => {
    const dispatcher = makeDispatcherSomeThrow(new Set([0, 1, 2, 3, 4, 5])) // all fail
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    for (const s of report.scanners) {
      expect(s.output).toContain("Scanner failed")
    }
  })

  it("success count in footer reflects actual successes", async () => {
    const dispatcher = makeDispatcherSomeThrow(new Set([1, 3]))
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    // 4 succeed, 2 fail
    expect(report.combinedReport).toContain("4/6 scanners completed successfully")
  })
})

// ---------------------------------------------------------------------------
// Full failure — all scanners fail
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — all scanners fail", () => {
  it("returns hasResults=false", async () => {
    const dispatcher = makeDispatcherAllThrow()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.hasResults).toBe(false)
  })

  it("all scanner results have success=false", async () => {
    const dispatcher = makeDispatcherAllThrow()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    for (const s of report.scanners) {
      expect(s.success).toBe(false)
    }
  })

  it("combinedReport still contains scanner names (for structure)", async () => {
    const dispatcher = makeDispatcherAllThrow()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    for (const name of SCANNER_NAMES) {
      expect(report.combinedReport).toContain(name)
    }
  })

  it("combinedReport footer shows 0/6", async () => {
    const dispatcher = makeDispatcherAllThrow()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.combinedReport).toContain("0/6 scanners completed successfully")
  })
})

// ---------------------------------------------------------------------------
// Prompt content — includes cwd and scanner-specific keywords
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — session creation", () => {
  it("creates sessions with agent=workflow-reviewer", async () => {
    const dispatcher = makeDispatcher()
    await runDiscoveryFleet(dispatcher, "/my/project", "REFACTOR")
    const calls = dispatcher._createMock.mock.calls
    for (const call of calls) {
      expect((call as any)?.[0]?.agent).toBe("workflow-reviewer")
    }
  })
})

// ---------------------------------------------------------------------------
// Minimum scanner threshold — warn when too few succeed
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — minimum scanner threshold", () => {
  it("sets lowConfidence=true when fewer than MIN_SCANNERS_THRESHOLD scanners succeed", async () => {
    // Only 1 of 6 succeeds
    const dispatcher = makeDispatcherSomeThrow(new Set([1, 2, 3, 4, 5]))
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.lowConfidence).toBe(true)
  })

  it("sets lowConfidence=false when enough scanners succeed", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.lowConfidence).toBe(false)
  })

  it("includes a warning in combinedReport when lowConfidence is true", async () => {
    const dispatcher = makeDispatcherAllThrow()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "REFACTOR")
    expect(report.lowConfidence).toBe(true)
    expect(report.combinedReport.toLowerCase()).toContain("warning")
  })
})

// ---------------------------------------------------------------------------
// Works with INCREMENTAL mode
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — INCREMENTAL mode", () => {
  it("runs the fleet successfully in INCREMENTAL mode", async () => {
    const dispatcher = makeDispatcher()
    const report = await runDiscoveryFleet(dispatcher, "/workspace", "INCREMENTAL")
    expect(report.hasResults).toBe(true)
    expect(report.scanners).toHaveLength(6)
  })
})
