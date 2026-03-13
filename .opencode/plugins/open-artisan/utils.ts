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
 * The result shape varies by OpenCode version — this probes common shapes:
 *   1. { parts: [{ type: "text", text: "..." }] }
 *   2. { text: "..." }
 *   3. { content: "..." }
 *   4. { output: "..." }
 *
 * Throws if no text can be extracted.
 *
 * @param result - Raw prompt result from client.session.prompt()
 * @param label  - Human-readable label for error messages (e.g. "self-review")
 */
export function extractTextFromPromptResult(result: unknown, label = "prompt"): string {
  if (!result || typeof result !== "object") throw new Error(`Empty ${label} result`)
  const r = result as Record<string, unknown>
  if (Array.isArray(r["parts"])) {
    for (const p of r["parts"] as Array<{ type?: string; text?: string }>) {
      if (p.type === "text" && typeof p.text === "string") return p.text
    }
  }
  if (typeof r["text"] === "string") return r["text"]
  if (typeof r["content"] === "string") return r["content"]
  if (typeof r["output"] === "string") return r["output"]
  throw new Error(`Cannot extract text from ${label} result: ${JSON.stringify(result).slice(0, 200)}`)
}

/**
 * Extracts a session ID from a client.session.create() response.
 *
 * Probes common SDK response shapes:
 *   1. { id: "..." }
 *   2. { sessionId: "..." }
 *   3. { session_id: "..." }
 *
 * @param response - Raw response object from client.session.create()
 * @param label - Human-readable label for error messages
 * @returns The session ID string, or throws if not found
 */
export function extractEphemeralSessionId(response: unknown, label = "session"): string {
  if (!response || typeof response !== "object") throw new Error(`${label}: empty session.create() response`)
  const r = response as Record<string, unknown>
  const id = (r["id"] as string | undefined) ??
    (r["sessionId"] as string | undefined) ??
    (r["session_id"] as string | undefined)
  if (!id) throw new Error(`${label}: could not extract session ID from session.create() response`)
  return id
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
