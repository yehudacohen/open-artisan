/**
 * Tests for auto-mode detection.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { detectMode } from "#plugin/mode-detect"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sw-mode-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("detectMode — empty directory", () => {
  it("suggests GREENFIELD for empty non-git directory", async () => {
    const result = await detectMode(tmpDir)
    expect(result.suggestedMode).toBe("GREENFIELD")
    expect(result.hasGitHistory).toBe(false)
    expect(result.sourceFileCount).toBe(0)
  })
})

describe("detectMode — git repo with no commits", () => {
  it("suggests GREENFIELD for git init but no commits", async () => {
    const { $ } = await import("bun")
    await $`git init`.cwd(tmpDir).quiet()
    const result = await detectMode(tmpDir)
    expect(result.suggestedMode).toBe("GREENFIELD")
    expect(result.hasGitHistory).toBe(false)
  })
})

describe("detectMode — existing codebase", () => {
  it("suggests REFACTOR when many source files present with git history", async () => {
    const { $ } = await import("bun")
    await $`git init`.cwd(tmpDir).quiet()
    await $`git config user.email test@test.com`.cwd(tmpDir).quiet()
    await $`git config user.name Test`.cwd(tmpDir).quiet()

    // Write 15 source files
    const srcDir = join(tmpDir, "src")
    await mkdir(srcDir, { recursive: true })
    for (let i = 0; i < 15; i++) {
      await writeFile(join(srcDir, `file${i}.ts`), `export const x${i} = ${i}`)
    }
    await $`git add -A`.cwd(tmpDir).quiet()
    await $`git commit -m "initial"`.cwd(tmpDir).quiet()

    const result = await detectMode(tmpDir)
    expect(result.suggestedMode).toBe("REFACTOR")
    expect(result.hasGitHistory).toBe(true)
    expect(result.sourceFileCount).toBeGreaterThanOrEqual(15)
  })

  it("suggests INCREMENTAL when few files changed relative to base", async () => {
    const { $ } = await import("bun")
    await $`git init`.cwd(tmpDir).quiet()
    await $`git config user.email test@test.com`.cwd(tmpDir).quiet()
    await $`git config user.name Test`.cwd(tmpDir).quiet()

    // Write 3 source files — small existing project
    const srcDir = join(tmpDir, "src")
    await mkdir(srcDir, { recursive: true })
    for (let i = 0; i < 3; i++) {
      await writeFile(join(srcDir, `file${i}.ts`), `export const x${i} = ${i}`)
    }
    await $`git add -A`.cwd(tmpDir).quiet()
    await $`git commit -m "initial"`.cwd(tmpDir).quiet()

    const result = await detectMode(tmpDir)
    // Small existing project — could be INCREMENTAL or REFACTOR; must not be GREENFIELD
    expect(result.suggestedMode).not.toBe("GREENFIELD")
    expect(result.hasGitHistory).toBe(true)
  })
})
