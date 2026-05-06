/**
 * Tests for the git checkpoint utility.
 *
 * Covers:
 * - Basic commit + tag creation
 * - Tag format: workflow/<phase>-v<approvalCount>
 * - No-op when working tree is clean (tag only)
 * - Not a git repo → failure
 * - INCREMENTAL mode allowlist warnings
 * - featureName scoping (.openartisan/<feature>/ only)
 * - expectedFiles: stages only listed files, warns about unstaged dirty files
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"

import { createGitCheckpoint } from "#core/hooks/git-checkpoint"

let tmpDir: string

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" }).trim()
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sw-git-"))
  git(["init"], tmpDir)
  git(["config", "user.email", "test@test.com"], tmpDir)
  git(["config", "user.name", "Test"], tmpDir)
  // Initial commit needed so HEAD exists
  await writeFile(join(tmpDir, "README.md"), "# Test")
  git(["add", "-A"], tmpDir)
  git(["commit", "-m", "initial"], tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Basic success cases
// ---------------------------------------------------------------------------

describe("createGitCheckpoint — success cases", () => {
  it("creates a commit and returns success with tag", async () => {
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "plan.md"), "# Plan")
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "PLANNING", approvalCount: 1 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.tag).toMatch(/^workflow\/planning-v1$/)
    expect(result.commitHash).toHaveLength(40)
  })

  it("tag follows format workflow/<phase>-v<approvalCount>", async () => {
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "interfaces.md"), "# Interfaces")
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "INTERFACES", approvalCount: 3 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.tag).toBe("workflow/interfaces-v3")
  })

  it("git tag is actually created in the repo", async () => {
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "impl-plan.md"), "# Impl Plan")
    await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "IMPLEMENTATION", approvalCount: 5 },
    )
    const tags = git(["tag", "-l", "workflow/*"], tmpDir)
    expect(tags).toContain("workflow/implementation-v5")
  })

  it("no-op when working tree is clean (nothing to commit) — returns success with existing HEAD", async () => {
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "PLANNING", approvalCount: 1 },
    )
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe("createGitCheckpoint — failure cases", () => {
  it("returns failure when directory is not a git repo", async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"))
    try {
      const result = await createGitCheckpoint(
        { cwd: nonGitDir },
        { phase: "PLANNING", approvalCount: 1 },
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error).toBeTruthy()
    } finally {
      await rm(nonGitDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// INCREMENTAL mode allowlist warnings
// ---------------------------------------------------------------------------

describe("createGitCheckpoint — INCREMENTAL mode allowlist warnings", () => {
  it("no warning when all staged files are in the allowlist", async () => {
    const allowedFile = join(tmpDir, "allowed.ts")
    await writeFile(allowedFile, "export const x = 0")
    git(["add", "allowed.ts"], tmpDir)
    git(["commit", "-m", "add allowed"], tmpDir)
    await writeFile(allowedFile, "export const x = 1")
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "IMPLEMENTATION", approvalCount: 1, fileAllowlist: [allowedFile] },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.warnings).toBeUndefined()
  })

  it("warns when a staged file is outside the allowlist", async () => {
    const allowedFile = join(tmpDir, "allowed.ts")
    const unexpectedFile = join(tmpDir, "unexpected.ts")
    await writeFile(allowedFile, "export const x = 0")
    await writeFile(unexpectedFile, "export const y = 0")
    git(["add", "allowed.ts", "unexpected.ts"], tmpDir)
    git(["commit", "-m", "add files"], tmpDir)
    await writeFile(allowedFile, "export const x = 1")
    await writeFile(unexpectedFile, "export const y = 2")
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "IMPLEMENTATION", approvalCount: 1, fileAllowlist: [allowedFile] },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings![0]).toContain("unexpected.ts")
  })

  it("no warning when fileAllowlist is empty (allowlist not configured)", async () => {
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "any-file.md"), "# Content")
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "IMPLEMENTATION", approvalCount: 1, fileAllowlist: [] },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.warnings).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// No-changes tag behavior (H4 fix)
// ---------------------------------------------------------------------------

describe("createGitCheckpoint — no-changes tag behavior (H4 fix)", () => {
  it("returns the real tag name when no changes to commit", async () => {
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "PLANNING", approvalCount: 2 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.tag).toBe("workflow/planning-v2")
    expect(result.tag).not.toContain("no changes")
    expect(result.commitHash).toHaveLength(40)
  })

  it("creates an annotated tag even when no changes exist (H4 — design invariant #8)", async () => {
    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "TESTS", approvalCount: 1 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.tag).toBe("workflow/tests-v1")
    const tags = git(["tag", "-l", "workflow/tests-v1"], tmpDir)
    expect(tags.trim()).toBe("workflow/tests-v1")
    const tagType = git(["cat-file", "-t", "refs/tags/workflow/tests-v1"], tmpDir)
    expect(tagType.trim()).toBe("tag")
  })
})

// ---------------------------------------------------------------------------
// featureName scoping
// ---------------------------------------------------------------------------

describe("createGitCheckpoint — featureName scoping", () => {
  it("stages only .openartisan/<featureName>/ artifacts, not other features", async () => {
    // Create artifacts for two features
    await mkdir(join(tmpDir, ".openartisan", "my-feature"), { recursive: true })
    await mkdir(join(tmpDir, ".openartisan", "other-feature"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "my-feature", "plan.md"), "# My Plan")
    await writeFile(join(tmpDir, ".openartisan", "other-feature", "plan.md"), "# Other Plan")

    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "PLANNING", approvalCount: 1, featureName: "my-feature", expectedFiles: [] },
    )
    expect(result.success).toBe(true)
    if (!result.success) return

    // Verify my-feature artifact was committed
    const log = git(["log", "--oneline", "-1", "--name-only"], tmpDir)
    expect(log).toContain(".openartisan/my-feature/plan.md")
    // other-feature should NOT be in the commit (it's unstaged)
    expect(log).not.toContain("other-feature")
  })

  it("falls back to all .openartisan/ when featureName is null", async () => {
    await mkdir(join(tmpDir, ".openartisan", "feature-a"), { recursive: true })
    await mkdir(join(tmpDir, ".openartisan", "feature-b"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "feature-a", "plan.md"), "# A")
    await writeFile(join(tmpDir, ".openartisan", "feature-b", "plan.md"), "# B")

    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "PLANNING", approvalCount: 1, featureName: null },
    )
    expect(result.success).toBe(true)
    if (!result.success) return

    const log = git(["log", "--oneline", "-1", "--name-only"], tmpDir)
    expect(log).toContain("feature-a")
    expect(log).toContain("feature-b")
  })
})

// ---------------------------------------------------------------------------
// expectedFiles: selective staging + unstaged detection
// ---------------------------------------------------------------------------

describe("createGitCheckpoint — expectedFiles selective staging", () => {
  it("stages only expectedFiles, not other modified tracked files", async () => {
    // Track two files, then modify both
    const expectedFile = join(tmpDir, "expected.ts")
    const otherFile = join(tmpDir, "other.ts")
    await writeFile(expectedFile, "v1")
    await writeFile(otherFile, "v1")
    git(["add", "expected.ts", "other.ts"], tmpDir)
    git(["commit", "-m", "track files"], tmpDir)
    await writeFile(expectedFile, "v2")
    await writeFile(otherFile, "v2")

    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "IMPLEMENTATION", approvalCount: 1, expectedFiles: [expectedFile], featureName: "test-feature" },
    )
    expect(result.success).toBe(true)
    if (!result.success) return

    // Verify only expected.ts was committed
    const log = git(["log", "--oneline", "-1", "--name-only"], tmpDir)
    expect(log).toContain("expected.ts")
    expect(log).not.toContain("other.ts")
  })

  it("warns about unstaged dirty files not in expectedFiles", async () => {
    const expectedFile = join(tmpDir, "expected.ts")
    const dirtyFile = join(tmpDir, "dirty.ts")
    await writeFile(expectedFile, "v1")
    await writeFile(dirtyFile, "v1")
    git(["add", "expected.ts", "dirty.ts"], tmpDir)
    git(["commit", "-m", "track files"], tmpDir)
    await writeFile(expectedFile, "v2")
    await writeFile(dirtyFile, "v2")

    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "IMPLEMENTATION", approvalCount: 1, expectedFiles: [expectedFile], featureName: "test-feature" },
    )
    expect(result.success).toBe(true)
    if (!result.success) return

    // Should warn about dirty.ts being unstaged
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w) => w.includes("dirty.ts"))).toBe(true)
    expect(result.warnings!.some((w) => w.includes("NOT staged"))).toBe(true)
  })

  it("no warning when expectedFiles covers all dirty files", async () => {
    const fileA = join(tmpDir, "a.ts")
    const fileB = join(tmpDir, "b.ts")
    await writeFile(fileA, "v1")
    await writeFile(fileB, "v1")
    git(["add", "a.ts", "b.ts"], tmpDir)
    git(["commit", "-m", "track"], tmpDir)
    await writeFile(fileA, "v2")
    await writeFile(fileB, "v2")

    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "IMPLEMENTATION", approvalCount: 1, expectedFiles: [fileA, fileB], featureName: "test-feature" },
    )
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.warnings).toBeUndefined()
  })

  it("empty expectedFiles falls back to legacy staging (stages all tracked modifications)", async () => {
    // Create a feature artifact + a modified tracked file
    await mkdir(join(tmpDir, ".openartisan", "my-feat"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "my-feat", "plan.md"), "# Plan")
    const sourceFile = join(tmpDir, "src.ts")
    await writeFile(sourceFile, "v1")
    git(["add", "."], tmpDir)
    git(["commit", "-m", "track"], tmpDir)
    await writeFile(sourceFile, "v2") // dirty source file

    const result = await createGitCheckpoint(
      { cwd: tmpDir },
      { phase: "PLANNING", approvalCount: 1, expectedFiles: [], featureName: "my-feat" },
    )
    // expectedFiles is empty array → condition `length > 0` is false → legacy fallback
    // Legacy stages ALL tracked modifications including the dirty source file
    expect(result.success).toBe(true)
    if (!result.success) return

    const log = git(["log", "--oneline", "-1", "--name-only"], tmpDir)
    expect(log).toContain("src.ts") // Legacy fallback staged everything
  })
})
