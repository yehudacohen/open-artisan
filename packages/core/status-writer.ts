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
