/**
 * mode-detect.ts — Heuristic mode detection from filesystem + git state.
 *
 * Rules:
 *   - No git commits at all → GREENFIELD (new project)
 *   - Git commits but zero source files → GREENFIELD (just initialised)
 *   - Git commits + source files → INCREMENTAL
 *
 * REFACTOR is intentionally never auto-suggested. Restructuring an existing
 * codebase is a deliberate architectural decision that requires explicit user
 * intent — it cannot be inferred from file counts or git history alone.
 * The user can always override by calling select_mode with REFACTOR.
 */
import { execSync } from "node:child_process"
import { readdirSync, type Dirent } from "node:fs"
import { join, extname } from "node:path"
import type { ModeDetectionResult } from "./mode-detection-types"
import type { WorkflowMode } from "./workflow-primitives"
import { SOURCE_EXTENSIONS } from "./constants"

function hasGitCommits(cwd: string): boolean {
  try {
    execSync("git rev-parse HEAD", { cwd, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/** Excluded directories for the non-git fallback glob. */
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", ".next", "coverage", "vendor",
  "__pycache__", ".cache", ".output", "out", "target",
])

/**
 * Recursive file walk that replaces Bun.Glob.
 * Returns all file paths (relative to cwd) matching source extensions,
 * excluding hidden files and common non-source directories.
 */
function walkSourceFiles(dir: string, base: string): string[] {
  const results: string[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const relPath = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...walkSourceFiles(fullPath, relPath))
    } else if (entry.isFile()) {
      const ext = extname(entry.name)
      if (ext && SOURCE_EXTENSIONS.has(ext)) {
        results.push(relPath)
      }
    }
  }
  return results
}

function countSourceFiles(cwd: string): number {
  try {
    // List all non-hidden, non-gitignored files tracked by git
    let stdout: string
    try {
      stdout = execSync("git ls-files", { cwd, stdio: "pipe", encoding: "utf-8" })
    } catch {
      // Fallback: recursive walk if not a git repo
      return walkSourceFiles(cwd, "").length
    }
    const files = stdout.trim().split("\n").filter(Boolean)
    return files.filter((f) => {
      const dotIdx = f.lastIndexOf(".")
      const ext = dotIdx >= 0 ? f.slice(dotIdx) : ""
      return ext !== "" && SOURCE_EXTENSIONS.has(ext)
    }).length
  } catch {
    return 0
  }
}

export function detectMode(cwd: string): ModeDetectionResult {
  const hasHistory = hasGitCommits(cwd)
  const sourceFileCount = countSourceFiles(cwd)

  if (!hasHistory || sourceFileCount === 0) {
    const reasoning = hasHistory
      ? `Git history present but no source files found — treating as a new project. Override with REFACTOR or INCREMENTAL if needed.`
      : "No git commits found — treating as a new project."
    return { suggestedMode: "GREENFIELD", hasGitHistory: hasHistory, sourceFileCount, reasoning }
  }

  // Existing project with source files → INCREMENTAL.
  // REFACTOR is never auto-suggested: it requires explicit architectural intent
  // that cannot be inferred from file counts or history alone.
  const reasoning =
    `Found ${sourceFileCount} source file(s) with git history — existing project detected. ` +
    `Suggesting INCREMENTAL (add/fix functionality without touching unrelated files). ` +
    `Override with REFACTOR if your goal is to restructure the entire codebase.`
  return { suggestedMode: "INCREMENTAL", hasGitHistory: hasHistory, sourceFileCount, reasoning }
}
