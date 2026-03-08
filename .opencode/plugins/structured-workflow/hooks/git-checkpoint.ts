/**
 * git-checkpoint.ts — Creates a git commit + annotated tag on phase approval.
 * Tag format: workflow/<phase-lowercase>-v<approvalCount>
 *
 * In INCREMENTAL mode, warns if files outside the approved allowlist are staged
 * (they still get committed — this is a warning, not a hard block, since the
 * user may have made manual edits). The warning surfaces in the tool response.
 */
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
 */
function parseStagedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim()) // strip "XY " prefix
}

export async function createGitCheckpoint(
  ctx: GitCheckpointContext,
  opts: GitCheckpointOptions,
): Promise<GitCheckpointResult> {
  const { cwd, $ } = ctx
  const tag = `workflow/${phaseLabel(opts.phase)}-v${opts.approvalCount}`

  try {
    // Verify this is a git repo
    const revParse = await $`git rev-parse --git-dir`.cwd(cwd).quiet()
    if (revParse.exitCode !== 0) {
      return { success: false, error: "Not a git repository" }
    }

    // Stage all changes (if any)
    await $`git add -A`.cwd(cwd).quiet()

    // Check if there's anything to commit
    const status = await $`git status --porcelain`.cwd(cwd).quiet()
    const porcelain = status.stdout.toString().trim()
    const hasChanges = porcelain.length > 0

    // INCREMENTAL mode: warn if files outside the allowlist were staged
    const warnings: string[] = []
    if (opts.fileAllowlist && opts.fileAllowlist.length > 0 && hasChanges) {
      const allowSet = new Set(opts.fileAllowlist)
      const staged = parseStagedFiles(porcelain)
      const unexpected = staged.filter((f) => !allowSet.has(f) && !allowSet.has(`${cwd}/${f}`))
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
    }

    // Get current HEAD hash
    const head = await $`git rev-parse HEAD`.cwd(cwd).quiet()
    commitHash = head.stdout.toString().trim()

    // Create or force-update the tag (version suffix in the tag name prevents
    // collisions across approvals; -f is a safety net for the rare case where
    // the same session re-approves the same phase at the same count)
    await $`git tag -f ${tag}`.cwd(cwd).quiet()

    return { success: true, tag, commitHash, ...(warnings.length > 0 ? { warnings } : {}) }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
