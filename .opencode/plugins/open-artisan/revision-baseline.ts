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
 * In-memory phases: the artifact is a single file written to .openartisan/
 * via writeArtifact. The agent passes artifact_content to request_review.
 * Diff detection: hash the file content.
 */
const CONTENT_HASH_PHASES: Set<Phase> = new Set(["PLANNING", "DISCOVERY", "IMPL_PLAN"])

/**
 * File-based phases: the artifact is spread across source files.
 * The agent edits files directly and typically omits artifact_content.
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
 * @param $ - Bun shell template tag (for running git commands)
 */
export async function captureRevisionBaseline(
  phase: Phase,
  state: WorkflowState,
  cwd: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $: any,
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
      // This avoids false positives from earlier cascade steps' uncommitted changes.
      const result = $`git -C ${cwd} diff`
      const diffOutput = await result.text()
      const exitCode = await result.exitCode
      if (exitCode !== 0) return null
      return { type: "git-sha", sha: contentHash(diffOutput) }
    }
  } catch {
    // Any error (fs read failure, git not available, etc.) — graceful degradation
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
 * @param artifactContent - The artifact_content argument from request_review (may be undefined for file-based phases)
 * @param state - Current workflow state (for artifactDiskPaths)
 * @param cwd - Working directory (for git operations)
 * @param $ - Bun shell template tag
 */
export async function hasArtifactChanged(
  baseline: RevisionBaseline,
  phase: Phase,
  artifactContent: string | undefined,
  state: WorkflowState,
  cwd: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $: any,
): Promise<boolean> {
  try {
    if (baseline.type === "content-hash") {
      // In-memory phase — compare content hash
      // If artifact_content was passed to request_review, hash it directly
      if (artifactContent) {
        const currentHash = contentHash(artifactContent)
        return currentHash !== baseline.hash
      }
      // Fallback: read the file from disk (agent may have overwritten it)
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
      // NOT a commit SHA. If the hashes match, the working tree is unchanged
      // since REVISE entry — no new work was done during this step.
      const result = $`git -C ${cwd} diff`
      const diffOutput = await result.text()
      const exitCode = await result.exitCode
      if (exitCode !== 0) return true // git error — allow through
      return contentHash(diffOutput) !== baseline.sha
    }
  } catch {
    // Any error — graceful degradation, allow through
    return true
  }

  return true // Unknown baseline type — allow through
}
