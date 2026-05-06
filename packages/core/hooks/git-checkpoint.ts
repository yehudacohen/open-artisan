/**
 * git-checkpoint.ts — Creates a git commit + annotated tag on phase approval.
 * Tag format: workflow/<phase-lowercase>-v<approvalCount>
 *
 * Staging strategy:
 *   - If expectedFiles is provided: stages only those files + feature artifacts.
 *     Warns about any other dirty files that were not staged.
 *   - If expectedFiles is not provided: legacy fallback — stages all .openartisan/
 *     artifacts + all tracked modifications (git add -u).
 *   - Feature artifacts are scoped to .openartisan/<featureName>/ when featureName
 *     is provided, preventing cross-feature artifact pollution.
 *   - In INCREMENTAL mode, warns if staged files are outside the approved allowlist.
 */
import { execFileSync } from "node:child_process"
import { realpath } from "node:fs/promises"
import type { GitCheckpointResult } from "../git-checkpoint-types"
import type { Phase } from "../workflow-primitives"

/**
 * Run a git command in the given cwd. Uses execFileSync (no shell) to avoid
 * injection risks from commit messages or tag names containing shell metacharacters.
 * If nothrow is true, non-zero exit codes do not throw.
 */
function gitExec(args: string[], cwd: string, opts?: { nothrow?: boolean }): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" })
    // trimEnd only — preserving leading whitespace is critical for git status --porcelain
    // where the first character encodes staging state (e.g. " M" = unstaged modification)
    return { stdout: stdout.trimEnd(), exitCode: 0 }
  } catch (err: unknown) {
    if (opts?.nothrow) {
      const exitCode = (err as { status?: number }).status ?? 1
      const stdout = ((err as { stdout?: Buffer | string }).stdout ?? "").toString().trimEnd()
      return { stdout, exitCode }
    }
    throw err
  }
}

export interface GitCheckpointContext {
  cwd: string
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
  /** Feature name — scopes artifact staging to `.openartisan/<featureName>/` */
  featureName?: string | null
  /**
   * Explicit list of absolute file paths this phase was expected to modify.
   * Derived from artifact disk paths + tool guard policy at the callsite.
   * If provided:
   *   - Only these files (+ feature artifacts) are staged
   *   - Any other dirty files trigger a warning (not staged, not committed)
   * If not provided: falls back to `git add -u` (stage all tracked modifications)
   */
  expectedFiles?: string[]
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
  const { cwd } = ctx
  const tag = `workflow/${phaseLabel(opts.phase)}-v${opts.approvalCount}`

  try {
    // Verify this is a git repo and get the canonical repo root.
    // `git status --porcelain` returns repo-root-relative paths, not cwd-relative,
    // so we must resolve staged paths against the repo root to compare with the
    // allowlist (which uses absolute paths).
    const rootResult = gitExec(["rev-parse", "--show-toplevel"], cwd, { nothrow: true })
    if (rootResult.exitCode !== 0) {
      return { success: false, error: "Not a git repository" }
    }
    const repoRoot = rootResult.stdout

    const warnings: string[] = []

    // ── Staging strategy ──────────────────────────────────────────────
    // If expectedFiles is provided, stage ONLY those files + feature artifacts.
    // Otherwise fall back to the legacy broad staging (git add -u).
    const artifactPath = opts.featureName
      ? `.openartisan/${opts.featureName}/`
      : ".openartisan/"

    if (opts.expectedFiles && opts.expectedFiles.length > 0) {
      // Stage feature artifacts
      gitExec(["add", "-A", artifactPath], cwd, { nothrow: true })
      // Resolve expected files through realpath to handle symlinks (e.g. /tmp → /private/tmp on macOS)
      const resolvedExpected = await Promise.all(
        opts.expectedFiles.map((p) => realpath(p).catch(() => p)),
      )
      // Stage only the expected source files (absolute paths → repo-relative for git add)
      for (const absPath of resolvedExpected) {
        const relPath = absPath.startsWith(repoRoot)
          ? absPath.slice(repoRoot.length + 1)
          : absPath
        gitExec(["add", "--", relPath], cwd, { nothrow: true })
      }

      // Detect unstaged dirty files within the project scope that might belong to this phase.
      // Scope to .openartisan/ + cwd-relative paths to avoid warning about unrelated repo changes.
      const allStatus = gitExec(["status", "--porcelain", "--", artifactPath, "."], cwd, { nothrow: true })
      const unstagedLines = allStatus.stdout.split("\n").filter((line) => {
        if (!line.trim()) return false
        // Unstaged: first column is space (modified not staged) or ? (untracked)
        const idx = line[0]
        return idx === " " || idx === "?"
      })
      if (unstagedLines.length > 0) {
        const unstagedPaths = unstagedLines.map((l) => l.slice(3).trim())
        warnings.push(
          `${unstagedLines.length} modified file(s) were NOT staged for this checkpoint ` +
          `(not in expectedFiles): ` +
          unstagedPaths.slice(0, 5).join(", ") +
          (unstagedPaths.length > 5 ? ` ... and ${unstagedPaths.length - 5} more` : "") +
          `. If these belong to this phase, add them to the file manifest.`,
        )
      }
    } else {
      // Legacy fallback: stage all artifacts + all tracked modifications
      gitExec(["add", "-A", artifactPath], cwd, { nothrow: true })
      gitExec(["add", "-u"], cwd, { nothrow: true })
    }

    // Check if there's anything staged to commit
    const status = gitExec(["status", "--porcelain"], cwd)
    const porcelain = status.stdout
    // Only count staged changes (first column is not space and not ?)
    const stagedLines = porcelain.split("\n").filter((line) => {
      if (!line.trim()) return false
      const idx = line[0]
      return idx !== " " && idx !== "?"
    })
    const hasChanges = stagedLines.length > 0

    // INCREMENTAL mode: warn if files outside the allowlist were staged
    if (opts.fileAllowlist && opts.fileAllowlist.length > 0 && hasChanges) {
      const resolvedAllowlist = await Promise.all(
        opts.fileAllowlist.map((p) => realpath(p).catch(() => p)),
      )
      const allowSet = new Set(resolvedAllowlist)
      const staged = parseStagedFiles(stagedLines.join("\n"))
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
      gitExec(["commit", "-m", msg], cwd)

      const head = gitExec(["rev-parse", "HEAD"], cwd)
      commitHash = head.stdout

      // Create or force-update an annotated tag (design doc §10 specifies annotated).
      gitExec(["tag", "-a", "-f", "-m", msg, tag], cwd)

      return { success: true, tag, commitHash, ...(warnings.length > 0 ? { warnings } : {}) }
    }

    // No changes to commit — tag the current HEAD so the approval is recorded in git history.
    const head = gitExec(["rev-parse", "HEAD"], cwd)
    commitHash = head.stdout
    const tagMsg = `workflow: ${phaseLabel(opts.phase)} approved (checkpoint #${opts.approvalCount}, no changes)`
    gitExec(["tag", "-a", "-f", "-m", tagMsg, tag], cwd)
    return { success: true, tag, commitHash }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
