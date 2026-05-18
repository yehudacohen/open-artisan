import { resolve } from "node:path"
import { readFileSync } from "node:fs"

import type { Phase, WorkflowMode } from "../workflow-primitives"
import type { PendingAllowlistExpansion } from "../workflow-state-types"

function normalizeHeading(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\d+[.)]?\s+/, "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .trim()
    .toLowerCase()
}

function headingLevel(text: string): number | null {
  const match = /^(#{1,6})\s+/.exec(text.trim())
  return match ? match[1]!.length : null
}

function isAllowlistHeading(lower: string): boolean {
  return (
    lower === "allowlist" ||
    lower === "file allowlist" ||
    lower === "file allowlist:" ||
    lower === "allowlist:" ||
    lower === "narrow allowlist" ||
    lower === "narrow allowlist:" ||
    lower === "minimal incremental file allowlist" ||
    lower === "minimal incremental file allowlist:" ||
    lower === "requested file allowlist" ||
    lower === "requested file allowlist:" ||
    lower === "proposed allowlist" ||
    lower === "proposed allowlist:" ||
    lower === "proposed file allowlist" ||
    lower === "proposed file allowlist:" ||
    lower === "proposed planning approval allowlist" ||
    lower === "proposed planning approval allowlist:" ||
    lower === "candidate allowlist" ||
    lower === "candidate allowlist:" ||
    lower === "candidate file allowlist" ||
    lower === "candidate file allowlist:" ||
    lower === "replacement allowlist" ||
    lower === "replacement allowlist:" ||
    lower === "replacement file allowlist" ||
    lower === "replacement file allowlist:" ||
    lower === "requested replacement allowlist" ||
    lower === "requested replacement allowlist:" ||
    lower === "full requested replacement allowlist" ||
    lower === "full requested replacement allowlist:" ||
    /^file allowlist\b/.test(lower)
  )
}

function isConcreteAllowlistHeading(lower: string): boolean {
  return (
    lower === "allowlist" ||
    lower === "allowlist:" ||
    lower === "narrow allowlist" ||
    lower === "narrow allowlist:" ||
    lower === "minimal incremental file allowlist" ||
    lower === "minimal incremental file allowlist:" ||
    lower === "requested file allowlist" ||
    lower === "requested file allowlist:" ||
    lower === "proposed allowlist" ||
    lower === "proposed allowlist:" ||
    lower === "proposed file allowlist" ||
    lower === "proposed file allowlist:" ||
    lower === "proposed planning approval allowlist" ||
    lower === "proposed planning approval allowlist:" ||
    lower === "candidate allowlist" ||
    lower === "candidate allowlist:" ||
    lower === "candidate file allowlist" ||
    lower === "candidate file allowlist:" ||
    lower === "replacement allowlist" ||
    lower === "replacement allowlist:" ||
    lower === "replacement file allowlist" ||
    lower === "replacement file allowlist:" ||
    lower === "requested replacement allowlist" ||
    lower === "requested replacement allowlist:" ||
    lower === "full requested replacement allowlist" ||
    lower === "full requested replacement allowlist:"
  )
}

function startsConcreteAllowlistList(trimmed: string): boolean {
  const lower = trimmed.toLowerCase().replace(/[*_`]/g, "")
  return (
    /expected to touch.*only.*these files/.test(lower) ||
    lower.includes("requests approval to modify only") ||
    lower.includes("modify only these files")
  )
}

function isNonPathAllowlistSubsection(lower: string): boolean {
  return (
    lower.includes("delta") ||
    lower.includes("decision") ||
    lower.includes("semantics") ||
    lower.includes("rationale") ||
    lower.includes("alternative") ||
    lower.includes("risk")
  )
}

export function extractApprovedFileAllowlist(planContent: string, cwd: string): string[] {
  const lines = planContent.split("\n")
  const collected: string[] = []
  let inAllowlist = false
  let collectingConcreteList = false
  let ignoringSubsectionBullets = false
  let allowlistHeadingLevel: number | null = null

  const pushCandidate = (candidate: string): void => {
    const normalized = candidate.trim()
    if (!normalized || /^none$/i.test(normalized)) return
    if (normalized.endsWith(":")) return
    if (/\s/.test(normalized)) return
    if (!/^[./`A-Za-z0-9_-]/.test(normalized)) return
    const unquoted = normalized.replace(/^`(.+)`$/, "$1")
    collected.push(unquoted.startsWith("/") ? unquoted : resolve(cwd, unquoted))
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const currentHeadingLevel = headingLevel(trimmed)
    const isHeading = currentHeadingLevel !== null
    const lower = normalizeHeading(trimmed)

    if (!inAllowlist) {
      if (isAllowlistHeading(lower)) {
        inAllowlist = true
        allowlistHeadingLevel = currentHeadingLevel
        collectingConcreteList = isConcreteAllowlistHeading(lower) && !lower.startsWith("file allowlist")
        ignoringSubsectionBullets = !collectingConcreteList
      }
      continue
    }

    if (isHeading) {
      if (collected.length > 0 && allowlistHeadingLevel !== null && currentHeadingLevel! <= allowlistHeadingLevel) {
        break
      }
      if (isConcreteAllowlistHeading(lower) && !isNonPathAllowlistSubsection(lower)) {
        collectingConcreteList = true
        ignoringSubsectionBullets = false
        continue
      }
      if (isNonPathAllowlistSubsection(lower)) {
        if (collected.length > 0) break
        collectingConcreteList = false
        ignoringSubsectionBullets = true
        continue
      }
      // Category headings inside a concrete allowlist list are allowed.
      if (collectingConcreteList) continue
      if (collected.length > 0) break
      continue
    }

    const boldSubsection = /^\*\*(.+):\*\*$/.exec(trimmed)
    if (boldSubsection) {
      const boldLower = normalizeHeading(boldSubsection[1]!)
      if (isNonPathAllowlistSubsection(boldLower)) {
        if (collected.length > 0) break
        collectingConcreteList = false
        ignoringSubsectionBullets = true
      }
      continue
    }

    if (startsConcreteAllowlistList(trimmed)) {
      collectingConcreteList = true
      ignoringSubsectionBullets = false
      continue
    }

    if (trimmed === "") {
      if (collected.length > 0 && !collectingConcreteList) break
      continue
    }

    if (/^(#{1,6}\s|[A-Za-z].*:$)/.test(trimmed) && !trimmed.startsWith("- ")) {
      if (collected.length > 0) break
      continue
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed)
    if (!bulletMatch) {
      if (collected.length > 0) break
      continue
    }

    if (!collectingConcreteList || ignoringSubsectionBullets) {
      continue
    }

    const rawPath = bulletMatch[1]!.trim()
    const inlineCodeMatches = Array.from(rawPath.matchAll(/`([^`]+)`/g), (match) => match[1]!.trim())
    if (inlineCodeMatches.length > 0) {
      for (const candidate of inlineCodeMatches) pushCandidate(candidate)
      continue
    }
    pushCandidate(rawPath)
  }

  return collected
}

export function deriveReviewFileAllowlist(input: {
  phase: Phase
  mode: WorkflowMode | null
  artifactPaths: string[]
  fallbackAllowlist: string[]
  cwd: string
  pendingAllowlistExpansions?: PendingAllowlistExpansion[]
}): { allowlist: string[]; source: "planning-artifact" | "active-state" | "none" } {
  if (input.mode === "INCREMENTAL" && input.phase === "PLANNING") {
    for (const artifactPath of input.artifactPaths) {
      try {
        const extracted = extractApprovedFileAllowlist(readFileSync(artifactPath, "utf-8"), input.cwd)
        if (extracted.length > 0) return { allowlist: extracted, source: "planning-artifact" }
      } catch {
        // Continue to the next artifact path, then fall back to active state.
      }
    }
    const pendingPlanAllowlist = (input.pendingAllowlistExpansions ?? [])
      .filter((request) => request.sourceArtifact === "plan" && request.requestedAtPhase === "PLANNING")
      .flatMap((request) => request.files)
    if (pendingPlanAllowlist.length > 0) {
      return { allowlist: Array.from(new Set(pendingPlanAllowlist)), source: "planning-artifact" }
    }
  }

  if (input.fallbackAllowlist.length > 0) {
    return { allowlist: input.fallbackAllowlist, source: "active-state" }
  }
  return { allowlist: [], source: "none" }
}
