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
import { $ } from "bun"
import type { ModeDetectionResult, WorkflowMode } from "./types"

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".cs", ".cpp", ".c", ".h",
  ".swift", ".kt", ".scala", ".ex", ".exs", ".clj",
])

async function hasGitCommits(cwd: string): Promise<boolean> {
  try {
    const result = await $`git rev-parse HEAD`.cwd(cwd).quiet()
    return result.exitCode === 0
  } catch {
    return false
  }
}

async function countSourceFiles(cwd: string): Promise<number> {
  try {
    // List all non-hidden, non-gitignored files tracked by git
    const result = await $`git ls-files`.cwd(cwd).quiet()
    if (result.exitCode !== 0) {
      // Fallback: glob if not a git repo
      const glob = new Bun.Glob("**/*")
      let count = 0
      for await (const file of glob.scan({ cwd, onlyFiles: true })) {
        const ext = "." + file.split(".").pop()
        if (SOURCE_EXTENSIONS.has(ext) && !file.startsWith(".")) count++
      }
      return count
    }
    const files = result.stdout.toString().trim().split("\n").filter(Boolean)
    return files.filter((f) => {
      const ext = "." + f.split(".").pop()
      return SOURCE_EXTENSIONS.has(ext)
    }).length
  } catch {
    return 0
  }
}

export async function detectMode(cwd: string): Promise<ModeDetectionResult> {
  const [hasHistory, sourceFileCount] = await Promise.all([
    hasGitCommits(cwd),
    countSourceFiles(cwd),
  ])

  let suggestedMode: WorkflowMode
  let reasoning: string

  if (!hasHistory || sourceFileCount === 0) {
    suggestedMode = "GREENFIELD"
    reasoning = hasHistory
      ? `Git history present but no source files found — treating as a new project. Override with REFACTOR or INCREMENTAL if needed.`
      : "No git commits found — treating as a new project."
  } else {
    // Existing project with source files → INCREMENTAL.
    // REFACTOR is never auto-suggested: it requires explicit architectural intent
    // that cannot be inferred from file counts or history alone.
    suggestedMode = "INCREMENTAL"
    reasoning =
      `Found ${sourceFileCount} source file(s) with git history — existing project detected. ` +
      `Suggesting INCREMENTAL (add/fix functionality without touching unrelated files). ` +
      `Override with REFACTOR if your goal is to restructure the entire codebase.`
  }

  return { suggestedMode, hasGitHistory: hasHistory, sourceFileCount, reasoning }
}
