/**
 * revision-baseline.ts — Captures and compares artifact state for the REVISE diff gate.
 *
 * When the workflow enters REVISE, a baseline snapshot is captured:
 *   - In-memory phases (PLANNING, DISCOVERY, IMPL_PLAN): SHA-256 hash of the artifact file on disk
 *   - File-based phases (INTERFACES, TESTS, IMPLEMENTATION): SHA-256 hash of `git diff` output
 *
 * For file-based phases, we hash the `git diff` output (uncommitted changes) rather
 * than storing a commit SHA. This prevents false positives during cascades: earlier
 * cascade steps may have left uncommitted changes that would always show up in a
 * cumulative `git diff <sha>` comparison. By comparing diff-output hashes, we only
 * detect NEW changes made during THIS REVISE step.
 *
 * When request_review is called from REVISE, the current state is compared against
 * the baseline. If nothing changed, the agent is blocked — it must actually make
 * changes to address the revision feedback.
 */

import { createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { execSync } from "node:child_process"
import type { Phase, ArtifactKey, WorkflowState } from "./types"
import { PHASE_TO_ARTIFACT } from "./artifacts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RevisionBaseline =
  | { type: "content-hash"; hash: string }
  | { type: "git-sha"; sha: string }

// ---------------------------------------------------------------------------
// Constants — which phases use content hashing vs git diffing
// ---------------------------------------------------------------------------

/**
 * Markdown phases: the artifact is a single file written to .openartisan/.
 * Diff detection: hash the file content.
 */
const CONTENT_HASH_PHASES: Set<Phase> = new Set(["PLANNING", "DISCOVERY", "IMPL_PLAN"])

/**
 * File-based phases: the artifact is spread across source files.
 * Diff detection: hash of `git diff` output (worktree snapshot).
 */
const GIT_DIFF_PHASES: Set<Phase> = new Set(["INTERFACES", "TESTS", "IMPLEMENTATION"])

// ---------------------------------------------------------------------------
// Baseline capture — called at REVISE entry
// ---------------------------------------------------------------------------

/** SHA-256 hex hash of a string, truncated to 32 chars for compactness. */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

/**
 * Capture a baseline snapshot of the artifact for the given phase.
 *
 * For in-memory phases: reads the artifact file from disk and hashes its content.
 * For file-based phases: hashes the current `git diff` output (uncommitted changes).
 *
 * Returns null if the baseline cannot be captured (missing file, no git, etc.).
 * Callers should treat null as "cannot enforce diff gate" (graceful degradation).
 *
 * @param phase - The phase being entered for revision
 * @param state - Current workflow state (for artifactDiskPaths)
 * @param cwd - Working directory (for git operations)
 */
export async function captureRevisionBaseline(
  phase: Phase,
  state: WorkflowState,
  cwd: string,
): Promise<RevisionBaseline | null> {
  try {
    if (CONTENT_HASH_PHASES.has(phase)) {
      // In-memory phase — hash the artifact file on disk
      const artifactKey = PHASE_TO_ARTIFACT[phase]
      if (!artifactKey) return null
      const diskPath = state.artifactDiskPaths[artifactKey]
      if (!diskPath || !existsSync(diskPath)) return null
      const content = readFileSync(diskPath, "utf-8")
      return { type: "content-hash", hash: contentHash(content) }
    }

    if (GIT_DIFF_PHASES.has(phase)) {
      // File-based phase — hash the current `git diff` output.
      // This captures a snapshot of uncommitted changes at REVISE entry.
      // At check time, we hash `git diff` again and compare. If the hashes
      // match, the agent made no new changes during this REVISE step.
      try {
        const diffOutput = execSync("git diff", { cwd, stdio: "pipe", encoding: "utf-8" })
        return { type: "git-sha", sha: contentHash(diffOutput) }
      } catch {
        return null // git not available — graceful degradation
      }
    }
  } catch {
    // Any error (fs read failure, etc.) — graceful degradation
    return null
  }

  return null
}

// ---------------------------------------------------------------------------
// Baseline comparison — called at request_review from REVISE
// ---------------------------------------------------------------------------

/**
 * Check whether the artifact has changed since the REVISE baseline was captured.
 *
 * Returns true if the artifact has changed (revision work was done).
 * Returns true if the check cannot be performed (graceful degradation — allow through).
 * Returns false only if we can definitively prove nothing changed.
 *
 * @param baseline - The baseline captured at REVISE entry
 * @param phase - Current phase
 * @param state - Current workflow state (for artifactDiskPaths)
 * @param cwd - Working directory (for git operations)
 */
export async function hasArtifactChanged(
  baseline: RevisionBaseline,
  phase: Phase,
  state: WorkflowState,
  cwd: string,
): Promise<boolean> {
  try {
    if (baseline.type === "content-hash") {
      // Markdown phase — compare the current on-disk artifact to the baseline.
      const artifactKey = PHASE_TO_ARTIFACT[phase]
      if (!artifactKey) return true // Cannot check — allow through
      const diskPath = state.artifactDiskPaths[artifactKey]
      if (!diskPath || !existsSync(diskPath)) return true // File missing — allow through
      const currentContent = readFileSync(diskPath, "utf-8")
      return contentHash(currentContent) !== baseline.hash
    }

    if (baseline.type === "git-sha") {
      // File-based phase — hash current `git diff` output and compare.
      // baseline.sha holds a content hash of the diff output at REVISE entry,
      // NOT a commit SHA. If the hashes match, the working tree is unchanged.
      try {
        const diffOutput = execSync("git diff", { cwd, stdio: "pipe", encoding: "utf-8" })
        return contentHash(diffOutput) !== baseline.sha
      } catch {
        return true // git error — allow through
      }
    }
  } catch {
    // Any error — graceful degradation, allow through
    return true
  }

  return true // Unknown baseline type — allow through
}
