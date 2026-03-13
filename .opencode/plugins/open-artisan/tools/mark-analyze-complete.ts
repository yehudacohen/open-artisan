/**
 * mark-analyze-complete.ts — The `mark_analyze_complete` tool definition.
 *
 * Called by the agent when it has finished analyzing scan results in
 * DISCOVERY/ANALYZE state. Fires the `analyze_complete` event → transitions
 * to DISCOVERY/CONVENTIONS.
 */
import type { MarkAnalyzeCompleteArgs } from "../types"

// Re-export for test convenience
export type { MarkAnalyzeCompleteArgs }

export const MARK_ANALYZE_COMPLETE_DESCRIPTION = `
Call this tool when you have finished analyzing the scan results in the DISCOVERY phase.

You should call this after synthesizing your scan findings into a coherent understanding
of the codebase — architecture, conventions, patterns, and risks.

Provide an analysis summary. After calling this tool, you will enter CONVENTIONS state
where you will draft the full conventions document that will guide all subsequent phases.

Only call this from DISCOVERY/ANALYZE state.
`.trim()

export interface MarkAnalyzeCompleteResult {
  responseMessage: string
}

/**
 * Builds the response for mark_analyze_complete.
 */
export function processMarkAnalyzeComplete(args: MarkAnalyzeCompleteArgs): MarkAnalyzeCompleteResult {
  return {
    responseMessage: buildAnalyzeCompleteMessage(args.analysis_summary),
  }
}

function buildAnalyzeCompleteMessage(summary: string): string {
  return (
    `Analysis complete. Summary recorded:\n\n${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}\n\n` +
    `Transitioning to CONVENTIONS state. ` +
    `Now draft the full conventions document covering:\n` +
    `  1. Naming conventions (files, functions, types, variables)\n` +
    `  2. Architecture patterns and module structure\n` +
    `  3. Testing conventions and coverage expectations\n` +
    `  4. Code style rules inferred from the existing codebase\n` +
    `  5. Constraints and risks identified during analysis\n\n` +
    `When the conventions document is complete, call \`request_review\`.`
  )
}
