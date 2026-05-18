import { isInterfaceFile } from "../hooks/tool-guard"

export interface PlannedInterfaceArtifact {
  path: string
  evidence: string
}

const PATHLIKE_RE = /(?:^|\s)([./]?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9.]+)/g

function normalizeHeading(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\d+[.)]?\s+/, "")
    .trim()
    .toLowerCase()
}

function headingLevel(text: string): number | null {
  const match = /^(#{1,6})\s+/.exec(text.trim())
  return match ? match[1]!.length : null
}

function isSupportingContext(text: string): boolean {
  return /\b(supporting|support|dependencies|dependency|implementation|context only|not reviewed|not a reviewed artifact)\b/i.test(text)
}

function isReviewedInterfaceHeading(text: string): boolean {
  if (isSupportingContext(text)) return false
  return (
    /\breviewed\b.*\binterfaces?\b/.test(text) ||
    /\binterfaces?\b.*\breview(?:ed)?\b.*\bartifacts?\b/.test(text) ||
    /\binterfaces?\s+review\s+files?\b/.test(text)
  )
}

function explicitlyNamesInterfaceReview(line: string): boolean {
  const lower = line.toLowerCase()
  if (isSupportingContext(lower)) return false
  return (
    /\binterfaces?\s+review\b/.test(lower) ||
    /\brequired by\s+interfaces?\s+review\b/.test(lower) ||
    /\bsource-of-truth\s+workflow\s+(?:contract|interface)\s+files?\b/.test(lower) ||
    /\binterface-contract\s+portion\b/.test(lower)
  )
}

function extractPathCandidates(text: string): string[] {
  const candidates: string[] = []
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const value = match[1]!.trim()
    if (PATHLIKE_RE.test(` ${value}`)) candidates.push(value)
    PATHLIKE_RE.lastIndex = 0
  }
  for (const match of text.matchAll(PATHLIKE_RE)) {
    candidates.push(match[1]!.trim())
  }
  return Array.from(new Set(candidates.map((path) => path.replace(/^\.\//, ""))))
}

export function extractPlannedReviewedInterfaceArtifacts(planContent: string): PlannedInterfaceArtifact[] {
  const artifacts: PlannedInterfaceArtifact[] = []
  const seen = new Set<string>()
  const lines = planContent.split(/\r?\n/)
  let reviewedSectionLevel: number | null = null

  const pushArtifacts = (line: string): void => {
    for (const path of extractPathCandidates(line)) {
      if (seen.has(path)) continue
      seen.add(path)
      artifacts.push({ path, evidence: line.trim() })
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const currentHeadingLevel = headingLevel(trimmed)
    if (currentHeadingLevel !== null) {
      const heading = normalizeHeading(trimmed)
      if (reviewedSectionLevel !== null && currentHeadingLevel <= reviewedSectionLevel) {
        reviewedSectionLevel = null
      }
      if (isReviewedInterfaceHeading(heading)) {
        reviewedSectionLevel = currentHeadingLevel
      }
      continue
    }

    if (!trimmed) continue
    if (reviewedSectionLevel !== null || explicitlyNamesInterfaceReview(trimmed)) {
      pushArtifacts(trimmed)
    }
  }

  return artifacts
}

export function validatePlannedReviewedInterfaceArtifacts(planContent: string): string[] {
  const invalid = extractPlannedReviewedInterfaceArtifacts(planContent)
    .filter((artifact) => !isInterfaceFile(artifact.path))

  return invalid.map((artifact) => (
    `planned reviewed INTERFACES artifact is not an interface/type/schema file: ${artifact.path}. ` +
    `If this is a supporting implementation dependency, label it separately as supporting/context, not as a reviewed INTERFACES artifact. ` +
    `Prefer a narrow *-types.ts, *-contracts.ts, schema, or declaration file for reviewed INTERFACES artifacts so unrelated legacy APIs do not enter review scope. ` +
    `Evidence: ${artifact.evidence}`
  ))
}
