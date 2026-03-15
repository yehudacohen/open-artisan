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
import { existsSync } from "node:fs"
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
import { dispatchSelfReview, dispatchRebuttal } from "./self-review"
import { getAcceptanceCriteria } from "./hooks/system-transform"
import { runDiscoveryFleet } from "./discovery/index"
import { parseImplPlan } from "./impl-plan-parser"
import { resolveArtifactPaths } from "./tools/artifact-paths"
import { writeArtifact } from "./artifact-store"

import { createHash } from "node:crypto"
import type { WorkflowMode, WorkflowState, SessionStateStore, ArtifactKey, RevisionStep, MarkSatisfiedArgs } from "./types"
import { VALID_PHASE_STATES } from "./types"
import { resolveSessionId } from "./utils"

/** Returns a 16-char SHA-256 hex fingerprint of the given text. */
function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/**
 * Lazily ensures workflow state exists for a session. If `session.created`
 * event was missed (e.g. plugin loaded after the session was already created),
 * this creates fresh state on first tool call instead of returning an error.
 */
async function ensureState(
  store: SessionStateStore,
  sessionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any,
): Promise<WorkflowState> {
  const existing = store.get(sessionId)
  if (existing) return existing
  // State doesn't exist — likely missed session.created event. Create it now.
  try {
    client?.tui?.showToast?.({
      body: {
        title: "Workflow initialized",
        message: "Session state created (missed startup event)",
        variant: "info",
        duration: 3000,
      },
    })
  } catch { /* ignore */ }
  return store.create(sessionId)
}

/**
 * Logs a state transition as a TUI toast notification so the user can see
 * workflow phase changes in real time. Falls back to console.log in test
 * environments or if the TUI API is unavailable.
 */
function logTransition(
  from: { phase: string; phaseState: string },
  to: { nextPhase: string; nextPhaseState: string } | { phase: string; phaseState: string },
  trigger: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any,
): void {
  const toPhase = "nextPhase" in to ? to.nextPhase : to.phase
  const toState = "nextPhaseState" in to ? to.nextPhaseState : to.phaseState
  const message = `${from.phase}/${from.phaseState} → ${toPhase}/${toState}`
  // Show as a transient toast in the TUI (best-effort, non-blocking)
  try {
    client?.tui?.showToast?.({
      body: {
        title: `Workflow: ${trigger}`,
        message,
        variant: "info",
        duration: 4000,
      },
    })
  } catch { /* ignore — TUI API may not be available */ }
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
export const OpenArtisanPlugin: Plugin = async ({ client, directory, worktree }: { client: any; directory?: string; worktree?: string }) => {
  // Plugin init — runs at plugin startup before the return.
  // Load persisted state from disk so sessions survive restarts.
  // IMPORTANT: Use the project directory (resolvedDir) to derive stateDir so that
  // workflow-state.json is read/written from the correct project's .opencode/ folder.
  // import.meta.dirname resolves to the symlink *target* (dev repo), so using it here
  // would cause the plugin to read/write state from the dev repo rather than the
  // active project. Fall back to import.meta.dirname only when no
  // project directory context is available (e.g. legacy environments).
  const resolvedDir = directory ?? worktree ?? process.env["OPENCODE_PROJECT_DIR"]
  const stateDir = resolvedDir
    ? join(resolvedDir.replace(/\/+$/, ""), ".opencode")
    : join(import.meta.dirname, "..", "..")  // .opencode/ fallback
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

  // Validate that the client object has the session API methods we depend on.
  // Subagent dispatch (discovery fleet, self-review, orchestrator) all require
  // client.session.{create, prompt, delete}. If any are missing, log a warning
  // at startup so the user knows subagents won't work.
  const sessionApi = client?.session
  const missingMethods: string[] = []
  if (!sessionApi) {
    console.warn("[open-artisan] client.session is missing — subagent dispatch (discovery fleet, self-review, orchestrator) will not work.")
  } else {
    for (const method of ["create", "prompt", "delete"] as const) {
      if (typeof sessionApi[method] !== "function") {
        missingMethods.push(method)
      }
    }
    if (missingMethods.length > 0) {
      console.warn(
        `[open-artisan] client.session is missing methods: ${missingMethods.join(", ")}. ` +
        `Subagent dispatch (discovery fleet, self-review, orchestrator) will silently fall back to degraded behavior.`,
      )
    }
  }

  // Idle re-prompt debounce: tracks the last re-prompt timestamp per session
  // to prevent cascading re-prompts when the user interrupts tool calls.
  const IDLE_COOLDOWN_MS = 10_000 // 10 seconds
  const lastRepromptTimestamps = new Map<string, number>()

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

        // Debounce: ignore idle events that arrive within 10 seconds of the
        // last re-prompt. This prevents a cascade when the user interrupts a
        // tool call — the abort triggers idle, we re-prompt, the LLM retries,
        // the user interrupts again, idle fires again, etc. The cooldown gives
        // the user time to type or take action.
        const now = Date.now()
        const lastReprompt = lastRepromptTimestamps.get(sessionId) ?? 0
        if (now - lastReprompt < IDLE_COOLDOWN_MS) return

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
          lastRepromptTimestamps.set(sessionId, Date.now())
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
      input: { sessionID?: string; sessionId?: string; session_id?: string; messageID?: string; [key: string]: unknown },
      output: { message: { sessionID?: string; sessionId?: string; id?: string }; parts: Array<{ type: string; text?: string; id?: string; sessionID?: string; messageID?: string }> },
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

      // Resolve messageID from input — required for v2 Part objects
      const messageId = (input.messageID as string | undefined) ?? (output.message?.id as string | undefined) ?? ""

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
        // Prepend routing note as a v2-compliant Part object.
        // v2 requires every Part to carry id, sessionID, and messageID (PartBase).
        // We generate a synthetic id prefixed with "oa-" so it's identifiable in logs.
        const injectedText = result.parts[0]?.text ?? ""
        if (injectedText) {
          output.parts.splice(0, 0, {
            type: "text",
            text: injectedText,
            id: `oa-routing-${Date.now()}`,
            sessionID: sessionId,
            messageID: messageId,
          })
        }

        // Mark that a real user message was received at USER_GATE.
        // submit_feedback(approve) checks this flag to prevent the agent
        // from self-approving without actual user input.
        await store.update(sessionId, (draft) => {
          draft.userGateMessageReceived = true
        })
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
          "or INCREMENTAL (add/fix specific functionality, runs discovery, do-no-harm). " +
          "You MUST provide a feature_name — all plan artifacts are written to " +
          ".openartisan/<feature_name>/ so multiple features can coexist in the same repo. " +
          "Derive a short kebab-case slug from the user's request (e.g. 'cloud-cost-platform').",
        args: {
          mode: tool.schema.enum(["GREENFIELD", "REFACTOR", "INCREMENTAL"]).describe(
            "The workflow mode to use for this session.",
          ),
          feature_name: tool.schema
            .string()
            .describe(
              "REQUIRED. Short kebab-case identifier for this feature/task (e.g. 'cloud-cost-platform', 'auth-refactor', 'fix-billing-bug'). " +
              "Used as a subdirectory under .openartisan/ to isolate this workflow's artifacts. " +
              "Derive from the user's request — no spaces, use hyphens.",
            ),
        },
        async execute(
          args: { mode: string; feature_name: string },
          context: { directory: string; sessionId?: string; session?: { id: string } },
        ) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, client)

          if (state.phase !== "MODE_SELECT") {
            return `Error: Mode already selected (current phase: ${state.phase}).`
          }

          const parsed = parseSelectModeArgs(args)
          if ("error" in parsed) return `Error: ${parsed.error}`

          const mode = parsed.mode as WorkflowMode
          const featureName = args.feature_name?.trim() || null
          if (!featureName) {
            return "Error: feature_name is required. Provide a short kebab-case slug derived from the user's request (e.g. 'cloud-cost-platform')."
          }
          const outcome = sm.transition(state.phase, state.phaseState, "mode_selected", mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          logTransition(state, outcome, "select_mode", client)
          await store.update(sessionId, (draft) => {
            draft.mode = mode
            draft.featureName = featureName
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.iterationCount = 0
            draft.retryCount = 0
          })

          return buildSelectModeResponse(mode) + ` Artifacts will be written to \`.openartisan/${featureName}/\`.`
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

          const state = await ensureState(store, sessionId, client)

          if (state.phase !== "DISCOVERY" || state.phaseState !== "SCAN") {
            return `Error: mark_scan_complete can only be called in DISCOVERY/SCAN (current: ${state.phase}/${state.phaseState}).`
          }

          const outcome = sm.transition(state.phase, state.phaseState, "scan_complete", state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          logTransition(state, outcome, "mark_scan_complete", client)
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

          const state = await ensureState(store, sessionId, client)

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
              const report = await runDiscoveryFleet(client, cwd, state.mode, sessionId ?? undefined, state.featureName)
              fleetReport = report.combinedReport
              const successCount = report.scanners.filter((s) => s.success).length
              fleetMsg = `\n\n**Discovery fleet:** ${successCount}/${report.scanners.length} scanners completed.`
            } catch (fleetErr) {
              // Non-fatal — fleet failure does not block conventions drafting
              const errMsg = fleetErr instanceof Error ? fleetErr.message : String(fleetErr)
              console.error(
                `[open-artisan] Discovery fleet dispatch failed: ${errMsg}`,
                fleetErr instanceof Error ? fleetErr.stack : "",
              )
              fleetMsg = `\n\n**Discovery fleet:** Failed to run (non-fatal): ${errMsg}. Conventions draft will proceed without fleet input.`
            }
          }

          // Write discovery report to disk so the agent can re-read it via tools
          // rather than relying on inline context injection in long sessions.
          let discoveryReportPath: string | null = null
          if (fleetReport !== null) {
            try {
              const cwd = context.directory || process.cwd()
              discoveryReportPath = await writeArtifact(cwd, "discovery_report", fleetReport, state.featureName)
            } catch (writeErr) {
              // Non-fatal — disk write failure doesn't block the workflow
              console.error("[open-artisan] Failed to write discovery report to disk:", writeErr)
            }
          }

          // Single atomic update: phase transition + fleet report together
          logTransition(state, outcome, "mark_analyze_complete", client)
          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.retryCount = 0
            if (fleetReport !== null) {
              draft.discoveryReport = fleetReport
            }
            if (discoveryReportPath) {
              draft.artifactDiskPaths["discovery_report" as ArtifactKey] = discoveryReportPath
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
          "If all blocking criteria are met (and all [Q] quality scores are >= 9/10), advances to user gate. " +
          "If any blocking criterion is unmet or any quality score is below 9, stays in REVIEW. " +
          "Suggestion-severity criteria are advisory and do not block advancement. " +
          "The isolated reviewer subagent reads the artifact from the disk path set by request_review. " +
          "Only pass artifact_content if request_review was called without artifact_content (legacy fallback).",
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
                score: tool.schema
                  .string()
                  .optional()
                  .describe(
                    "Quality score as a number string ('1' to '10') for [Q] quality-dimension criteria. " +
                    "Required for criteria prefixed with [Q]. Score >= 9 means met, < 9 means not met.",
                  ),
              }),
            )
            .describe("Assessment of each acceptance criterion. Include score for [Q] quality criteria."),
          artifact_content: tool.schema
            .string()
            .optional()
            .describe(
              "Fallback: the full artifact text, only needed if request_review was called without artifact_content. " +
              "In normal flow, the artifact is already on disk from request_review — omit this field.",
            ),
        },
        async execute(
          args: { criteria_met: Array<{ criterion: string; met: boolean; evidence: string; severity?: "blocking" | "suggestion"; score?: string }>; artifact_content?: string },
          context: { directory: string; sessionId?: string; session?: { id: string } },
        ) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, client)

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
          // Parse string scores to numbers — tool.schema has no .number() so
          // the schema declares score as string, but MarkSatisfiedArgs expects number.
          const parsedArgs: MarkSatisfiedArgs = {
            criteria_met: args.criteria_met.map((c) => ({
              criterion: c.criterion,
              met: c.met,
              evidence: c.evidence,
              severity: c.severity,
              score: c.score ? parseInt(c.score, 10) : undefined,
            })),
          }
          let result = evaluateMarkSatisfied(parsedArgs, expectedBlocking) // fallback baseline (agent self-report)

          if (criteriaText) {
            // resolveArtifactPaths now returns real disk paths for all phases
            // that have written artifacts (.openartisan/). The reviewer reads
            // files directly rather than receiving inlined content.
            const artifactPaths = resolveArtifactPaths(
              state.phase,
              state.mode,
              context.directory || process.cwd(),
              state.fileAllowlist,
              state.artifactDiskPaths,
            )
            // Upstream summary: pass the disk path to the conventions file if available,
            // otherwise fall back to the inline conventions text (for backward compat
            // with sessions approved before v9 disk path tracking was added).
            const conventionsPath = state.artifactDiskPaths["conventions"]
            const upstreamSummary = conventionsPath && existsSync(conventionsPath)
              ? `Conventions document is at \`${conventionsPath}\`. Read it before evaluating.`
              : (state.conventions ?? undefined)

            // The artifact is now written to disk at request_review time, so artifactPaths
            // should already contain the disk path for in-memory phases (PLANNING, DISCOVERY,
            // IMPL_PLAN). artifact_content is only a legacy fallback for sessions where
            // request_review was called without artifact_content.
            const artifactContent = (artifactPaths.length === 0 && args.artifact_content)
              ? args.artifact_content
              : undefined

            let reviewResult: Awaited<ReturnType<typeof dispatchSelfReview>> | null = null
            try {
              reviewResult = await dispatchSelfReview(client, {
                phase: state.phase,
                mode: state.mode,
                artifactPaths,
                criteriaText,
                ...(upstreamSummary ? { upstreamSummary } : {}),
                // Fallback: pass artifact content only if no disk path available
                ...(artifactContent ? { artifactContent } : {}),
                parentSessionId: sessionId ?? undefined,
                featureName: state.featureName,
              })
            } catch (reviewErr) {
              // dispatchSelfReview should never throw (returns SelfReviewError),
              // but guard against unexpected runtime failures. Fall through to
              // use the agent's self-report as baseline.
              const errMsg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr)
              console.error(
                `[open-artisan] Self-review dispatch failed unexpectedly: ${errMsg}`,
                reviewErr instanceof Error ? reviewErr.stack : "",
              )
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
                  ...(typeof c.score === "number" ? { score: c.score } : {}),
                })),
              }, expectedBlocking)

              // Agent rebuttal loop: when the review fails and we're one iteration
              // from the escalation cap, give the agent one chance to rebut criteria
              // that scored 7-8 (close to threshold). This avoids escalating to the
              // user over scope disagreements the reviewer might concede.
              const preEscalationIteration = state.iterationCount + 1 === MAX_REVIEW_ITERATIONS - 1
              if (!result.passed && preEscalationIteration) {
                // Find rebuttable criteria: unmet blocking with scores 7-8
                const rebuttableCriteria = result.unmetCriteria.filter(
                  (c) => typeof c.score === "number" && c.score >= 7 && c.score <= 8,
                )
                // Find agent's counterarguments for those same criteria
                const agentCounterargs = parsedArgs.criteria_met.filter((ac) =>
                  rebuttableCriteria.some((rc) => rc.criterion === ac.criterion) && ac.met,
                )
                if (rebuttableCriteria.length > 0 && agentCounterargs.length > 0) {
                  console.log(
                    `[open-artisan] Attempting rebuttal for ${rebuttableCriteria.length} criteria scoring 7-8`,
                  )
                  try {
                    const rebuttalResult = await dispatchRebuttal(client, {
                      phase: state.phase,
                      mode: state.mode,
                      reviewerVerdict: rebuttableCriteria,
                      agentAssessment: agentCounterargs,
                      artifactPaths,
                      criteriaText,
                      parentSessionId: sessionId ?? undefined,
                      featureName: state.featureName,
                    })
                    if (rebuttalResult.success) {
                      // Merge revised results: replace the disputed criteria in the
                      // reviewer's full results with the rebuttal's revised assessments.
                      const revisedMap = new Map(
                        rebuttalResult.revisedResults.map((r) => [r.criterion, r]),
                      )
                      const mergedCriteria = reviewResult.criteriaResults.map((c) => {
                        const revised = revisedMap.get(c.criterion)
                        return revised ?? c
                      })
                      // Re-evaluate with the merged criteria
                      result = evaluateMarkSatisfied({
                        criteria_met: mergedCriteria.map((c) => ({
                          criterion: c.criterion,
                          met: c.met,
                          evidence: c.evidence,
                          severity: c.severity,
                          ...(typeof c.score === "number" ? { score: c.score } : {}),
                        })),
                      }, expectedBlocking)
                      if (result.passed) {
                        console.log("[open-artisan] Rebuttal accepted — review now passes")
                      } else {
                        console.log("[open-artisan] Rebuttal rejected — reviewer maintained position")
                      }
                    }
                    // If rebuttalResult.success === false, keep the original failing result
                  } catch (rebuttalErr) {
                    // Non-fatal — rebuttal failure does not change the review outcome
                    const errMsg = rebuttalErr instanceof Error ? rebuttalErr.message : String(rebuttalErr)
                    console.error(`[open-artisan] Rebuttal dispatch failed: ${errMsg}`)
                  }
                }
              }
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

          logTransition(state, outcome, `mark_satisfied/${event}`, client)
          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.iterationCount = nextIterationCount
            draft.retryCount = 0
            // Reset the user gate flag whenever we enter USER_GATE so the agent
            // cannot reuse a stale approval signal from a previous gate.
            if (outcome.nextPhaseState === "USER_GATE") {
              draft.userGateMessageReceived = false
            }
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

          const state = await ensureState(store, sessionId, client)

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
          "Transitions to REVIEW state. " +
          "For in-memory phases (PLANNING, DISCOVERY conventions, IMPL_PLAN), pass the full " +
          "artifact text in artifact_content — it will be written to .openartisan/ immediately " +
          "so the user can read it before approving and the isolated reviewer can evaluate the " +
          "real file. For file-based phases (INTERFACES, TESTS, IMPLEMENTATION), omit artifact_content.",
        args: {
          summary: tool.schema.string().describe(
            "Brief description of what was built in this phase.",
          ),
          artifact_description: tool.schema.string().describe(
            "Description of the artifact(s) produced.",
          ),
          artifact_content: tool.schema
            .string()
            .optional()
            .describe(
              "The full text of the artifact (required for PLANNING, DISCOVERY conventions, IMPL_PLAN). " +
              "Written to .openartisan/ immediately so it is readable before approval.",
            ),
        },
        async execute(
          args: { summary: string; artifact_description: string; artifact_content?: string },
          context: { directory: string; sessionId?: string; session?: { id: string } },
        ) {
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, client)

          const validDraftStates = ["DRAFT", "CONVENTIONS", "REVISE"]
          if (!validDraftStates.includes(state.phaseState)) {
            return `Error: request_review can only be called from DRAFT/CONVENTIONS/REVISE state (current: ${state.phaseState}).`
          }

          const event = state.phaseState === "REVISE" ? "revision_complete" : "draft_complete"
          const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          logTransition(state, outcome, `request_review/${event}`, client)
          // Write the artifact to disk immediately (before the user gate) so:
          //   1. The user can read the real file before approving.
          //   2. The isolated self-reviewer reads from disk (no inline content size cap).
          //   3. On approval, the file is already in place — no re-write needed.
          let artifactDiskPath: string | null = null
          if (args.artifact_content) {
            const artifactKey = PHASE_TO_ARTIFACT[state.phase]
            if (artifactKey && artifactKey !== "implementation") {
              try {
                const cwd = context.directory || process.cwd()
                artifactDiskPath = await writeArtifact(cwd, artifactKey, args.artifact_content, state.featureName)
              } catch (writeErr) {
                // Non-fatal — disk write failure does not block the review
                console.error("[open-artisan] Failed to write artifact draft to disk:", writeErr)
              }
            }
          }

          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.retryCount = 0
            // Record the disk path so mark_satisfied and system-transform can use it
            if (artifactDiskPath) {
              const artifactKey = PHASE_TO_ARTIFACT[state.phase]
              if (artifactKey) draft.artifactDiskPaths[artifactKey] = artifactDiskPath
            }
          })

          const diskMsg = artifactDiskPath
            ? `\n\nArtifact written to \`${artifactDiskPath}\` — the user can read it there before approving.`
            : ""

          const result = processRequestReview(args)
          return result.responseMessage + diskMsg + "\n\n" + result.phaseInstructions
        },
      }),

      // -----------------------------------------------------------------------
      // submit_feedback — records user decision at a gate
      // -----------------------------------------------------------------------
      submit_feedback: tool({
          description:
          "Record the user's response at a review gate (approve or request revision). " +
          "In the normal flow, the artifact is already on disk from request_review — you do NOT need to pass artifact_content. " +
          "Only pass artifact_content if request_review was called without it (legacy sessions). " +
          "For PLANNING approval in INCREMENTAL mode, pass approved_files with the file allowlist.",
        args: {
          feedback_text: tool.schema.string().describe("The user's feedback text."),
          feedback_type: tool.schema
            .enum(["approve", "revise"])
            .describe("Whether the user approved or wants changes."),
          artifact_content: tool.schema
            .string()
            .optional()
            .describe(
              "Legacy fallback only: the full artifact text. " +
              "In normal flow (request_review was called with artifact_content), omit this — the file is already on disk. " +
              "Only provide this if the disk file was not written at request_review time.",
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

          const state = await ensureState(store, sessionId, client)

          if (state.phaseState !== "USER_GATE") {
            return `Error: submit_feedback can only be called at USER_GATE (current: ${state.phaseState}).`
          }

          const result = processSubmitFeedback(args)

          if (result.feedbackType === "approve") {
            // Block self-approval: the agent cannot approve its own work. A real
            // Soft check: warn if chat.message hook has not confirmed a user message at this
            // USER_GATE. This can happen on session resume after restart (the hook doesn't
            // fire retroactively) or in rare race conditions. We allow approval to proceed
            // with a warning rather than blocking — a false positive rejection here is worse
            // than a false negative (the agent can only reach USER_GATE after self-review pass,
            // and the routing hint tells it to call submit_feedback only on user input).
            const approvalWarning = !state.userGateMessageReceived
              ? "\n\n**Note:** Approval recorded without a confirmed user message via chat.message hook (possible session resume). If no real user message was received, the user may need to re-confirm."
              : ""

            const outcome = sm.transition(state.phase, state.phaseState, "user_approve", state.mode)
            if (!outcome.success) return `Error: ${outcome.message}`

            logTransition(state, outcome, "submit_feedback/approve", client)
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

            // S_DISK: Ensure artifact is on disk before recording the approved path.
            // In the new flow, the file was already written at request_review time.
            // We re-write only if artifact_content is provided AND no disk path exists yet
            // (backward compat for sessions started before this change, or for file-based phases
            // where the agent didn't call request_review with artifact_content).
            const artifactKey = PHASE_TO_ARTIFACT[state.phase]
            let artifactDiskPath: string | null = state.artifactDiskPaths[artifactKey ?? ""] ?? null
            if (!artifactDiskPath && args.artifact_content && artifactKey && artifactKey !== "implementation") {
              try {
                const cwd = context.directory || process.cwd()
                artifactDiskPath = await writeArtifact(cwd, artifactKey, args.artifact_content, state.featureName)
              } catch (writeErr) {
                // Non-fatal — disk write failure does not block the approval
                console.error("[open-artisan] Failed to write artifact to disk:", writeErr)
              }
            }

            await store.update(sessionId, (draft) => {
              draft.phase = outcome.nextPhase
              draft.phaseState = outcome.nextPhaseState
              draft.approvalCount = newApprovalCount
              draft.phaseApprovalCounts[state.phase] = phaseCount
              draft.iterationCount = 0
              draft.retryCount = 0
              // Reset after approval — the next USER_GATE starts fresh.
              draft.userGateMessageReceived = false
              if (checkpointResult.success) {
                draft.lastCheckpointTag = checkpointResult.tag
              }
              // S1: Capture conventions document at DISCOVERY approval.
              // Prefer artifact_content if passed; fall back to reading the disk file
              // (written at request_review time). If neither is available, conventions stays null.
              if (state.phase === "DISCOVERY") {
                if (args.artifact_content) {
                  draft.conventions = args.artifact_content
                } else if (artifactDiskPath) {
                  // conventions will be read from disk by system-transform (path is recorded below)
                  // We set conventions to a sentinel so downstream code knows it's on disk
                  draft.conventions = null  // system-transform uses artifactDiskPaths["conventions"]
                }
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
              if (artifactKey) {
                draft.approvedArtifacts[artifactKey] = args.artifact_content
                  ? artifactHash(args.artifact_content)
                  : `approved-at-${Date.now()}`
              }
              // S_DISK_PATH: Record the disk path for use by resolveArtifactPaths and system-transform
              if (artifactDiskPath && artifactKey) {
                draft.artifactDiskPaths[artifactKey] = artifactDiskPath
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

            // Warn if DISCOVERY approved without conventions document on disk or inline.
            // All downstream phases rely on conventions for consistent guidance.
            const discoveryWarning =
              state.phase === "DISCOVERY" && !args.artifact_content && !artifactDiskPath
                ? "\n\n**Warning:** No conventions document available (neither `artifact_content` provided nor written to disk via `request_review`). Downstream phases will receive no conventions context. Re-call `submit_feedback` with `artifact_content`, or proceed knowing convention injection is disabled."
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

            return result.responseMessage + checkpointMsg + discoveryWarning + implPlanWarning + approvalWarning

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
            logTransition(state, { phase: handlerOutcome.targetPhase, phaseState: "REVISE" }, "submit_feedback/revise", client)
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
