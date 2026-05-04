/**
 * Tests for getPhaseToolPolicy — the phase-gating rules for tool calls.
 */
import { describe, expect, it } from "bun:test"

import { extractWriteToolPaths, getPhaseToolPolicy } from "#core/hooks/tool-guard"
import type { PhaseToolPolicy } from "#core/types"

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

describe("Tool policy — apply_patch path extraction", () => {
  it("extracts .openartisan targets from freeform apply_patch text", () => {
    const paths = extractWriteToolPaths("*** Begin Patch\n*** Add File: .openartisan/fix-ci-dev-mode-aspect/conventions.md\n+body\n*** End Patch")
    expect(paths).toEqual([".openartisan/fix-ci-dev-mode-aspect/conventions.md"])
  })

  it("extracts quoted targets from apply_patch text", () => {
    const paths = extractWriteToolPaths({
      patchText: "*** Begin Patch\n*** Add File: \".openartisan/fix-ci-dev-mode-aspect/conventions.md\"\n+body\n*** End Patch",
    })
    expect(paths).toEqual([".openartisan/fix-ci-dev-mode-aspect/conventions.md"])
  })

  it("extracts nested and diff-style patch targets", () => {
    const paths = extractWriteToolPaths({
      input: {
        patch: "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts",
      },
    })
    expect(paths).toEqual(["src/new.ts"])
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

describe("Tool policy — PLANNING and IMPL_PLAN DRAFT allow artifact writes only", () => {
  it("PLANNING/DRAFT allows .openartisan/ writes but blocks bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).toContain("bash")
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/feature-x/plan.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/.openartisan/.env")).toBe(false)
  })

  it("IMPL_PLAN/DRAFT allows .openartisan/ writes but blocks bash", () => {
    const policy = getPhaseToolPolicy("IMPL_PLAN", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).toContain("bash")
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/feature-x/impl-plan.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/server.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/.openartisan/.env")).toBe(false)
  })

  it("PLANNING/CONVENTIONS allows .openartisan/ writes but blocks bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "CONVENTIONS", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).toContain("bash")
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/.openartisan/feature-x/plan.md")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
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

  it("predicate blocks .openartisan markdown artifacts in INTERFACES", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.(".openartisan/feature/interfaces.md")).toBe(false)
    expect(policy.writePathPredicate?.("/project/.openartisan/feature/interfaces.md")).toBe(false)
  })

  // Decision note: treat REDRAFT as artifact authoring and SKIP_CHECK/CASCADE_CHECK
  // as non-authoring decision states. Alternative considered: inherit ordinary
  // DRAFT permissions for all new states. Rejected because that would over-grant
  // writes during structural decision points and weaken the approved plan's guard story.
  it("INTERFACES/REDRAFT should preserve interface-only write permissions", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "REDRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/src/types.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/server.ts")).toBe(false)
    expect(policy.blocked).toContain("bash")
  })

  it("INTERFACES/SKIP_CHECK should block writes while the workflow is deciding whether to skip", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "SKIP_CHECK", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).toContain("bash")
  })

  it("INTERFACES/CASCADE_CHECK should block writes while cascade auto-skip is being evaluated", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "CASCADE_CHECK", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).toContain("bash")
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

  it("predicate blocks .openartisan markdown artifacts in TESTS", () => {
    const policy = getPhaseToolPolicy("TESTS", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate?.(".openartisan/feature/tests.md")).toBe(false)
    expect(policy.writePathPredicate?.("/project/.openartisan/feature/tests.md")).toBe(false)
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

describe("Tool policy — IMPLEMENTATION structural sub-states", () => {
  const allowlist = ["/project/src/task.ts", "/project/tests/task.test.ts"]
  const taskFiles = ["/project/src/task.ts", "/project/tests/task.test.ts"]

  // Decision note: SCHEDULING, TASK_REVIEW, HUMAN_GATE, and DELEGATED_WAIT are
  // structural wait/decision states, not authoring states. Alternative considered:
  // inherit IMPLEMENTATION/DRAFT permissions for all of them. Rejected because it
  // would allow source writes while the workflow is dispatching, reviewing, waiting
  // on manual action, or blocked on delegated completion.
  for (const phaseState of ["SCHEDULING", "TASK_REVIEW", "HUMAN_GATE", "DELEGATED_WAIT"] as const) {
    it(`IMPLEMENTATION/${phaseState} blocks source writes while no authoring work is active`, () => {
      const policy = getPhaseToolPolicy("IMPLEMENTATION", phaseState, "INCREMENTAL", allowlist, taskFiles)
      expect(policy.blocked).toContain("write")
      expect(policy.blocked).toContain("edit")
    })
  }

  it("IMPLEMENTATION/TASK_REVISE preserves current-task file restrictions for targeted repair", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "TASK_REVISE", "INCREMENTAL", allowlist, taskFiles)
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/src/task.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/tests/task.test.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/other.ts")).toBe(false)
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
  it("IMPLEMENTATION/INCREMENTAL with empty allowlist does not tell the agent to call select_mode", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", [])
    expect(policy.allowedDescription.toLowerCase()).not.toContain("select_mode")
    expect(policy.allowedDescription.toLowerCase()).toContain("allowlist")
  })

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

  it("blocks heredoc pattern (<<EOF)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!("cat <<EOF > file.txt\nhello\nEOF")).toBe(false)
  })

  it("blocks heredoc with dash (<<-EOF)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!("cat <<-EOF\nhello\nEOF")).toBe(false)
  })

  it("blocks heredoc with single-quoted delimiter (<<'MARKER')", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!("cat <<'MARKER'\ncontent\nMARKER")).toBe(false)
  })

  it("blocks heredoc with double-quoted delimiter (<<\"MARKER\")", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    expect(policy.bashCommandPredicate!('cat <<"MARKER"\ncontent\nMARKER')).toBe(false)
  })

  it("does NOT block << in non-heredoc context (shift operator)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"])
    // Note: our regex will match <<- with a word after it. The shift operator
    // x << 3 has a number after <<, not a word. However, `<<3` does match
    // \w+ (numbers are word characters). This is a false positive we accept
    // for security — it's better to over-block than under-block.
    // The predicate blocks << followed by a word character, which catches
    // most heredoc patterns.
    expect(policy.bashCommandPredicate!("node -e 'console.log(1 << 3)'")).toBe(true)
    expect(policy.bashCommandPredicate!("node -e 'console.log(value << amount)'")).toBe(false)
  })

  it("GREENFIELD mode does NOT have bashCommandPredicate", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.bashCommandPredicate).toBeUndefined()
  })
})

describe("Tool policy — MODE_SELECT blocks write and edit but allows bash", () => {
  it("MODE_SELECT blocks write and edit", () => {
    const policy = getPhaseToolPolicy("MODE_SELECT", "DRAFT", null, [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
  })

  it("MODE_SELECT allows bash (read-only exploration for mode selection)", () => {
    const policy = getPhaseToolPolicy("MODE_SELECT", "DRAFT", null, [])
    expect(policy.blocked).not.toContain("bash")
  })
})

describe("Tool policy — DONE blocks write and edit but allows bash", () => {
  it("DONE blocks write and edit", () => {
    const policy = getPhaseToolPolicy("DONE", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
  })

  it("DONE allows bash for read-only post-completion tasks", () => {
    const policy = getPhaseToolPolicy("DONE", "DRAFT", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })
})

// ---------------------------------------------------------------------------
// ESCAPE_HATCH sub-state — same gating as USER_GATE for each phase
// ---------------------------------------------------------------------------

describe("Tool policy — DISCOVERY/ESCAPE_HATCH blocks write and edit", () => {
  it("DISCOVERY/ESCAPE_HATCH blocks write", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "ESCAPE_HATCH", "REFACTOR", [])
    expect(policy.blocked).toContain("write")
  })

  it("DISCOVERY/ESCAPE_HATCH blocks edit", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "ESCAPE_HATCH", "REFACTOR", [])
    expect(policy.blocked).toContain("edit")
  })

  it("DISCOVERY/ESCAPE_HATCH does not block bash", () => {
    const policy = getPhaseToolPolicy("DISCOVERY", "ESCAPE_HATCH", "REFACTOR", [])
    expect(policy.blocked).not.toContain("bash")
  })
})

describe("Tool policy — PLANNING/ESCAPE_HATCH blocks write and edit", () => {
  it("PLANNING/ESCAPE_HATCH blocks write", () => {
    const policy = getPhaseToolPolicy("PLANNING", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
  })

  it("PLANNING/ESCAPE_HATCH blocks edit", () => {
    const policy = getPhaseToolPolicy("PLANNING", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.blocked).toContain("edit")
  })

  it("PLANNING/ESCAPE_HATCH does not block bash", () => {
    const policy = getPhaseToolPolicy("PLANNING", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("IMPL_PLAN/ESCAPE_HATCH blocks write and edit", () => {
    const policy = getPhaseToolPolicy("IMPL_PLAN", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.blocked).toContain("write")
    expect(policy.blocked).toContain("edit")
    expect(policy.blocked).not.toContain("bash")
  })
})

describe("Tool policy — INTERFACES/ESCAPE_HATCH allows interface writes and bash", () => {
  it("INTERFACES/ESCAPE_HATCH does not block bash", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("INTERFACES/ESCAPE_HATCH allows writes to interface files via predicate", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/src/types.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/foo.d.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/schema.proto")).toBe(true)
  })

  it("INTERFACES/ESCAPE_HATCH blocks writes to non-interface files", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/server.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
  })

  it("INTERFACES/ESCAPE_HATCH blocks .env writes", () => {
    const policy = getPhaseToolPolicy("INTERFACES", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/.env")).toBe(false)
  })
})

describe("Tool policy — TESTS/ESCAPE_HATCH allows test file writes and bash", () => {
  it("TESTS/ESCAPE_HATCH does not block bash", () => {
    const policy = getPhaseToolPolicy("TESTS", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("bash")
  })

  it("TESTS/ESCAPE_HATCH allows writes to test files via predicate", () => {
    const policy = getPhaseToolPolicy("TESTS", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate?.("/project/tests/foo.test.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/src/foo.spec.ts")).toBe(true)
  })

  it("TESTS/ESCAPE_HATCH blocks writes to non-test files", () => {
    const policy = getPhaseToolPolicy("TESTS", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/src/index.ts")).toBe(false)
    expect(policy.writePathPredicate?.("/project/src/Component.tsx")).toBe(false)
  })

  it("TESTS/ESCAPE_HATCH blocks .env writes", () => {
    const policy = getPhaseToolPolicy("TESTS", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/.env")).toBe(false)
  })
})

describe("Tool policy — IMPLEMENTATION/ESCAPE_HATCH has full write access (GREENFIELD/REFACTOR)", () => {
  it("IMPLEMENTATION/ESCAPE_HATCH (GREENFIELD) allows any non-env file", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
    expect(policy.blocked).not.toContain("bash")
    expect(policy.writePathPredicate?.("/project/src/anything.ts")).toBe(true)
    expect(policy.writePathPredicate?.("/project/README.md")).toBe(true)
  })

  it("IMPLEMENTATION/ESCAPE_HATCH (REFACTOR) allows any non-env file", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "ESCAPE_HATCH", "REFACTOR", [])
    expect(policy.blocked).not.toContain("write")
    expect(policy.blocked).not.toContain("edit")
    expect(policy.writePathPredicate?.("/project/src/service.ts")).toBe(true)
  })

  it("IMPLEMENTATION/ESCAPE_HATCH still blocks .env", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "ESCAPE_HATCH", "GREENFIELD", [])
    expect(policy.writePathPredicate?.("/project/.env")).toBe(false)
    expect(policy.writePathPredicate?.("/project/.env.local")).toBe(false)
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

// ---------------------------------------------------------------------------
// Per-task file enforcement (v22)
// ---------------------------------------------------------------------------

describe("IMPLEMENTATION — per-task expectedFiles enforcement", () => {
  it("GREENFIELD with taskExpectedFiles restricts writes to task files", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [], ["pages/01.html", "css/page.css"])
    expect(policy.writePathPredicate).toBeDefined()
    expect(policy.writePathPredicate!("pages/01.html")).toBe(true)
    expect(policy.writePathPredicate!("css/page.css")).toBe(true)
    expect(policy.writePathPredicate!("pages/02.html")).toBe(false) // different task's file
    expect(policy.writePathPredicate!("src/random.ts")).toBe(false)
  })

  it("GREENFIELD with taskExpectedFiles always allows .openartisan/ writes", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [], ["pages/01.html"])
    expect(policy.writePathPredicate!("/project/.openartisan/status.md")).toBe(true)
  })

  it("GREENFIELD with taskExpectedFiles still blocks .env", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [], ["pages/01.html", ".env"])
    expect(policy.writePathPredicate!(".env")).toBe(false)
    expect(policy.writePathPredicate!(".env.local")).toBe(false)
  })

  it("GREENFIELD without taskExpectedFiles allows any file (except .env)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [])
    expect(policy.writePathPredicate!("anything.ts")).toBe(true)
    expect(policy.writePathPredicate!(".env")).toBe(false)
  })

  it("GREENFIELD with empty taskExpectedFiles allows any file (fallback)", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [], [])
    expect(policy.writePathPredicate!("anything.ts")).toBe(true)
  })

  it("INCREMENTAL with taskExpectedFiles intersects with allowlist", () => {
    const allowlist = ["/project/src/a.ts", "/project/src/b.ts", "/project/src/c.ts"]
    const taskFiles = ["/project/src/a.ts", "/project/src/b.ts"]
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", allowlist, taskFiles)
    expect(policy.writePathPredicate!("/project/src/a.ts")).toBe(true)  // in both
    expect(policy.writePathPredicate!("/project/src/b.ts")).toBe(true)  // in both
    expect(policy.writePathPredicate!("/project/src/c.ts")).toBe(false) // in allowlist but not task
    expect(policy.writePathPredicate!("/project/src/d.ts")).toBe(false) // in neither
  })

  it("task write restrictions may include expected test files", () => {
    const allowlist = ["/project/src/a.ts", "/project/tests/a.test.ts"]
    const taskFiles = ["/project/src/a.ts", "/project/tests/a.test.ts"]
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", allowlist, taskFiles)
    expect(policy.writePathPredicate!("/project/src/a.ts")).toBe(true)
    expect(policy.writePathPredicate!("/project/tests/a.test.ts")).toBe(true)
  })

  it("INCREMENTAL with taskExpectedFiles still allows .openartisan/", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "INCREMENTAL", ["/a.ts"], ["/a.ts"])
    expect(policy.writePathPredicate!("/project/.openartisan/status.md")).toBe(true)
  })

  it("REFACTOR with taskExpectedFiles restricts writes to task files", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "REFACTOR", [], ["src/refactored.ts"])
    expect(policy.writePathPredicate!("src/refactored.ts")).toBe(true)
    expect(policy.writePathPredicate!("src/other.ts")).toBe(false)
  })

  it("description mentions current task files count", () => {
    const policy = getPhaseToolPolicy("IMPLEMENTATION", "DRAFT", "GREENFIELD", [], ["a.ts", "b.ts"])
    expect(policy.allowedDescription).toContain("2 files")
    expect(policy.allowedDescription).toContain("current task")
  })
})
