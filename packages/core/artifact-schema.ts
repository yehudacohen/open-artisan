/**
 * artifact-schema.ts — Public contract for parser-backed artifact prompt schemas.
 */

import type { Phase } from "./types"

export type ArtifactSchemaPhase = Extract<Phase, "PLANNING" | "IMPL_PLAN">

export interface ArtifactHeadingContract {
  heading: string
  required: boolean
  description: string
}

export interface ArtifactMetadataFieldContract {
  label: string
  required: boolean
  example: string
  description: string
}

export interface ArtifactPromptExample {
  title: string
  markdown: string
}

/**
 * Contract rendered into prompts so parser expectations are visible before review gates.
 */
export interface MachineValidatedArtifactSchema {
  phase: ArtifactSchemaPhase
  name: string
  parserSource: string
  headings: ArtifactHeadingContract[]
  metadataFields: ArtifactMetadataFieldContract[]
  examples: ArtifactPromptExample[]
}

/**
 * Result shape for rendering a schema block into system prompts or rubrics.
 */
export interface ArtifactSchemaPromptBlock {
  phase: ArtifactSchemaPhase
  markdown: string
}
