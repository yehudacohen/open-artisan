/**
 * direct-application.ts — Small-task fast path that keeps Open Artisan in control.
 */

import { spawn } from "node:child_process"

import { getPhaseToolPolicy } from "./hooks/tool-guard"
import { extractPatchTouchedPaths } from "./patch-suggestion-application"
import type { WorkflowState } from "./workflow-state-types"

export interface DirectApplicationInput {
  state: WorkflowState
  cwd: string
  summary: string
  whySafe: string
  affectedFiles: string[]
  patch: string
  verificationCommand?: string
}

export interface DirectApplicationResult {
  approved: boolean
  applied: boolean
  reason: string
  touchedFiles: string[]
  verificationCommand?: string
}

const MAX_DIRECT_APPLICATION_FILES = 3
const MAX_DIRECT_APPLICATION_PATCH_CHARS = 20_000

function runGitApply(cwd: string, patch: string, checkOnly: boolean): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", ...(checkOnly ? ["--check"] : []), "--whitespace=nowarn"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)))
    child.on("error", (error) => resolve({ ok: false, output: error.message }))
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        output: Buffer.concat([...chunks, ...errors]).toString("utf-8").trim(),
      })
    })
    child.stdin.end(patch)
  })
}

function normalizeRelativePath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  if (!normalized) return null
  if (normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../")) return null
  if (normalized === "." || normalized === "..") return null
  return normalized
}

function isEnvPath(path: string): boolean {
  const base = path.split("/").at(-1) ?? ""
  return base === ".env" || base.startsWith(".env.")
}

function isBlockedDirectPath(path: string): string | null {
  if (isEnvPath(path)) return ".env files are never eligible for direct application"
  if (path === ".openartisan" || path.startsWith(".openartisan/")) return "workflow state/artifacts are not eligible for direct application"
  if (path === ".git" || path.startsWith(".git/") || path.includes("/.git/")) return "git internals are not eligible for direct application"
  if (path === "node_modules" || path.startsWith("node_modules/") || path.includes("/node_modules/")) return "dependency directories are not eligible for direct application"
  if (/^(?:bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/.test(path)) return "lockfiles require the full workflow"
  return null
}

function reject(reason: string, touchedFiles: string[] = []): DirectApplicationResult {
  return { approved: false, applied: false, reason, touchedFiles }
}

function approvePendingApply(touchedFiles: string[], verificationCommand?: string): DirectApplicationResult {
  return {
    approved: true,
    applied: false,
    reason: "Direct application approved by structural checks; patch application pending.",
    touchedFiles,
    ...(verificationCommand ? { verificationCommand } : {}),
  }
}

export async function proposeDirectApplication(input: DirectApplicationInput): Promise<DirectApplicationResult> {
  if (!input.whySafe.trim()) return reject("why_safe must explain why this is small and safe enough for direct application.")
  if (input.patch.length > MAX_DIRECT_APPLICATION_PATCH_CHARS) return reject(`Patch is too large for direct application (${input.patch.length} chars > ${MAX_DIRECT_APPLICATION_PATCH_CHARS}).`)
  if (/GIT binary patch|Binary files /.test(input.patch)) return reject("Binary patches are not eligible for direct application.")
  if (/^deleted file mode\b/m.test(input.patch) || /^\+\+\+\s+\/dev\/null\b/m.test(input.patch)) return reject("File deletion is not eligible for direct application.")

  const affectedFiles = input.affectedFiles.map(normalizeRelativePath)
  if (affectedFiles.some((path) => path === null)) return reject("affected_files must be project-relative paths without traversal.")
  const normalizedAffected = Array.from(new Set(affectedFiles as string[]))
  if (normalizedAffected.length === 0) return reject("At least one affected file is required.")
  if (normalizedAffected.length > MAX_DIRECT_APPLICATION_FILES) return reject(`Direct application is limited to ${MAX_DIRECT_APPLICATION_FILES} files; use the full workflow for broader work.`)
  for (const file of normalizedAffected) {
    const blocked = isBlockedDirectPath(file)
    if (blocked) return reject(`Direct application rejected for ${file}: ${blocked}.`)
  }

  const touchedFiles = Array.from(new Set(extractPatchTouchedPaths(input.patch).map(normalizeRelativePath).filter((path): path is string => Boolean(path))))
  if (touchedFiles.length === 0) return reject("Patch does not contain any touched file paths to review.")
  if (touchedFiles.length > MAX_DIRECT_APPLICATION_FILES) return reject(`Patch touches ${touchedFiles.length} files; direct application is limited to ${MAX_DIRECT_APPLICATION_FILES}.`, touchedFiles)
  for (const file of touchedFiles) {
    const blocked = isBlockedDirectPath(file)
    if (blocked) return reject(`Direct application rejected for ${file}: ${blocked}.`, touchedFiles)
  }

  const affectedSet = new Set(normalizedAffected)
  const touchedSet = new Set(touchedFiles)
  const missingFromPatch = normalizedAffected.filter((file) => !touchedSet.has(file))
  const undeclaredTouched = touchedFiles.filter((file) => !affectedSet.has(file))
  if (missingFromPatch.length > 0 || undeclaredTouched.length > 0) {
    return reject(`affected_files must exactly match patch paths. Missing from patch: ${missingFromPatch.join(", ") || "none"}; undeclared touched files: ${undeclaredTouched.join(", ") || "none"}.`, touchedFiles)
  }

  // Phase gate. Direct application is always available at MODE_SELECT/DONE. During an
  // ACTIVE workflow it may only touch OUT-OF-BAND files — files the current phase's own
  // policy would NOT let the agent author directly (e.g. an unrelated design doc during
  // INTERFACES). In-scope/in-phase files must go through the normal authoring + review
  // path, so they are never applied unreviewed. (MODE_SELECT/DONE and gate states block
  // all writes and expose no writePathPredicate, so every file is out-of-band there.)
  const policy = getPhaseToolPolicy(
    input.state.phase,
    input.state.phaseState,
    input.state.mode,
    input.state.fileAllowlist,
    undefined,
    input.cwd,
    input.state.approvedCleanupFiles,
  )
  const writableInPhase = policy.writePathPredicate
  if (writableInPhase) {
    const inScope = touchedFiles.filter((file) => writableInPhase(file))
    if (inScope.length > 0) {
      return reject(
        `Direct application during ${input.state.phase}/${input.state.phaseState} may only touch out-of-band files. These are writable in the current phase — author them in-phase so they go through review: ${inScope.join(", ")}.`,
        touchedFiles,
      )
    }
  }

  const approved = approvePendingApply(touchedFiles, input.verificationCommand)
  const checked = await runGitApply(input.cwd, input.patch, true)
  if (!checked.ok) return { ...approved, approved: false, reason: checked.output || "git apply --check failed" }

  const applied = await runGitApply(input.cwd, input.patch, false)
  if (!applied.ok) return { ...approved, approved: false, reason: applied.output || "git apply failed" }
  return { ...approved, applied: true, reason: `Applied direct patch to ${touchedFiles.join(", ")}.` }
}
