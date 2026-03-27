/**
 * fast-forward.ts — Phase skip logic for the open-artisan plugin.
 *
 * Two mechanisms:
 *
 * 1. **Phase fast-forward** (returning projects) — `computeFastForward()`
 *    After mode selection, if the project has existing approved artifacts from a
 *    prior workflow cycle, determines how many phases can be skipped by verifying
 *    artifacts are still intact on disk.
 *
 * 2. **Forward-pass skip** (INCREMENTAL mode) — `computeForwardSkip()`
 *    During the forward pass, if the fileAllowlist doesn't contain files relevant
 *    to a phase (e.g., no interface files for INTERFACES), that phase is auto-skipped.
 *    This avoids forcing the agent through ceremony gates for phases where no work
 *    is needed. Only applies to INCREMENTAL mode with a non-empty fileAllowlist.
 *    Skippable phases: INTERFACES (no interface files), TESTS (no test files),
 *    IMPL_PLAN (skipped if both INTERFACES and TESTS were skipped or if the
 *    allowlist is small enough that a task DAG adds no value).
 *
 * Both functions are pure — they return a result but do NOT mutate state.
 * The caller applies the result.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { Phase, WorkflowMode, ArtifactKey } from "./types"
import { PHASE_TO_ARTIFACT } from "./artifacts"
import { isInterfaceFile, isTestFile } from "./hooks/tool-guard"

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
// Main function (async)
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
export async function computeFastForward(
  mode: WorkflowMode,
  approvedArtifacts: Partial<Record<ArtifactKey, string>>,
  artifactDiskPaths: Partial<Record<ArtifactKey, string>>,
): Promise<FastForwardResult> {
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
        const content = await readFile(diskPath, "utf-8")
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
// Sync variant (no file reads; caller provides content)
// ---------------------------------------------------------------------------

/**
 * Synchronous fast-forward variant that avoids disk reads.
 *
 * If a content-based approval hash is present, the caller must provide
 * the corresponding artifact content via `artifactContents`. If content
 * is missing, the function conservatively stops at that phase.
 */
export function computeFastForwardSync(
  mode: WorkflowMode,
  approvedArtifacts: Partial<Record<ArtifactKey, string>>,
  artifactDiskPaths: Partial<Record<ArtifactKey, string>>,
  artifactContents: Partial<Record<ArtifactKey, string>> = {},
): FastForwardResult {
  const phases = PHASE_SEQUENCES[mode]
  const skippedPhases: Phase[] = []

  for (const phase of phases) {
    const artifactKey = PHASE_TO_ARTIFACT[phase]
    if (!artifactKey) {
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    const approvedHash = approvedArtifacts[artifactKey]
    if (!approvedHash) {
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    const diskPath = artifactDiskPaths[artifactKey]
    if (!diskPath) {
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    if (!existsSync(diskPath)) {
      return {
        targetPhase: phase,
        targetPhaseState: getInitialPhaseState(phase),
        skippedPhases,
        message: buildMessage(skippedPhases, phase),
      }
    }

    if (!isTimeSentinel(approvedHash)) {
      const content = artifactContents[artifactKey]
      if (typeof content !== "string") {
        return {
          targetPhase: phase,
          targetPhaseState: getInitialPhaseState(phase),
          skippedPhases,
          message: buildMessage(skippedPhases, phase, "artifact content not provided for sync verification"),
        }
      }
      const currentHash = artifactHash(content)
      if (currentHash !== approvedHash) {
        return {
          targetPhase: phase,
          targetPhaseState: getInitialPhaseState(phase),
          skippedPhases,
          message: buildMessage(skippedPhases, phase, "artifact content changed since last approval"),
        }
      }
    }

    skippedPhases.push(phase)
  }

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

// ---------------------------------------------------------------------------
// Forward-pass skip (INCREMENTAL mode)
// ---------------------------------------------------------------------------

/**
 * The ordered phase sequence used by the forward-pass skip.
 * MODE_SELECT, DISCOVERY, PLANNING always need work. DONE is the terminus.
 * The skippable phases are INTERFACES, TESTS, and IMPL_PLAN.
 */
const FORWARD_PHASE_ORDER: Phase[] = [
  "MODE_SELECT", "DISCOVERY", "PLANNING",
  "INTERFACES", "TESTS", "IMPL_PLAN",
  "IMPLEMENTATION", "DONE",
]

/** Phases that can be auto-skipped on the forward pass based on fileAllowlist. */
const FORWARD_SKIPPABLE: Set<Phase> = new Set(["INTERFACES", "TESTS", "IMPL_PLAN"])

export interface ForwardSkipResult {
  /** The phase to land at after skipping */
  targetPhase: Phase
  /** The phaseState to land at */
  targetPhaseState: "DRAFT" | "SCAN"
  /** Phases that were skipped (in order) */
  skippedPhases: Phase[]
  /** Human-readable message describing what was skipped */
  message: string
}

/**
 * Determines whether consecutive phases starting from `nextPhase` can be
 * auto-skipped on the forward pass because the fileAllowlist proves no
 * relevant files will be changed.
 *
 * Only applies to INCREMENTAL mode with a non-empty fileAllowlist.
 *
 * Skip criteria per phase:
 * - INTERFACES: no files in allowlist match isInterfaceFile
 * - TESTS: no files in allowlist match isTestFile
 * - IMPL_PLAN: skipped when both INTERFACES and TESTS were skipped
 *   (if neither phase needs work, the implementation is simple enough
 *   to not need a multi-task DAG)
 *
 * @param nextPhase      The phase that would normally be entered next
 * @param mode           Current workflow mode (only INCREMENTAL triggers skipping)
 * @param fileAllowlist  The INCREMENTAL file allowlist (absolute paths)
 * @returns ForwardSkipResult, or null if no phases can be skipped
 */
export function computeForwardSkip(
  nextPhase: Phase,
  mode: WorkflowMode | null,
  fileAllowlist: string[],
): ForwardSkipResult | null {
  // Only INCREMENTAL mode triggers forward-pass skip.
  // An empty allowlist is valid here: it means "no source files will be changed"
  // (a purely operational task), which implies hasInterfaceFiles=false and
  // hasTestFiles=false — all three ceremony phases (INTERFACES, TESTS, IMPL_PLAN)
  // will be skipped and the workflow lands directly at IMPLEMENTATION.
  // Do NOT short-circuit on length === 0: that conflates "allowlist not yet set"
  // with "allowlist explicitly empty". The allowlist is always populated from
  // args.approved_files before computeForwardSkip is called (see index.ts).
  if (mode !== "INCREMENTAL") return null

  // Only skip from a skippable phase
  if (!FORWARD_SKIPPABLE.has(nextPhase)) return null

  // Pre-compute allowlist analysis
  const hasInterfaceFiles = fileAllowlist.some(isInterfaceFile)
  const hasTestFiles = fileAllowlist.some(isTestFile)

  // Determine which phases to skip, starting from nextPhase
  const startIdx = FORWARD_PHASE_ORDER.indexOf(nextPhase)
  if (startIdx === -1) return null

  const skippedPhases: Phase[] = []
  let targetPhase: Phase = nextPhase

  for (let i = startIdx; i < FORWARD_PHASE_ORDER.length; i++) {
    const phase = FORWARD_PHASE_ORDER[i]!
    if (!FORWARD_SKIPPABLE.has(phase)) {
      // Hit a non-skippable phase — this is where work resumes
      targetPhase = phase
      break
    }

    const canSkip = canSkipPhaseForward(phase, hasInterfaceFiles, hasTestFiles, skippedPhases)
    if (!canSkip) {
      targetPhase = phase
      break
    }

    skippedPhases.push(phase)
  }

  if (skippedPhases.length === 0) return null

  return {
    targetPhase,
    targetPhaseState: getInitialPhaseState(targetPhase),
    skippedPhases,
    message: buildForwardSkipMessage(skippedPhases, targetPhase),
  }
}

/**
 * Returns true if a phase can be skipped on the forward pass.
 */
function canSkipPhaseForward(
  phase: Phase,
  hasInterfaceFiles: boolean,
  hasTestFiles: boolean,
  alreadySkipped: Phase[],
): boolean {
  switch (phase) {
    case "INTERFACES":
      return !hasInterfaceFiles
    case "TESTS":
      return !hasTestFiles
    case "IMPL_PLAN":
      // Skip IMPL_PLAN if both INTERFACES and TESTS were skipped —
      // the change is scoped enough that a task DAG adds no value.
      // If either phase needed work, IMPL_PLAN organizes the fuller effort.
      return alreadySkipped.includes("INTERFACES") && alreadySkipped.includes("TESTS")
    default:
      return false
  }
}

function buildForwardSkipMessage(skippedPhases: Phase[], targetPhase: Phase): string {
  const skippedList = skippedPhases.map((p) => `**${p}**`).join(", ")
  const reasons = skippedPhases.map((p) => {
    switch (p) {
      case "INTERFACES": return "no interface files in allowlist"
      case "TESTS": return "no test files in allowlist"
      case "IMPL_PLAN": return "implementation is scoped — DAG not needed"
      default: return "no relevant files"
    }
  })
  return (
    `Auto-skipped ${skippedPhases.length} phase(s): ${skippedList} ` +
    `(${reasons.join("; ")}).\n\n` +
    `Advancing directly to **${targetPhase}**.`
  )
}
