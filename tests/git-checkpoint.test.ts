/**
 * Tests for the git checkpoint utility.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
    await writeFile(join(tmpDir, "new-file.ts"), "export const x = 1")
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
    await writeFile(join(tmpDir, "file2.ts"), "export const y = 2")
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
    await writeFile(join(tmpDir, "impl.ts"), "export const z = 3")
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
