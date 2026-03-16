/**
 * git-checkpoint.ts — Creates a git commit + annotated tag on phase approval.
 * Tag format: workflow/<phase-lowercase>-v<approvalCount>
 *
 * In INCREMENTAL mode, warns if files outside the approved allowlist are staged
 * (they still get committed — this is a warning, not a hard block, since the
 * user may have made manual edits). The warning surfaces in the tool response.
 */
import { realpath } from "node:fs/promises"
import type { GitCheckpointResult, Phase } from "../types"

// BunShell type: use 'any' to avoid dependency on bun's internal type export,
// which varies across Bun versions. The $ object is the Bun shell template tag.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunShellLike = any

export interface GitCheckpointContext {
  cwd: string
  $: BunShellLike
}

export interface GitCheckpointOptions {
  phase: Phase
  /** Per-phase approval count (M11) — used for tag version suffix */
  approvalCount: number
  /**
   * INCREMENTAL mode only: list of files the agent was approved to modify.
   * If provided and non-empty, staged files outside this list trigger a warning.
   */
  fileAllowlist?: string[]
}

function phaseLabel(phase: Phase): string {
  return phase.toLowerCase().replace(/_/g, "-")
}

/**
 * Parses `git status --porcelain` output into a list of modified file paths.
 * Each line is "XY filename" where XY is a 2-char status code.
 * For rename/copy lines ("R  old -> new" or "C  old -> new"), returns the
 * destination path only (after " -> ").
 */
function parseStagedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3).trim() // strip "XY " prefix
      // Rename/copy: "old -> new" — take the destination
      const arrowIdx = raw.indexOf(" -> ")
      return arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw
    })
}

export async function createGitCheckpoint(
  ctx: GitCheckpointContext,
  opts: GitCheckpointOptions,
): Promise<GitCheckpointResult> {
  const { cwd, $ } = ctx
  const tag = `workflow/${phaseLabel(opts.phase)}-v${opts.approvalCount}`

  try {
    // Verify this is a git repo and get the canonical repo root.
    // `git status --porcelain` returns repo-root-relative paths, not cwd-relative,
    // so we must resolve staged paths against the repo root to compare with the
    // allowlist (which uses absolute paths).
    const rootResult = await $`git rev-parse --show-toplevel`.cwd(cwd).quiet()
    if (rootResult.exitCode !== 0) {
      return { success: false, error: "Not a git repository" }
    }
    const repoRoot = rootResult.stdout.toString().trim()

    // Stage only workflow-related changes: .openartisan/ artifacts and any files
    // already tracked by git that have been modified. This avoids capturing
    // unrelated working tree changes (e.g. user's uncommitted work) in the
    // checkpoint commit.
    // 1. Always stage .openartisan/ (plan artifacts)
    await $`git add -A .openartisan/`.cwd(cwd).quiet().nothrow()
    // 2. Stage modified tracked files only (excludes untracked files outside .openartisan/)
    await $`git add -u`.cwd(cwd).quiet().nothrow()

    // Check if there's anything to commit
    const status = await $`git status --porcelain`.cwd(cwd).quiet()
    const porcelain = status.stdout.toString().trim()
    const hasChanges = porcelain.length > 0

    // INCREMENTAL mode: warn if files outside the allowlist were staged
    const warnings: string[] = []
    if (opts.fileAllowlist && opts.fileAllowlist.length > 0 && hasChanges) {
      // Resolve all allowlist paths to their real (symlink-resolved) paths so comparison
      // works correctly on macOS where /tmp → /private/var/... and git resolves the latter.
      const resolvedAllowlist = await Promise.all(
        opts.fileAllowlist.map((p) => realpath(p).catch(() => p)),
      )
      const allowSet = new Set(resolvedAllowlist)
      const staged = parseStagedFiles(porcelain)
      // Resolve each staged path (repo-root-relative) to an absolute path for comparison
      const unexpected = staged.filter((f) => !allowSet.has(`${repoRoot}/${f}`))
      if (unexpected.length > 0) {
        warnings.push(
          `INCREMENTAL mode: ${unexpected.length} file(s) outside the approved allowlist were staged: ` +
          unexpected.slice(0, 5).join(", ") +
          (unexpected.length > 5 ? ` ... and ${unexpected.length - 5} more` : "") +
          `. These were committed. If this was unintentional, run \`git reset HEAD~1\` and review.`,
        )
      }
    }

    let commitHash = ""

    if (hasChanges) {
      const msg = `workflow: ${phaseLabel(opts.phase)} approved (checkpoint #${opts.approvalCount})`
      await $`git commit -m ${msg}`.cwd(cwd).quiet()

      // Get current HEAD hash
      const head = await $`git rev-parse HEAD`.cwd(cwd).quiet()
      commitHash = head.stdout.toString().trim()

      // Create or force-update an annotated tag (design doc §10 specifies annotated).
      // The version suffix in the tag name prevents collisions across approvals;
      // -f is a safety net for the rare case where the same session re-approves
      // the same phase at the same count.
      await $`git tag -a -f -m ${msg} ${tag}`.cwd(cwd).quiet()

      return { success: true, tag, commitHash, ...(warnings.length > 0 ? { warnings } : {}) }
    }

    // No changes to commit — but design invariant #8 requires a checkpoint
    // tag on every user approval. Tag the current HEAD so the approval is
    // recorded in git history even without a new commit.
    const head = await $`git rev-parse HEAD`.cwd(cwd).quiet()
    commitHash = head.stdout.toString().trim()
    const tagMsg = `workflow: ${phaseLabel(opts.phase)} approved (checkpoint #${opts.approvalCount}, no changes)`
    await $`git tag -a -f -m ${tagMsg} ${tag}`.cwd(cwd).quiet()
    return { success: true, tag, commitHash }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
