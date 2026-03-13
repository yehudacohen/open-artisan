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
  it("suggests INCREMENTAL (not REFACTOR) for large existing codebases", async () => {
    // REFACTOR is never auto-suggested — it requires explicit user intent.
    // Any existing project with source files → INCREMENTAL.
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
    expect(result.suggestedMode).toBe("INCREMENTAL")
    expect(result.hasGitHistory).toBe(true)
    expect(result.sourceFileCount).toBeGreaterThanOrEqual(15)
    // REFACTOR is never auto-suggested
    expect(result.suggestedMode).not.toBe("REFACTOR")
  })

  it("suggests INCREMENTAL for small existing codebase with git history", async () => {
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
    expect(result.suggestedMode).toBe("INCREMENTAL")
    expect(result.hasGitHistory).toBe(true)
    expect(result.suggestedMode).not.toBe("GREENFIELD")
  })

  it("suggests GREENFIELD when git history present but no source files", async () => {
    const { $ } = await import("bun")
    await $`git init`.cwd(tmpDir).quiet()
    await $`git config user.email test@test.com`.cwd(tmpDir).quiet()
    await $`git config user.name Test`.cwd(tmpDir).quiet()

    // Only a README, no source files
    await writeFile(join(tmpDir, "README.md"), "# Project")
    await $`git add -A`.cwd(tmpDir).quiet()
    await $`git commit -m "initial"`.cwd(tmpDir).quiet()

    const result = await detectMode(tmpDir)
    expect(result.suggestedMode).toBe("GREENFIELD")
    expect(result.hasGitHistory).toBe(true)
    expect(result.sourceFileCount).toBe(0)
  })
})

describe("detectMode — result shape", () => {
  it("always returns a ModeDetectionResult with all required fields", async () => {
    const result = await detectMode(tmpDir)
    expect(result).toHaveProperty("suggestedMode")
    expect(result).toHaveProperty("hasGitHistory")
    expect(result).toHaveProperty("sourceFileCount")
    expect(result).toHaveProperty("reasoning")
    expect(typeof result.reasoning).toBe("string")
    expect(result.reasoning.length).toBeGreaterThan(0)
  })

  it("never suggests REFACTOR — that requires explicit user intent", async () => {
    // Even a directory with source files should never auto-suggest REFACTOR
    const { $ } = await import("bun")
    await $`git init`.cwd(tmpDir).quiet()
    await $`git config user.email test@test.com`.cwd(tmpDir).quiet()
    await $`git config user.name Test`.cwd(tmpDir).quiet()
    const srcDir = join(tmpDir, "src")
    await mkdir(srcDir, { recursive: true })
    for (let i = 0; i < 50; i++) {
      await writeFile(join(srcDir, `module${i}.ts`), `export const m = ${i}`)
    }
    await $`git add -A`.cwd(tmpDir).quiet()
    await $`git commit -m "big project"`.cwd(tmpDir).quiet()

    const result = await detectMode(tmpDir)
    expect(result.suggestedMode).not.toBe("REFACTOR")
  })

  it("sourceFileCount is a non-negative number", async () => {
    const result = await detectMode(tmpDir)
    expect(result.sourceFileCount).toBeGreaterThanOrEqual(0)
  })

  it("handles non-existent directory gracefully", async () => {
    const result = await detectMode("/this/path/does/not/exist/at/all")
    expect(result.suggestedMode).toBe("GREENFIELD")
    expect(result.sourceFileCount).toBe(0)
  })
})
