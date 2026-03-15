/**
 * utils.ts — Shared utilities that have no external dependencies.
 * Exported separately so they can be tested without importing the full plugin
 * (which requires @opencode-ai/plugin at runtime).
 */

/**
 * Maximum characters for conventions document injection.
 * Shared across system-transform.ts and compaction.ts to prevent divergence.
 * ~3000 tokens at ~4 chars/token.
 */
export const MAX_CONVENTIONS_CHARS = 12_000

/**
 * Maximum characters for discovery report injection.
 * Shared across system-transform.ts and compaction.ts to prevent divergence.
 * ~4000 tokens at ~4 chars/token.
 */
export const MAX_REPORT_CHARS = 16_000

/**
 * Wraps a promise with a timeout. Rejects with a descriptive error if the
 * promise does not settle within `ms` milliseconds.
 *
 * Used to guard subagent dispatch calls (discovery fleet, self-review) from
 * hanging indefinitely when an ephemeral session stalls or hangs.
 *
 * @param promise - The promise to race against the timeout
 * @param ms - Timeout in milliseconds
 * @param label - Human-readable label for the error message (e.g. "self-review")
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/**
 * Extracts text content from a client.session.prompt() result.
 *
 * v1 SDK returns: { data: { info: AssistantMessage, parts: Part[] }, request, response }
 * We extract the first TextPart (type === "text") from data.parts.
 *
 * Throws if no text can be extracted.
 *
 * @param result - Raw prompt result from client.session.prompt() (SDK envelope)
 * @param label  - Human-readable label for error messages (e.g. "self-review")
 */
export function extractTextFromPromptResult(result: unknown, label = "prompt"): string {
  if (!result || typeof result !== "object") throw new Error(`Empty ${label} result`)
  // v2 SDK returns { data: { info, parts: Part[] }, request, response }
  const r = result as Record<string, unknown>
  const data = (r["data"] ?? r) as Record<string, unknown>
  if (Array.isArray(data["parts"])) {
    for (const p of data["parts"] as Array<{ type?: string; text?: string }>) {
      if (p.type === "text" && typeof p.text === "string") return p.text
    }
  }
  throw new Error(`Cannot extract text from ${label} result: ${JSON.stringify(result).slice(0, 200)}`)
}

/**
 * Extracts a JSON object from a text string that may contain markdown code fences.
 *
 * The LLM sometimes wraps JSON in ```json ... ``` or ``` ... ``` blocks.
 * This helper strips those fences and returns the raw JSON string, ready for JSON.parse().
 *
 * Strategy (in order):
 *   1. Try to extract content from a ```json ... ``` or ``` ... ``` block
 *   2. Try to find a bare {...} block (the outermost braces)
 *   3. Return the original string as-is (let JSON.parse fail with a clear error)
 *
 * @param text - Raw LLM output text
 * @returns JSON string (without fences), suitable for JSON.parse()
 */
export function extractJsonFromText(text: string): string {
  // 1. Markdown code fence: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1].trim()

  // 2. Bare outermost braces
  const braceStart = text.indexOf("{")
  const braceEnd = text.lastIndexOf("}")
  if (braceStart !== -1 && braceEnd > braceStart) return text.slice(braceStart, braceEnd + 1)

  // 3. Fallback — return as-is
  return text.trim()
}

/**
 * Extracts a session ID from a client.session.create() response.
 *
 * v1 SDK returns: { data: Session, request, response } where Session has id: string.
 *
 * @param response - Raw response object from client.session.create() (SDK envelope)
 * @param label - Human-readable label for error messages
 * @returns The session ID string, or throws if not found
 */
export function extractEphemeralSessionId(response: unknown, label = "session"): string {
  if (!response || typeof response !== "object") throw new Error(`${label}: empty session.create() response`)
  // SDK returns { data: Session, request, response } where Session has id: string
  const r = response as Record<string, unknown>
  const data = (r["data"] ?? r) as Record<string, unknown>
  const id = data["id"] as string | undefined
  if (!id) throw new Error(`${label}: could not extract session ID from session.create() response`)
  return id
}

// ---------------------------------------------------------------------------
// Shared next-action mapping — single source of truth for compaction,
// idle-handler, and system-transform
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable instruction describing what the agent should do
 * in the given phase/sub-state. Used by compaction context, idle re-prompt,
 * and system prompt sub-state context to ensure consistent guidance.
 *
 * This is the single source of truth — compaction.ts, idle-handler.ts, and
 * system-transform.ts all delegate to this function.
 */
export function getNextActionForState(phase: string, phaseState: string): string {
  if (phase === "DONE") {
    return "The workflow is complete. All phases have been approved."
  }
  if (phase === "MODE_SELECT") {
    return "Present the three workflow modes to the user (GREENFIELD, REFACTOR, INCREMENTAL) and ask them to select one using the `select_mode` tool."
  }
  if (phaseState === "SCAN") {
    return "Continue scanning the codebase with read-only tools. Call `mark_scan_complete` when finished."
  }
  if (phaseState === "ANALYZE") {
    return "Continue analyzing scan results. Synthesize findings into a coherent picture of the codebase. Call `mark_analyze_complete` when analysis is complete."
  }
  if (phaseState === "DRAFT" || phaseState === "CONVENTIONS") {
    return `Continue drafting the ${phase} artifact. Review the acceptance criteria and ensure full coverage. Call \`request_review\` when complete.`
  }
  if (phaseState === "REVIEW") {
    return `Continue self-reviewing the ${phase} artifact against the acceptance criteria. Evaluate each criterion independently. Call \`mark_satisfied\` when done.`
  }
  if (phaseState === "USER_GATE") {
    return "The artifact is ready for user review. Present a clear summary to the user and WAIT for their response. Do not proceed until they respond."
  }
  if (phaseState === "REVISE") {
    return `Continue revising the ${phase} artifact based on the feedback. Make incremental changes only — do NOT rewrite from scratch. Call \`request_review\` when revision is complete.`
  }
  return `Continue working on the ${phase}/${phaseState} state.`
}

/**
 * Resolves the session ID from the tool execute context.
 *
 * The official OpenCode ToolContext type (@opencode-ai/plugin) uses `sessionID` (capital D).
 * We also probe legacy/alternative shapes for robustness.
 *
 * Priority order:
 *   1. context.sessionID  — official ToolContext shape (capital D)
 *   2. context.sessionId  — camelCase lowercase d (legacy)
 *   3. context.session.id — nested object shape
 *   4. context.session_id — snake_case
 *   5. context.id         — bare id fallback
 *
 * Exported for testability (G19).
 */
export function resolveSessionId(
  context: { directory?: string; sessionId?: string; sessionID?: string; session?: { id: string }; [key: string]: unknown },
): string | null {
  // Official ToolContext shape: sessionID (capital D)
  if (typeof context.sessionID === "string") return context.sessionID
  // Legacy/alternative shapes
  if (typeof context.sessionId === "string") return context.sessionId
  if (typeof context.session?.id === "string") return context.session.id
  const ctx = context as Record<string, unknown>
  const candidates = ["session_id", "id"]
  for (const key of candidates) {
    if (typeof ctx[key] === "string") return ctx[key] as string
  }
  return null
}
