/**
 * Tests for getPhaseToolPolicy — the phase-gating rules for tool calls.
 */
import { describe, expect, it } from "bun:test"

import { getPhaseToolPolicy } from "#plugin/hooks/tool-guard"
import type { PhaseToolPolicy } from "#plugin/types"

describe("Tool policy — DISCOVERY/SCAN and DISCOVERY/ANALYZE are strictly read-only", () => {
  for (const ps of ["SCAN", "ANALYZE"] as const) {
    it(`DISCOVERY/${ps} blocks write`, () => {
      const policy: PhaseToolPolicy = getPhaseToolPolicy("DISCOVERY", ps, "REFACTOR", [])
      expect(policy.blocked).toContain("write")
    })

    it(`DISCOVERY/${ps} blocks edit`, () => {
      const policy: PhaseToolPolicy = getPhaseToolPolicy("DISCOVERY", ps, "REFACTOR", [])
      expect(policy.blocked).toContain("edit")
    })

    it(`DISCOVERY/${ps} blocks bash`, () => {
      const policy: PhaseToolPolicy = getPhaseToolPolicy("DISCOVERY", ps, "REFACTOR", [])
      expect(policy.blocked).toContain("bash")
    })
  }
})

describe("Tool policy — DISCOVERY/CONVENTIONS allows writes to .openartisan/ only", () => {
  it("DISCOVERY/CONVENTIONS does not block write or edit", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "CONVENTIONS", "REFACTOR", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
  })

  it("DISCOVERY/CONVENTIONS blocks bash", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "CONVENTIONS", "REFACTOR", [])
    expect(policy.blocked).toContain("bash")
  })

  it("DISCOVERY/CONVENTIONS allows writes to .openartisan/ files", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "CONVENTIONS", "REFACTOR", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/conventions.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/.openartisan/discovery/notes.md")).toBe(true)
  })

  it("DISCOVERY/CONVENTIONS blocks writes to project source files", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "CONVENTIONS", "REFACTOR", [])
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/package.json")).toBe(false)
  })

  it("DISCOVERY/CONVENTIONS blocks writes to .env files even in .openartisan/", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "CONVENTIONS", "REFACTOR", [])
    expect(policy.writePathPredicate?.("/project/.openartisan/.env")).toBe(false)
  })
})

describe("Tool policy — DISCOVERY/REVISE allows writes to .openartisan/ only", () => {
  it("DISCOVERY/REVISE does not block write or edit", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "REVISE", "REFACTOR", [])
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).not.toContain("write")
  })

  it("DISCOVERY/REVISE does not block bash", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "REVISE", "REFACTOR", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("DISCOVERY/REVISE allows writes to .openartisan/ files", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "REVISE", "REFACTOR", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/conventions.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/.openartisan/discovery/notes.md")).toBe(true)
  })

  it("DISCOVERY/REVISE blocks writes to project source files", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "REVISE", "REFACTOR", [])
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/package.json")).toBe(false)
  })

  it("DISCOVERY/REVISE blocks writes to .env files even in .openartisan/", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "REVISE", "REFACTOR", [])
    expect(policy.writePathPredicate?.("/project/.openartisan/.env")).toBe(false)
  })
})

describe("Tool policy — DISCOVERY/REVIEW allows .openartisan/ writes + bash for verification", () => {
  it("DISCOVERY/REVIEW allows writes to .openartisan/ and bash", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "REVIEW", "REFACTOR", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).not.toContain("bash")
    // Must restrict writes to .openartisan/ only
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/conventions.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
  })

  it("DISCOVERY/USER_GATE blocks write and edit but allows bash", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "USER_GATE", "REFACTOR", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).not.toContain("bash")
  })
})

describe("Tool policy — PLANNING and IMPL_PLAN block writes and bash", () => {
  it("PLANNING/DRAFT blocks write, edit, bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).toContain("bash")
  })

  it("IMPL_PLAN/DRAFT blocks write, edit, bash", () => {
    const policy = getPhaseToolPolicy("IMPL_PLAN", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).toContain("bash")
  })

  it("PLANNING/CONVENTIONS blocks write, edit, bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "CONVENTIONS", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).toContain("bash")
  })
})

describe("Tool policy — PLANNING/REVISE allows edits to .openartisan/ only", () => {
  it("PLANNING/REVISE does not block edit or write", () => {
    const policy = getPhaseToolPolicy("PLANNING", "REVISE", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).not.toContain("write")
  })

  it("PLANNING/REVISE does not block bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "REVISE", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("PLANNING/REVISE allows writes to .openartisan/ files", () => {
    const policy = getPhaseToolPolicy("PLANNING", "REVISE", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/plan.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/.openartisan/feature-x/plan.md")).toBe(true)
  })

  it("PLANNING/REVISE blocks writes to project source files", () => {
    const policy = getPhaseToolPolicy("PLANNING", "REVISE", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/package.json")).toBe(false)
  })

  it("PLANNING/REVISE blocks writes to .env files even in .openartisan/", () => {
    const policy = getPhaseToolPolicy("PLANNING", "REVISE", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/.openartisan/.env")).toBe(false)
  })

  it("IMPL_PLAN/REVISE allows writes to .openartisan/ files", () => {
    const policy = getPhaseToolPolicy("IMPL_PLAN", "REVISE", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/impl-plan.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/server.ts")).toBe(false)
  })
})

describe("Tool policy — PLANNING/REVIEW allows .openartisan/ writes + bash for verification", () => {
  it("PLANNING/REVIEW allows writes to .openartisan/ and bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "REVIEW", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).not.toContain("bash")
    // Must restrict writes to .openartisan/ only
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/plan.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
  })

  it("PLANNING/USER_GATE blocks write and edit but allows bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "USER_GATE", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).not.toContain("bash")
  })

  it("IMPL_PLAN/REVIEW allows .openartisan/ writes and bash for verification", () => {
    const policy = getPhaseToolPolicy("IMPL_PLAN", "REVIEW", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
    expect(policy.blocked).not.toContain("write")
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/impl-plan.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/server.ts")).toBe(false)
  })
})

describe("Tool policy — INTERFACES allows .ts/.tsx/.d.ts writes only (G1)", () => {
  it("INTERFACES/DRAFT has a writePathPredicate", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
  })

  it("bash is blocked in INTERFACES/DRAFT", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).toContain("bash")
  })

  it("bash is allowed in INTERFACES/REVISE (read-only verification for revision)", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "REVISE", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("bash is allowed in INTERFACES/REVIEW (read-only verification)", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "REVIEW", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("bash is allowed in INTERFACES/USER_GATE (read-only verification)", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "USER_GATE", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("INTERFACES/REVIEW still restricts writes to interface files", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "REVIEW", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/src/types.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/server.ts")).toBe(false)
  })

  it("predicate allows .ts files with interface-like names", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/types.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/interfaces.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/models.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/schema.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/api-types.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/foo.d.ts")).toBe(true)
  })

  it("predicate blocks .ts files without interface-like names", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    // Implementation files are blocked during INTERFACES phase
    expect(policy.writePathPredicate?.("/project/src/server.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/src/Component.tsx")).toBe(false)
    expect(policy.writePathPredicate?.("/project/src/utils.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
  })

  it("predicate always allows .d.ts and .d.tsx declaration files", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/types.d.tsx")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/global.d.ts")).toBe(true)
  })

  it("predicate allows schema/IDL formats unconditionally", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/schema.proto")).toBe(true)
    expect(policy.writePathPredicate?.("/project/api.graphql")).toBe(true)
    expect(policy.writePathPredicate?.("/project/schema.json")).toBe(true)
    expect(policy.writePathPredicate?.("/project/openapi.yaml")).toBe(true)
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

describe("Tool policy — TESTS allows .test.ts/.test.tsx writes only (G1)", () => {
  it("bash is blocked in TESTS/DRAFT", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).toContain("bash")
  })

  it("bash is allowed in TESTS/REVISE (read-only verification for revision)", () => {
    const policy = getPhaseToolPolicy("TESTS", "REVISE", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("bash is allowed in TESTS/REVIEW (read-only verification)", () => {
    const policy = getPhaseToolPolicy("TESTS", "REVIEW", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("bash is allowed in TESTS/USER_GATE (read-only verification)", () => {
    const policy = getPhaseToolPolicy("TESTS", "USER_GATE", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("TESTS/REVIEW still restricts writes to test files", () => {
    const policy = getPhaseToolPolicy("TESTS", "REVIEW", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/tests/foo.test.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
  })

  it("predicate allows .test.ts files", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/tests/foo.test.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/foo.spec.ts")).toBe(true)
  })

  it("predicate allows .test.tsx files (G1 — React component tests)", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/tests/Component.test.tsx")).toBe(true)
    expect(policy.writePathPredicate?.("/project/tests/Page.spec.tsx")).toBe(true)
  })

  it("predicate blocks non-test .ts files in TESTS", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
  })

  it("predicate blocks .tsx implementation files in TESTS", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/Component.tsx")).toBe(false)
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

  it("GREENFIELD/REFACTOR mode: no write block, but has writePathPredicate for .env (R3-G1)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("write")
    // Must have a predicate to protect .env even in GREENFIELD
    expect(policy.writePathPredicate).toBeDefined()
  })

  it("GREENFIELD mode: any non-env file is allowed (R3-G1)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/anything.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/styles.css")).toBe(true)
    expect(policy.writePathPredicate?.("/project/README.md")).toBe(true)
  })

  it("REFACTOR mode: any non-env file is allowed (R3-G1)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "REFACTOR", [])
    expect(policy.writePathPredicate?.("/project/src/service.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/utils.js")).toBe(true)
  })
})

describe("Tool policy — always blocks .env writes", () => {
  // PLANNING: blocked via "write" in blocked list
  // INTERFACES/TESTS: blocked via writePathPredicate
  // IMPLEMENTATION+GREENFIELD/REFACTOR: blocked via writePathPredicate (R3-G1 fix)
  // IMPLEMENTATION+INCREMENTAL: blocked via writePathPredicate (allowlist check)
  const phasesWithPredicateOrBlocked = ["PLANNING", "INTERFACES", "TESTS"] as const

  for (const phase of phasesWithPredicateOrBlocked) {
    it(`${phase} blocks .env file writes`, () => {
      const policy = getPhaseToolPolicy(phase, "DRAFT", "GREENFIELD", [])
      // Either blocked entirely or predicate returns false for .env
      const envBlocked = policy.blocked.includes("write") ||
        policy.writePathPredicate?.("/project/.env") === false
      expect(envBlocked).toBe(true)
    })
  }

  it("IMPLEMENTATION/INCREMENTAL blocks .env via predicate", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/project/src/foo.ts"])
    expect(policy.writePathPredicate?.("/project/.env")).toBe(false)
  })

  it("IMPLEMENTATION/GREENFIELD blocks .env via predicate (R3-G1 fix)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/.env")).toBe(false)
  })

  it("IMPLEMENTATION/REFACTOR blocks .env via predicate (R3-G1 fix)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "REFACTOR", [])
    expect(policy.writePathPredicate?.("/project/.env")).toBe(false)
  })

  it("IMPLEMENTATION/GREENFIELD blocks .env.production via predicate (R3-G1 fix)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/.env.production")).toBe(false)
  })
})

describe("Tool policy — IMPLEMENTATION/INCREMENTAL with empty allowlist blocks all writes (M1 fix)", () => {
  it("blocks write when allowlist is empty", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", [])
    expect(policy.blocked).toContain("write")
  })

  it("blocks edit when allowlist is empty", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", [])
    expect(policy.blocked).toContain("edit")
  })

  it("does NOT block write when allowlist has entries", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/project/src/foo.ts"])
    expect(policy.blocked).not.toContain("write")
  })

  it("allowedDescription mentions allowlist when empty", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", [])
    expect(policy.allowedDescription.toLowerCase()).toContain("allowlist")
  })
})

describe("Tool policy — IMPLEMENTATION/INCREMENTAL bashCommandPredicate", () => {
  it("provides bashCommandPredicate when allowlist is non-empty", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate).toBeDefined()
  })

  it("allows read-only commands (bun test, grep, find)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!("bun test")).toBe(true)
    expect(policy.bashCommandPredicate!("grep -r 'foo' src/")).toBe(true)
    expect(policy.bashCommandPredicate!("find . -name '*.ts'")).toBe(true)
  })

  it("blocks file-write operators (>, >>)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!("echo 'bad' > /etc/foo")).toBe(false)
    expect(policy.bashCommandPredicate!("cat data >> output.txt")).toBe(false)
  })

  it("blocks tee command", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!("echo hello | tee file.txt")).toBe(false)
  })

  it("blocks sed -i command", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!("sed -i 's/old/new/g' file.ts")).toBe(false)
  })

  it("does NOT block stderr redirect (2>&1)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    // 2>&1 should be allowed (it redirects stderr to stdout, not to a file)
    expect(policy.bashCommandPredicate!("bun test 2>&1")).toBe(true)
  })

  it("GREENFIELD mode does NOT have bashCommandPredicate", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.bashCommandPredicate).toBeUndefined()
  })
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

describe("Tool policy — exhaustive default case (H5)", () => {
  it("unknown phase returns blocked=[write,edit,bash] as safety fallback", () => {
    // Cast an invalid string to Phase to exercise the runtime default branch.
    // TypeScript's `never` check would catch this at compile time for real code,
    // but at runtime we need a safe fallback.
    const policy = getPhaseToolPolicy("NONEXISTENT_PHASE" as any, "DRAFT", null, [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).toContain("bash")
  })

  it("unknown phase allowedDescription mentions the phase name", () => {
    const policy = getPhaseToolPolicy("FUTURE_PHASE" as any, "DRAFT", null, [])
    expect(policy.allowedDescription).toContain("FUTURE_PHASE")
  })

  it("unknown phase has no writePathPredicate or bashCommandPredicate", () => {
    const policy = getPhaseToolPolicy("BOGUS" as any, "DRAFT", "GREENFIELD", ["/a.ts"])
    expect(policy.writePathPredicate).toBeUndefined()
    expect(policy.bashCommandPredicate).toBeUndefined()
  })
})
