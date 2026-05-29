import type { TaskNode } from "./dag"

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value)
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function stringArrayDiffDetail(existing: string[], planned: string[]): string {
  const plannedSet = new Set(planned)
  const existingSet = new Set(existing)
  const missing = existing.filter((value) => !plannedSet.has(value))
  const additions = planned.filter((value) => !existingSet.has(value))
  const sameSet = missing.length === 0 && additions.length === 0
  const parts: string[] = []
  if (missing.length > 0) parts.push(`missing from revised plan: ${missing.join(", ")}`)
  if (additions.length > 0) parts.push(`unexpected additions: ${additions.join(", ")}`)
  if (sameSet) parts.push("same entries but different order")
  return parts.join("; ")
}

const COMPLETED_TASK_DESCRIPTION_METADATA_LABEL = String.raw`(?:Dependencies|Depends\s+on|Requires|Expected\s+tests?|Tests?|Verification\s+commands?|Commands?|Expected\s+files?|Required\s+files?|Files?|Complexity|Category|Roadmap\s+items?)`
const COMPLETED_TASK_DESCRIPTION_METADATA_RE = new RegExp(
  String.raw`\s*(?:[-*]\s*)?\*{0,2}${COMPLETED_TASK_DESCRIPTION_METADATA_LABEL}\*{0,2}\s*:\s*(?:(?!\s*(?:[-*]\s*)?\*{0,2}${COMPLETED_TASK_DESCRIPTION_METADATA_LABEL}\*{0,2}\s*:).)*`,
  "gi",
)

export function normalizeCompletedTaskDescription(description: string): string {
  return description
    .replace(COMPLETED_TASK_DESCRIPTION_METADATA_RE, "")
    .replace(/\s+—\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const COMPLETED_TASK_SECTION_LABELS = [
  "Intentional deletion targets",
  "Implementation",
  "Human action",
  "Verification after human action",
  "Acceptance",
  "Scheduling Notes",
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function completedTaskSectionLabelRe(label: string): RegExp {
  return new RegExp(`(?:#{1,6}\\s*)?\\b${escapeRegExp(label)}\\b\\s*:`, "i")
}

function completedTaskNextSectionLabelRe(label: string): RegExp {
  return new RegExp(`(?:#{1,6}\\s*)?\\b${escapeRegExp(label)}\\b(?:\\s*:|\\s+-|$)`, "i")
}

function addCompletedTaskDescriptionBlockVariant(variants: Set<string>, description: string, label: string): void {
  const normalized = normalizeCompletedTaskDescription(description)
  const separator = normalized.indexOf(" — ")
  if (separator === -1) return
  const title = normalized.slice(0, separator)
  const body = normalized.slice(separator + 3)
  const labelMatch = completedTaskSectionLabelRe(label).exec(body)
  if (!labelMatch || labelMatch.index === undefined) return
  const start = labelMatch.index
  let end = body.length
  for (const nextLabel of COMPLETED_TASK_SECTION_LABELS) {
    if (nextLabel === label) continue
    const nextMatch = completedTaskNextSectionLabelRe(nextLabel).exec(body.slice(start + labelMatch[0].length))
    if (nextMatch?.index !== undefined) {
      end = Math.min(end, start + labelMatch[0].length + nextMatch.index)
    }
  }
  variants.add(`${title} — ${body.slice(start, end).trim()}`)
}

function completedTaskDescriptionVariants(description: string): Set<string> {
  const variants = new Set<string>([normalizeCompletedTaskDescription(description)])
  addCompletedTaskDescriptionBlockVariant(variants, description, "Implementation")
  addCompletedTaskDescriptionBlockVariant(variants, description, "Human action")
  addCompletedTaskDescriptionBlockVariant(variants, description, "Acceptance")
  return variants
}

function completedTaskDescriptionVariantMatches(left: string, right: string): boolean {
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return shorter.length >= 500 && longer.startsWith(shorter)
}

export function sameCompletedTaskDescription(existing: string, planned: string): boolean {
  const existingVariants = completedTaskDescriptionVariants(existing)
  const plannedVariants = completedTaskDescriptionVariants(planned)
  for (const existingVariant of existingVariants) {
    for (const plannedVariant of plannedVariants) {
      if (completedTaskDescriptionVariantMatches(existingVariant, plannedVariant)) return true
    }
  }
  return false
}

export function completedTaskRewriteReason(existing: TaskNode, planned: TaskNode): string | null {
  return completedTaskRewriteDiagnostic(existing, planned)?.field ?? null
}

export function completedTaskRewriteDiagnostic(existing: TaskNode, planned: TaskNode): { field: string; detail: string; guidance: string } | null {
  const checks: Array<[string, boolean]> = [
    ["description", sameCompletedTaskDescription(existing.description, planned.description)],
    ["dependencies", sameStringSet(existing.dependencies, planned.dependencies)],
    ["expectedTests", sameStringSet(existing.expectedTests, planned.expectedTests)],
    ["verificationCommands", sameStringArray(existing.verificationCommands ?? [], planned.verificationCommands ?? [])],
    ["expectedFiles", sameStringSet(existing.expectedFiles, planned.expectedFiles)],
    ["roadmapItemIds", sameStringSet(existing.roadmapItemIds ?? [], planned.roadmapItemIds ?? [])],
    ["estimatedComplexity", existing.estimatedComplexity === planned.estimatedComplexity],
    ["category", (existing.category ?? "standalone") === (planned.category ?? "standalone")],
  ]
  const changed = checks.find(([, matches]) => !matches)
  if (!changed) return null
  const field = changed[0]
  const detail = (() => {
    if (field === "expectedFiles") return stringArrayDiffDetail(existing.expectedFiles, planned.expectedFiles)
    if (field === "expectedTests") return stringArrayDiffDetail(existing.expectedTests, planned.expectedTests)
    if (field === "dependencies") return stringArrayDiffDetail(existing.dependencies, planned.dependencies)
    if (field === "verificationCommands") return stringArrayDiffDetail(existing.verificationCommands ?? [], planned.verificationCommands ?? [])
    if (field === "roadmapItemIds") return stringArrayDiffDetail(existing.roadmapItemIds ?? [], planned.roadmapItemIds ?? [])
    if (field === "description") return `existing: ${normalizeCompletedTaskDescription(existing.description)}; revised: ${normalizeCompletedTaskDescription(planned.description)}`
    return `existing: ${String((existing as unknown as Record<string, unknown>)[field])}; revised: ${String((planned as unknown as Record<string, unknown>)[field])}`
  })()
  const guidance = field === "expectedFiles"
    ? "Preserve the completed task's Files metadata exactly. Do not remove deleted historical files from completed tasks; record deleted/superseded paths only on a future corrective task via Intentional deletion targets/Deleted files."
    : "Preserve completed task metadata exactly and add a future corrective, revert, or superseding task for new work."
  return { field, detail, guidance }
}
