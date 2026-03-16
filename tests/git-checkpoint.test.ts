/**
 * Tests for the git checkpoint utility.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createGitCheckpoint } from "#plugin/hooks/git-checkpoint"

let tmpDir: string

beforeEach(async () => {
  const { $ } = await import("bun")
  tmpDir = await mkdtemp(join(tmpdir(), "sw-git-"))
  await $`git init`.cwd(tmpDir).quiet()
  await $`git config user.email test@test.com`.cwd(tmpDir).quiet()
  await $`git config user.name Test`.cwd(tmpDir).quiet()
  // Initial commit needed so HEAD exists
  await writeFile(join(tmpDir, "README.md"), "# Test")
  await $`git add -A`.cwd(tmpDir).quiet()
  await $`git commit -m "initial"`.cwd(tmpDir).quiet()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("createGitCheckpoint — success cases", () => {
  it("creates a commit and returns success with tag", async () => {
    const { $ } = await import("bun")
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "plan.md"), "# Plan")
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "PLANNING", approvalCount: 1 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.tag).toMatch(/^workflow\/planning-v1$/)
    expect(result.commitHash).toHaveLength(40)
  })

  it("tag follows format workflow/<phase>-v<approvalCount>", async () => {
    const { $ } = await import("bun")
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "interfaces.md"), "# Interfaces")
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "INTERFACES", approvalCount: 3 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.tag).toBe("workflow/interfaces-v3")
  })

  it("git tag is actually created in the repo", async () => {
    const { $ } = await import("bun")
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "impl-plan.md"), "# Impl Plan")
    await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "IMPLEMENTATION", approvalCount: 5 },
    )
    const tags = await $`git tag -l "workflow/*"`.cwd(tmpDir).text()
    expect(tags).toContain("workflow/implementation-v5")
  })

  it("no-op when working tree is clean (nothing to commit) — returns success with existing HEAD", async () => {
    const { $ } = await import("bun")
    // Do not write any new files — tree is clean
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "PLANNING", approvalCount: 1 },
    )
    // Should succeed even with clean tree (just tags)
    expect(result.success).toBe(true)
  })
})

describe("createGitCheckpoint — failure cases", () => {
  it("returns failure when directory is not a git repo", async () => {
    const { $ } = await import("bun")
    const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"))
    try {
      const result = await createGitCheckpoint(
        { cwd: nonGitDir, $ },
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

describe("createGitCheckpoint — INCREMENTAL mode allowlist warnings", () => {
  it("no warning when all staged files are in the allowlist", async () => {
    const { $ } = await import("bun")
    // Create and track the file first, then modify it so `git add -u` stages it
    const allowedFile = join(tmpDir, "allowed.ts")
    await writeFile(allowedFile, "export const x = 0")
    await $`git add allowed.ts`.cwd(tmpDir).quiet()
    await $`git commit -m "add allowed"`.cwd(tmpDir).quiet()
    await writeFile(allowedFile, "export const x = 1")
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "IMPLEMENTATION", approvalCount: 1, fileAllowlist: [allowedFile] },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.warnings).toBeUndefined()
  })

  it("warns when a staged file is outside the allowlist", async () => {
    const { $ } = await import("bun")
    // Create and track both files, then modify so `git add -u` stages them
    const allowedFile = join(tmpDir, "allowed.ts")
    const unexpectedFile = join(tmpDir, "unexpected.ts")
    await writeFile(allowedFile, "export const x = 0")
    await writeFile(unexpectedFile, "export const y = 0")
    await $`git add allowed.ts unexpected.ts`.cwd(tmpDir).quiet()
    await $`git commit -m "add files"`.cwd(tmpDir).quiet()
    await writeFile(allowedFile, "export const x = 1")
    await writeFile(unexpectedFile, "export const y = 2")
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "IMPLEMENTATION", approvalCount: 1, fileAllowlist: [allowedFile] },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings![0]).toContain("unexpected.ts")
  })

  it("no warning when fileAllowlist is empty (allowlist not configured)", async () => {
    const { $ } = await import("bun")
    // Place file in .openartisan/ so it gets staged by `git add -A .openartisan/`
    await mkdir(join(tmpDir, ".openartisan"), { recursive: true })
    await writeFile(join(tmpDir, ".openartisan", "any-file.md"), "# Content")
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "IMPLEMENTATION", approvalCount: 1, fileAllowlist: [] },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.warnings).toBeUndefined()
  })
})

describe("createGitCheckpoint — no-changes tag behavior (H4 fix)", () => {
  it("returns the real tag name when no changes to commit", async () => {
    const { $ } = await import("bun")
    // Do not write any new files — tree is clean
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "PLANNING", approvalCount: 2 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    // Should return the real tag name, not "(no changes to commit)"
    expect(result.tag).toBe("workflow/planning-v2")
    expect(result.tag).not.toContain("no changes")
    // commitHash should still be the HEAD
    expect(result.commitHash).toHaveLength(40)
  })

  it("creates an annotated tag even when no changes exist (H4 — design invariant #8)", async () => {
    const { $ } = await import("bun")
    const result = await createGitCheckpoint(
      { cwd: tmpDir, $ },
      { phase: "TESTS", approvalCount: 1 },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.tag).toBe("workflow/tests-v1")
    // Tag should exist even without a new commit
    const tags = await $`git tag -l "workflow/tests-v1"`.cwd(tmpDir).text()
    expect(tags.trim()).toBe("workflow/tests-v1")
    // Should be an annotated tag (verify with git cat-file)
    const tagType = await $`git cat-file -t refs/tags/workflow/tests-v1`.cwd(tmpDir).text()
    expect(tagType.trim()).toBe("tag")
  })
})
