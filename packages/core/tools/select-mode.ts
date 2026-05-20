/**
 * select-mode.ts — The `select_mode` tool definition.
 *
 * The agent calls this at MODE_SELECT to record which workflow mode was chosen.
 * After calling this tool, the state machine transitions to DISCOVERY (REFACTOR/INCREMENTAL)
 * or PLANNING (GREENFIELD). Modes are validated against the WorkflowMode enum.
 */
import type { WorkflowMode } from "../workflow-primitives"
import type { SelectModeArgs } from "../tool-types"

export interface ParsedSelectModeArgs {
  mode: WorkflowMode
  featureName: string | null
  roadmapItemIds: string[]
  executionSliceId: string | null
}

export const VALID_MODES: WorkflowMode[] = ["GREENFIELD", "REFACTOR", "INCREMENTAL"]

export const SELECT_MODE_DESCRIPTION = `
Call this tool to select the workflow mode for this session.

Choose the mode that best describes the work:
- **GREENFIELD** — New project from scratch (empty or near-empty repo). No discovery phase. Full creative freedom.
- **REFACTOR** — Existing project where the goal is to improve structure, patterns, or architecture. Full discovery phase runs first. All files can be modified, but must follow the transformation plan.
- **INCREMENTAL** — Existing project where the goal is to add or fix specific functionality. Full discovery phase. Do-no-harm directive: only files explicitly approved in the plan can be modified.

The auto-detection suggests a mode based on git history and file count, but you can override it.
`.trim()

/**
 * Validates and parses the select_mode tool arguments.
 * Returns the mode if valid, or an error string.
 */
export function parseSelectModeArgs(args: unknown): ParsedSelectModeArgs | { error: string } {
  if (!args || typeof args !== "object") {
    return { error: "Invalid arguments: expected an object" }
  }
  const obj = args as Record<string, unknown>
  const rawMode = obj["mode"]
  // Normalize to uppercase so "greenfield", "Greenfield", "GREENFIELD" all work
  const mode = typeof rawMode === "string" ? rawMode.toUpperCase() : rawMode
  if (!VALID_MODES.includes(mode as WorkflowMode)) {
    return {
      error: `Invalid mode "${rawMode}". Valid modes: ${VALID_MODES.join(", ")}`,
    }
  }
  const rawFeatureName = obj["feature_name"] ?? obj["feature"]
  if (rawFeatureName !== undefined && typeof rawFeatureName !== "string") {
    return { error: "Invalid feature_name: expected a string" }
  }
  const featureName = typeof rawFeatureName === "string" ? rawFeatureName.trim() || null : null
  const rawRoadmapItemIds = obj["roadmap_item_ids"] ?? obj["roadmapItemIds"]
  if (rawRoadmapItemIds !== undefined && (!Array.isArray(rawRoadmapItemIds) || rawRoadmapItemIds.some((item) => typeof item !== "string" || item.trim().length === 0))) {
    return { error: "Invalid roadmap_item_ids: expected an array of non-empty strings" }
  }
  const rawExecutionSliceId = obj["execution_slice_id"] ?? obj["executionSliceId"]
  if (rawExecutionSliceId !== undefined && (typeof rawExecutionSliceId !== "string" || rawExecutionSliceId.trim().length === 0)) {
    return { error: "Invalid execution_slice_id: expected a non-empty string" }
  }
  return {
    mode: mode as WorkflowMode,
    featureName,
    roadmapItemIds: Array.isArray(rawRoadmapItemIds) ? rawRoadmapItemIds.map((item) => item.trim()) : [],
    executionSliceId: typeof rawExecutionSliceId === "string" ? rawExecutionSliceId.trim() : null,
  }
}

/**
 * Builds the success response message for the select_mode tool.
 */
export function buildSelectModeResponse(mode: WorkflowMode): string {
  switch (mode) {
    case "GREENFIELD":
      return (
        `Mode set to GREENFIELD. ` +
        `Transitioning directly to PLANNING — no discovery phase in greenfield mode. ` +
        `Begin drafting the plan now.`
      )
    case "REFACTOR":
      return (
        `Mode set to REFACTOR. ` +
        `Transitioning to DISCOVERY phase. ` +
        `Start scanning the codebase to understand its current state before planning any changes.`
      )
    case "INCREMENTAL":
      return (
        `Mode set to INCREMENTAL (do-no-harm). ` +
        `Transitioning to DISCOVERY phase. ` +
        `Scan the codebase to document the existing conventions that must be followed. ` +
        `All subsequent changes will be constrained to the approved file allowlist.`
      )
    default: {
      const exhaustive: never = mode
      return `Error: unrecognized mode "${exhaustive}".`
    }
  }
}
