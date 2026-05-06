/**
 * open-artisan-json-compat.ts — JSON import/export seam for the DB runtime.
 *
 * The next major runtime uses the database as canonical state. These helpers
 * define the compatibility boundary for best-effort imports from legacy
 * workflow-state.json files and exports back to the old shape for debugging.
 */

import {
  type DbRecordId,
  type JsonWorkflowImportResult,
  type OpenArtisanDbResult,
  type OpenArtisanRepository,
} from "./open-artisan-repository"
import type { WorkflowState } from "./workflow-state-types"

export interface LegacyWorkflowImportOptions {
  /** When true, tolerate repairable legacy inconsistencies and report warnings. */
  bestEffort: boolean
  /** Optional source path used only for diagnostics/provenance. */
  sourcePath?: string
}

export interface LegacyWorkflowExportOptions {
  /** Include derived debug-only fields when exporting the compatibility JSON. */
  includeDebugProjections?: boolean
}

export async function importLegacyWorkflowState(
  repo: OpenArtisanRepository,
  state: WorkflowState,
  _options: LegacyWorkflowImportOptions = { bestEffort: true },
): Promise<OpenArtisanDbResult<JsonWorkflowImportResult>> {
  return repo.importWorkflowState(state)
}

export async function exportLegacyWorkflowState(
  repo: OpenArtisanRepository,
  workflowId: DbRecordId,
  _options: LegacyWorkflowExportOptions = {},
): Promise<OpenArtisanDbResult<WorkflowState>> {
  return repo.exportWorkflowState(workflowId)
}
