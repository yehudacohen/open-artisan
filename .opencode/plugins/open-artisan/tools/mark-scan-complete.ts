/**
 * mark-scan-complete.ts — The `mark_scan_complete` tool definition.
 *
 * Called by the agent when it has finished scanning the codebase in
 * DISCOVERY/SCAN state. Fires the `scan_complete` event → transitions
 * to DISCOVERY/ANALYZE.
 */
import type { MarkScanCompleteArgs } from "../types"

// Re-export for test convenience
export type { MarkScanCompleteArgs }

export const MARK_SCAN_COMPLETE_DESCRIPTION = `
Call this tool when you have finished scanning the codebase in the DISCOVERY phase.

You should call this after completing a thorough read-only scan of the project structure,
including all source files, configuration, dependencies, and git history.

Provide a brief summary of what you found during the scan. After calling this tool,
you will enter ANALYZE state where you will synthesize your findings.

Only call this from DISCOVERY/SCAN state.
`.trim()

export interface MarkScanCompleteResult {
  responseMessage: string
}

/**
 * Builds the response for mark_scan_complete.
 */
export function processMarkScanComplete(args: MarkScanCompleteArgs): MarkScanCompleteResult {
  return {
    responseMessage: buildScanCompleteMessage(args.scan_summary),
  }
}

function buildScanCompleteMessage(summary: string): string {
  return (
    `Scan complete. Summary recorded:\n\n${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}\n\n` +
    `Transitioning to ANALYZE state. ` +
    `Now synthesize your scan findings into a coherent picture of the codebase — ` +
    `architecture, conventions, patterns, dependencies, and potential risks. ` +
    `When analysis is complete, call \`mark_analyze_complete\`.`
  )
}
