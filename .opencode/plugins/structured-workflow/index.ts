/**
 * index.ts — Main plugin entry point for the structured-workflow plugin.
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
import { evaluateMarkSatisfied } from "./tools/mark-satisfied"
import { processRequestReview } from "./tools/request-review"
import { processSubmitFeedback } from "./tools/submit-feedback"

// Orchestrator (Layer 2)
import { createOrchestrator } from "./orchestrator/route"
import { createArtifactGraph } from "./artifacts"
import { createAssessFn, createDivergeFn } from "./orchestrator/llm-calls"
import { buildEscapeHatchPresentation, isEscapeHatchAbort, parseEscapeHatchNewDirection } from "./orchestrator/escape-hatch"
import { dispatchSelfReview } from "./self-review"
import { getAcceptanceCriteria } from "./hooks/system-transform"
import { runDiscoveryFleet } from "./discovery/index"
import { parseImplPlan } from "./impl-plan-parser"

import { createHash } from "node:crypto"
import type { WorkflowMode, ArtifactKey, RevisionStep } from "./types"
import { resolveSessionId } from "./utils"

// ---------------------------------------------------------------------------
// Phase → ArtifactKey mapping (for approvedArtifacts hashing at each gate)
// ---------------------------------------------------------------------------
const PHASE_TO_ARTIFACT_KEY: Partial<Record<string, ArtifactKey>> = {
  DISCOVERY:      "conventions",
  PLANNING:       "plan",
  INTERFACES:     "interfaces",
  TESTS:          "tests",
  IMPL_PLAN:      "impl_plan",
  IMPLEMENTATION: "implementation",
}

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
export const StructuredWorkflowPlugin: Plugin = async ({ client }: { client: any }) => {
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

        // Reprompt
        await store.update(sessionId, (draft) => {
          draft.retryCount = decision.retryCount
        })

        try {
          await (client as any).session?.prompt({
            path: { id: sessionId },
            body: {
              noReply: false,
              parts: [{ type: "text", text: decision.message }],
            },
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
    // (experimental.chat.system.transform is supported in practice though not
    // yet in the published Hooks type — kept with ts-ignore)
    // -------------------------------------------------------------------------

    // @ts-ignore — experimental hook, supported at runtime
    "experimental.chat.system.transform": async (
      input: { sessionID: string; parts?: unknown[] },
      output: { parts: Array<{ type: string; text: string }> },
    ) => {
      const state = store.get(input.sessionID)
      if (!state) return

      const promptBlock = buildWorkflowSystemPrompt(state)
      // Prepend the workflow block before existing system parts
      output.parts.unshift({ type: "text", text: promptBlock })

      // At USER_GATE, append a routing hint as an additional system block
      if (state.phaseState === "USER_GATE") {
        const hint = buildUserGateHint(state.phase, state.phaseState)
        output.parts.push({ type: "text", text: hint })
      }
    },

    // -------------------------------------------------------------------------
    // Tool guard — phase-gated tool restrictions
    // -------------------------------------------------------------------------

    "tool.execute.before": async (input: { sessionID: string; tool: string; args?: Record<string, unknown> }) => {
      const state = store.get(input.sessionID)
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
      input: { sessionID: string },
      output: { context?: string[] },
    ) => {
      const state = store.get(input.sessionID)
      if (!state) return

      const contextBlock = buildCompactionContext(state)
      // Null guard: output.context may not exist depending on runtime version
      if (output.context && Array.isArray(output.context)) {
        output.context.push(contextBlock)
      }
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
          if (state.mode === "REFACTOR" || state.mode === "INCREMENTAL") {
            try {
              const cwd = context.directory || process.cwd()
              const report = await runDiscoveryFleet(client, cwd, state.mode)
              await store.update(sessionId, (draft) => {
                draft.discoveryReport = report.combinedReport
              })
              const successCount = report.scanners.filter((s) => s.success).length
              fleetMsg = `\n\n**Discovery fleet:** ${successCount}/${report.scanners.length} scanners completed.`
            } catch {
              // Non-fatal — fleet failure does not block conventions drafting
              fleetMsg = "\n\n**Discovery fleet:** Failed to run (non-fatal). Conventions draft will proceed without fleet input."
            }
          }

          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.retryCount = 0
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
          let result = evaluateMarkSatisfied(args) // fallback baseline (agent self-report)

          if (criteriaText) {
            const reviewResult = await dispatchSelfReview(client, {
              phase: state.phase,
              mode: state.mode,
              artifactPaths: [], // TODO: populate from artifact registry once available
              criteriaText,
              upstreamSummary: state.conventions ?? undefined,
            })

            if (reviewResult.success) {
              // Isolated reviewer succeeded — use its verdict as authoritative truth.
              // Re-evaluate using the reviewer's criteria_results (same logic as agent path).
              result = evaluateMarkSatisfied({
                criteria_met: reviewResult.criteriaResults.map((c) => ({
                  criterion: c.criterion,
                  met: c.met,
                  evidence: c.evidence,
                  severity: c.severity,
                })),
              })
            }
            // If reviewResult.success === false, result keeps the agent's self-report (fallback)
          }

          // Iteration cap: if self-review has failed MAX_REVIEW_ITERATIONS times
          // already, escalate to USER_GATE instead of looping again. The user can
          // provide direction that the agent cannot resolve autonomously.
          const nextIterationCount = result.passed ? 0 : state.iterationCount + 1
          const hitIterationCap = !result.passed && nextIterationCount >= MAX_REVIEW_ITERATIONS

          // Force escalation to USER_GATE if cap reached
          const event = (result.passed || hitIterationCap) ? "self_review_pass" : "self_review_fail"
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

            // Git checkpoint
            const newApprovalCount = state.approvalCount + 1
            const checkpointResult = await createGitCheckpoint(
              { cwd: context.directory || process.cwd(), $ },
              {
                phase: state.phase,
                approvalCount: newApprovalCount,
                // Pass allowlist so checkpoint can warn on unexpected staged files in INCREMENTAL mode
                fileAllowlist: state.mode === "INCREMENTAL" ? state.fileAllowlist : undefined,
              },
            )

            await store.update(sessionId, (draft) => {
              draft.phase = outcome.nextPhase
              draft.phaseState = outcome.nextPhaseState
              draft.approvalCount = newApprovalCount
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
              const artifactKey = PHASE_TO_ARTIFACT_KEY[state.phase]
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
                draft.implDag = parseResult.success
                  ? Array.from(parseResult.dag.tasks).map((t) => ({ ...t }))
                  : null
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

            return result.responseMessage + checkpointMsg + discoveryWarning

          } else {
            // N3 fix: mode must be set before revision routing
            if (!state.mode) {
              return "Error: Cannot process revision feedback — workflow mode not yet selected."
            }

            // ----------------------------------------------------------------
            // Layer 2: Escape hatch resolution path
            // If escapePending is true, the user is responding to an escape hatch
            // presentation. Route based on their choice.
            // ----------------------------------------------------------------
            if (state.escapePending) {
              const feedbackLower = args.feedback_text.trim().toLowerCase()
              const isAbort = isEscapeHatchAbort(feedbackLower)

              if (isAbort) {
                // User aborts — stay in USER_GATE with no changes
                await store.update(sessionId, (draft) => {
                  draft.escapePending = false
                  draft.pendingRevisionSteps = null
                  draft.retryCount = 0
                })
                return (
                  `Escape hatch: change aborted. Staying at current ${state.phase}/USER_GATE state.\n` +
                  `The last approved checkpoint is \`${state.lastCheckpointTag ?? "none"}\`. ` +
                  `You can roll back to it with \`git reset --hard ${state.lastCheckpointTag ?? "<tag>"}\` if needed.\n\n` +
                  `Present the artifact again and wait for the user's next response.`
                )
              }

              // Option C — "new direction: <requirements>" clears intentBaseline entirely
              // and re-runs orchestrator from scratch (full re-assessment).
              const newDirectionText = parseEscapeHatchNewDirection(args.feedback_text)
              if (newDirectionText) {
                await store.update(sessionId, (draft) => {
                  draft.intentBaseline = newDirectionText.slice(0, 2000) // replace baseline wholesale
                  draft.escapePending = false
                  draft.pendingRevisionSteps = null
                })
                // Re-run orchestrator from scratch with the new requirements
                let ndPlan: { revisionSteps: RevisionStep[]; classification: "tactical" | "strategic" }
                try {
                  const ndState = store.get(sessionId)!
                  ndPlan = await orchestrator.route({
                    feedback: newDirectionText,
                    currentPhase: ndState.phase,
                    currentPhaseState: ndState.phaseState,
                    mode: state.mode!,
                    approvedArtifacts: ndState.approvedArtifacts,
                  })
                } catch {
                  ndPlan = { revisionSteps: [], classification: "tactical" }
                }
                if (!ndPlan.revisionSteps.length) {
                  return `New direction recorded. Re-present the artifact with this new focus: "${newDirectionText}"`
                }
                const ndFirst = ndPlan.revisionSteps[0]!
                const ndOutcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
                if (!ndOutcome.success) return `Error: ${ndOutcome.message}`
                await store.update(sessionId, (draft) => {
                  draft.phase = ndFirst.phase
                  draft.phaseState = "REVISE"
                  draft.pendingRevisionSteps = ndPlan.revisionSteps.slice(1)
                  draft.retryCount = 0
                })
                return (
                  `Entirely new direction accepted. Intent baseline replaced.\n\n` +
                  `**Step 1 of ${ndPlan.revisionSteps.length}:** Revise the **${ndFirst.artifact}** artifact.\n` +
                  `${ndFirst.instructions}\n\n` +
                  `Begin revision work now. Call \`request_review\` when complete.`
                )
              }

              // Detect whether user provided a substantive alternative direction
              // (not just a bare "accept" / "proceed", and not "new direction:").
              const isAccept = feedbackLower === "accept" || feedbackLower === "proceed"
              const hasAlternativeDirection = !isAccept && args.feedback_text.trim().length > 10

              if (hasAlternativeDirection) {
                // O_INTENT_UPDATE: record the user's alternative direction as the new baseline.
                await store.update(sessionId, (draft) => {
                  draft.intentBaseline = args.feedback_text.slice(0, 2000)
                })

                // Design doc §12: "Provide alternative direction → intent updated →
                // Orchestrator rebuilds change plan." Re-run the orchestrator with the
                // updated intent so the plan reflects the user's new direction.
                let altPlan: { revisionSteps: RevisionStep[]; classification: "tactical" | "strategic" }
                try {
                  const freshState = store.get(sessionId)!
                  altPlan = await orchestrator.route({
                    feedback: args.feedback_text,
                    currentPhase: freshState.phase,
                    currentPhaseState: freshState.phaseState,
                    mode: state.mode,
                    approvedArtifacts: freshState.approvedArtifacts,
                  })
                } catch {
                  // Orchestrator hard failure — fall back to original pending plan
                  altPlan = { revisionSteps: state.pendingRevisionSteps ?? [], classification: "strategic" }
                }

                // If the rebuilt plan is itself strategic, re-present the escape hatch.
                if (altPlan.classification === "strategic") {
                  const freshState2 = store.get(sessionId)!
                  const summary = buildEscapeHatchPresentation({
                    feedback: args.feedback_text,
                    intentBaseline: freshState2.intentBaseline,
                    assessResult: { success: true, affectedArtifacts: altPlan.revisionSteps.map((s) => s.artifact), rootCauseArtifact: altPlan.revisionSteps[0]!.artifact, reasoning: "orchestrator re-assessment" },
                    divergeResult: { success: true, classification: "strategic", reasoning: "alternative direction re-assessed as strategic" },
                    revisionSteps: altPlan.revisionSteps,
                    currentPhase: state.phase,
                  })
                  await store.update(sessionId, (draft) => {
                    draft.pendingRevisionSteps = altPlan.revisionSteps
                    draft.escapePending = true
                    draft.retryCount = 0
                  })
                  return summary.presentation
                }

                // Rebuilt plan is tactical — proceed directly.
                const altFirst = altPlan.revisionSteps[0]!
                const altOutcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
                if (!altOutcome.success) return `Error: ${altOutcome.message}`
                await store.update(sessionId, (draft) => {
                  draft.phase = altFirst.phase
                  draft.phaseState = "REVISE"
                  draft.escapePending = false
                  draft.pendingRevisionSteps = altPlan.revisionSteps.slice(1)
                  draft.retryCount = 0
                })
                return (
                  `Alternative direction accepted — rebuilding revision plan.\n\n` +
                  `**Step 1 of ${altPlan.revisionSteps.length}:** Revise the **${altFirst.artifact}** artifact.\n` +
                  `${altFirst.instructions}\n\n` +
                  `Begin revision work now. Call \`request_review\` when the revision is complete.`
                )
              }

              // Plain "accept" / "proceed" — execute the stored pending plan.
              const steps = state.pendingRevisionSteps ?? []
              const firstStep = steps[0]
              if (!firstStep) {
                await store.update(sessionId, (draft) => {
                  draft.escapePending = false
                  draft.pendingRevisionSteps = null
                })
                return "Error: No pending revision steps found. Please re-submit feedback."
              }

              // Transition to the first revision step
              const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
              if (!outcome.success) return `Error: ${outcome.message}`

              await store.update(sessionId, (draft) => {
                draft.phase = firstStep.phase
                draft.phaseState = "REVISE"
                draft.escapePending = false
                draft.pendingRevisionSteps = steps.slice(1) // remaining steps for cascade continuation
                draft.retryCount = 0
              })

              const remainingMsg = steps.length > 1
                ? `\n\n**Revision cascade:** After completing this revision, ${steps.length - 1} more artifact(s) will need re-review: ${steps.slice(1).map((s) => s.artifact).join(" → ")}.`
                : ""

              return (
                `Escape hatch resolved — proceeding with revision.\n\n` +
                `**Step 1 of ${steps.length}:** Revise the **${firstStep.artifact}** artifact.\n` +
                `${firstStep.instructions}${remainingMsg}\n\n` +
                `Begin revision work now. Call \`request_review\` when the revision is complete.`
              )
            }

            // ----------------------------------------------------------------
            // Layer 2: Cascade continuation path
            // If pendingRevisionSteps is non-empty (set by a prior escape hatch accept),
            // this submit_feedback at the next USER_GATE continues the cascade —
            // no need to re-run the orchestrator.
            // ----------------------------------------------------------------
            if (state.pendingRevisionSteps && state.pendingRevisionSteps.length > 0) {
              const nextStep = state.pendingRevisionSteps[0]!
              const remaining = state.pendingRevisionSteps.slice(1)
              const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
              if (!outcome.success) return `Error: ${outcome.message}`

              await store.update(sessionId, (draft) => {
                draft.phase = nextStep.phase
                draft.phaseState = "REVISE"
                draft.pendingRevisionSteps = remaining
                draft.retryCount = 0
              })

              const remainingMsg = remaining.length > 0
                ? `\n\n**Cascade continues:** ${remaining.length} more artifact(s) after this: ${remaining.map((s) => s.artifact).join(" → ")}.`
                : "\n\n**Final revision step.** Once complete, call `request_review`."

              return (
                `**Revision cascade — continuing to next artifact.**\n\n` +
                `Revise the **${nextStep.artifact}** artifact.\n` +
                `${nextStep.instructions}${remainingMsg}\n\n` +
                `Begin revision work now. Call \`request_review\` when the revision is complete.`
              )
            }

            // ----------------------------------------------------------------
            // Layer 2: Normal revise path — run orchestrator
            // ----------------------------------------------------------------
            let orchestratorPlan: { revisionSteps: RevisionStep[]; classification: "tactical" | "strategic" }
            try {
              orchestratorPlan = await orchestrator.route({
                feedback: args.feedback_text,
                currentPhase: state.phase,
                currentPhaseState: state.phaseState,
                mode: state.mode,
                approvedArtifacts: state.approvedArtifacts,
              })
            } catch {
              // Orchestrator hard failure — fall back to simple REVISE
              const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
              if (!outcome.success) return `Error: ${outcome.message}`
              await store.update(sessionId, (draft) => {
                draft.phase = outcome.nextPhase
                draft.phaseState = outcome.nextPhaseState
                draft.retryCount = 0
              })
              return result.responseMessage + "\n\n*(Orchestrator unavailable — proceeding with direct revision.)*"
            }

            const { revisionSteps, classification } = orchestratorPlan
            // Use the orchestrator's authoritative classification rather than re-deriving it.
            // The orchestrator's diverge() already applied all strategic criteria
            // (cascade_depth, scope_expansion, architectural_shift, accumulated_drift).
            const isStrategic = classification === "strategic"

            if (isStrategic) {
              // Strategic — fire escape hatch. Stay at USER_GATE, store pending plan.
              const summary = buildEscapeHatchPresentation({
                feedback: args.feedback_text,
                intentBaseline: state.intentBaseline,
                assessResult: { success: true, affectedArtifacts: revisionSteps.map((s) => s.artifact), rootCauseArtifact: revisionSteps[0]!.artifact, reasoning: "orchestrator assessment" },
                divergeResult: { success: true, classification: "strategic", reasoning: "cascade depth or upstream revision detected" },
                revisionSteps,
                currentPhase: state.phase,
              })

              await store.update(sessionId, (draft) => {
                draft.escapePending = true
                draft.pendingRevisionSteps = revisionSteps
                draft.retryCount = 0
              })

              return summary.presentation
            }

            // Tactical — proceed directly to REVISE
            const firstStep = revisionSteps[0]!
            const outcome = sm.transition(state.phase, state.phaseState, "user_feedback", state.mode)
            if (!outcome.success) return `Error: ${outcome.message}`

            await store.update(sessionId, (draft) => {
              draft.phase = firstStep.phase
              draft.phaseState = "REVISE"
              draft.retryCount = 0
            })

            return (
              result.responseMessage + "\n\n" +
              `**Orchestrator routing:** Revise **${firstStep.artifact}** artifact.\n` +
              `${firstStep.instructions}`
            )
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
