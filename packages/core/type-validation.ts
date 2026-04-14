/**
 * Type validation helpers to replace unsafe type assertions
 */

export interface PriorState {
  intentBaseline: string | null
  phase: string
  artifactDiskPaths: Record<string, string>
  approvedArtifacts?: Record<string, string>
}

/**
 * Validate and extract prior state from unknown data
 * @param state - Unknown state object to validate
 * @returns Validated PriorState or null if invalid
 */
export function validatePriorState(state: unknown): PriorState | null {
  if (!state || typeof state !== "object") return null

  const s = state as Record<string, unknown>

  // Validate required fields
  const intentBaseline = s.intentBaseline === null || typeof s.intentBaseline === "string" 
    ? s.intentBaseline 
    : null

  const phase = typeof s.phase === "string" ? s.phase : "UNKNOWN"

  const artifactDiskPaths = 
    s.artifactDiskPaths && typeof s.artifactDiskPaths === "object" && !Array.isArray(s.artifactDiskPaths)
      ? (s.artifactDiskPaths as Record<string, unknown>)
      : {}

  // Validate artifactDiskPaths values are strings
  const validatedPaths: Record<string, string> = {}
  for (const [key, value] of Object.entries(artifactDiskPaths)) {
    if (typeof value === "string") {
      validatedPaths[key] = value
    }
  }

  // Validate approvedArtifacts (optional field)
  const approvedArtifacts = 
    s.approvedArtifacts && typeof s.approvedArtifacts === "object" && !Array.isArray(s.approvedArtifacts)
      ? (s.approvedArtifacts as Record<string, unknown>)
      : undefined

  const validatedApprovedArtifacts: Record<string, string> = {}
  if (approvedArtifacts) {
    for (const [key, value] of Object.entries(approvedArtifacts)) {
      if (typeof value === "string") {
        validatedApprovedArtifacts[key] = value
      }
    }
  }

  return {
    intentBaseline,
    phase,
    artifactDiskPaths: validatedPaths,
    ...(approvedArtifacts ? { approvedArtifacts: validatedApprovedArtifacts } : {}),
  }
}

/**
 * Extract session ID from session creation response
 * @param response - Unknown response object
 * @returns Session ID string or null if not found
 */
export function extractSessionId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null

  const r = response as Record<string, unknown>

  // Try direct id field
  if (typeof r.id === "string") return r.id

  // Try data.id field
  if (r.data && typeof r.data === "object") {
    const data = r.data as Record<string, unknown>
    if (typeof data.id === "string") return data.id
  }

  return null
}

/**
 * Extract text from LLM response
 * @param response - Unknown response object
 * @returns Text string or null if not found
 */
export function extractLLMText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null

  const r = response as Record<string, unknown>

  // Try direct text field
  if (typeof r.text === "string") return r.text

  // Try data.text field
  if (r.data && typeof r.data === "object") {
    const data = r.data as Record<string, unknown>

    if (typeof data.text === "string") return data.text

    // Try data.parts[0].text field
    if (Array.isArray(data.parts) && data.parts.length > 0) {
      const firstPart = data.parts[0]
      if (firstPart && typeof firstPart === "object") {
        const part = firstPart as Record<string, unknown>
        if (typeof part.text === "string") return part.text
      }
    }
  }

  return null
}
