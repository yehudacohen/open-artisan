/**
 * cascade-auto-skip.ts — Deterministic auto-skip at cascade entry.
 *
 * When the workflow enters a cascade step's REVISE, this module checks whether
 * the artifact actually needs changes. If not, it loops through consecutive
 * no-op steps until it finds one that needs work, or fast-forwards to USER_GATE
 * if all remaining steps are no-ops.
 *
 * This runs at the STATE TRANSITION level — the agent never sees the skipped
 * phases, preventing it from getting stuck in tool-blocked states (e.g., bash
 * blocked in TESTS/REVISE) and rationalizing workarounds.
 *
 * Extracted from index.ts for testability — the function takes explicit
 * dependencies instead of closing over plugin-scope variables.
 */

import type { WorkflowState, SessionStateStore, StateMachine } from "./types"
import type { RevisionStep } from "./orchestrator-types"
import type { Logger } from "./logger"
import { hasArtifactChanged, captureRevisionBaseline } from "./revision-baseline"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected from the engine context. */
export interface CascadeAutoSkipDeps {
  store: SessionStateStore
  sm: StateMachine
  log: Logger
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Checks whether the current cascade step (and subsequent steps) can be
 * auto-skipped because no artifact changes are needed.
 *
 * Called immediately after transitioning to a cascade step's REVISE.
 *
 * @param deps      Injected dependencies (store, state machine, logger, shell)
 * @param sessionId Session to check
 * @param cwd       Project working directory
 * @returns A message to return to the agent, or null if no skip was performed.
 */
export async function cascadeAutoSkip(
  deps: CascadeAutoSkipDeps,
  sessionId: string,
  cwd: string,
): Promise<string | null> {
  const { store, sm, log } = deps
  const skippedPhases: string[] = []

  // Loop: keep skipping no-op cascade steps
  // Safety cap: max 10 iterations to prevent infinite loops
  for (let i = 0; i < 10; i++) {
    const current = store.get(sessionId)
    if (!current) return null
    if (current.phaseState !== "REVISE") return null
    if (!current.revisionBaseline) return null // No baseline → can't detect, let agent proceed

    let changed: boolean
    try {
      changed = await hasArtifactChanged(
        current.revisionBaseline,
        current.phase,
        current,
        cwd,
      )
    } catch {
      // Diff check failed → graceful degradation, let agent proceed
      return null
    }

    if (changed) {
      // This phase needs work — stop skipping
      break
    }

    // No changes detected for this step.
    // Guard: on the first iteration, only skip if this is part of a cascade
    // (pendingRevisionSteps has items). If pendingRevisionSteps is empty/null
    // on the first check, this is a standalone REVISE or single-step revise
    // where the agent is expected to do work — return null so the caller
    // applies the standalone hard block.
    if (skippedPhases.length === 0 && (!current.pendingRevisionSteps || current.pendingRevisionSteps.length === 0)) {
      return null
    }

    skippedPhases.push(current.phase)

    if (current.pendingRevisionSteps && current.pendingRevisionSteps.length > 0) {
      // More cascade steps → advance to next step's REVISE
      const nextStep = current.pendingRevisionSteps[0]!
      const remainingSteps = current.pendingRevisionSteps.slice(1)

      let nextBaseline: WorkflowState["revisionBaseline"] = null
      try {
        nextBaseline = await captureRevisionBaseline(
          nextStep.phase,
          current,
          cwd,
        )
      } catch { /* non-fatal */ }

      await store.update(sessionId, (draft) => {
        draft.phase = nextStep.phase
        draft.phaseState = "REVISE"
        draft.pendingRevisionSteps = remainingSteps
        draft.revisionBaseline = nextBaseline
        draft.retryCount = 0
      })

      log.info("Auto-skipped cascade step at entry", { detail: `${current.phase}/REVISE → ${nextStep.phase}/REVISE` })

      // Continue loop — check the NEXT step too
      continue
    }

    // Last cascade step (or pendingRevisionSteps is empty) — fast-forward to USER_GATE
    const skipOutcome = sm.transition(current.phase, "REVISE", "revision_complete", current.mode)
    if (skipOutcome.ok) {
      const userGateOutcome = sm.transition(skipOutcome.nextPhase, skipOutcome.nextPhaseState, "self_review_pass", current.mode)
      if (userGateOutcome.ok && userGateOutcome.nextPhaseState === "USER_GATE") {
        await store.update(sessionId, (draft) => {
          draft.phase = userGateOutcome.nextPhase
          draft.phaseState = userGateOutcome.nextPhaseState
          draft.revisionBaseline = null
          draft.pendingRevisionSteps = null
          draft.retryCount = 0
          draft.userGateMessageReceived = false
        })

        log.info("Auto-skipped all remaining cascade steps", { detail: `${skippedPhases.join(" → ")} → ${userGateOutcome.nextPhase}/USER_GATE` })

        return (
          `No changes needed for **${skippedPhases.join("**, **")}** — auto-skipped.\n\n` +
          `All cascade revisions are complete. Present the results to the user ` +
          `and wait for their approval or further feedback.`
        )
      }
    }
    // SM transitions failed — fall through (let agent proceed in current state)
    break
  }

  if (skippedPhases.length === 0) return null

  // We skipped some phases but landed on one that needs work
  const current = store.get(sessionId)
  if (!current) return null

  return (
    `No changes needed for **${skippedPhases.join("**, **")}** — auto-skipped.\n\n` +
    `Advancing to **${current.phase}/REVISE**. ` +
    `Apply the revision feedback to the ${current.phase.toLowerCase()} artifact, ` +
    `then call \`request_review\` when done.` +
    (current.pendingRevisionSteps && current.pendingRevisionSteps.length > 0
      ? `\n\n**Cascade:** ${current.pendingRevisionSteps.length} more step(s) after this: ${current.pendingRevisionSteps.map((s: RevisionStep) => s.artifact).join(" → ")}.`
      : "\n\n**Final cascade step.**")
  )
}
