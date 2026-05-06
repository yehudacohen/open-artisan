import type { Phase } from "../workflow-primitives"
import { isInterfaceFile, isOpenArtisanFile, isTestFile } from "../hooks/tool-guard"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const FILE_BASED_PHASES = new Set<Phase>(["INTERFACES", "TESTS", "IMPLEMENTATION"])
const MARKDOWN_ARTIFACT_NAMES: Partial<Record<Phase, string>> = {
  DISCOVERY: "conventions.md",
  PLANNING: "plan.md",
  IMPL_PLAN: "impl-plan.md",
}

export function isStructurallyFileBasedPhase(phase: Phase): boolean {
  return FILE_BASED_PHASES.has(phase)
}

export function validateFileBasedReviewArtifacts(input: {
  phase: Phase
  artifactFiles: string[]
  cwd?: string
  featureName?: string | null
}): string | null {
  if (input.artifactFiles.length === 0) {
    return `request_review for ${input.phase} requires artifact_files listing the files to review.`
  }

  for (const file of input.artifactFiles) {
    if (!existsSync(file)) {
      return `request_review for ${input.phase} requires artifact_files to exist on disk; missing file: ${file}`
    }
  }

  const markdownArtifactName = MARKDOWN_ARTIFACT_NAMES[input.phase]
  if (markdownArtifactName) {
    if (!input.featureName) {
      return `request_review for ${input.phase} requires a feature name before validating markdown artifact files.`
    }
    if (input.artifactFiles.length !== 1) {
      return `request_review for ${input.phase} requires exactly one markdown artifact file: .openartisan/${input.featureName}/${markdownArtifactName}`
    }
    const cwd = input.cwd ?? process.cwd()
    const expected = resolve(cwd, ".openartisan", input.featureName, markdownArtifactName)
    if (resolve(input.artifactFiles[0]!) !== expected) {
      return `request_review for ${input.phase} must use .openartisan/${input.featureName}/${markdownArtifactName}; invalid artifact file: ${input.artifactFiles[0]}`
    }
    return null
  }

  if (!isStructurallyFileBasedPhase(input.phase)) return null

  for (const file of input.artifactFiles) {
    if (isOpenArtisanFile(file)) {
      return `request_review for ${input.phase} cannot review .openartisan artifacts (${file}). Submit real project files instead.`
    }
    if (input.phase === "INTERFACES" && !isInterfaceFile(file)) {
      return `request_review for INTERFACES only accepts interface/type/schema files; invalid artifact file: ${file}`
    }
    if (input.phase === "TESTS" && !isTestFile(file)) {
      return `request_review for TESTS only accepts runnable test/spec files; invalid artifact file: ${file}`
    }
    if (input.phase === "IMPLEMENTATION" && file.toLowerCase().endsWith(".md")) {
      return `request_review for IMPLEMENTATION accepts changed implementation files, not markdown summaries; invalid artifact file: ${file}`
    }
  }

  return null
}
