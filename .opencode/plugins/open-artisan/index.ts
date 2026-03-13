/**
 * index.ts — Main plugin entry point for the open-artisan plugin.
 *
 * Registers all hooks and custom tools with the OpenCode plugin runtime.
 * Uses the @opencode-ai/plugin package (provided by OpenCode at runtime).
 *
 * Architecture overview:
 * - SessionStateStore: per-session WorkflowState, persisted to .opencode/workflow-state.json
 * - StateMachine: pure transition function for state changes
 * - Hooks: system-transform (+ USER_GATE hint injection), tool-guard, idle-handler, compaction
 * - Tools: select_mode, mark_scan_complete, mark_analyze_complete,
 *          mark_satisfied, request_review, submit_feedback
 *
 * Integration notes:
 * - G6 fix: chat-message approval hint is injected via system-transform (no chat.message hook in API)
 * - G7 fix: detectMode runs on session.created and result is prepended to the initial system prompt
 * - G19 fix: resolveSessionId is exported for testability
 *
 * Correct OpenCode plugin export shape (from https://opencode.ai/docs/plugins):
 *   export const MyPlugin = async ({ project, client, $, directory, worktree }) => { ... }
 * Hooks are flat top-level keys. Tools use "tool" (singular) with tool() helper and tool.schema.*.
 */

// @ts-ignore — @opencode-ai/plugin is provided by the OpenCode runtime, not installed as a dev dep
import { tool, type Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { $ } from "bun"

import { createSessionStateStore } from "./session-state"
import { createStateMachine } from "./state-machine"
import { getPhaseToolPolicy } from "./hooks/tool-guard"
import { buildWorkflowSystemPrompt } from "./hooks/system-transform"
import { buildUserGateHint, processUserMessage } from "./hooks/chat-message"
import { handleIdle } from "./hooks/idle-handler"
import { buildCompactionContext } from "./hooks/compaction"
import { createGitCheckpoint } from "./hooks/git-checkpoint"
import { detectMode } from "./mode-detect"

// Tool handlers
import { parseSelectModeArgs, buildSelectModeResponse } from "./tools/select-mode"
import { processMarkScanComplete } from "./tools/mark-scan-complete"
import { processMarkAnalyzeComplete } from "./tools/mark-analyze-complete"
import { evaluateMarkSatisfied, countExpectedBlockingCriteria } from "./tools/mark-satisfied"
import { processRequestReview } from "./tools/request-review"
import { processSubmitFeedback } from "./tools/submit-feedback"
import { processMarkTaskComplete } from "./tools/mark-task-complete"

// Orchestrator (Layer 2)
import { createOrchestrator } from "./orchestrator/route"
import { createArtifactGraph, PHASE_TO_ARTIFACT } from "./artifacts"
import { createAssessFn, createDivergeFn } from "./orchestrator/llm-calls"
import { handleEscapeHatch, handleCascade, handleNormalRevise } from "./tools/submit-feedback-handlers"
import { dispatchSelfReview } from "./self-review"
import { getAcceptanceCriteria } from "./hooks/system-transform"
import { runDiscoveryFleet } from "./discovery/index"
import { parseImplPlan } from "./impl-plan-parser"
import { resolveArtifactPaths } from "./tools/artifact-paths"

import { createHash } from "node:crypto"
import type { WorkflowMode, ArtifactKey, RevisionStep } from "./types"
import { VALID_PHASE_STATES } from "./types"
import { resolveSessionId } from "./utils"

/** Returns a 16-char SHA-256 hex fingerprint of the given text. */
function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

// Re-export for consumers who import from index.ts (G19)
export { resolveSessionId }

/**
 * Names of all custom workflow control tools.
 * The tool guard must never block these regardless of phase — they are the
 * mechanism by which the agent signals state transitions.
 * Defined as a module constant so adding a new tool cannot be silently missed.
 */
export const WORKFLOW_TOOL_NAMES = new Set([
  "select_mode",
  "mark_scan_complete",
  "mark_analyze_complete",
  "mark_satisfied",
  "mark_task_complete",
  "request_review",
  "submit_feedback",
])

/**
 * Maximum number of self_review_fail loops before escalating to USER_GATE.
 * Prevents the agent from spinning indefinitely in REVIEW when it cannot
 * resolve a blocking criterion on its own. After this many failures, the
 * user gate is forced so the user can provide direction.
 */
export const MAX_REVIEW_ITERATIONS = 5

// ---------------------------------------------------------------------------
// Plugin export — correct OpenCode plugin API shape
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OpenArtisanPlugin: Plugin = async ({ client }: { client: any }) => {
  // Plugin init — runs at plugin startup before the return.
  // Load persisted state from disk so sessions survive restarts.
  const stateDir = join(import.meta.dirname, "..", "..")  // .opencode/
  const store = createSessionStateStore(stateDir)
  const sm = createStateMachine()

  // Layer 2: Orchestrator — wires LLM-backed assess + diverge into the routing logic.
  // The graph and orchestrator are shared across sessions (stateless pure functions).
  const graph = createArtifactGraph()
  const orchestrator = createOrchestrator({
    assess: createAssessFn(client),
    diverge: createDivergeFn(client),
    graph,
  })

  // Load persisted state on plugin startup (replaces the defunct "session.started" hook)
  await store.load()

  return {
    // -------------------------------------------------------------------------
    // event hook — handles session lifecycle events and idle re-prompts
    // -------------------------------------------------------------------------

    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      // Session created: initialize fresh workflow state.
      // SDK type: { type: "session.created", properties: { info: Session } }
      // The session ID lives at properties.info.id
      if (event.type === "session.created") {
        const info = event.properties?.["info"] as { id?: string } | undefined
        const sessionId = info?.id
        if (!sessionId) return
        try {
          await store.create(sessionId)
        } catch {
          // Already exists from a previous load — no-op
        }

        // G7: Run mode detection and store in the dedicated modeDetectionNote field.
        // This is separate from intentBaseline (which holds the user's actual task).
        // modeDetectionNote is shown in the MODE_SELECT system prompt only.
        try {
          const cwd = (info as any)?.path?.cwd ?? (info as any)?.path ?? process.cwd()
          const detectionResult = await detectMode(typeof cwd === "string" ? cwd : process.cwd())
          await store.update(sessionId, (draft) => {
            draft.modeDetectionNote = buildModeDetectionNote(detectionResult)
          })
        } catch {
          // Non-fatal — mode detection is advisory only
        }
        return
      }

      // Session deleted: clean up state.
      // SDK type: { type: "session.deleted", properties: { info: Session } }
      if (event.type === "session.deleted") {
        const info = event.properties?.["info"] as { id?: string } | undefined
        const sessionId = info?.id
        if (sessionId) await store.delete(sessionId)
        return
      }

      // Session idle: re-prompt if agent stopped prematurely.
      // SDK type: { type: "session.idle", properties: { sessionID: string } }
      if (event.type === "session.idle") {
        const sessionId = (
          (event.properties?.["sessionID"] as string | undefined) ??
          (event.properties?.["sessionId"] as string | undefined) ??
          (event.properties?.["session_id"] as string | undefined)
        )
        if (!sessionId) return

        const state = store.get(sessionId)
        if (!state) return

        const decision = handleIdle(state)
        if (decision.action === "ignore") return

        if (decision.action === "escalate") {
          // Best-effort toast notification; ignore if client API differs
          try {
            await (client as any).tui?.showToast?.({
              body: { title: "Workflow Stalled", message: decision.message, variant: "warning" },
            })
          } catch { /* ignore */ }
          return
        }

        // Reprompt — only increment retry count AFTER the prompt succeeds,
        // so failed prompts don't consume retry budget.
        try {
          await (client as any).session?.prompt({
            path: { id: sessionId },
            body: {
              noReply: false,
              parts: [{ type: "text", text: decision.message }],
            },
          })
          await store.update(sessionId, (draft) => {
            draft.retryCount = decision.retryCount
          })
        } catch { /* ignore if API shape differs */ }
      }
    },

    // -------------------------------------------------------------------------
    // chat.message hook — official OpenCode API for intercepting user messages.
    // Two responsibilities:
    //   1. Capture the first user message as intentBaseline (for O_DIVERGE later)
    //   2. At USER_GATE, inject routing instructions so the agent knows whether to
    //      call submit_feedback with approve or revise.
    // The sessionID comes from the extended input shape (the core passes extra fields).
    // -------------------------------------------------------------------------

    "chat.message": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string; [key: string]: unknown },
      output: { message: { sessionID?: string; sessionId?: string }; parts: Array<{ type: string; text?: string }> },
    ) => {
      // Resolve sessionID — probe all casing variants the SDK may use
      const sessionId = (
        (input.sessionID as string | undefined) ??
        (input.sessionId as string | undefined) ??
        (input.session_id as string | undefined) ??
        (output.message?.sessionID as string | undefined) ??
        (output.message?.sessionId as string | undefined)
      )
      if (!sessionId) return
      const state = store.get(sessionId)
      if (!state) return

      // Capture first real user message as intent baseline (for O_DIVERGE later).
      // intentBaseline is null until the first real user message arrives.
      // After capture, only O_INTENT_UPDATE (in the escape hatch path) may update it.
      if (!state.intentBaseline) {
        const textContent = (output.parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!)
          .join(" ")
          .trim()
        if (textContent) {
          await store.update(sessionId, (draft) => {
            if (!draft.intentBaseline) {
              draft.intentBaseline = textContent.slice(0, 2000)
            }
          })
        }
      }

      // Only inject routing hint at USER_GATE
      if (state.phaseState !== "USER_GATE") return

      const result = processUserMessage(state, output.parts as Array<{ type: string; text?: string }>)
      if (result.intercepted) {
        // Prepend routing note to parts
        output.parts.splice(0, 0, ...result.parts.slice(0, 1))
      }
    },

    // -------------------------------------------------------------------------
     // System prompt injection via experimental transform.
     // Injects the phase header + phase-specific prompt + sub-state context.
     // At USER_GATE also appends the routing hint for the agent.
     // -------------------------------------------------------------------------

    "experimental.chat.system.transform": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string; model?: unknown },
      output: { system: string[] },
    ) => {
      const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
      if (!sessionId) return
      const state = store.get(sessionId)
      if (!state) return

      const promptBlock = buildWorkflowSystemPrompt(state)
      // Prepend the workflow block before existing system parts
      output.system.unshift(promptBlock)

      // At USER_GATE, append a routing hint as an additional system block
      if (state.phaseState === "USER_GATE") {
        const hint = buildUserGateHint(state.phase, state.phaseState)
        output.system.push(hint)
      }
    },

    // -------------------------------------------------------------------------
    // Tool guard — phase-gated tool restrictions
    // -------------------------------------------------------------------------

    "tool.execute.before": async (input: { sessionID?: string; sessionId?: string; session_id?: string; tool: string; args?: Record<string, unknown> }) => {
      const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
      if (!sessionId) return
      const state = store.get(sessionId)
      if (!state) return

      // Never block our own workflow tools regardless of phase — they are the
      // only way the agent can signal state transitions.
      if (WORKFLOW_TOOL_NAMES.has(input.tool)) return

      const policy = getPhaseToolPolicy(
        state.phase,
        state.phaseState,
        state.mode,
        state.fileAllowlist,
      )

      const toolName = input.tool.toLowerCase()

      // Check blocked tools (substring match — catches "file_write", "bash_exec", etc.)
      if (policy.blocked.some((blocked) => toolName.includes(blocked))) {
        throw new Error(
          `[Workflow] Tool "${input.tool}" is blocked in ${state.phase}/${state.phaseState}. ` +
          `Allowed: ${policy.allowedDescription}`,
        )
      }

      // Check bash command predicate (INCREMENTAL mode: block file-write operators)
      if (policy.bashCommandPredicate && toolName.includes("bash")) {
        const command = (input.args?.["command"] ?? input.args?.["cmd"] ?? input.args?.["script"] ?? "") as string
        if (command && !policy.bashCommandPredicate(command)) {
          throw new Error(
            `[Workflow] Bash command blocked in INCREMENTAL mode — file-write operators (>, >>, tee, sed -i) are not allowed. ` +
            `Use write/edit tools instead so the file allowlist can be enforced.`,
          )
        }
      }

      // Check write path predicate for write/edit tools.
      // Catches: write, edit, patch, create, overwrite, and any namespaced variants
      // (file_write, write_file, str_replace_editor, apply_patch, etc.)
      const WRITE_LIKE_TOKENS = ["write", "edit", "patch", "create", "overwrite"]
      if (policy.writePathPredicate && WRITE_LIKE_TOKENS.some((t) => toolName.includes(t))) {
        // Probe all common argument names used by different tool implementations
        const filePath = (
          input.args?.["filePath"] ??
          input.args?.["path"] ??
          input.args?.["file"] ??
          input.args?.["filename"] ??
          input.args?.["target"] ??
          input.args?.["destination"]
        ) as string | undefined
        if (filePath && !policy.writePathPredicate(filePath)) {
          throw new Error(
            `[Workflow] Writing to "${filePath}" is blocked in ${state.phase}/${state.phaseState}. ` +
            `${policy.allowedDescription}`,
          )
        }
      }
    },

    // -------------------------------------------------------------------------
    // Compaction resilience — preserve state across context window reductions
    // -------------------------------------------------------------------------

    "experimental.session.compacting": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string },
      output: { context?: string[] },
    ) => {
      const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
      if (!sessionId) return
      const state = store.get(sessionId)
      if (!state) return

      const contextBlock = buildCompactionContext(state)
      // Ensure output.context exists — runtime may not initialize it
      output.context ??= []
      output.context.push(contextBlock)
    },

    // -------------------------------------------------------------------------
    // Custom tools — "tool" (singular) with tool() helper and tool.schema.*
    // -------------------------------------------------------------------------

    tool: {
      // -----------------------------------------------------------------------
      // select_mode — first call in every session
      // -----------------------------------------------------------------------
      select_mode: tool({
        description:
          "Select the workflow mode: GREENFIELD (new project, skips discovery), " +
          "REFACTOR (restructure existing project, runs discovery), " +
          "or INCREMENTAL (add/fix specific functionality, runs discovery, do-no-harm).",
        args: {
          mode: tool.schema.enum(["GREENFIELD", "REFACTOR", "INCREMENTAL"]).describe(
            "The workflow mode to use for this session.",
          ),
        },
        async execute(args: { mode: string }, context: { directory: string; sessionId?: string; session?: { id: string } }) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = store.get(sessionId)
          if (!state) return "Error: No workflow state for this session."

          if (state.phase !== "MODE_SELECT") {
            return `Error: Mode already selected (current phase: ${state.phase}).`
          }

          const parsed = parseSelectModeArgs(args)
          if ("error" in parsed) return `Error: ${parsed.error}`

          const mode = parsed.mode as WorkflowMode
          const outcome = sm.transition(state.phase, state.phaseState, "mode_selected", mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          await store.update(sessionId, (draft) => {
            draft.mode = mode
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.iterationCount = 0
            draft.retryCount = 0
          })

          return buildSelectModeResponse(mode)
        },
      }),

      // -----------------------------------------------------------------------
      // mark_scan_complete — signals end of DISCOVERY/SCAN
      // -----------------------------------------------------------------------
      mark_scan_complete: tool({
        description:
          "Call when you have finished scanning the codebase in DISCOVERY/SCAN state. " +
          "Transitions to DISCOVERY/ANALYZE.",
        args: {
          scan_summary: tool.schema.string().describe(
            "Brief summary of what was scanned and key observations.",
          ),
        },
        async execute(args: { scan_summary: string }, context: { directory: string; sessionId?: string; session?: { id: string } }) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = store.get(sessionId)
          if (!state) return "Error: No workflow state for this session."

          if (state.phase !== "DISCOVERY" || state.phaseState !== "SCAN") {
            return `Error: mark_scan_complete can only be called in DISCOVERY/SCAN (current: ${state.phase}/${state.phaseState}).`
          }

          const outcome = sm.transition(state.phase, state.phaseState, "scan_complete", state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.retryCount = 0
          })

          const result = processMarkScanComplete(args)
          return result.responseMessage
        },
      }),

      // -----------------------------------------------------------------------
      // mark_analyze_complete — signals end of DISCOVERY/ANALYZE
      // -----------------------------------------------------------------------
      mark_analyze_complete: tool({
        description:
          "Call when you have finished analyzing scan results in DISCOVERY/ANALYZE state. " +
          "Transitions to DISCOVERY/CONVENTIONS where you will draft the conventions document.",
        args: {
          analysis_summary: tool.schema.string().describe(
            "Brief summary of what was analyzed and key architectural/convention findings.",
          ),
        },
        async execute(args: { analysis_summary: string }, context: { directory: string; sessionId?: string; session?: { id: string } }) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = store.get(sessionId)
          if (!state) return "Error: No workflow state for this session."

          if (state.phase !== "DISCOVERY" || state.phaseState !== "ANALYZE") {
            return `Error: mark_analyze_complete can only be called in DISCOVERY/ANALYZE (current: ${state.phase}/${state.phaseState}).`
          }

          const outcome = sm.transition(state.phase, state.phaseState, "analyze_complete", state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          // Layer 3 — Discovery fleet: dispatch 6 parallel scanner subagents.
          // This runs BEFORE the state transition so the report is available
          // immediately in the CONVENTIONS phase system prompt.
          // Fleet runs only in REFACTOR/INCREMENTAL modes (GREENFIELD skips discovery).
          let fleetMsg = ""
          let fleetReport: string | null = null
          if (state.mode === "REFACTOR" || state.mode === "INCREMENTAL") {
            try {
              const cwd = context.directory || process.cwd()
              const report = await runDiscoveryFleet(client, cwd, state.mode)
              fleetReport = report.combinedReport
              const successCount = report.scanners.filter((s) => s.success).length
              fleetMsg = `\n\n**Discovery fleet:** ${successCount}/${report.scanners.length} scanners completed.`
            } catch {
              // Non-fatal — fleet failure does not block conventions drafting
              fleetMsg = "\n\n**Discovery fleet:** Failed to run (non-fatal). Conventions draft will proceed without fleet input."
            }
          }

          // Single atomic update: phase transition + fleet report together
          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.retryCount = 0
            if (fleetReport !== null) {
              draft.discoveryReport = fleetReport
            }
          })

          const result = processMarkAnalyzeComplete(args)
          return result.responseMessage + fleetMsg
        },
      }),

      // -----------------------------------------------------------------------
      // mark_satisfied — self-review completion signal
      // -----------------------------------------------------------------------
      mark_satisfied: tool({
        description:
          "Call after completing self-review. Provide assessment of each criterion. " +
          "If all blocking criteria are met, advances to user gate. " +
          "If any blocking criterion is unmet, stays in REVIEW for continued work. " +
          "Suggestion-severity criteria are advisory and do not block advancement.",
        args: {
          criteria_met: tool.schema
            .array(
              tool.schema.object({
                criterion: tool.schema.string(),
                met: tool.schema.boolean(),
                evidence: tool.schema.string(),
                severity: tool.schema
                  .enum(["blocking", "suggestion"])
                  .optional()
                  .describe("Defaults to 'blocking'. Use 'suggestion' for advisory-only criteria."),
              }),
            )
            .describe("Assessment of each acceptance criterion."),
        },
        async execute(
          args: { criteria_met: Array<{ criterion: string; met: boolean; evidence: string; severity?: "blocking" | "suggestion" }> },
          context: { directory: string; sessionId?: string; session?: { id: string } },
        ) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = store.get(sessionId)
          if (!state) return "Error: No workflow state for this session."

          if (state.phaseState !== "REVIEW") {
            return `Error: mark_satisfied can only be called in REVIEW state (current: ${state.phaseState}).`
          }

          // Layer 3: Dispatch isolated reviewer subagent.
          // The reviewer runs in a fresh ephemeral session that sees ONLY the
          // artifact files and acceptance criteria — never the authoring conversation.
          // This eliminates anchoring bias. If the reviewer call fails, fall back
          // to the agent's self-reported criteria (graceful degradation).
          const criteriaText = getAcceptanceCriteria(state.phase, state.phaseState, state.mode)
          const expectedBlocking = countExpectedBlockingCriteria(criteriaText)
          let result = evaluateMarkSatisfied(args, expectedBlocking) // fallback baseline (agent self-report)

          if (criteriaText) {
            const artifactPaths = resolveArtifactPaths(
              state.phase,
              state.mode,
              context.directory || process.cwd(),
              state.fileAllowlist,
            )
            // For in-memory artifact phases (DISCOVERY, PLANNING, IMPL_PLAN), pass
            // artifact content directly so the isolated reviewer can evaluate it.
            // DISCOVERY: conventions text is in state.conventions.
            // PLANNING/IMPL_PLAN: artifact text is not captured — reviewer will
            // evaluate structurally (marking criteria as unmet if evidence is missing).
            let artifactContent: string | undefined
            if (state.phase === "DISCOVERY" && state.conventions) {
              artifactContent = state.conventions
            }

            let reviewResult: Awaited<ReturnType<typeof dispatchSelfReview>> | null = null
            try {
              reviewResult = await dispatchSelfReview(client, {
                phase: state.phase,
                mode: state.mode,
                artifactPaths,
                criteriaText,
                ...(state.conventions ? { upstreamSummary: state.conventions } : {}),
                ...(artifactContent ? { artifactContent } : {}),
              })
            } catch {
              // dispatchSelfReview should never throw (returns SelfReviewError),
              // but guard against unexpected runtime failures. Fall through to
              // use the agent's self-report as baseline.
            }

            if (reviewResult?.success) {
              // Isolated reviewer succeeded — use its verdict as authoritative truth.
              // Re-evaluate using the reviewer's criteria_results (same logic as agent path).
              // Pass expectedBlocking for cross-validation (same anti-gaming check as agent path).
              result = evaluateMarkSatisfied({
                criteria_met: reviewResult.criteriaResults.map((c) => ({
                  criterion: c.criterion,
                  met: c.met,
                  evidence: c.evidence,
                  severity: c.severity,
                })),
              }, expectedBlocking)
            }
            // If reviewResult.success === false, result keeps the agent's self-report (fallback)
          }

          // Iteration cap: if self-review has failed MAX_REVIEW_ITERATIONS times
          // already, escalate to USER_GATE instead of looping again. The user can
          // provide direction that the agent cannot resolve autonomously.
          const nextIterationCount = result.passed ? 0 : state.iterationCount + 1
          const hitIterationCap = !result.passed && nextIterationCount >= MAX_REVIEW_ITERATIONS

          // Force escalation to USER_GATE if cap reached (M12: dedicated escalate_to_user event).
          const event = result.passed ? "self_review_pass" : hitIterationCap ? "escalate_to_user" : "self_review_fail"
          const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.iterationCount = nextIterationCount
            draft.retryCount = 0
          })

          if (hitIterationCap) {
            const unmetList = result.unmetCriteria.map((c) => `  - ${c.criterion}: ${c.evidence}`).join("\n")
            return (
              `Self-review reached the maximum of ${MAX_REVIEW_ITERATIONS} iterations without resolving all blocking criteria.\n\n` +
              `**Unresolved blocking criteria:**\n${unmetList}\n\n` +
              `Escalating to user gate. Present the artifact and the unresolved issues to the user for direction.`
            )
          }

          return result.responseMessage
        },
      }),

      // -----------------------------------------------------------------------
      // mark_task_complete — closes the DAG feedback loop in IMPLEMENTATION
      // -----------------------------------------------------------------------
      mark_task_complete: tool({
        description:
          "Call after completing a DAG implementation task and verifying its tests pass. " +
          "Updates the task status in the implementation DAG and returns the next task to implement, " +
          "or signals that all tasks are complete (triggering final review).",
        args: {
          task_id: tool.schema.string().describe(
            "The DAG task ID that was just completed (e.g. 'T1', 'auth-service'). " +
            "Must exactly match an ID in the approved implementation plan.",
          ),
          implementation_summary: tool.schema.string().describe(
            "Brief summary of what was implemented for this task.",
          ),
          tests_passing: tool.schema.boolean().describe(
            "Set to true only if all expected tests for this task are passing. " +
            "If false, fix the failing tests before calling this tool.",
          ),
        },
        async execute(
          args: { task_id: string; implementation_summary: string; tests_passing: boolean },
          context: { directory: string; sessionId?: string; session?: { id: string } },
        ) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = store.get(sessionId)
          if (!state) return "Error: No workflow state for this session."

          if (state.phase !== "IMPLEMENTATION") {
            return `Error: mark_task_complete can only be called during the IMPLEMENTATION phase (current: ${state.phase}).`
          }

          if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
            return `Error: mark_task_complete can only be called in DRAFT or REVISE state (current: ${state.phase}/${state.phaseState}).`
          }

          const result = processMarkTaskComplete(args, state.implDag, state.currentTaskId)

          if ("error" in result) return `Error: ${result.error}`

          // Persist the updated DAG and set currentTaskId to the next dispatched task
          await store.update(sessionId, (draft) => {
            draft.implDag = result.updatedNodes
            draft.currentTaskId = result.nextTaskId
          })

          return result.responseMessage
        },
      }),

      // -----------------------------------------------------------------------
      // request_review — signals draft is complete, transitions to REVIEW
      // -----------------------------------------------------------------------
      request_review: tool({
        description:
          "Call when the current draft is complete and ready for self-review. " +
          "Transitions to REVIEW state.",
        args: {
          summary: tool.schema.string().describe(
            "Brief description of what was built in this phase.",
          ),
          artifact_description: tool.schema.string().describe(
            "Description of the artifact(s) produced.",
          ),
        },
        async execute(
          args: { summary: string; artifact_description: string },
          context: { directory: string; sessionId?: string; session?: { id: string } },
        ) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = store.get(sessionId)
          if (!state) return "Error: No workflow state for this session."

          const validDraftStates = ["DRAFT", "CONVENTIONS", "REVISE"]
          if (!validDraftStates.includes(state.phaseState)) {
            return `Error: request_review can only be called from DRAFT/CONVENTIONS/REVISE state (current: ${state.phaseState}).`
          }

          const event = state.phaseState === "REVISE" ? "revision_complete" : "draft_complete"
          const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.retryCount = 0
          })

          const result = processRequestReview(args)
          return result.responseMessage + "\n\n" + result.phaseInstructions
        },
      }),

      // -----------------------------------------------------------------------
      // submit_feedback — records user decision at a gate
      // -----------------------------------------------------------------------
      submit_feedback: tool({
          description:
          "Record the user's response at a review gate (approve or request revision). " +
          "For any phase approval, pass artifact_content with the full artifact text to enable drift detection. " +
          "For PLANNING approval in INCREMENTAL mode, also pass approved_files with the file allowlist.",
        args: {
          feedback_text: tool.schema.string().describe("The user's feedback text."),
          feedback_type: tool.schema
            .enum(["approve", "revise"])
            .describe("Whether the user approved or wants changes."),
          artifact_content: tool.schema
            .string()
            .optional()
            .describe(
              "The full text of the approved artifact at this phase. " +
              "For DISCOVERY: pass the conventions document (required — used in all subsequent phases). " +
              "For other phases: pass the key artifact text (plan, interface definitions, etc.) to enable drift detection.",
            ),
          approved_files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "For PLANNING/USER_GATE approval in INCREMENTAL mode: " +
              "list of absolute file paths the agent is allowed to modify.",
            ),
        },
        async execute(
          args: {
            feedback_text: string
            feedback_type: "approve" | "revise"
            artifact_content?: string
            approved_files?: string[]
          },
          context: { directory: string; sessionId?: string; session?: { id: string } },
        ) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = store.get(sessionId)
          if (!state) return "Error: No workflow state for this session."

          if (state.phaseState !== "USER_GATE") {
            return `Error: submit_feedback can only be called at USER_GATE (current: ${state.phaseState}).`
          }

          const result = processSubmitFeedback(args)

          if (result.feedbackType === "approve") {
            const outcome = sm.transition(state.phase, state.phaseState, "user_approve", state.mode)
            if (!outcome.success) return `Error: ${outcome.message}`

            // Git checkpoint — use per-phase approval count for tag versioning (M11)
            const phaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
            const newApprovalCount = state.approvalCount + 1
            const checkpointOpts = state.mode === "INCREMENTAL"
              ? { phase: state.phase, approvalCount: phaseCount, fileAllowlist: state.fileAllowlist }
              : { phase: state.phase, approvalCount: phaseCount }
            const checkpointResult = await createGitCheckpoint(
              { cwd: context.directory || process.cwd(), $ },
              checkpointOpts,
            )

            await store.update(sessionId, (draft) => {
              draft.phase = outcome.nextPhase
              draft.phaseState = outcome.nextPhaseState
              draft.approvalCount = newApprovalCount
              draft.phaseApprovalCounts[state.phase] = phaseCount
              draft.iterationCount = 0
              draft.retryCount = 0
              if (checkpointResult.success) {
                draft.lastCheckpointTag = checkpointResult.tag
              }
              // S1: Capture conventions document at DISCOVERY approval
              if (state.phase === "DISCOVERY" && args.artifact_content) {
                draft.conventions = args.artifact_content
              }
              // S2: Capture file allowlist at PLANNING approval in INCREMENTAL mode
              if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && args.approved_files) {
                draft.fileAllowlist = args.approved_files
              }
              // S3: Record artifact hash for drift detection (approvedArtifacts).
              // If artifact_content is provided, hash it for accurate content-based drift detection.
              // If not provided, record a time-based sentinel so the artifact key is at least
              // marked as "approved at this point" — prevents approvedArtifacts from being
              // permanently empty for file-based phases (PLANNING, INTERFACES, TESTS, etc.).
              const artifactKey = PHASE_TO_ARTIFACT[state.phase]
              if (artifactKey) {
                draft.approvedArtifacts[artifactKey] = args.artifact_content
                  ? artifactHash(args.artifact_content)
                  : `approved-at-${Date.now()}`
              }
              // S4: Layer 4 — Parse IMPL_PLAN into DAG at IMPL_PLAN approval.
              // The sequential scheduler uses this DAG to find the next ready task
              // during the IMPLEMENTATION phase. Non-fatal: if parsing fails, implDag
              // stays null and the agent falls back to sequential task execution without
              // DAG tracking.
              if (state.phase === "IMPL_PLAN" && args.artifact_content) {
                const parseResult = parseImplPlan(args.artifact_content)
                if (parseResult.success) {
                  const nodes = Array.from(parseResult.dag.tasks).map((t) => ({ ...t }))
                  draft.implDag = nodes
                  // M8: Set currentTaskId to the first ready task from the DAG
                  const firstReady = nodes.find((t) => t.status === "pending" && t.dependencies.length === 0)
                  draft.currentTaskId = firstReady?.id ?? null
                } else {
                  draft.implDag = null
                }
              }
            })

            let checkpointMsg: string
            if (checkpointResult.success) {
              checkpointMsg = ` Git checkpoint created: \`${checkpointResult.tag}\`.`
              if (checkpointResult.warnings && checkpointResult.warnings.length > 0) {
                checkpointMsg += "\n\n**Warnings:**\n" + checkpointResult.warnings.map((w) => `- ${w}`).join("\n")
              }
            } else {
              checkpointMsg = ` (Git checkpoint failed: ${checkpointResult.error})`
            }

            // Warn if DISCOVERY approved without providing the conventions document —
            // all downstream phases rely on conventions for consistent guidance.
            const discoveryWarning =
              state.phase === "DISCOVERY" && !args.artifact_content
                ? "\n\n**Warning:** No `artifact_content` provided. The conventions document will be null — downstream phases will receive no conventions context. Re-call `submit_feedback` with the conventions summary, or proceed knowing convention injection is disabled."
                : ""

            // Warn if IMPL_PLAN approved without artifact_content or with a DAG parse failure —
            // without a DAG the IMPLEMENTATION phase loses task scheduling (H2/H3).
            let implPlanWarning = ""
            if (state.phase === "IMPL_PLAN") {
              if (!args.artifact_content) {
                implPlanWarning = "\n\n**Warning:** No `artifact_content` provided for IMPL_PLAN approval. The implementation DAG will be null — task scheduling is disabled. Re-call `submit_feedback` with the implementation plan text, or proceed with manual task ordering."
              } else {
                const parseCheck = parseImplPlan(args.artifact_content)
                if (!parseCheck.success) {
                  implPlanWarning = `\n\n**Warning:** Failed to parse implementation plan into DAG: ${parseCheck.errors.join("; ")}. Task scheduling is disabled — the agent will fall back to manual task ordering.`
                }
              }
            }

            return result.responseMessage + checkpointMsg + discoveryWarning + implPlanWarning

          } else {
            // N3 fix: mode must be set before revision routing
            if (!state.mode) {
              return "Error: Cannot process revision feedback — workflow mode not yet selected."
            }

            // Route to the appropriate handler based on state context.
            // Three paths: escape hatch resolution, cascade continuation, normal revise.
            let handlerOutcome
            if (state.escapePending) {
              handlerOutcome = await handleEscapeHatch(args.feedback_text, state, sm, orchestrator)
            } else if (state.pendingRevisionSteps && state.pendingRevisionSteps.length > 0) {
              handlerOutcome = handleCascade(state, sm)
            } else {
              handlerOutcome = await handleNormalRevise(args.feedback_text, result.responseMessage, state, sm, orchestrator)
            }

            // Apply state mutations based on outcome
            if (handlerOutcome.action === "error") {
              return `Error: ${handlerOutcome.message}`
            }

            if (handlerOutcome.action === "abort") {
              await store.update(sessionId, (draft) => {
                draft.escapePending = false
                draft.pendingRevisionSteps = null
                draft.retryCount = 0
                draft.iterationCount = 0
              })
              return handlerOutcome.message
            }

            if (handlerOutcome.action === "escape_represent") {
              await store.update(sessionId, (draft) => {
                draft.escapePending = true
                draft.pendingRevisionSteps = handlerOutcome.pendingRevisionSteps
                draft.retryCount = 0
              })
              return handlerOutcome.message
            }

            // action === "revise"
            // Validate targetPhase supports REVISE — guard against orchestrator returning an invalid destination
            const validStates = VALID_PHASE_STATES[handlerOutcome.targetPhase]
            if (!validStates || !validStates.includes("REVISE")) {
              return `Error: Orchestrator routed to invalid phase "${handlerOutcome.targetPhase}" which does not support REVISE.`
            }
            await store.update(sessionId, (draft) => {
              draft.phase = handlerOutcome.targetPhase
              draft.phaseState = "REVISE"
              draft.pendingRevisionSteps = handlerOutcome.pendingRevisionSteps
              if (handlerOutcome.clearEscapePending) draft.escapePending = false
              if (handlerOutcome.newIntentBaseline !== undefined) {
                draft.intentBaseline = handlerOutcome.newIntentBaseline
              }
              draft.retryCount = 0
              // Record feedback in history for accumulated-drift detection (design doc §9)
              draft.feedbackHistory.push({
                phase: state.phase,
                feedback: args.feedback_text.slice(0, 2000),
                timestamp: Date.now(),
              })
            })
            return handlerOutcome.message
          }
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildModeDetectionNote(result: Awaited<ReturnType<typeof detectMode>>): string {
  return (
    `[Auto-detected workflow mode suggestion: ${result.suggestedMode}]\n` +
    `Reasoning: ${result.reasoning}\n` +
    `(Git history: ${result.hasGitHistory ? "yes" : "no"}, source files: ${result.sourceFileCount})\n` +
    `You may override this suggestion when calling select_mode.`
  )
}
