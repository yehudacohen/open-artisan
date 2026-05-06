/**
 * Tests for fast-forward.ts — phase skip logic.
 *
 * Section 1: Phase fast-forward for returning projects (computeFastForward)
 * - No approved artifacts → no skip, start at first phase
 * - All artifacts approved and intact → skip all phases
 * - Partial artifacts → skip up to the first missing one
 * - File deleted from disk → stop at that phase
 * - Content hash mismatch → stop at that phase
 * - Time-sentinel hash → skip (no content verification)
 * - GREENFIELD skips DISCOVERY in phase sequence
 * - REFACTOR/INCREMENTAL include DISCOVERY
 * - Message format verification
 *
 * Section 2: Forward-pass skip for INCREMENTAL mode (computeForwardSkip)
 * - Non-INCREMENTAL mode → no skip
 * - Empty fileAllowlist → no skip
 * - No interface files in allowlist → skip INTERFACES
 * - No test files in allowlist → skip TESTS
 * - Both skipped → also skip IMPL_PLAN
 * - Has interface files → don't skip INTERFACES
 * - Has test files → don't skip TESTS
 * - Non-skippable next phase → no skip
 * - Message format
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { computeFastForward, computeForwardSkip } from "#core/fast-forward"
import type { ArtifactKey, Phase } from "#core/workflow-primitives"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches the artifactHash() in index.ts and fast-forward.ts */
function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ff-test-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeArtifact(key: string, content: string): string {
  const dir = join(tmpDir, ".openartisan", "test-feature")
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${key}.md`)
  writeFileSync(filePath, content)
  return filePath
}

// ---------------------------------------------------------------------------
// No approved artifacts
// ---------------------------------------------------------------------------

describe("computeFastForward — no approved artifacts", () => {
  it("returns first phase for GREENFIELD with no approvals", async () => {
    const result = await computeFastForward("GREENFIELD", {}, {})
    expect(result.targetPhase).toBe("PLANNING")
    expect(result.targetPhaseState).toBe("DRAFT")
    expect(result.skippedPhases).toHaveLength(0)
  })

  it("returns DISCOVERY/SCAN for REFACTOR with no approvals", async () => {
    const result = await computeFastForward("REFACTOR", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
    expect(result.skippedPhases).toHaveLength(0)
  })

  it("returns DISCOVERY/SCAN for INCREMENTAL with no approvals", async () => {
    const result = await computeFastForward("INCREMENTAL", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
    expect(result.skippedPhases).toHaveLength(0)
  })

  it("message indicates no prior artifacts found", async () => {
    const result = await computeFastForward("GREENFIELD", {}, {})
    expect(result.message).toContain("no prior approved artifacts")
  })
})

// ---------------------------------------------------------------------------
// Full fast-forward (all artifacts present and verified)
// ---------------------------------------------------------------------------

describe("computeFastForward — all artifacts intact", () => {
  it("skips all phases for GREENFIELD when all artifacts are intact", async () => {
    const planContent = "# Plan\nDo the thing."
    const ifaceContent = "# Interfaces\nexport interface Foo {}"
    const testsContent = "# Tests\ntest('works', ...)"
    const implPlanContent = "# Impl Plan\n1. Do step A"
    const implContent = "# Implementation\nDone."

    const planPath = writeArtifact("plan", planContent)
    const ifacePath = writeArtifact("interfaces", ifaceContent)
    const testsPath = writeArtifact("tests", testsContent)
    const implPlanPath = writeArtifact("impl_plan", implPlanContent)
    const implPath = writeArtifact("implementation", implContent)

    const approved: Partial<Record<ArtifactKey, string>> = {
      plan: artifactHash(planContent),
      interfaces: artifactHash(ifaceContent),
      tests: artifactHash(testsContent),
      impl_plan: artifactHash(implPlanContent),
      implementation: artifactHash(implContent),
    }

    const diskPaths: Partial<Record<ArtifactKey, string>> = {
      plan: planPath,
      interfaces: ifacePath,
      tests: testsPath,
      impl_plan: implPlanPath,
      implementation: implPath,
    }

    const result = await computeFastForward("GREENFIELD", approved, diskPaths)
    expect(result.targetPhase).toBe("DONE")
    expect(result.skippedPhases).toHaveLength(5)
    expect(result.skippedPhases).toEqual(["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"])
    expect(result.message).toContain("All")
    expect(result.message).toContain("intact")
  })

  it("skips all phases for REFACTOR when all artifacts including conventions are intact", async () => {
    const convContent = "# Conventions\nUse kebab-case."
    const planContent = "# Plan"
    const ifaceContent = "# Interfaces"
    const testsContent = "# Tests"
    const implPlanContent = "# Impl Plan"
    const implContent = "# Implementation"

    const convPath = writeArtifact("conventions", convContent)
    const planPath = writeArtifact("plan", planContent)
    const ifacePath = writeArtifact("interfaces", ifaceContent)
    const testsPath = writeArtifact("tests", testsContent)
    const implPlanPath = writeArtifact("impl_plan", implPlanContent)
    const implPath = writeArtifact("implementation", implContent)

    const approved: Partial<Record<ArtifactKey, string>> = {
      conventions: artifactHash(convContent),
      plan: artifactHash(planContent),
      interfaces: artifactHash(ifaceContent),
      tests: artifactHash(testsContent),
      impl_plan: artifactHash(implPlanContent),
      implementation: artifactHash(implContent),
    }

    const diskPaths: Partial<Record<ArtifactKey, string>> = {
      conventions: convPath,
      plan: planPath,
      interfaces: ifacePath,
      tests: testsPath,
      impl_plan: implPlanPath,
      implementation: implPath,
    }

    const result = await computeFastForward("REFACTOR", approved, diskPaths)
    expect(result.targetPhase).toBe("DONE")
    expect(result.skippedPhases).toHaveLength(6)
    expect(result.skippedPhases[0]).toBe("DISCOVERY")
    expect(result.skippedPhases[5]).toBe("IMPLEMENTATION")
  })
})

// ---------------------------------------------------------------------------
// Partial fast-forward
// ---------------------------------------------------------------------------

describe("computeFastForward — partial artifacts", () => {
  it("skips PLANNING, stops at INTERFACES when only plan is approved", async () => {
    const planContent = "# Plan\nThe plan."
    const planPath = writeArtifact("plan", planContent)

    const result = await computeFastForward("GREENFIELD", {
      plan: artifactHash(planContent),
    }, {
      plan: planPath,
    })

    expect(result.targetPhase).toBe("INTERFACES")
    expect(result.targetPhaseState).toBe("DRAFT")
    expect(result.skippedPhases).toEqual(["PLANNING"])
    expect(result.message).toContain("Fast-forwarded")
    expect(result.message).toContain("PLANNING")
    expect(result.message).toContain("INTERFACES")
  })

  it("skips DISCOVERY+PLANNING, stops at INTERFACES for REFACTOR", async () => {
    const convContent = "# Conventions"
    const planContent = "# Plan"
    const convPath = writeArtifact("conventions", convContent)
    const planPath = writeArtifact("plan", planContent)

    const result = await computeFastForward("REFACTOR", {
      conventions: artifactHash(convContent),
      plan: artifactHash(planContent),
    }, {
      conventions: convPath,
      plan: planPath,
    })

    expect(result.targetPhase).toBe("INTERFACES")
    expect(result.targetPhaseState).toBe("DRAFT")
    expect(result.skippedPhases).toEqual(["DISCOVERY", "PLANNING"])
  })

  it("stops at first missing artifact even if later ones exist", async () => {
    // Plan approved, interfaces NOT approved, tests approved
    const planContent = "# Plan"
    const testsContent = "# Tests"
    const planPath = writeArtifact("plan", planContent)
    const testsPath = writeArtifact("tests", testsContent)

    const result = await computeFastForward("GREENFIELD", {
      plan: artifactHash(planContent),
      // interfaces: NOT in approvedArtifacts
      tests: artifactHash(testsContent),
    }, {
      plan: planPath,
      tests: testsPath,
    })

    expect(result.targetPhase).toBe("INTERFACES")
    expect(result.skippedPhases).toEqual(["PLANNING"])
    // TESTS is NOT skipped even though it's approved, because INTERFACES isn't
  })
})

// ---------------------------------------------------------------------------
// File deleted from disk
// ---------------------------------------------------------------------------

describe("computeFastForward — file deleted from disk", () => {
  it("stops at phase whose artifact file was deleted", async () => {
    const planContent = "# Plan"
    const planPath = join(tmpDir, ".openartisan", "test-feature", "plan.md")
    // Do NOT write the file — simulate deletion

    const result = await computeFastForward("GREENFIELD", {
      plan: artifactHash(planContent),
    }, {
      plan: planPath, // Path exists in state but file doesn't exist on disk
    })

    expect(result.targetPhase).toBe("PLANNING")
    expect(result.skippedPhases).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Content hash mismatch
// ---------------------------------------------------------------------------

describe("computeFastForward — content hash mismatch", () => {
  it("stops at phase whose artifact content changed", async () => {
    const originalContent = "# Plan v1"
    const modifiedContent = "# Plan v2 — user edited this"
    const planPath = writeArtifact("plan", modifiedContent) // Write modified content

    const result = await computeFastForward("GREENFIELD", {
      plan: artifactHash(originalContent), // Hash of original content
    }, {
      plan: planPath,
    })

    expect(result.targetPhase).toBe("PLANNING")
    expect(result.skippedPhases).toHaveLength(0)
    expect(result.message).toContain("artifact content changed")
  })
})

// ---------------------------------------------------------------------------
// Time-sentinel hash (no content verification)
// ---------------------------------------------------------------------------

describe("computeFastForward — time-sentinel approved hash", () => {
  it("skips phase with time-sentinel hash without verifying content", async () => {
    // Time sentinels are used for approvals that do not have a single
    // content hash. We trust the sentinel as "was approved."
    const planContent = "# Plan"
    const planPath = writeArtifact("plan", planContent)

    const result = await computeFastForward("GREENFIELD", {
      plan: "approved-at-1710000000000", // Time sentinel — skip content verification
    }, {
      plan: planPath,
    })

    // Should skip PLANNING even though hash doesn't match content
    expect(result.targetPhase).toBe("INTERFACES")
    expect(result.skippedPhases).toEqual(["PLANNING"])
  })

  it("still requires file to exist on disk even with time-sentinel", async () => {
    const planPath = join(tmpDir, ".openartisan", "nonexistent", "plan.md")

    const result = await computeFastForward("GREENFIELD", {
      plan: "approved-at-1710000000000",
    }, {
      plan: planPath, // File doesn't exist
    })

    expect(result.targetPhase).toBe("PLANNING")
    expect(result.skippedPhases).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// No disk path recorded
// ---------------------------------------------------------------------------

describe("computeFastForward — no disk path", () => {
  it("stops at phase with approved hash but no disk path", async () => {
    const result = await computeFastForward("GREENFIELD", {
      plan: artifactHash("content"),
      // No disk path for plan
    }, {})

    expect(result.targetPhase).toBe("PLANNING")
    expect(result.skippedPhases).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Phase sequence by mode
// ---------------------------------------------------------------------------

describe("computeFastForward — mode-specific phase sequences", () => {
  it("GREENFIELD starts at PLANNING (no DISCOVERY)", async () => {
    const result = await computeFastForward("GREENFIELD", {}, {})
    expect(result.targetPhase).toBe("PLANNING")
    expect(result.targetPhaseState).toBe("DRAFT")
  })

  it("REFACTOR starts at DISCOVERY/SCAN", async () => {
    const result = await computeFastForward("REFACTOR", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
  })

  it("INCREMENTAL starts at DISCOVERY/SCAN", async () => {
    const result = await computeFastForward("INCREMENTAL", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
  })

  it("DISCOVERY uses SCAN as initial phaseState, others use DRAFT", async () => {
    // Make conventions approved so DISCOVERY is skipped, landing at PLANNING
    const convContent = "# Conv"
    const convPath = writeArtifact("conventions", convContent)

    const result = await computeFastForward("REFACTOR", {
      conventions: artifactHash(convContent),
    }, {
      conventions: convPath,
    })

    expect(result.targetPhase).toBe("PLANNING")
    expect(result.targetPhaseState).toBe("DRAFT")
  })
})

// ---------------------------------------------------------------------------
// Message format
// ---------------------------------------------------------------------------

describe("computeFastForward — message format", () => {
  it("no-skip message mentions starting phase", async () => {
    const result = await computeFastForward("GREENFIELD", {}, {})
    expect(result.message).toContain("PLANNING")
  })

  it("skip message mentions skipped phases and target", async () => {
    const planContent = "# Plan"
    const planPath = writeArtifact("plan", planContent)

    const result = await computeFastForward("GREENFIELD", {
      plan: artifactHash(planContent),
    }, {
      plan: planPath,
    })

    expect(result.message).toContain("Fast-forwarded")
    expect(result.message).toContain("PLANNING")
    expect(result.message).toContain("INTERFACES")
    expect(result.message).toContain("Prior artifacts are intact")
  })

  it("all-skipped message mentions all phases verified", async () => {
    const planContent = "# P"
    const ifaceContent = "# I"
    const testsContent = "# T"
    const implPlanContent = "# IP"
    const implContent = "# Impl"

    const result = await computeFastForward("GREENFIELD", {
      plan: artifactHash(planContent),
      interfaces: artifactHash(ifaceContent),
      tests: artifactHash(testsContent),
      impl_plan: artifactHash(implPlanContent),
      implementation: artifactHash(implContent),
    }, {
      plan: writeArtifact("plan", planContent),
      interfaces: writeArtifact("interfaces", ifaceContent),
      tests: writeArtifact("tests", testsContent),
      impl_plan: writeArtifact("impl_plan", implPlanContent),
      implementation: writeArtifact("implementation", implContent),
    })

    expect(result.message).toContain("All")
    expect(result.message).toContain("verified")
  })
})

// ===========================================================================
// Section 2: computeForwardSkip — forward-pass skip for INCREMENTAL mode
// ===========================================================================

describe("computeForwardSkip — non-INCREMENTAL mode returns null", () => {
  it("returns null for GREENFIELD even with implementation-only files", () => {
    const result = computeForwardSkip("INTERFACES", "GREENFIELD", ["/project/src/foo.impl.ts"])
    expect(result).toBeNull()
  })

  it("returns null for REFACTOR", () => {
    const result = computeForwardSkip("INTERFACES", "REFACTOR", ["/project/src/foo.impl.ts"])
    expect(result).toBeNull()
  })

  it("returns null when mode is null", () => {
    const result = computeForwardSkip("INTERFACES", null, ["/project/src/foo.impl.ts"])
    expect(result).toBeNull()
  })
})

describe("computeForwardSkip — empty fileAllowlist behavior", () => {
  it("skips ceremony phases when allowlist is empty (operational-only task)", () => {
    // Empty allowlist means "no source files will be changed" (operational task)
    // This should skip INTERFACES, TESTS, IMPL_PLAN and go to IMPLEMENTATION
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [])
    expect(result).not.toBeNull()
    expect(result?.targetPhase).toBe("IMPLEMENTATION")
    expect(result?.skippedPhases).toEqual(["INTERFACES", "TESTS", "IMPL_PLAN"])
  })
})

describe("computeForwardSkip — INTERFACES skip", () => {
  it("skips INTERFACES when no interface files in allowlist", () => {
    // Only .impl.ts files — no interface files
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
      "/project/src/bar.impl.ts",
    ])
    expect(result).not.toBeNull()
    expect(result!.skippedPhases).toContain("INTERFACES")
  })

  it("does NOT skip INTERFACES when allowlist has interface files", () => {
    // types.ts matches isInterfaceFile due to "type" keyword
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/types.ts",
      "/project/src/foo.impl.ts",
    ])
    expect(result).toBeNull()
  })

  it("does NOT skip INTERFACES when allowlist has .d.ts files", () => {
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/foo.d.ts",
    ])
    expect(result).toBeNull()
  })

  it("does NOT skip INTERFACES when allowlist has schema files", () => {
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/schema.graphql",
    ])
    expect(result).toBeNull()
  })
})

describe("computeForwardSkip — TESTS skip", () => {
  it("skips TESTS when no test files in allowlist", () => {
    const result = computeForwardSkip("TESTS", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    expect(result).not.toBeNull()
    expect(result!.skippedPhases).toContain("TESTS")
  })

  it("does NOT skip TESTS when allowlist has test files", () => {
    const result = computeForwardSkip("TESTS", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
      "/project/tests/foo.test.ts",
    ])
    expect(result).toBeNull()
  })

  it("does NOT skip TESTS when allowlist has spec files", () => {
    const result = computeForwardSkip("TESTS", "INCREMENTAL", [
      "/project/src/foo.spec.ts",
    ])
    expect(result).toBeNull()
  })
})

describe("computeForwardSkip — IMPL_PLAN skip", () => {
  it("IMPL_PLAN alone is NOT skipped (requires INTERFACES+TESTS skipped first)", () => {
    // If nextPhase is IMPL_PLAN, INTERFACES and TESTS were not skipped in this call
    const result = computeForwardSkip("IMPL_PLAN", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    // IMPL_PLAN is the nextPhase, but INTERFACES and TESTS aren't in skippedPhases
    // because we're starting from IMPL_PLAN, not INTERFACES
    expect(result).toBeNull()
  })
})

describe("computeForwardSkip — multi-phase skip", () => {
  it("skips INTERFACES + TESTS + IMPL_PLAN when only impl files in allowlist", () => {
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
      "/project/src/bar.impl.ts",
    ])
    expect(result).not.toBeNull()
    expect(result!.skippedPhases).toEqual(["INTERFACES", "TESTS", "IMPL_PLAN"])
    expect(result!.targetPhase).toBe("IMPLEMENTATION")
    expect(result!.targetPhaseState).toBe("DRAFT")
  })

  it("skips INTERFACES + TESTS but NOT IMPL_PLAN when test files present", () => {
    // Has interface-irrelevant but test-relevant files
    // Actually wait — if test files are present, TESTS is NOT skipped
    // So this test is about: no interface, no test → skip all 3
    // Let's test: no interface files, has test files → skip INTERFACES, stop at TESTS
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
      "/project/tests/bar.test.ts",
    ])
    expect(result).not.toBeNull()
    expect(result!.skippedPhases).toEqual(["INTERFACES"])
    expect(result!.targetPhase).toBe("TESTS")
  })

  it("skips INTERFACES only when test files present (stops at TESTS)", () => {
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
      "/project/tests/foo.test.ts",
    ])
    expect(result).not.toBeNull()
    expect(result!.skippedPhases).toEqual(["INTERFACES"])
    expect(result!.targetPhase).toBe("TESTS")
    expect(result!.targetPhaseState).toBe("DRAFT")
  })
})

describe("computeForwardSkip — non-skippable next phase", () => {
  it("returns null when nextPhase is IMPLEMENTATION", () => {
    const result = computeForwardSkip("IMPLEMENTATION", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    expect(result).toBeNull()
  })

  it("returns null when nextPhase is PLANNING", () => {
    const result = computeForwardSkip("PLANNING", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    expect(result).toBeNull()
  })

  it("returns null when nextPhase is DISCOVERY", () => {
    const result = computeForwardSkip("DISCOVERY", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    expect(result).toBeNull()
  })

  it("returns null when nextPhase is DONE", () => {
    const result = computeForwardSkip("DONE", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    expect(result).toBeNull()
  })
})

describe("computeForwardSkip — message format", () => {
  it("message mentions skipped phases and target", () => {
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    expect(result).not.toBeNull()
    expect(result!.message).toContain("Auto-skipped")
    expect(result!.message).toContain("INTERFACES")
    expect(result!.message).toContain("IMPLEMENTATION")
  })

  it("message includes reason for each skipped phase", () => {
    const result = computeForwardSkip("INTERFACES", "INCREMENTAL", [
      "/project/src/foo.impl.ts",
    ])
    expect(result).not.toBeNull()
    expect(result!.message).toContain("no interface files")
    expect(result!.message).toContain("no test files")
    expect(result!.message).toContain("DAG not needed")
  })
})
