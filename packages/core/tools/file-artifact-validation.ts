import type { Phase } from "../workflow-primitives"
import type { WorkflowState } from "../workflow-state-types"
import { isInterfaceFile, isOpenArtisanFile, isTestFile } from "../hooks/tool-guard"
import { normalizeWorkflowPaths } from "../path-normalization"
import { extractExistingFileArgumentsFromCommand, isLikelyCommandMetadataEntry } from "../task-metadata-paths"
import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"

const FILE_BASED_PHASES = new Set<Phase>(["INTERFACES", "TESTS", "IMPLEMENTATION"])
const MARKDOWN_ARTIFACT_NAMES: Partial<Record<Phase, string>> = {
  DISCOVERY: "conventions.md",
  PLANNING: "plan.md",
  IMPL_PLAN: "impl-plan.md",
}

export function isStructurallyFileBasedPhase(phase: Phase): boolean {
  return FILE_BASED_PHASES.has(phase)
}

export function collectImplementationReviewArtifactFiles(state: WorkflowState, cwd?: string): string[] {
  if (state.phase !== "IMPLEMENTATION") return []
  const projectRoot = cwd ?? process.cwd()
  const files = new Set(normalizeWorkflowPaths(state.reviewArtifactFiles, projectRoot))
  const deletionTargets = new Set<string>()
  for (const task of state.implDag ?? []) {
    if (task.status !== "complete") continue
    for (const entry of task.expectedFiles ?? []) {
      if (isLikelyCommandMetadataEntry(entry, projectRoot)) {
        for (const file of extractExistingFileArgumentsFromCommand(entry, projectRoot)) files.add(file)
        continue
      }
      for (const file of normalizeWorkflowPaths([entry], projectRoot)) files.add(file)
    }
    for (const entry of task.expectedTests ?? []) {
      if (isLikelyCommandMetadataEntry(entry, projectRoot)) {
        for (const file of extractExistingFileArgumentsFromCommand(entry, projectRoot)) files.add(file)
        continue
      }
      for (const file of normalizeWorkflowPaths([entry], projectRoot)) files.add(file)
    }
    for (const file of normalizeWorkflowPaths(task.intentionalDeletionTargets ?? [], projectRoot)) deletionTargets.add(file)
  }
  for (const file of deletionTargets) files.delete(file)
  // Auto-derived expected files come from the IMPL_PLAN DAG metadata, which can be stale or
  // (before the parser fix) malformed — e.g. prose tokens from a "**Files:** none (…)" line.
  // Only enforce DAG-derived paths that still exist on disk; a derived path that is gone is
  // treated as stale and skipped rather than failing the whole review. The agent's explicitly
  // provided artifact_files are merged in separately and remain strictly existence-checked.
  return Array.from(files).filter((file) => existsSync(file))
}

export function mergeImplementationReviewArtifactFiles(state: WorkflowState, artifactFiles: string[], cwd?: string): string[] {
  if (state.phase !== "IMPLEMENTATION") return artifactFiles
  const projectRoot = cwd ?? process.cwd()
  return Array.from(new Set([
    ...collectImplementationReviewArtifactFiles(state, projectRoot),
    ...normalizeWorkflowPaths(artifactFiles, projectRoot),
  ]))
}

export function validateFileBasedReviewArtifacts(input: {
  phase: Phase
  artifactFiles: string[]
  cwd?: string
  featureName?: string | null
  implementationArtifactFiles?: string[]
}): string | null {
  if (input.artifactFiles.length === 0) {
    return `request_review for ${input.phase} requires artifact_files listing the files to review.`
  }

  const cwd = input.cwd ?? process.cwd()
  const allowedImplementationMarkdownFiles = new Set(normalizeWorkflowPaths(input.implementationArtifactFiles ?? [], cwd))

  for (const file of input.artifactFiles) {
    if (isLikelyCommandMetadataEntry(file, cwd)) {
      return `request_review for ${input.phase} received a command where artifact_files must contain real files: ${file}. Put runnable commands in verificationCommands / **Verification commands:** metadata instead of artifact_files.`
    }
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
      return `request_review for INTERFACES only accepts interface/type/schema files; invalid artifact file: ${file}. If the approved plan named this as a reviewed INTERFACES artifact, backtrack to PLANNING and reclassify it as a supporting dependency or choose a phase-legal interface artifact.`
    }
    if (input.phase === "TESTS" && !isTestFile(file)) {
      return `request_review for TESTS only accepts runnable test/spec files; invalid artifact file: ${file}`
    }
    if (input.phase === "IMPLEMENTATION" && file.toLowerCase().endsWith(".md")) {
      if (basename(file).toLowerCase() === "readme.md") continue
      const normalized = normalizeWorkflowPaths([file], cwd)[0]
      if (!normalized || !allowedImplementationMarkdownFiles.has(normalized)) {
        return `request_review for IMPLEMENTATION accepts Markdown only for README.md files or when it is part of the completed task expected files/review artifact set; invalid artifact file: ${file}`
      }
    }
  }

  return null
}
