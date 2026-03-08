/**
 * utils.ts — Shared utilities that have no external dependencies.
 * Exported separately so they can be tested without importing the full plugin
 * (which requires @opencode-ai/plugin at runtime).
 */

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
