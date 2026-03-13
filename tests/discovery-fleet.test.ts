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
import { runDiscoveryFleet, SCANNER_NAMES } from "#plugin/discovery/index"

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeClient(responseText = "## Analysis\nSome findings here.") {
  return {
    session: {
      create: mock(async () => ({ id: `session-${Math.random().toString(36).slice(2)}` })),
      prompt: mock(async () => ({
        parts: [{ type: "text", text: responseText }],
      })),
      delete: mock(async () => undefined),
    },
  }
}

function makeClientSomeThrow(failPattern: RegExp) {
  let callCount = 0
  return {
    session: {
      create: mock(async () => {
        const id = `session-${++callCount}`
        return { id }
      }),
      prompt: mock(async (args: { path: { id: string }; body: unknown }) => {
        // Fail for session IDs matching the pattern (e.g. session-2, session-4)
        if (failPattern.test(args.path.id)) {
          throw new Error(`Scanner failure for session ${args.path.id}`)
        }
        return { parts: [{ type: "text", text: "## Analysis\nOK" }] }
      }),
      delete: mock(async () => undefined),
    },
  }
}

function makeClientAllThrow() {
  return {
    session: {
      create: mock(async () => ({ id: `session-${Math.random().toString(36).slice(2)}` })),
      prompt: mock(async () => {
        throw new Error("All scanners failed")
      }),
      delete: mock(async () => undefined),
    },
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
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.hasResults).toBe(true)
  })

  it("returns 6 scanner results", async () => {
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.scanners).toHaveLength(6)
  })

  it("all scanner results have success=true", async () => {
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    for (const s of report.scanners) {
      expect(s.success).toBe(true)
    }
  })

  it("combinedReport contains all 6 scanner names", async () => {
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    for (const name of SCANNER_NAMES) {
      expect(report.combinedReport).toContain(name)
    }
  })

  it("combinedReport includes scanner output text", async () => {
    const client = makeClient("## My Scanner Output\nKey finding here.")
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.combinedReport).toContain("Key finding here.")
  })

  it("combinedReport includes success count footer", async () => {
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "INCREMENTAL")
    expect(report.combinedReport).toContain("6/6 scanners completed successfully")
  })

  it("combinedReport starts with the discovery report header", async () => {
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.combinedReport).toContain("# Discovery Report")
  })
})

// ---------------------------------------------------------------------------
// Parallel dispatch — all sessions created concurrently
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — parallel dispatch", () => {
  it("creates exactly 6 sessions (one per scanner)", async () => {
    const client = makeClient()
    await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect((client.session.create as ReturnType<typeof mock>).mock.calls).toHaveLength(6)
  })

  it("calls session.prompt exactly 6 times", async () => {
    const client = makeClient()
    await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect((client.session.prompt as ReturnType<typeof mock>).mock.calls).toHaveLength(6)
  })

  it("deletes all 6 sessions (cleanup)", async () => {
    const client = makeClient()
    await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect((client.session.delete as ReturnType<typeof mock>).mock.calls).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// Partial failure — some scanners fail
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — partial failures", () => {
  it("returns hasResults=true if at least one scanner succeeds", async () => {
    // Fail sessions 2 and 4; sessions 1, 3, 5, 6 succeed
    const client = makeClientSomeThrow(/session-(2|4)/)
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.hasResults).toBe(true)
  })

  it("failed scanners have success=false", async () => {
    const client = makeClientSomeThrow(/session-(2|4)/)
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    const failed = report.scanners.filter((s) => !s.success)
    expect(failed.length).toBeGreaterThan(0)
  })

  it("failed scanners include an error note in their output", async () => {
    const client = makeClientSomeThrow(/session-(1|2|3|4|5|6)/) // all fail
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    for (const s of report.scanners) {
      expect(s.output).toContain("Scanner failed")
    }
  })

  it("success count in footer reflects actual successes", async () => {
    const client = makeClientSomeThrow(/session-(2|4)/)
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    // 4 succeed, 2 fail
    expect(report.combinedReport).toContain("4/6 scanners completed successfully")
  })
})

// ---------------------------------------------------------------------------
// Full failure — all scanners fail
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — all scanners fail", () => {
  it("returns hasResults=false", async () => {
    const client = makeClientAllThrow()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.hasResults).toBe(false)
  })

  it("all scanner results have success=false", async () => {
    const client = makeClientAllThrow()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    for (const s of report.scanners) {
      expect(s.success).toBe(false)
    }
  })

  it("combinedReport still contains scanner names (for structure)", async () => {
    const client = makeClientAllThrow()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    for (const name of SCANNER_NAMES) {
      expect(report.combinedReport).toContain(name)
    }
  })

  it("combinedReport footer shows 0/6", async () => {
    const client = makeClientAllThrow()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.combinedReport).toContain("0/6 scanners completed successfully")
  })
})

// ---------------------------------------------------------------------------
// Prompt content — includes cwd and scanner-specific keywords
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — prompt content", () => {
  it("structure scanner prompt includes the cwd", async () => {
    const client = makeClient()
    await runDiscoveryFleet(client, "/my/project", "REFACTOR")

    const calls = (client.session.prompt as ReturnType<typeof mock>).mock.calls
    const texts = calls.map((c: Array<unknown>) => {
      const arg = c[0] as { body: { parts: Array<{ text: string }> } }
      return arg.body.parts[0]?.text ?? ""
    })
    // At least one prompt should contain the cwd path
    expect(texts.some((t: string) => t.includes("/my/project"))).toBe(true)
  })

  it("each session is created with agent: 'workflow-reviewer'", async () => {
    const client = makeClient()
    await runDiscoveryFleet(client, "/workspace", "REFACTOR")

    const createCalls = (client.session.create as ReturnType<typeof mock>).mock.calls
    for (const call of createCalls) {
      const arg = (call as Array<unknown>)[0] as { body: { agent: string } }
      expect(arg.body.agent).toBe("workflow-reviewer")
    }
  })
})

// ---------------------------------------------------------------------------
// Minimum scanner threshold — warn when too few succeed
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — minimum scanner threshold", () => {
  it("sets lowConfidence=true when fewer than MIN_SCANNERS_THRESHOLD scanners succeed", async () => {
    // Only 1 of 6 succeeds
    const client = makeClientSomeThrow(/session-[2-6]/)
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.lowConfidence).toBe(true)
  })

  it("sets lowConfidence=false when enough scanners succeed", async () => {
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.lowConfidence).toBe(false)
  })

  it("includes a warning in combinedReport when lowConfidence is true", async () => {
    const client = makeClientAllThrow()
    const report = await runDiscoveryFleet(client, "/workspace", "REFACTOR")
    expect(report.lowConfidence).toBe(true)
    expect(report.combinedReport.toLowerCase()).toContain("warning")
  })
})

// ---------------------------------------------------------------------------
// Works with INCREMENTAL mode
// ---------------------------------------------------------------------------

describe("runDiscoveryFleet — INCREMENTAL mode", () => {
  it("runs the fleet successfully in INCREMENTAL mode", async () => {
    const client = makeClient()
    const report = await runDiscoveryFleet(client, "/workspace", "INCREMENTAL")
    expect(report.hasResults).toBe(true)
    expect(report.scanners).toHaveLength(6)
  })
})
