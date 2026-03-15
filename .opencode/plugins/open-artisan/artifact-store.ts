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
import { mkdirSync } from "node:fs"
import type { ArtifactKey } from "./types"

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
 * Otherwise returns `.openartisan/` (flat legacy layout).
 */
export function getArtifactDir(cwd: string, featureName: string | null | undefined): string {
  if (featureName) {
    // Sanitize: strip path separators and dots to prevent directory traversal
    const safe = featureName.replace(/[/\\]/g, "-").replace(/^\.+/, "")
    return join(cwd, ARTIFACT_DIR, safe)
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
  await Bun.write(filePath, text)
  return filePath
}
