/**
 * Tests for fast-forward.ts — phase fast-forward for returning projects.
 *
 * Tests cover:
 * - No approved artifacts → no skip, start at first phase
 * - All artifacts approved and intact → skip all phases
 * - Partial artifacts → skip up to the first missing one
 * - File deleted from disk → stop at that phase
 * - Content hash mismatch → stop at that phase
 * - Time-sentinel hash → skip (no content verification)
 * - GREENFIELD skips DISCOVERY in phase sequence
 * - REFACTOR/INCREMENTAL include DISCOVERY
 * - Message format verification
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { computeFastForward } from "#plugin/fast-forward"
import type { ArtifactKey, Phase } from "#plugin/types"

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
  it("returns first phase for GREENFIELD with no approvals", () => {
    const result = computeFastForward("GREENFIELD", {}, {})
    expect(result.targetPhase).toBe("PLANNING")
    expect(result.targetPhaseState).toBe("DRAFT")
    expect(result.skippedPhases).toHaveLength(0)
  })

  it("returns DISCOVERY/SCAN for REFACTOR with no approvals", () => {
    const result = computeFastForward("REFACTOR", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
    expect(result.skippedPhases).toHaveLength(0)
  })

  it("returns DISCOVERY/SCAN for INCREMENTAL with no approvals", () => {
    const result = computeFastForward("INCREMENTAL", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
    expect(result.skippedPhases).toHaveLength(0)
  })

  it("message indicates no prior artifacts found", () => {
    const result = computeFastForward("GREENFIELD", {}, {})
    expect(result.message).toContain("no prior approved artifacts")
  })
})

// ---------------------------------------------------------------------------
// Full fast-forward (all artifacts present and verified)
// ---------------------------------------------------------------------------

describe("computeFastForward — all artifacts intact", () => {
  it("skips all phases for GREENFIELD when all artifacts are intact", () => {
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

    const result = computeFastForward("GREENFIELD", approved, diskPaths)
    expect(result.targetPhase).toBe("DONE")
    expect(result.skippedPhases).toHaveLength(5)
    expect(result.skippedPhases).toEqual(["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"])
    expect(result.message).toContain("All")
    expect(result.message).toContain("intact")
  })

  it("skips all phases for REFACTOR when all artifacts including conventions are intact", () => {
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

    const result = computeFastForward("REFACTOR", approved, diskPaths)
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
  it("skips PLANNING, stops at INTERFACES when only plan is approved", () => {
    const planContent = "# Plan\nThe plan."
    const planPath = writeArtifact("plan", planContent)

    const result = computeFastForward("GREENFIELD", {
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

  it("skips DISCOVERY+PLANNING, stops at INTERFACES for REFACTOR", () => {
    const convContent = "# Conventions"
    const planContent = "# Plan"
    const convPath = writeArtifact("conventions", convContent)
    const planPath = writeArtifact("plan", planContent)

    const result = computeFastForward("REFACTOR", {
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

  it("stops at first missing artifact even if later ones exist", () => {
    // Plan approved, interfaces NOT approved, tests approved
    const planContent = "# Plan"
    const testsContent = "# Tests"
    const planPath = writeArtifact("plan", planContent)
    const testsPath = writeArtifact("tests", testsContent)

    const result = computeFastForward("GREENFIELD", {
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
  it("stops at phase whose artifact file was deleted", () => {
    const planContent = "# Plan"
    const planPath = join(tmpDir, ".openartisan", "test-feature", "plan.md")
    // Do NOT write the file — simulate deletion

    const result = computeFastForward("GREENFIELD", {
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
  it("stops at phase whose artifact content changed", () => {
    const originalContent = "# Plan v1"
    const modifiedContent = "# Plan v2 — user edited this"
    const planPath = writeArtifact("plan", modifiedContent) // Write modified content

    const result = computeFastForward("GREENFIELD", {
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
  it("skips phase with time-sentinel hash without verifying content", () => {
    // Time sentinels are used for file-based phases where artifact_content
    // wasn't provided at approval. We trust the sentinel as "was approved."
    const planContent = "# Plan"
    const planPath = writeArtifact("plan", planContent)

    const result = computeFastForward("GREENFIELD", {
      plan: "approved-at-1710000000000", // Time sentinel — skip content verification
    }, {
      plan: planPath,
    })

    // Should skip PLANNING even though hash doesn't match content
    expect(result.targetPhase).toBe("INTERFACES")
    expect(result.skippedPhases).toEqual(["PLANNING"])
  })

  it("still requires file to exist on disk even with time-sentinel", () => {
    const planPath = join(tmpDir, ".openartisan", "nonexistent", "plan.md")

    const result = computeFastForward("GREENFIELD", {
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
  it("stops at phase with approved hash but no disk path", () => {
    const result = computeFastForward("GREENFIELD", {
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
  it("GREENFIELD starts at PLANNING (no DISCOVERY)", () => {
    const result = computeFastForward("GREENFIELD", {}, {})
    expect(result.targetPhase).toBe("PLANNING")
    expect(result.targetPhaseState).toBe("DRAFT")
  })

  it("REFACTOR starts at DISCOVERY/SCAN", () => {
    const result = computeFastForward("REFACTOR", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
  })

  it("INCREMENTAL starts at DISCOVERY/SCAN", () => {
    const result = computeFastForward("INCREMENTAL", {}, {})
    expect(result.targetPhase).toBe("DISCOVERY")
    expect(result.targetPhaseState).toBe("SCAN")
  })

  it("DISCOVERY uses SCAN as initial phaseState, others use DRAFT", () => {
    // Make conventions approved so DISCOVERY is skipped, landing at PLANNING
    const convContent = "# Conv"
    const convPath = writeArtifact("conventions", convContent)

    const result = computeFastForward("REFACTOR", {
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
  it("no-skip message mentions starting phase", () => {
    const result = computeFastForward("GREENFIELD", {}, {})
    expect(result.message).toContain("PLANNING")
  })

  it("skip message mentions skipped phases and target", () => {
    const planContent = "# Plan"
    const planPath = writeArtifact("plan", planContent)

    const result = computeFastForward("GREENFIELD", {
      plan: artifactHash(planContent),
    }, {
      plan: planPath,
    })

    expect(result.message).toContain("Fast-forwarded")
    expect(result.message).toContain("PLANNING")
    expect(result.message).toContain("INTERFACES")
    expect(result.message).toContain("Prior artifacts are intact")
  })

  it("all-skipped message mentions all phases verified", () => {
    const planContent = "# P"
    const ifaceContent = "# I"
    const testsContent = "# T"
    const implPlanContent = "# IP"
    const implContent = "# Impl"

    const result = computeFastForward("GREENFIELD", {
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
