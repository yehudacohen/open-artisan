/**
 * Shared LLM-based intent comparison logic
 * 
 * Used by check_prior_workflow and select_mode to determine if a prior workflow
 * covers the current user request (FULL/PARTIAL/DIFFERENT).
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import type { SubagentDispatcher } from "./subagent-dispatcher"
import { withTimeout } from "./utils"
import {
  MAX_PRIOR_INTENT_CHARS,
  MAX_SCOPE_DISPLAY_CHARS,
  MAX_SCOPE_CONTEXT_CHARS
} from "./constants"

/** Timeout for the intent comparison LLM call. */
const INTENT_COMPARISON_TIMEOUT_MS = 60_000

export interface IntentComparisonResult {
  classification: "FULL" | "PARTIAL" | "DIFFERENT" | "ERROR"
  explanation: string
  rawResponse: string
}

export interface IntentComparisonInput {
  currentIntent: string
  priorIntent: string
  priorPlanPath?: string
  dispatcher: SubagentDispatcher
  parentModel?: string | { modelID: string; providerID?: string }
}

// ---------------------------------------------------------------------------
// Ephemeral session helper (consistent with all other subagent modules)
// ---------------------------------------------------------------------------

async function ephemeralIntentCheckPrompt(
  dispatcher: SubagentDispatcher,
  prompt: string,
  parentModel?: string | { modelID: string; providerID?: string },
): Promise<string> {
  const session = await dispatcher.createSession({
    title: "intent-check",
    agent: "workflow-reviewer",
    model: parentModel,
  })
  try {
    return await session.prompt(prompt)
  } finally {
    await session.destroy()
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compare current and prior intents using LLM semantic analysis.
 *
 * @param input - Current intent, prior intent, optional plan path, and dispatcher
 * @returns Classification (FULL/PARTIAL/DIFFERENT/ERROR) with explanation
 */
export async function compareIntentsWithLLM(
  input: IntentComparisonInput
): Promise<IntentComparisonResult> {
  const { currentIntent, priorIntent, priorPlanPath, dispatcher, parentModel } = input

  // Read prior plan for scope context
  let priorScope = ""
  if (priorPlanPath && existsSync(priorPlanPath)) {
    try {
      const planContent = await readFile(priorPlanPath, "utf-8")
      priorScope = planContent.slice(0, MAX_SCOPE_DISPLAY_CHARS)
    } catch {
      priorScope = "(plan file not readable)"
    }
  }

  const comparisonPrompt = buildComparisonPrompt(currentIntent, priorIntent, priorScope)

  let llmResult = "ERROR: Could not compare intents"
  try {
    const text = await withTimeout(
      ephemeralIntentCheckPrompt(dispatcher, comparisonPrompt, parentModel),
      INTENT_COMPARISON_TIMEOUT_MS,
      "intent-comparison",
    )
    llmResult = text || "ERROR: Empty response"
  } catch (llmErr) {
    llmResult = `ERROR: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`
  }

  return parseIntentComparisonResponse(llmResult)
}

/**
 * Build the LLM comparison prompt with consistent formatting
 */
function buildComparisonPrompt(
  currentIntent: string,
  priorIntent: string,
  priorScope: string
): string {
  return `You are a workflow intent matcher. Your job is to determine if a prior workflow covers what the user is now asking for.

Current user request:
"${currentIntent.slice(0, MAX_PRIOR_INTENT_CHARS)}"

Prior workflow goal (from prior session):
"${priorIntent.slice(0, MAX_PRIOR_INTENT_CHARS)}"

${priorScope ? `Prior plan scope (first ${MAX_SCOPE_CONTEXT_CHARS} chars):
${priorScope.slice(0, MAX_SCOPE_CONTEXT_CHARS)}
` : ""}

First, determine if these are the SAME goal or a DIFFERENT goal.
Second, if SAME, determine if the prior workflow FULLY covers the current request or only PARTIALLY covers it.

Respond with exactly one line:
- If DIFFERENT: "DIFFERENT: <one sentence explaining why>"
- If SAME but PARTIAL: "PARTIAL: <one sentence explaining what the prior workflow covered and what's missing>"
- If SAME and FULL: "FULL: <one sentence confirming the prior workflow covers everything>"

Examples:
- "DIFFERENT: One is about billing, the other is about user profiles"
- "PARTIAL: Prior workflow added OAuth, but current request also wants email login"
- "FULL: Prior workflow added OAuth and the current request is just to add password reset"

Respond now:`
}

/**
 * Parse LLM response into structured result
 */
function parseIntentComparisonResponse(llmResult: string): IntentComparisonResult {
  const response = llmResult.trim().toUpperCase()
  const isError = response.startsWith("ERROR:")
  const isDifferent = response.startsWith("DIFFERENT:")
  const isPartial = response.startsWith("PARTIAL:")
  const isFull = response.startsWith("FULL:")

  // Extract explanation (text after the classification prefix)
  const explanation = llmResult.replace(/^(DIFFERENT|PARTIAL|FULL|ERROR):/i, "").trim()

  // CRITICAL: Check for ERROR first before treating as FULL
  if (isError) {
    return {
      classification: "ERROR",
      explanation,
      rawResponse: llmResult,
    }
  } else if (isDifferent) {
    return {
      classification: "DIFFERENT",
      explanation,
      rawResponse: llmResult,
    }
  } else if (isPartial) {
    return {
      classification: "PARTIAL",
      explanation,
      rawResponse: llmResult,
    }
  } else if (isFull) {
    return {
      classification: "FULL",
      explanation,
      rawResponse: llmResult,
    }
  } else {
    // Unrecognized response format - treat as ERROR for safety
    return {
      classification: "ERROR",
      explanation: `Unrecognized response format: ${llmResult}`,
      rawResponse: llmResult,
    }
  }
}
