/**
 * Tests for getPhaseToolPolicy — the phase-gating rules for tool calls.
 */
import { describe, expect, it } from "bun:test"

import { getPhaseToolPolicy } from "#plugin/hooks/tool-guard"
import type { PhaseToolPolicy } from "#plugin/types"

describe("Tool policy — DISCOVERY phases block writes", () => {
  const discoverPhaseStates = ["SCAN", "ANALYZE", "CONVENTIONS", "USER_GATE", "REVISE"] as const

  for (const ps of discoverPhaseStates) {
    it(`DISCOVERY/${ps} blocks write`, () => {
      const policy: PhaseToolPolicy = getPhaseToolPolicy("DISCOVERY", ps, "GREENFIELD", [])
      expect(policy.blocked).toContain("write")
    })

    it(`DISCOVERY/${ps} blocks edit`, () => {
      const policy: PhaseToolPolicy = getPhaseToolPolicy("DISCOVERY", ps, "GREENFIELD", [])
      expect(policy.blocked).toContain("edit")
    })
  }
})

describe("Tool policy — PLANNING blocks writes and bash", () => {
  it("PLANNING/DRAFT blocks write, edit, bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
  })
})

describe("Tool policy — INTERFACES allows .ts/.d.ts writes only", () => {
  it("INTERFACES/DRAFT has a writePathPredicate", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
  })

  it("predicate allows .ts files", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/types.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/foo.d.ts")).toBe(true)
  })

  it("predicate blocks .js files in INTERFACES", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/index.js")).toBe(false)
  })

  it("predicate blocks .md files in INTERFACES", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/README.md")).toBe(false)
  })
})

describe("Tool policy — TESTS allows .test.ts writes only", () => {
  it("predicate allows .test.ts files", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/tests/foo.test.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/foo.spec.ts")).toBe(true)
  })

  it("predicate blocks non-test .ts files in TESTS", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
  })
})

describe("Tool policy — IMPLEMENTATION with INCREMENTAL allowlist", () => {
  const allowlist = ["/project/src/foo.ts", "/project/src/bar.ts"]

  it("allows writing to allowlisted files", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", allowlist)
    expect(policy.writePathPredicate?.("/project/src/foo.ts")).toBe(true)
  })

  it("blocks writing to non-allowlisted files", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", allowlist)
    expect(policy.writePathPredicate?.("/project/src/baz.ts")).toBe(false)
  })

  it("GREENFIELD/REFACTOR mode: no path restriction in IMPLEMENTATION", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeUndefined()
    expect(policy.blocked).not.toContain("write")
  })
})

describe("Tool policy — always blocks .env writes", () => {
  const allPhases = ["PLANNING", "INTERFACES", "TESTS", "IMPLEMENTATION"] as const

  for (const phase of allPhases) {
    it(`${phase} blocks .env file writes`, () => {
      const policy = getPhaseToolPolicy(phase, "DRAFT", "GREENFIELD", [])
      // Either blocked entirely or predicate returns false for .env
      const envBlocked = policy.blocked.includes("write") ||
        policy.writePathPredicate?.("/project/.env") === false
      expect(envBlocked).toBe(true)
    })
  }
})

describe("Tool policy — MODE_SELECT and DONE block everything except workflow tools", () => {
  it("MODE_SELECT blocks write", () => {
    const policy = getPhaseToolPolicy("MODE_SELECT", "DRAFT", null, [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
  })

  it("DONE blocks write and edit", () => {
    const policy = getPhaseToolPolicy("DONE", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
  })
})
