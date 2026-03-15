/**
 * Tests for tools/artifact-paths.ts — resolveArtifactPaths.
 *
 * Covers:
 * - Phases that always return [] (DISCOVERY, PLANNING, IMPL_PLAN, MODE_SELECT, DONE)
 * - INCREMENTAL mode: filters allowlist by interface/test/source type per phase
 * - INTERFACES: returns interface-like files from allowlist in INCREMENTAL mode
 * - TESTS: returns test-like files from allowlist in INCREMENTAL mode
 * - IMPLEMENTATION: returns all allowlist files in INCREMENTAL mode
 * - GREENFIELD/REFACTOR: returns [] for INTERFACES/TESTS (no allowlist, no src/ to scan)
 * - Return values are bounded by MAX_PATHS (20)
 */
import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { resolveArtifactPaths } from "#plugin/tools/artifact-paths"

// ---------------------------------------------------------------------------
// Phases that return [] regardless of mode
// ---------------------------------------------------------------------------

describe("resolveArtifactPaths — always-empty phases", () => {
  for (const phase of ["DISCOVERY", "PLANNING", "IMPL_PLAN", "MODE_SELECT", "DONE"] as const) {
    it(`returns [] for ${phase}`, () => {
      const result = resolveArtifactPaths(phase, "GREENFIELD", "/workspace", [])
      expect(result).toEqual([])
    })

    it(`returns [] for ${phase} in INCREMENTAL mode with non-empty allowlist`, () => {
      const result = resolveArtifactPaths(phase, "INCREMENTAL", "/workspace", ["/workspace/src/foo.ts"])
      expect(result).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// INTERFACES phase — INCREMENTAL mode filters by interface-like extensions
// ---------------------------------------------------------------------------

describe("resolveArtifactPaths — INTERFACES phase, INCREMENTAL mode", () => {
  it("returns .ts files from the allowlist", () => {
    const allowlist = ["/workspace/src/types.ts", "/workspace/src/api.ts"]
    const result = resolveArtifactPaths("INTERFACES", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/src/types.ts")
    expect(result).toContain("/workspace/src/api.ts")
  })

  it("filters out non-interface files (e.g. .txt, .md)", () => {
    const allowlist = ["/workspace/src/types.ts", "/workspace/README.md", "/workspace/notes.txt"]
    const result = resolveArtifactPaths("INTERFACES", "INCREMENTAL", "/workspace", allowlist)
    expect(result).not.toContain("/workspace/README.md")
    expect(result).not.toContain("/workspace/notes.txt")
    expect(result).toContain("/workspace/src/types.ts")
  })

  it("includes .proto files", () => {
    const allowlist = ["/workspace/api/service.proto"]
    const result = resolveArtifactPaths("INTERFACES", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/api/service.proto")
  })

  it("includes .graphql files", () => {
    const allowlist = ["/workspace/api/schema.graphql"]
    const result = resolveArtifactPaths("INTERFACES", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/api/schema.graphql")
  })

  it("returns [] when allowlist is empty (INCREMENTAL, no files)", () => {
    const result = resolveArtifactPaths("INTERFACES", "INCREMENTAL", "/workspace", [])
    // Empty allowlist → no interface files either
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TESTS phase — INCREMENTAL mode filters by test-like paths
// ---------------------------------------------------------------------------

describe("resolveArtifactPaths — TESTS phase, INCREMENTAL mode", () => {
  it("returns files with 'test' in name", () => {
    const allowlist = ["/workspace/src/auth.test.ts", "/workspace/src/auth.ts"]
    const result = resolveArtifactPaths("TESTS", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/src/auth.test.ts")
    expect(result).not.toContain("/workspace/src/auth.ts")
  })

  it("returns files with 'spec' in name", () => {
    const allowlist = ["/workspace/src/auth.spec.ts"]
    const result = resolveArtifactPaths("TESTS", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/src/auth.spec.ts")
  })

  it("returns files in 'tests/' directory", () => {
    const allowlist = ["/workspace/tests/auth.ts"]
    const result = resolveArtifactPaths("TESTS", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/tests/auth.ts")
  })

  it("returns files in '__tests__/' directory", () => {
    const allowlist = ["/workspace/__tests__/auth.ts"]
    const result = resolveArtifactPaths("TESTS", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/__tests__/auth.ts")
  })

  it("returns monorepo test files in packages/*/src/__tests__/ (INCREMENTAL)", () => {
    const allowlist = [
      "/workspace/packages/shared/src/__tests__/focus.test.ts",
      "/workspace/packages/ingestion/src/__tests__/handler.test.ts",
      "/workspace/packages/billing/src/__tests__/calculator.test.ts",
      "/workspace/packages/app/src/index.ts", // non-test file should be filtered
    ]
    const result = resolveArtifactPaths("TESTS", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/packages/shared/src/__tests__/focus.test.ts")
    expect(result).toContain("/workspace/packages/ingestion/src/__tests__/handler.test.ts")
    expect(result).toContain("/workspace/packages/billing/src/__tests__/calculator.test.ts")
    expect(result).not.toContain("/workspace/packages/app/src/index.ts")
  })
})

// ---------------------------------------------------------------------------
// IMPLEMENTATION phase — INCREMENTAL mode returns full allowlist
// ---------------------------------------------------------------------------

describe("resolveArtifactPaths — IMPLEMENTATION phase, INCREMENTAL mode", () => {
  it("returns all allowlist files for IMPLEMENTATION", () => {
    const allowlist = [
      "/workspace/src/auth.ts",
      "/workspace/src/auth.test.ts",
      "/workspace/src/models.ts",
    ]
    const result = resolveArtifactPaths("IMPLEMENTATION", "INCREMENTAL", "/workspace", allowlist)
    expect(result).toContain("/workspace/src/auth.ts")
    expect(result).toContain("/workspace/src/auth.test.ts")
    expect(result).toContain("/workspace/src/models.ts")
  })
})

// ---------------------------------------------------------------------------
// GREENFIELD/REFACTOR — no src/ directory in test environment → returns []
// ---------------------------------------------------------------------------

describe("resolveArtifactPaths — GREENFIELD mode with no src/ dir", () => {
  it("returns [] for INTERFACES when src/ does not exist", () => {
    const result = resolveArtifactPaths("INTERFACES", "GREENFIELD", "/nonexistent/path", [])
    expect(result).toEqual([])
  })

  it("returns [] for TESTS when no test dirs exist", () => {
    const result = resolveArtifactPaths("TESTS", "GREENFIELD", "/nonexistent/path", [])
    expect(result).toEqual([])
  })

  it("returns [] for IMPLEMENTATION when src/ does not exist", () => {
    const result = resolveArtifactPaths("IMPLEMENTATION", "GREENFIELD", "/nonexistent/path", [])
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GREENFIELD/REFACTOR mode — TESTS phase scans project directories
// Uses the actual project root (this repo) to verify the scan finds .test.ts files
// under tests/ directory (a directory that actually exists in this repo).
// ---------------------------------------------------------------------------

describe("resolveArtifactPaths — TESTS phase, GREENFIELD scan finds real test files", () => {
  it("finds .test.ts files under tests/ directory of this project", () => {
    // Use the actual project root — this repo has a tests/ directory with .test.ts files
    const projectRoot = join(import.meta.dirname, "..")
    const result = resolveArtifactPaths("TESTS", "GREENFIELD", projectRoot, [])
    // Should find at least some of our own test files
    expect(result.length).toBeGreaterThan(0)
    // All returned paths should be test files
    for (const p of result) {
      const lower = p.toLowerCase()
      const hasTestPattern = lower.includes("test") || lower.includes("spec")
      expect(hasTestPattern).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// MAX_PATHS cap (20)
// ---------------------------------------------------------------------------

describe("resolveArtifactPaths — MAX_PATHS cap", () => {
  it("returns at most 20 paths for IMPLEMENTATION INCREMENTAL with large allowlist", () => {
    const large = Array.from({ length: 50 }, (_, i) => `/workspace/src/module${i}.ts`)
    const result = resolveArtifactPaths("IMPLEMENTATION", "INCREMENTAL", "/workspace", large)
    expect(result.length).toBeLessThanOrEqual(20)
  })

  it("returns at most 20 paths for INTERFACES INCREMENTAL with large allowlist", () => {
    const large = Array.from({ length: 50 }, (_, i) => `/workspace/src/types${i}.ts`)
    const result = resolveArtifactPaths("INTERFACES", "INCREMENTAL", "/workspace", large)
    expect(result.length).toBeLessThanOrEqual(20)
  })
})
