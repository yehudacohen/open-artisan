/**
 * status-writer.ts — Generates a persistent status file from WorkflowState.
 *
 * Written to `.openartisan/<feature>/status.md` on every state transition.
 * The user can keep this open in a split pane for at-a-glance visibility
 * into: current phase, artifact table, and latest review results.
 *
 * The OpenCode plugin API (v1.2.20) has no sidebar panel hook, so this
 * file-based approach is the best available mechanism for persistent status.
 */

import { join } from "node:path"
import { writeFile, mkdir } from "node:fs/promises"
import type { WorkflowState, Phase, ArtifactKey } from "./types"
import { PHASE_TO_ARTIFACT } from "./artifacts"

const ARTIFACT_DISPLAY_ORDER: ArtifactKey[] = [
  "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation",
]

const PHASE_DISPLAY_ORDER: Phase[] = [
  "DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION",
]

function artifactStatus(
  artifact: ArtifactKey,
  state: WorkflowState,
): string {
  const currentPhaseArtifact = PHASE_TO_ARTIFACT[state.phase]
  if (state.approvedArtifacts[artifact]) {
    return "approved"
  }
  if (state.artifactDiskPaths[artifact]) {
    return "saved"
  }
  if (artifact === currentPhaseArtifact) {
    return state.phaseState === "USER_GATE"
      ? "awaiting review"
      : state.phaseState === "REVIEW"
        ? "self-reviewing"
        : state.phaseState === "REVISE"
          ? "revising"
          : "drafting"
  }
  return "—"
}

function formatReviewResults(
  results: WorkflowState["latestReviewResults"],
): string {
  if (!results || results.length === 0) return "No review results yet."

  const blocking = results.filter((r) => !r.criterion.startsWith("[S]"))
  const passing = blocking.filter((r) => r.met)
  const failing = blocking.filter((r) => !r.met)

  const lines: string[] = []
  lines.push(`- **Result:** ${failing.length === 0 ? "All blocking criteria met" : `${failing.length} of ${blocking.length} blocking criteria not met`}`)

  if (failing.length > 0) {
    lines.push(`- **Failing criteria:**`)
    for (const f of failing) {
      lines.push(`  - "${f.criterion}" — ${f.evidence.slice(0, 120)}`)
    }
  }

  lines.push(`- **Passing criteria:** ${passing.length} of ${blocking.length} met`)

  return lines.join("\n")
}

function formatPathList(paths: string[]): string[] {
  return paths.map((p) => `- \`${p}\``)
}

function formatReviewAssets(state: WorkflowState): string[] {
  const lines: string[] = []
  const artifactEntries = Object.entries(state.artifactDiskPaths)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
  const reviewFiles = state.reviewArtifactFiles.filter((p) => p.length > 0)

  if (artifactEntries.length === 0 && reviewFiles.length === 0) return lines

  lines.push(`## Review Assets`)
  if (artifactEntries.length > 0) {
    lines.push(`- **Artifact documents:**`)
    for (const [key, path] of artifactEntries) {
      lines.push(`- ${key}: \`${path}\``)
    }
  }
  if (reviewFiles.length > 0) {
    lines.push(`- **Files under review:**`)
    lines.push(...formatPathList(reviewFiles))
  }
  lines.push("")
  return lines
}

function formatHumanGates(state: WorkflowState): string[] {
  const gates = state.implDag?.filter((task) =>
    task.status === "human-gated" && (!task.humanGate || !task.humanGate.resolved)
  ) ?? []
  if (gates.length === 0) return []

  const lines: string[] = [`## Human Gates`]
  for (const task of gates) {
    const gate = task.humanGate
    lines.push(`- **${task.id}:** ${gate?.whatIsNeeded ?? task.description}`)
    if (gate?.why) lines.push(`- **Why:** ${gate.why}`)
    if (gate?.verificationSteps) lines.push(`- **Verification:** ${gate.verificationSteps}`)
  }
  lines.push("")
  return lines
}

function formatReviewEvidence(
  results: WorkflowState["latestReviewResults"],
): string[] {
  if (!results || results.length === 0) return []

  const lines: string[] = [`## Review Evidence`]
  for (const result of results.slice(0, 8)) {
    const status = result.met ? "met" : "unmet"
    const score = result.score ? `, score ${result.score}` : ""
    const evidence = result.evidence.length > 240
      ? `${result.evidence.slice(0, 240)}...`
      : result.evidence
    lines.push(`- **${result.criterion}** (${status}${score}): ${evidence}`)
  }
  if (results.length > 8) {
    lines.push(`- ${results.length - 8} additional criteria omitted from status summary.`)
  }
  lines.push("")
  return lines
}

export function generateStatusMarkdown(state: WorkflowState): string {
  const featureName = state.featureName ?? "unknown"
  const lines: string[] = []

  lines.push(`# Workflow Status: ${featureName}`)
  lines.push("")
  lines.push(`## Current State`)
  lines.push(`- **Phase:** ${state.phase}`)
  lines.push(`- **Sub-state:** ${state.phaseState}`)
  lines.push(`- **Mode:** ${state.mode ?? "not selected"}`)
  lines.push("")

  lines.push(`## Artifacts`)
  lines.push(`| Artifact | Status |`)
  lines.push(`|----------|--------|`)
  for (const artifact of ARTIFACT_DISPLAY_ORDER) {
    const status = artifactStatus(artifact, state)
    lines.push(`| ${artifact} | ${status} |`)
  }
  lines.push("")

  lines.push(`## Latest Review Results`)
  lines.push(formatReviewResults(state.latestReviewResults))
  lines.push("")

  lines.push(...formatReviewAssets(state))
  lines.push(...formatHumanGates(state))
  lines.push(...formatReviewEvidence(state.latestReviewResults))

  return lines.join("\n")
}

export async function writeStatusFile(
  projectDir: string,
  state: WorkflowState,
): Promise<void> {
  const featureName = state.featureName
  if (!featureName) return // Can't write status without a feature name

  const statusDir = join(projectDir, ".openartisan", featureName)
  await mkdir(statusDir, { recursive: true })

  const statusPath = join(statusDir, "status.md")
  const content = generateStatusMarkdown(state)
  await writeFile(statusPath, content, "utf-8")
}
