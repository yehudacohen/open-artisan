/**
 * patch-suggestion-application.ts — Apply persisted reviewer patch suggestions.
 */

import { createHash } from "node:crypto"
import { spawn } from "node:child_process"

import type { OpenArtisanServices } from "./open-artisan-services"
import type { DbPatchApplication } from "./open-artisan-repository"
import { routePatchSuggestion } from "./patch-suggestion-routing"
import { workflowDbId } from "./runtime-persistence"
import type { WorkflowState } from "./types"

export interface ApplyPatchSuggestionInput {
  services: OpenArtisanServices
  state: WorkflowState
  cwd: string
  patchSuggestionId: string
  force?: boolean
  appliedBy?: "agent" | "orchestrator" | "user"
}

export interface ApplyPatchSuggestionResult {
  ok: boolean
  message: string
  application?: DbPatchApplication
}

function nowIso(): string {
  return new Date().toISOString()
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

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

function normalizePatchPath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed || trimmed === "/dev/null") return null
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/\\"/g, '"')
    : trimmed
  return unquoted.replace(/\\/g, "/").replace(/^(?:a|b)\//, "").replace(/^\.\//, "")
}

function pathMatches(left: string, right: string): boolean {
  const a = normalizePatchPath(left)
  const b = normalizePatchPath(right)
  if (!a || !b) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export function extractPatchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git\s+("(?:[^"\\]|\\.)+"|\S+)\s+("(?:[^"\\]|\\.)+"|\S+)/.exec(line)
      if (match) {
        for (const raw of [match[1], match[2]]) {
          const path = raw ? normalizePatchPath(raw) : null
          if (path) paths.add(path)
        }
      }
      continue
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const raw = line.slice(4).split("\t", 1)[0] ?? ""
      const path = normalizePatchPath(raw)
      if (path) paths.add(path)
    }
  }
  return [...paths]
}

async function recordApplication(
  services: OpenArtisanServices,
  patchSuggestionId: string,
  result: "applied" | "failed",
  message: string,
  appliedBy: "agent" | "orchestrator" | "user",
): Promise<{ ok: true; application: DbPatchApplication } | { ok: false; message: string }> {
  const createdAt = nowIso()
  const application: DbPatchApplication = {
    id: stableId(patchSuggestionId, result, createdAt),
    patchSuggestionId,
    appliedBy,
    result,
    ...(message ? { message } : {}),
    createdAt,
  }
  const persisted = await services.patchSuggestions.applySuggestion(application)
  return persisted.ok ? { ok: true, application: persisted.value } : { ok: false, message: persisted.error.message }
}

export async function applyPatchSuggestionToWorktree(input: ApplyPatchSuggestionInput): Promise<ApplyPatchSuggestionResult> {
  const workflowId = workflowDbId(input.state)
  const pending = await input.services.patchSuggestions.listSuggestions(workflowId, "pending")
  if (!pending.ok) return { ok: false, message: pending.error.message }
  const suggestion = pending.value.find((item) => item.id === input.patchSuggestionId)
  if (!suggestion) return { ok: false, message: `Patch suggestion ${input.patchSuggestionId} is not pending for this workflow.` }

  const route = routePatchSuggestion(input.state, suggestion)
  if (route.route !== "apply-current-task" && !input.force) {
    return {
      ok: false,
      message: `Patch suggestion ${suggestion.id} is routed to ${route.route}: ${route.reason}. Pass force=true only after user approval.`,
    }
  }

  const touchedPaths = extractPatchTouchedPaths(suggestion.suggestedPatch)
  if (touchedPaths.length === 0) {
    return { ok: false, message: `Patch suggestion ${suggestion.id} does not contain any file paths to validate.` }
  }
  if (!touchedPaths.some((path) => pathMatches(path, suggestion.targetPath))) {
    return { ok: false, message: `Patch suggestion ${suggestion.id} metadata target ${suggestion.targetPath} is not touched by the patch.` }
  }
  if (!input.force) {
    const blockedRoutes = touchedPaths
      .map((path) => routePatchSuggestion(input.state, { ...suggestion, targetPath: path }))
      .filter((candidate) => candidate.route !== "apply-current-task")
    if (blockedRoutes.length > 0) {
      return {
        ok: false,
        message: blockedRoutes
          .map((candidate) => `Patch touches ${candidate.suggestion.targetPath}, routed to ${candidate.route}: ${candidate.reason}`)
          .join("\n"),
      }
    }
  }

  const checked = await runGitApply(input.cwd, suggestion.suggestedPatch, true)
  if (!checked.ok) {
    const application = await recordApplication(input.services, suggestion.id, "failed", checked.output || "git apply --check failed", input.appliedBy ?? "agent")
    if (!application.ok) return { ok: false, message: application.message }
    return { ok: false, message: checked.output || "git apply --check failed", application: application.application }
  }

  const applied = await runGitApply(input.cwd, suggestion.suggestedPatch, false)
  const application = await recordApplication(
    input.services,
    suggestion.id,
    applied.ok ? "applied" : "failed",
    applied.output,
    input.appliedBy ?? "agent",
  )
  if (!application.ok) return { ok: false, message: application.message }
  if (applied.ok) {
    const createdAt = nowIso()
    const provenance = await input.services.fastForward.recordFastForward({
      id: stableId(suggestion.id, "patch-provenance", createdAt),
      workflowId,
      fromPhase: input.state.phase,
      fromPhaseState: input.state.phaseState,
      toPhase: input.state.phase,
      toPhaseState: input.state.phaseState,
      reason: `Patch-only correction applied from reviewer suggestion ${suggestion.id}.`,
      patchSuggestionIds: [suggestion.id],
      createdAt,
    })
    if (!provenance.ok) {
      return { ok: false, message: `Applied patch suggestion ${suggestion.id}, but failed to record patch provenance: ${provenance.error.message}`, application: application.application }
    }
  }
  return {
    ok: applied.ok,
    message: applied.ok ? `Applied patch suggestion ${suggestion.id} to ${suggestion.targetPath}.` : applied.output || "git apply failed",
    application: application.application,
  }
}
