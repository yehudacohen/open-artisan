/**
 * fast-forward.ts — Phase fast-forward for returning projects.
 *
 * After mode selection, if the project has existing approved artifacts from a
 * prior workflow cycle (preserved across DONE → MODE_SELECT resets), this module
 * determines how many phases can be skipped.
 *
 * Algorithm (Option E — fast-forward with validation):
 *   1. Get the phase sequence for the selected mode
 *   2. For each phase in order:
 *      a. Look up the artifact key (PHASE_TO_ARTIFACT[phase])
 *      b. Check if approvedArtifacts has an entry for that key
 *      c. Check if artifactDiskPaths has a path for that key
 *      d. Verify the file still exists on disk
 *      e. If the approved hash is content-based (not time-sentinel), verify
 *         the file content still matches
 *   3. First phase that fails any check → that's where work starts
 *   4. All phases pass → land at DONE (everything is still valid)
 *
 * The function returns the target phase/phaseState and a list of skipped phases,
 * but does NOT mutate state. The caller (select_mode handler) applies the result.
 *
 * Key structural guarantee: we NEVER skip a phase whose artifact is missing,
 * changed, or was never approved. We only skip phases with verified-intact artifacts.
 */

import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import type { Phase, WorkflowMode, ArtifactKey } from "./types"
import { PHASE_TO_ARTIFACT } from "./artifacts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FastForwardResult {
  /** The phase to land at after fast-forward */
  targetPhase: Phase
  /** The phaseState to land at */
  targetPhaseState: "DRAFT" | "SCAN"
  /** Phases that were skipped (in order) */
  skippedPhases: Phase[]
  /** Human-readable message describing what happened */
  message: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Phase sequences by mode. These are the phases the agent would traverse
 * after mode selection, in order. GREENFIELD skips DISCOVERY.
 */
const PHASE_SEQUENCES: Record<WorkflowMode, Phase[]> = {
  GREENFIELD:  ["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"],
  REFACTOR:    ["DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"],
  INCREMENTAL: ["DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"],
}

/**
 * The initial phaseState for each phase when landing on it after fast-forward.
 * DISCOVERY starts at SCAN; all other phases start at DRAFT.
 */
function getInitialPhaseState(phase: Phase): "DRAFT" | "SCAN" {
  return phase === "DISCOVERY" ? "SCAN" : "DRAFT"
}

// ---------------------------------------------------------------------------
// Hash verification
// ---------------------------------------------------------------------------

/** SHA-256 hex hash of the file content, truncated to 16 chars.
 *  Matches the `artifactHash()` function in index.ts. */
function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** Returns true if the approved hash is a time-based sentinel (not content-based). */
function isTimeSentinel(hash: string): boolean {
  return hash.startsWith("approved-at-")
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Determines how many phases can be fast-forwarded based on existing
 * approved artifacts that are still intact on disk.
 *
 * @param mode              The selected workflow mode
 * @param approvedArtifacts Map of artifact key → approval hash from prior cycle
 * @param artifactDiskPaths Map of artifact key → absolute file path from prior cycle
 * @returns FastForwardResult describing where to land and what was skipped
 */
export function computeFastForward(
  mode: WorkflowMode,
  approvedArtifacts: Partial<Record<ArtifactKey, string>>,
  artifactDiskPaths: Partial<Record<ArtifactKey, string>>,
): FastForwardResult {
  const phases = PHASE_SEQUENCES[mode]
  const skippedPhases: Phase[] = []

  for (const phase of phases) {
    const artifactKey = PHASE_TO_ARTIFACT[phase]
    if (!artifactKey) {
      // Phase has no artifact (shouldn't happen for phases in sequence, but guard)
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    const approvedHash = approvedArtifacts[artifactKey]
    if (!approvedHash) {
      // Artifact was never approved → must start here
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    const diskPath = artifactDiskPaths[artifactKey]
    if (!diskPath) {
      // No disk path recorded → must start here
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    // Check file exists on disk
    if (!existsSync(diskPath)) {
      // File was deleted → must start here
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    // Content verification: if the approval hash is content-based, verify it
    if (!isTimeSentinel(approvedHash)) {
      try {
        const content = readFileSync(diskPath, "utf-8")
        const currentHash = artifactHash(content)
        if (currentHash !== approvedHash) {
          // Content changed since approval → must start here
          return {
            targetPhase: phase,
            targetPhaseState: getInitialPhaseState(phase),
            skippedPhases,
            message: buildMessage(skippedPhases, phase, "artifact content changed since last approval"),
          }
        }
      } catch {
        // Read failed → must start here (graceful degradation)
        return {
          targetPhase: phase,
          targetPhaseState: getInitialPhaseState(phase),
          skippedPhases,
          message: buildMessage(skippedPhases, phase, "could not read artifact file"),
        }
      }
    }

    // All checks passed — this phase can be skipped
    skippedPhases.push(phase)
  }

  // All phases passed — every artifact is still intact.
  // Land at DONE — nothing needs redoing.
  // In practice this is rare (IMPLEMENTATION artifact is usually time-sentinel),
  // but structurally valid.
  return {
    targetPhase: "DONE",
    targetPhaseState: "DRAFT",
    skippedPhases,
    message: buildAllSkippedMessage(skippedPhases),
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildMessage(skippedPhases: Phase[], targetPhase: Phase, reason?: string): string {
  if (skippedPhases.length === 0) {
    return reason
      ? `Starting at **${targetPhase}** (${reason}).`
      : `Starting at **${targetPhase}** — no prior approved artifacts found.`
  }

  const skippedList = skippedPhases.map((p) => `**${p}**`).join(", ")
  const reasonSuffix = reason ? ` (${reason})` : ""
  return (
    `Fast-forwarded past ${skippedPhases.length} phase(s) with verified artifacts: ${skippedList}.\n\n` +
    `Starting at **${targetPhase}**${reasonSuffix}. Prior artifacts are intact and will be reused.`
  )
}

function buildAllSkippedMessage(skippedPhases: Phase[]): string {
  const skippedList = skippedPhases.map((p) => `**${p}**`).join(", ")
  return (
    `All ${skippedPhases.length} phase artifacts are still intact: ${skippedList}.\n\n` +
    `All prior work is verified. The workflow is complete — no phases need redoing.`
  )
}
