/**
 * artifact-paths.ts — Resolves filesystem paths for phase artifacts,
 * so the isolated self-review subagent can read the actual files it is reviewing.
 *
 * Strategy:
 * - INCREMENTAL mode: the fileAllowlist is the authoritative set of written files.
 *   For INTERFACES and TESTS we filter to only include interface/test files respectively.
 *   For IMPLEMENTATION we use the full allowlist.
 * - GREENFIELD/REFACTOR modes: we use glob-based heuristics per phase since there is
 *   no explicit allowlist. These are best-effort — the reviewer will fall back to
 *   "no specific paths" mode if the paths are empty or files do not exist.
 * - PLANNING/IMPL_PLAN: artifacts are in-memory documents (not written to disk by
 *   the workflow itself), so we return [] and the reviewer uses conversation context.
 * - DISCOVERY: conventions document is stored in state.conventions (not a file),
 *   return [].
 *
 * The returned paths are absolute. Callers must not assume the files exist — the
 * reviewer's prompt gracefully handles the empty-paths case.
 */

import { join } from "node:path"
import { readdirSync, existsSync, statSync } from "node:fs"
import type { Phase, WorkflowMode } from "../types"
import { isInterfaceFile, isTestFile } from "../hooks/tool-guard"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect files matching a predicate under a directory (max depth). */
function collectFiles(
  dir: string,
  predicate: (path: string) => boolean,
  maxDepth = 4,
  depth = 0,
): string[] {
  if (depth > maxDepth || !existsSync(dir)) return []
  const results: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue
    const full = join(dir, entry)
    let stat: import("node:fs").Stats
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, predicate, maxDepth, depth + 1))
    } else if (predicate(full)) {
      results.push(full)
    }
  }
  return results
}

/** Cap paths to a reasonable number to avoid bloating the reviewer's prompt. */
const MAX_PATHS = 20

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns a best-effort list of absolute artifact file paths for the given phase.
 *
 * @param phase - Current workflow phase
 * @param mode - Workflow mode
 * @param cwd - Absolute path to the project root
 * @param fileAllowlist - INCREMENTAL allowlist (may be empty for other modes)
 */
export function resolveArtifactPaths(
  phase: Phase,
  mode: WorkflowMode | null,
  cwd: string,
  fileAllowlist: string[],
): string[] {
  switch (phase) {
    // Documents living in conversation memory, not files — reviewer uses context
    case "DISCOVERY":
    case "PLANNING":
    case "IMPL_PLAN":
    case "MODE_SELECT":
    case "DONE":
      return []

    case "INTERFACES": {
      if (mode === "INCREMENTAL" && fileAllowlist.length > 0) {
        return fileAllowlist.filter(isInterfaceFile).slice(0, MAX_PATHS)
      }
      // GREENFIELD/REFACTOR: scan common source directories for interface-like files
      const sourceDirs = [
        join(cwd, "src"),
        join(cwd, "lib"),
        join(cwd, "app"),
        join(cwd, "packages"),
      ]
      const candidates: string[] = []
      for (const dir of sourceDirs) {
        candidates.push(...collectFiles(dir, isInterfaceFile))
        if (candidates.length >= MAX_PATHS) break
      }
      // Prefer files with "types", "interfaces", "models", "schema" in name
      const preferred = candidates.filter((p) =>
        /types|interfaces|models|schema|api/i.test(p.split("/").at(-1) ?? ""),
      )
      const rest = candidates.filter((p) => !preferred.includes(p))
      return [...preferred, ...rest].slice(0, MAX_PATHS)
    }

    case "TESTS": {
      if (mode === "INCREMENTAL" && fileAllowlist.length > 0) {
        return fileAllowlist.filter(isTestFile).slice(0, MAX_PATHS)
      }
      // GREENFIELD/REFACTOR: scan common test directories
      const testDirs = [
        join(cwd, "tests"),
        join(cwd, "test"),
        join(cwd, "__tests__"),
        join(cwd, "spec"),
        join(cwd, "src"),
      ]
      const found: string[] = []
      for (const dir of testDirs) {
        found.push(...collectFiles(dir, isTestFile))
        if (found.length >= MAX_PATHS) break
      }
      return found.slice(0, MAX_PATHS)
    }

    case "IMPLEMENTATION": {
      if (mode === "INCREMENTAL" && fileAllowlist.length > 0) {
        return fileAllowlist.slice(0, MAX_PATHS)
      }
      // GREENFIELD/REFACTOR: scan common source directories for source files (non-test)
      const implDirs = [
        join(cwd, "src"),
        join(cwd, "lib"),
        join(cwd, "app"),
        join(cwd, "packages"),
      ]
      const all: string[] = []
      for (const dir of implDirs) {
        all.push(...collectFiles(dir, (p) => {
          const lower = p.toLowerCase()
          return (
            !isTestFile(p) &&
            (lower.endsWith(".ts") || lower.endsWith(".js") ||
             lower.endsWith(".py") || lower.endsWith(".go") ||
             lower.endsWith(".rs") || lower.endsWith(".java"))
          )
        }))
        if (all.length >= MAX_PATHS) break
      }
      return all.slice(0, MAX_PATHS)
    }

    default: {
      // Exhaustive guard — new phases return empty paths by default
      const _exhaustive: never = phase
      return []
    }
  }
}
