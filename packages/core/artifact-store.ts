/**
 * artifact-store.ts — Writes plan artifacts to well-known paths under the project root.
 *
 * All plan documents (conventions, plan, interfaces, tests, impl_plan) are written
 * to `.openartisan/` inside the project directory. This allows:
 *   1. The agent to read them back via file-reading tools rather than relying on
 *      inline context injection (which gets truncated in long sessions).
 *   2. The isolated self-review subagent to read real files rather than receiving
 *      artifact content inline (eliminating the 10,000-char cap).
 *   3. system-transform and compaction to reference file paths instead of embedding
 *      large strings into every system prompt.
 *
 * File naming convention:
 *   .openartisan/conventions.md
 *   .openartisan/plan.md
 *   .openartisan/interfaces.md
 *   .openartisan/tests.md
 *   .openartisan/impl-plan.md
 *   .openartisan/discovery-report.md
 *
 * The `.openartisan/` directory is created on first write if it does not exist.
 */

import { join } from "node:path"
import { mkdirSync, existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import type { ArtifactKey } from "./workflow-primitives"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory under the project root where all plan artifacts are stored. */
export const ARTIFACT_DIR = ".openartisan"

/**
 * Maps each artifact key (and the discovery report) to its filename.
 * These filenames are stable — do not change them without a migration plan.
 */
const ARTIFACT_FILENAMES: Record<ArtifactKey | "discovery_report", string> = {
  design: "design.md",
  conventions: "conventions.md",
  plan: "plan.md",
  interfaces: "interfaces.md",
  tests: "tests.md",
  impl_plan: "impl-plan.md",
  implementation: "implementation-notes.md",
  discovery_report: "discovery-report.md",
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the artifact subdirectory path under `cwd`.
 * When `featureName` is set, returns `.openartisan/<featureName>/`.
 * Sub-workflow featureNames may contain "/" for nesting (e.g., "parent/sub/child").
 * Otherwise returns `.openartisan/` (flat legacy layout).
 *
 * Safety: featureName is validated by validateWorkflowState() which rejects
 * ".." (path traversal) and "\\" (backslashes), and validates each path segment.
 */
export function getArtifactDir(cwd: string, featureName: string | null | undefined): string {
  if (featureName) {
    // Reject path traversal (defense in depth — validateWorkflowState also checks this)
    if (/\.\./.test(featureName)) {
      throw new Error(`featureName contains path traversal: "${featureName}"`)
    }
    return join(cwd, ARTIFACT_DIR, featureName)
  }
  return join(cwd, ARTIFACT_DIR)
}

/**
 * Returns the absolute path where an artifact would be stored.
 * Does NOT create the file or directory.
 *
 * @param cwd         - Absolute path to the project root
 * @param key         - Artifact key (or "discovery_report" for the fleet output)
 * @param featureName - Optional feature subdirectory (e.g. "cloud-cost-platform")
 */
export function getArtifactPath(
  cwd: string,
  key: ArtifactKey | "discovery_report",
  featureName?: string | null,
): string {
  return join(getArtifactDir(cwd, featureName), ARTIFACT_FILENAMES[key])
}

/**
 * Writes artifact content to `.openartisan/[<featureName>/]<filename>` under `cwd`.
 * Creates the directory if it does not exist.
 *
 * @param cwd         - Absolute path to the project root
 * @param key         - Artifact key (or "discovery_report" for the fleet output)
 * @param text        - Full artifact text to write
 * @param featureName - Optional feature subdirectory (e.g. "cloud-cost-platform")
 * @returns           - The absolute path of the written file
 */
export async function writeArtifact(
  cwd: string,
  key: ArtifactKey | "discovery_report",
  text: string,
  featureName?: string | null,
): Promise<string> {
  const dir = getArtifactDir(cwd, featureName)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, ARTIFACT_FILENAMES[key])
  await writeFile(filePath, text, "utf-8")
  return filePath
}

// ---------------------------------------------------------------------------
// Design doc detection
// ---------------------------------------------------------------------------

/**
 * Candidate file paths for a user-authored design document, checked in order.
 * First match wins. The `.openartisan/` scoped paths are checked first (most
 * specific), then common project-root conventions.
 */
const DESIGN_DOC_CANDIDATES = [
  // Feature-scoped (populated dynamically)
  // Flat .openartisan layout
  (cwd: string, _feature: string | null) => join(cwd, ARTIFACT_DIR, "design.md"),
  // Common project-root conventions
  (cwd: string, _feature: string | null) => join(cwd, "docs", "design.md"),
  (cwd: string, _feature: string | null) => join(cwd, "DESIGN.md"),
  (cwd: string, _feature: string | null) => join(cwd, "design.md"),
  (cwd: string, _feature: string | null) => join(cwd, "docs", "DESIGN.md"),
]

/**
 * Scans known locations for a user-authored design document.
 * Returns the absolute path if found, null otherwise.
 *
 * When a design doc is detected, the workflow registers it as a tracked artifact
 * upstream of the plan. Acceptance criteria then include design invariant compliance.
 *
 * @param cwd         - Absolute path to the project root
 * @param featureName - Optional feature subdirectory
 */
export function detectDesignDoc(cwd: string, featureName?: string | null): string | null {
  // Feature-scoped path takes highest priority
  if (featureName) {
    const featurePath = join(getArtifactDir(cwd, featureName), "design.md")
    if (existsSync(featurePath)) return featurePath
  }

  for (const candidateFn of DESIGN_DOC_CANDIDATES) {
    const path = candidateFn(cwd, featureName ?? null)
    if (existsSync(path)) return path
  }

  return null
}
