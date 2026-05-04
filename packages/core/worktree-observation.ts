/**
 * worktree-observation.ts — Classify dirty worktree changes for review context.
 */

import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { DbWorktreeObservation } from "./open-artisan-repository"

const execFileAsync = promisify(execFile)

export interface WorktreeChange {
  path: string
  status: DbWorktreeObservation["status"]
  raw?: string
}

export interface WorktreeFileClaim {
  path: string
  agentLeaseId: string
}

export interface ClassifyWorktreeChangesInput {
  workflowId: string
  changes: WorktreeChange[]
  taskOwnedFiles?: string[]
  artifactFiles?: string[]
  currentAgentLeaseId?: string
  fileClaims?: WorktreeFileClaim[]
  createdAt?: string
}

export interface CollectWorktreeObservationsInput extends Omit<ClassifyWorktreeChangesInput, "changes"> {
  cwd: string
}

const GENERATED_PREFIXES = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".turbo/",
  ".cache/",
]

const GENERATED_SUFFIXES = [
  ".log",
  ".tmp",
  ".tsbuildinfo",
]

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

function observationId(workflowId: string, path: string, createdAt: string): string {
  return createHash("sha256").update(`${workflowId}\0${path}\0${createdAt}`).digest("hex").slice(0, 16)
}

function parsePorcelainStatus(rawStatus: string): DbWorktreeObservation["status"] {
  if (rawStatus === "??") return "untracked"
  if (rawStatus.includes("R")) return "renamed"
  if (rawStatus.includes("D")) return "deleted"
  if (rawStatus.includes("A")) return "added"
  return "modified"
}

function isGeneratedPath(path: string): boolean {
  if (path === ".openartisan/openartisan-errors.log") return true
  if (GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  return GENERATED_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

function isArtifactPath(path: string, artifactFiles: Set<string>): boolean {
  if (artifactFiles.has(path)) return true
  return path.startsWith(".openartisan/") && path.endsWith(".md")
}

export function parseGitPorcelain(output: string): WorktreeChange[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawStatus = line.slice(0, 2)
      const rawPath = line.slice(3)
      const path = rawStatus.includes("R") && rawPath.includes(" -> ")
        ? rawPath.split(" -> ").at(-1)!
        : rawPath
      return {
        path: normalizePath(path),
        status: parsePorcelainStatus(rawStatus),
        raw: line,
      }
    })
}

export function classifyWorktreeChanges(input: ClassifyWorktreeChangesInput): DbWorktreeObservation[] {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const taskOwnedFiles = new Set((input.taskOwnedFiles ?? []).map(normalizePath))
  const artifactFiles = new Set((input.artifactFiles ?? []).map(normalizePath))
  const claims = new Map((input.fileClaims ?? []).map((claim) => [normalizePath(claim.path), claim.agentLeaseId]))

  return input.changes.map((change) => {
    const path = normalizePath(change.path)
    const claimOwner = claims.get(path)
    const classification: DbWorktreeObservation["classification"] = taskOwnedFiles.has(path)
      ? "task-owned"
      : isArtifactPath(path, artifactFiles)
        ? "artifact"
        : isGeneratedPath(path)
          ? "generated"
          : claimOwner && claimOwner !== input.currentAgentLeaseId
            ? "parallel-claimed"
            : claimOwner
              ? "unowned-overlap"
              : "ambient"

    return {
      id: observationId(input.workflowId, path, createdAt),
      workflowId: input.workflowId,
      path,
      status: change.status,
      classification,
      createdAt,
    }
  })
}

export async function collectWorktreeObservations(input: CollectWorktreeObservationsInput): Promise<DbWorktreeObservation[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: input.cwd })
    const changes = parseGitPorcelain(stdout)
    if (changes.length === 0) return []
    return classifyWorktreeChanges({ ...input, changes })
  } catch {
    return []
  }
}
