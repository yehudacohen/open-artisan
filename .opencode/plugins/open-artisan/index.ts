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
import { join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { createSessionStateStore, setPostUpdateHook } from "../../../packages/core/session-state"
import { createStateMachine } from "../../../packages/core/state-machine"
import { getPhaseToolPolicy } from "../../../packages/core/hooks/tool-guard"
import { buildWorkflowSystemPrompt, buildSubagentContext } from "../../../packages/core/hooks/system-transform"
import { buildUserGateHint, processUserMessage } from "../../../packages/core/hooks/chat-message"
import { handleIdle } from "../../../packages/core/hooks/idle-handler"
import { buildCompactionContext } from "../../../packages/core/hooks/compaction"
import { createGitCheckpoint } from "../../../packages/core/hooks/git-checkpoint"
import { detectMode } from "../../../packages/core/mode-detect"
import { compareIntentsWithLLM } from "../../../packages/core/intent-comparison"
import { validatePriorState } from "../../../packages/core/type-validation"
import { createLogger, setDefaultStateDir, type Logger, type NotificationSink } from "../../../packages/core/logger"
import type { EngineContext } from "../../../packages/core/engine-context"
import { 
  MAX_INTENT_DISPLAY_CHARS, 
  MIN_COMPLETE_ARTIFACTS 
} from "../../../packages/core/constants"

// Tool handlers
import { parseSelectModeArgs, buildSelectModeResponse } from "../../../packages/core/tools/select-mode"
import { processMarkScanComplete } from "../../../packages/core/tools/mark-scan-complete"
import { processMarkAnalyzeComplete } from "../../../packages/core/tools/mark-analyze-complete"
import { evaluateMarkSatisfied, countExpectedBlockingCriteria } from "../../../packages/core/tools/mark-satisfied"
import { processRequestReview } from "../../../packages/core/tools/request-review"
import { processSubmitFeedback } from "../../../packages/core/tools/submit-feedback"
import { processMarkTaskComplete } from "../../../packages/core/tools/mark-task-complete"
import { handleProposeBacktrack } from "../../../packages/core/tools/propose-backtrack"

// Orchestrator (Layer 2)
import { createOrchestrator } from "../../../packages/core/orchestrator/route"
import { createArtifactGraph, PHASE_TO_ARTIFACT } from "../../../packages/core/artifacts"
import { createAssessFn, createDivergeFn } from "../../../packages/core/orchestrator/llm-calls"
import { handleEscapeHatch, handleCascade, handleNormalRevise } from "../../../packages/core/tools/submit-feedback-handlers"
import { dispatchSelfReview, dispatchRebuttal } from "../../../packages/core/self-review"
import { createOpenCodeSubagentDispatcher } from "./opencode-subagent-dispatcher"
import { getAcceptanceCriteria } from "../../../packages/core/hooks/system-transform"
import { runDiscoveryFleet } from "../../../packages/core/discovery/index"
import { parseImplPlan } from "../../../packages/core/impl-plan-parser"
import { createImplDAG, type TaskCategory, type HumanGateInfo } from "../../../packages/core/dag"
import { nextSchedulerDecision, resolveHumanGate } from "../../../packages/core/scheduler"
import { resolveArtifactPaths } from "../../../packages/core/tools/artifact-paths"
import { writeArtifact, detectDesignDoc } from "../../../packages/core/artifact-store"
import { dispatchTaskReview, type AdjacentTask } from "../../../packages/core/task-review"
import { dispatchDriftCheck } from "../../../packages/core/task-drift"
import { captureRevisionBaseline, hasArtifactChanged } from "../../../packages/core/revision-baseline"
import { writeStatusFile } from "../../../packages/core/status-writer"
import { computeFastForward, computeForwardSkip } from "../../../packages/core/fast-forward"
import { cascadeAutoSkip } from "../../../packages/core/cascade-auto-skip"
import { dispatchAutoApproval } from "../../../packages/core/auto-approve"
import { createHash } from "node:crypto"
import type { WorkflowMode, WorkflowState, SessionStateStore, ArtifactKey, RevisionStep, MarkSatisfiedArgs, CriterionResult } from "../../../packages/core/types"
import { VALID_PHASE_STATES } from "../../../packages/core/types"
import type { PluginClient } from "./client-types"
import { resolveSessionId } from "../../../packages/core/utils"
import {
  MAX_REVIEW_ITERATIONS,
  MAX_TASK_REVIEW_ITERATIONS,
  MAX_INTENT_BASELINE_CHARS,
  MAX_FEEDBACK_CHARS,
  IDLE_COOLDOWN_MS,
  MAX_IDLE_RETRIES,
} from "../../../packages/core/constants"

/** Returns a 16-char SHA-256 hex fingerprint of the given text. */
function artifactHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/**
 * Phases where the artifact is a single plan document under .openartisan/.
 * For these phases, the complete expected file list is just the artifact path.
 * The checkpoint can safely stage only these files without missing source files.
 */
const PLAN_ONLY_PHASES: Set<string> = new Set(["DISCOVERY", "PLANNING", "IMPL_PLAN"])

/**
 * Derive the list of files this phase is expected to have modified.
 * Used by git checkpoint to stage only the right files.
 *
 * Returns a non-empty array ONLY when we can enumerate the complete file list:
 *   - Plan-only phases (DISCOVERY, PLANNING, IMPL_PLAN): just the artifact path
 *   - IMPLEMENTATION in INCREMENTAL mode: artifact path + file allowlist
 *
 * Returns empty array for phases where the agent writes source files we can't
 * enumerate (INTERFACES, TESTS, IMPLEMENTATION in GREENFIELD/REFACTOR).
 * Empty array causes the checkpoint to fall back to legacy staging (git add -u).
 */
function deriveExpectedFiles(state: WorkflowState): string[] {
  const files: string[] = []

  // Include the current phase's artifact disk path (plan.md, conventions.md, etc.)
  const artifactKey = PHASE_TO_ARTIFACT[state.phase]
  if (artifactKey) {
    const diskPath = state.artifactDiskPaths[artifactKey]
    if (diskPath) files.push(diskPath)
  }

  // For plan-only phases, the artifact path is the complete manifest
  if (PLAN_ONLY_PHASES.has(state.phase)) {
    return files
  }

  // For IMPLEMENTATION in INCREMENTAL mode, add the file allowlist
  if (state.phase === "IMPLEMENTATION" && state.mode === "INCREMENTAL" && state.fileAllowlist.length > 0) {
    files.push(...state.fileAllowlist)
    return files
  }

  // For INTERFACES, TESTS, and non-INCREMENTAL IMPLEMENTATION:
  // We can't enumerate which source files the agent wrote.
  // Return empty → checkpoint falls back to legacy staging (git add -u).
  return []
}

/**
 * Validate feature name format (kebab-case).
 * Returns null if valid, error message if invalid.
 */
function validateFeatureName(featureName: string): string | null {
  if (!featureName) {
    return "feature_name is required"
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(featureName)) {
    return "feature_name must be kebab-case (lowercase letters, numbers, hyphens only, e.g. 'my-feature-name')"
  }
  return null
}

/**
 * Find prior workflow state by feature name.
 * Uses SessionStateStore abstraction instead of direct file reads.
 * Returns the state if found, null otherwise.
 */
async function findPriorWorkflowState(
  store: ReturnType<typeof createSessionStateStore>,
  featureName: string,
  log?: Logger,
): Promise<{ intentBaseline: string | null; phase: string; artifactDiskPaths: Record<string, string>; approvedArtifacts?: Record<string, string> } | null> {
  try {
    log?.info("findPriorWorkflowState", { featureName, action: "searching" })
    
    const state = store.findByFeatureName(featureName)
    if (!state) {
      log?.info("findPriorWorkflowState", { featureName, result: "not found" })
      return null
    }

    // Validate and extract state fields
    const validated = validatePriorState(state)
    log?.info("findPriorWorkflowState", { featureName, result: "found", phase: validated?.phase })
    return validated
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log?.error("findPriorWorkflowState", { featureName, error: errorMsg })
    return null
  }
}

/**
 * Extracts full model config (modelID + providerID) from input.model.
 * Returns an object suitable for passing to session.create().
 */
function extractModelConfig(model: unknown): { modelID: string; providerID?: string } | null {
  if (!model) return null
  if (typeof model === "object" && !Array.isArray(model)) {
    const obj = model as Record<string, unknown>
    const id = obj["id"]
    const providerID = obj["providerID"]
    if (typeof id === "string" && id.trim()) {
      return {
        modelID: id,
        ...(typeof providerID === "string" && providerID.trim() ? { providerID } : {}),
      }
    }
    const modelID = obj["modelID"]
    if (typeof modelID === "string" && modelID.trim()) {
      return {
        modelID,
        ...(typeof providerID === "string" && providerID.trim() ? { providerID } : {}),
      }
    }
  }
  return null
}

const ALLOWLIST_CRITERION = "Allowlist adequacy"

function requiresAllowlistCriterion(state: WorkflowState): boolean {
  return state.mode === "INCREMENTAL" && state.phase === "PLANNING" && state.fileAllowlist.length > 0
}

function ensureAllowlistCriterion(
  criteria: Array<{ criterion: string; met: boolean; evidence: string; severity?: "blocking" | "suggestion"; score?: number }>,
  state: WorkflowState,
): Array<{ criterion: string; met: boolean; evidence: string; severity?: "blocking" | "suggestion"; score?: number }> {
  if (!requiresAllowlistCriterion(state)) return criteria
  const hasAllowlist = criteria.some((c) => c.criterion.toLowerCase().includes("allowlist adequacy"))
  if (hasAllowlist) return criteria
  return [
    ...criteria,
    {
      criterion: ALLOWLIST_CRITERION,
      met: false,
      evidence: "Allowlist adequacy was not assessed. Review whether the allowlist covers remaining phases before approval.",
      severity: "blocking",
    },
  ]
}

/**
 * Extended tool execute context — includes optional agent name.
 * The base context has directory, sessionId, session. OpenCode passes
 * `agent` when the session was created with an agent identifier.
 */
interface ToolExecuteContext {
  directory: string
  sessionId?: string
  session?: { id: string }
  /** Agent name from the session's agent file (e.g. "artisan", "robot-artisan") */
  agent?: string
  [key: string]: unknown
}

/**
 * Known artisan agent names. Only these agents activate the full workflow.
 * Non-artisan agents (Plan, Build, or unknown) cause the plugin to go dormant.
 */
export const ARTISAN_AGENT_NAMES = new Set(["artisan", "robot-artisan"])

/**
 * Lazily ensures workflow state exists for a session. If `session.created`
 * event was missed (e.g. plugin loaded after the session was already created),
 * this creates fresh state on first tool call instead of returning an error.
 */
async function ensureState(
  store: SessionStateStore,
  sessionId: string,
  notify?: NotificationSink,
): Promise<WorkflowState> {
  const existing = store.get(sessionId)
  if (existing) return existing
  // State doesn't exist — likely missed session.created event. Create it now.
  try {
    notify?.toast("Workflow initialized", "Session state created (missed startup event)", "info")
  } catch { /* ignore */ }
  return store.create(sessionId)
}

/**
 * Detects the active agent from the tool execute context and persists it
 * to state.activeAgent if changed. Called at the top of every custom tool's
 * execute() handler — the first tool call in a session captures the agent
 * and subsequent calls short-circuit if already set.
 *
 * context.agent is only available inside custom tool execute() — NOT in
 * tool.execute.before hooks or session.created events.
 */
async function detectAgent(
  store: SessionStateStore,
  sessionId: string,
  context: ToolExecuteContext,
): Promise<void> {
  const agentName = context.agent
  if (!agentName) return // Agent not in context — can't detect

  const state = store.get(sessionId)
  if (!state) return
  if (state.activeAgent === agentName) return // Already set — no-op

  await store.update(sessionId, (draft) => {
    draft.activeAgent = agentName
  })
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
  notify?: NotificationSink,
): void {
  const toPhase = "nextPhase" in to ? to.nextPhase : to.phase
  const toState = "nextPhaseState" in to ? to.nextPhaseState : to.phaseState
  const message = `${from.phase}/${from.phaseState} → ${toPhase}/${toState}`
  try {
    notify?.toast(`Workflow: ${trigger}`, message, "info")
  } catch { /* ignore — sink may not be available */ }
}

// Re-export for consumers who import from index.ts (G19)
export { resolveSessionId }

/**
 * Wraps a tool execute function so any uncaught exception is converted to an
 * error string rather than propagating to the OpenCode runtime. Without this,
 * a store.update() validation failure or disk I/O error inside a tool handler
 * would surface as an "internal server error" instead of a readable message.
 *
 * Also logs the error to the persistent error log for post-mortem tracing.
 */
function safeToolExecute<A, C>(
  toolName: string,
  fn: (args: A, context: C) => Promise<string>,
  logFn: Logger,
): (args: A, context: C) => Promise<string> {
  return async (args: A, context: C): Promise<string> => {
    try {
      return await fn(args, context)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const stack = e instanceof Error ? e.stack : undefined
      logFn.error(`Unexpected error in ${toolName}`, { detail: stack ?? message })
      return `Error: Unexpected internal error in ${toolName}: ${message}`
    }
  }
}

/**
 * Wraps every tool's execute() function in a safety net so that unexpected
 * exceptions (store.update validation failures, disk I/O errors, etc.) are
 * caught and returned as error strings. Without this, an unhandled throw
 * from any tool handler would surface as an "internal server error" in
 * the OpenCode runtime.
 */
function wrapToolMap<T extends Record<string, { execute: (...args: any[]) => Promise<string>; [key: string]: unknown }>>(
  tools: T,
  logFn: Logger,
): T {
  for (const [name, def] of Object.entries(tools)) {
    const original = def.execute
    def.execute = safeToolExecute(name, original.bind(def), logFn)
  }
  return tools
}

/**
 * Names of all custom workflow control tools.
 * The tool guard must never block these regardless of phase — they are the
 * mechanism by which the agent signals state transitions.
 * Defined as a module constant so adding a new tool cannot be silently missed.
 */
export const WORKFLOW_TOOL_NAMES = new Set([
  "check_prior_workflow",
  "select_mode",
  "mark_scan_complete",
  "mark_analyze_complete",
  "mark_satisfied",
  "mark_task_complete",
  "request_review",
  "submit_feedback",
  "resolve_human_gate",
  "propose_backtrack",
])

/**
 * OpenCode-internal infrastructure tools that should never be blocked by the
 * workflow tool guard. These are agent plumbing — task management, search,
 * reading, web access — not file write operations. Without this allowlist,
 * the substring match on "write"/"edit" would block tools like "todowrite"
 * because they contain "write" in the name.
 *
 * Matched by exact tool name (lowercase). This is intentionally narrow to
 * avoid accidentally allowing file-write tools with similar names.
 */
export const PASSTHROUGH_TOOL_NAMES = new Set([
  "todowrite",       // Task management — agent's own todo list
  "todoread",        // Task management — read agent's todo list
  "task",            // Subagent dispatch (child session gets its own tool guard)
  "glob",            // File pattern search (read-only)
  "grep",            // Content search (read-only)
  "read",            // File reading (read-only)
  "webfetch",        // Web content fetch (read-only)
  "google_search",   // Web search (read-only)
  "skill",           // Skill loading (read-only)
  "question",        // User interaction (read-only)
])



// ---------------------------------------------------------------------------
// Plugin export — correct OpenCode plugin API shape
// ---------------------------------------------------------------------------

export const OpenArtisanPlugin: Plugin = async ({ client: rawClient, directory, worktree }: { client: unknown; directory?: string; worktree?: string }) => {
  // Cast the raw client to our typed interface. The Plugin type from @opencode-ai/plugin
  // passes `client` as an opaque object — we narrow it to PluginClient for type safety
  // within the plugin body. Methods are accessed via optional chaining for robustness.
  const client = rawClient as PluginClient
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

  // Register post-update hook for status file writer (Change 5)
  const projectDir = resolvedDir || process.cwd()
  setPostUpdateHook((state, dir) => {
    // Fire-and-forget — status file write should never block state transitions
    writeStatusFile(dir, state).catch(() => { /* non-fatal */ })
  }, projectDir)

  // Set the module-level default stateDir for error log persistence.
  setDefaultStateDir(stateDir)

  // Create notification sink from the OpenCode client's TUI API.
  // The logger wraps toast calls in try/catch, so we don't need to here.
  const notify: NotificationSink = {
    toast(title: string, message: string, level: "info" | "warning" | "error"): void {
      const duration = level === "error" ? 8000 : level === "warning" ? 6000 : 4000
      client.tui?.showToast?.({ body: { title, message, variant: level, duration } })
    },
  }

  const log = createLogger(notify, stateDir)
  log.debug("Plugin initialized", { detail: `stateDir: ${stateDir}` })

  // Layer 2: Orchestrator — wires LLM-backed assess + diverge into the routing logic.
  // The graph and orchestrator are shared across sessions (stateless pure functions).
  // Design doc detection: if a user-authored design document exists, it becomes an
  // upstream dependency of the plan artifact. This makes the orchestrator cascade
  // changes through the design doc and enables design invariant acceptance criteria.
  const designDocPath = detectDesignDoc(process.cwd())
  const hasDesignDoc = designDocPath !== null
  if (hasDesignDoc) {
    log.info("Design document detected", { detail: designDocPath! })
  }
  const graph = createArtifactGraph(hasDesignDoc)
  const activeSession: { id: string | undefined } = { id: undefined }
  const getActiveSessionId = () => activeSession.id
  const getActiveSessionModel = (): string | { modelID: string; providerID?: string } | undefined => {
    if (!activeSession.id) return undefined
    const state = store.get(activeSession.id)
    return state?.sessionModel ?? undefined
  }
  // Subagent dispatcher — platform-agnostic interface for ephemeral LLM sessions.
  // All review/orchestrator/discovery dispatch uses this instead of client.session directly.
  const subagentDispatcher = createOpenCodeSubagentDispatcher(client)

  const orchestrator = createOrchestrator({
    assess: createAssessFn(subagentDispatcher, getActiveSessionId, getActiveSessionModel),
    diverge: createDivergeFn(subagentDispatcher, getActiveSessionId, getActiveSessionModel),
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
    log.warn("client.session is missing — subagent dispatch will not work")
  } else {
    for (const method of ["create", "prompt", "delete"] as const) {
      if (typeof sessionApi[method] !== "function") {
        missingMethods.push(method)
      }
    }
    if (missingMethods.length > 0) {
      log.warn("client.session is missing methods", { detail: missingMethods.join(", ") })
    }
  }

  // Idle re-prompt debounce: tracks the last re-prompt timestamp per session
  // to prevent cascading re-prompts when the user interrupts tool calls.
  // IDLE_COOLDOWN_MS is imported from constants.ts
  const lastRepromptTimestamps = new Map<string, number>()

  // Active session tracking: stores the most recently active primary session ID.
  // Used to pass parentID to orchestrator sessions so they appear in the session tree.

  // Child session tracking: maps child session IDs → parent session IDs.
  // Used to resolve the parent's workflow state for tool guard and system-transform
  // in Task subagent sessions (spawned by the agent) and plugin ephemeral sessions
  // (self-review, task-review, discovery). Child sessions do NOT get their own
  // workflow state — they inherit the parent's tool policy.
  const childSessionParents = new Map<string, string>()

  // Engine context — explicit dependency bag for tool and hook handlers.
  // Created once at plugin init. Handlers reference ctx.field instead of closures.
  // The mutable fields (activeSession, childSessionParents, lastRepromptTimestamps)
  // are shared by reference — mutations propagate automatically.
  const ctx: EngineContext = {
    store,
    sm,
    orchestrator,
    subagentDispatcher,
    log,
    notify,
    graph,
    designDocPath,
    activeSession,
    childSessionParents,
    lastRepromptTimestamps,
    async promptExistingSession(sessionId: string, text: string): Promise<void> {
      await client.session?.prompt({
        path: { id: sessionId },
        body: { noReply: false, parts: [{ type: "text", text }] },
      })
    },
  }

  return {
    // -------------------------------------------------------------------------
    // event hook — handles session lifecycle events and idle re-prompts
    // -------------------------------------------------------------------------

    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      const { store, log, childSessionParents, lastRepromptTimestamps, notify } = ctx
      try {
      // Session created: initialize fresh workflow state.
      // SDK type: { type: "session.created", properties: { info: Session } }
      // The session ID lives at properties.info.id
      if (event.type === "session.created") {
        const info = event.properties?.["info"] as { id?: string; parentID?: string } | undefined
        const sessionId = info?.id
        if (!sessionId) return

        // Child sessions (Task subagents spawned by the agent, or plugin ephemeral
        // sessions like self-review/task-review) should NOT get workflow state.
        // They inherit the parent's tool policy via the childSessionParents map.
        // This prevents:
        //   - Subagents landing in MODE_SELECT with blocked tools
        //   - Wasted detectMode() scans for ephemeral sessions
        //   - State mutation races when multiple subagents modify the DAG
        if (info?.parentID) {
          childSessionParents.set(sessionId, info.parentID)
          return
        }

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
        if (!sessionId) return
        // Clean up child session mapping if this was a child session
        childSessionParents.delete(sessionId)
        try {
          await store.delete(sessionId)
        } catch (e) {
          log.warn("Failed to delete session state", { detail: e instanceof Error ? e.message : String(e), sessionId })
        }
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

        // Agent-aware dormancy: skip idle re-prompts for non-artisan agents
        if (state.activeAgent !== null && !ARTISAN_AGENT_NAMES.has(state.activeAgent)) return

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
          // Hard escalation: toast + in-session prompt telling the agent to
          // stop and ask the user for help. The agent's response will be
          // visible in the conversation, making the stall impossible to miss.
          log.warn(`Idle escalation: agent stopped ${state.retryCount} times at ${state.phase}/${state.phaseState}`, { sessionId })
          try {
            notify.toast("Workflow Stalled", decision.message, "warning")
          } catch { /* ignore */ }
          // Reset retry count so the agent gets fresh attempts after user input
          try {
            await store.update(sessionId, (draft) => { draft.retryCount = 0 })
          } catch (e) {
            log.warn("Failed to reset retryCount on escalation", { detail: e instanceof Error ? e.message : String(e), sessionId })
          }
          try {
            await ctx.promptExistingSession(sessionId,
              `WORKFLOW STALLED: You have stopped ${state.retryCount} times during ${state.phase}/${state.phaseState} ` +
              `without completing the current step. Stop what you are doing and ask the user for guidance. ` +
              `Explain what you were trying to do and where you got stuck.`)
          } catch { /* ignore if API shape differs */ }
          return
        }

        // Reprompt — only increment retry count AFTER the prompt succeeds,
        // so failed prompts don't consume retry budget.
        log.warn(`Idle reprompt ${decision.retryCount}/${MAX_IDLE_RETRIES} at ${state.phase}/${state.phaseState}`, { sessionId })
        try {
          lastRepromptTimestamps.set(sessionId, Date.now())
          await ctx.promptExistingSession(sessionId, decision.message)
          await store.update(sessionId, (draft) => {
            draft.retryCount = decision.retryCount
          })
        } catch { /* ignore if API shape differs */ }
      }
      } catch (e) {
        // Top-level safety net — hooks must never throw to the OpenCode runtime.
        // Errors here cause "internal server error" retries if left unhandled.
        log.error("Unhandled error in event hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
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
      const { store, log, notify } = ctx
      try {
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

      // Agent-aware dormancy: skip chat.message processing for non-artisan agents
      if (state.activeAgent !== null && !ARTISAN_AGENT_NAMES.has(state.activeAgent)) return

      // DONE → MODE_SELECT auto-reset: when a user sends a new message after a
      // completed workflow, reset the state so a fresh workflow cycle can begin.
      // This prevents the agent from working outside the workflow framework after
      // the first workflow completes. The user's message becomes the new intent.
      if (state.phase === "DONE") {
        const textContent = (output.parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!)
          .join(" ")
          .trim()
        await store.update(sessionId, (draft) => {
          draft.phase = "MODE_SELECT"
          draft.phaseState = "DRAFT"
          draft.iterationCount = 0
          draft.retryCount = 0
          draft.intentBaseline = textContent ? textContent.slice(0, MAX_INTENT_BASELINE_CHARS) : null
          draft.userGateMessageReceived = false
          draft.currentTaskId = null
          draft.implDag = null
          draft.feedbackHistory = []
          draft.pendingRevisionSteps = null
          draft.escapePending = false
          draft.taskCompletionInProgress = null
          draft.taskReviewCount = 0
          draft.pendingFeedback = null
          draft.revisionBaseline = null
          draft.userMessages = textContent ? [textContent] : []
          // Preserve: mode, approvedArtifacts, conventions, fileAllowlist,
          // featureName, artifactDiskPaths, activeAgent, phaseApprovalCounts,
          // lastCheckpointTag, approvalCount — these carry forward from the
          // previous workflow cycle for context.
        })
        logTransition(
          { phase: "DONE", phaseState: "DRAFT" },
          { phase: "MODE_SELECT", phaseState: "DRAFT" },
          "new workflow cycle — user sent new work",
          notify,
        )
        return // Don't inject USER_GATE routing hints — we're now at MODE_SELECT
      }

      // Resolve messageID from input — required for v2 Part objects
      const messageId = (input.messageID as string | undefined) ?? (output.message?.id as string | undefined) ?? ""

      // Collect all user messages for self-review context
      const textContent = (output.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join(" ")
        .trim()

      if (textContent) {
        await store.update(sessionId, (draft) => {
          // Append to userMessages array
          draft.userMessages.push(textContent)
          
          // Capture first real user message as intent baseline (for O_DIVERGE later).
          // intentBaseline is null until the first real user message arrives.
          // After capture, only O_INTENT_UPDATE (in the escape hatch path) may update it.
          if (!draft.intentBaseline) {
            draft.intentBaseline = textContent.slice(0, MAX_INTENT_BASELINE_CHARS)
          }
        })
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
      } catch (e) {
        log.error("Unhandled error in chat.message hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
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
      const { store, log, childSessionParents, designDocPath } = ctx
      try {
      const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
      if (!sessionId) return

      // Child sessions (Task subagents): inject subagent-specific context
      // from the parent's workflow state. This gives the subagent structured
      // knowledge of the DAG, artifact paths, conventions, and constraints
      // without injecting workflow tool instructions or review criteria.
      const parentSessionId = childSessionParents.get(sessionId)
      if (parentSessionId) {
        const parentState = store.get(parentSessionId)
        if (parentState) {
          output.system.push(buildSubagentContext(parentState))
        }
        return
      }

      const state = store.get(sessionId)
      if (!state) return

      // Extract full model config (modelID + providerID) from input.model
      const modelConfig = extractModelConfig(input.model)
      // Always log model detection for debugging
      if (input.model) {
        log.debug("Session model detected", { detail: `input.model: ${JSON.stringify(input.model)}, extracted: ${JSON.stringify(modelConfig)}` })
      }
      if (modelConfig) {
        // Compare by fields to avoid unnecessary store updates
        const current = state.sessionModel
        const changed = !current
          || typeof current === "string"
          || current.modelID !== modelConfig.modelID
          || (current.providerID ?? undefined) !== (modelConfig.providerID ?? undefined)
        if (changed) {
          await store.update(sessionId, (draft) => {
            draft.sessionModel = modelConfig
          })
        }
      } else if (input.model) {
        log.warn("Failed to extract model config", { detail: `input.model type: ${typeof input.model}, value: ${JSON.stringify(input.model).slice(0, 200)}` })
      }

      // Agent-aware dormancy: if the active agent is NOT an artisan agent,
      // skip workflow prompt injection entirely. The plugin should be invisible
      // to non-artisan agents (Plan, Build). activeAgent === null means "not yet
      // detected" — default to ACTIVE for backward compatibility.
      if (state.activeAgent !== null && !ARTISAN_AGENT_NAMES.has(state.activeAgent)) {
        return // DORMANT — non-artisan agent, no workflow prompt injection
      }

      const promptBlock = buildWorkflowSystemPrompt(state)
      // Append the workflow block after existing system parts to preserve
      // OpenCode's own system block positions (applyCaching expects its
      // blocks at index 0-1 for cache_control breakpoints).
      output.system.push(promptBlock)

      // At USER_GATE, append a routing hint as an additional system block
      if (state.phaseState === "USER_GATE") {
        const hint = buildUserGateHint(state.phase, state.phaseState)
        output.system.push(hint)
      }
      } catch (e) {
        log.error("Unhandled error in system.transform hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    },

    // -------------------------------------------------------------------------
    // Tool guard — phase-gated tool restrictions
    // -------------------------------------------------------------------------

    "tool.execute.before": async (input: { sessionID?: string; sessionId?: string; session_id?: string; tool: string; args?: Record<string, unknown> }) => {
      const { store, log, childSessionParents } = ctx
      try {
      const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
      if (!sessionId) return

      // Child session handling: look up the parent's state for tool policy.
      // Child sessions (Task subagents, plugin ephemeral sessions) inherit the
      // parent's tool policy but CANNOT call workflow tools.
      const parentId = childSessionParents.get(sessionId)
      if (parentId) {
        // Never block OpenCode infrastructure tools in child sessions
        if (PASSTHROUGH_TOOL_NAMES.has(input.tool.toLowerCase())) return

        // Block workflow tools in child sessions — only the parent can
        // advance workflow state. This prevents state mutation races when
        // multiple Task subagents run concurrently.
        if (WORKFLOW_TOOL_NAMES.has(input.tool)) {
          throw new Error(
            `[Workflow] Tool "${input.tool}" cannot be called from a subagent session. ` +
            `Only the parent session can call workflow control tools (mark_task_complete, request_review, etc.). ` +
            `Complete your implementation work and report results back to the parent session.`,
          )
        }
        // Use the parent's state for tool policy enforcement
        const parentState = store.get(parentId)
        if (!parentState) return // Parent state gone — allow through (graceful degradation)
        const policy = getPhaseToolPolicy(
          parentState.phase,
          parentState.phaseState,
          parentState.mode,
          parentState.fileAllowlist,
        )
        // Apply the same blocked/predicate checks using the parent's policy
        const toolName = input.tool.toLowerCase()
        if (policy.blocked.some((blocked) => toolName.includes(blocked))) {
          throw new Error(
            `[Workflow] Tool "${input.tool}" is blocked in ${parentState.phase}/${parentState.phaseState}. ` +
            `Allowed: ${policy.allowedDescription}`,
          )
        }
        if (policy.bashCommandPredicate && toolName.includes("bash")) {
          const command = (input.args?.["command"] ?? input.args?.["cmd"] ?? input.args?.["script"] ?? "") as string
          if (command && !policy.bashCommandPredicate(command)) {
            throw new Error(
              `[Workflow] Bash command blocked in INCREMENTAL mode — file-write operators (>, >>, tee, sed -i) are not allowed.`,
            )
          }
        }
        const WRITE_LIKE_TOKENS_CHILD = ["write", "edit", "patch", "create", "overwrite"]
        if (policy.writePathPredicate && WRITE_LIKE_TOKENS_CHILD.some((t) => toolName.includes(t))) {
          const filePath = (
            input.args?.["filePath"] ?? input.args?.["path"] ?? input.args?.["file"] ??
            input.args?.["filename"] ?? input.args?.["target"] ?? input.args?.["destination"]
          ) as string | undefined
          if (filePath && !policy.writePathPredicate(filePath)) {
            throw new Error(
              `[Workflow] Writing to "${filePath}" is blocked in ${parentState.phase}/${parentState.phaseState}. ` +
              `${policy.allowedDescription}`,
            )
          }
        }
        return
      }

      const state = store.get(sessionId)
      if (!state) return

      // Track the most recently active primary session ID for orchestrator parentID.
      activeSession.id = sessionId

      // Agent-aware dormancy: if the active agent is NOT an artisan agent
      // (e.g. Plan, Build, or any unknown agent), skip ALL tool blocking.
      // The plugin should be invisible to non-artisan agents.
      // activeAgent === null means "not yet detected" — default to ACTIVE
      // for backward compatibility (existing sessions before schema v13).
      if (state.activeAgent !== null && !ARTISAN_AGENT_NAMES.has(state.activeAgent)) {
        return // DORMANT — non-artisan agent, skip tool guard entirely
      }

      // Never block our own workflow tools regardless of phase — they are the
      // only way the agent can signal state transitions.
      if (WORKFLOW_TOOL_NAMES.has(input.tool)) return

      // Never block OpenCode infrastructure tools (todowrite, glob, read, etc.)
      // These are agent plumbing, not file operations. The substring match on
      // "write"/"edit" would otherwise false-positive on tools like "todowrite".
      if (PASSTHROUGH_TOOL_NAMES.has(input.tool.toLowerCase())) return

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
      } catch (e) {
        // Re-throw intentional tool blocks — these are the mechanism for enforcing
        // phase-gated tool restrictions. Only swallow truly unexpected errors.
        if (e instanceof Error && e.message.startsWith("[Workflow]")) throw e
        log.error("Unhandled error in tool.execute.before hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
        // Swallow — failing open is safer than blocking all tools on an internal error
      }
    },

    // -------------------------------------------------------------------------
    // Compaction resilience — preserve state across context window reductions
    // -------------------------------------------------------------------------

    "experimental.session.compacting": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string },
      output: { context?: string[] },
    ) => {
      const { store, childSessionParents } = ctx
      try {
      const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
      if (!sessionId) return
      const state = store.get(sessionId)
      if (!state) return

      // Agent-aware dormancy: skip compaction context for non-artisan agents
      if (state.activeAgent !== null && !ARTISAN_AGENT_NAMES.has(state.activeAgent)) return

      const contextBlock = buildCompactionContext(state)
      // Ensure output.context exists — runtime may not initialize it
      output.context ??= []
      output.context.push(contextBlock)
      } catch (e) {
        log.error("Unhandled error in compacting hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    },

    // -------------------------------------------------------------------------
    // Custom tools — "tool" (singular) with tool() helper and tool.schema.*
    // Each tool's execute() is wrapped by safeToolExecute at the end of this
    // block so that store.update() failures and other unexpected exceptions
    // are caught and returned as error strings instead of propagating as
    // unhandled exceptions to the OpenCode runtime.
    // -------------------------------------------------------------------------

    tool: wrapToolMap({
      // -----------------------------------------------------------------------
      // check_prior_workflow — run before select_mode to validate intent alignment
      // -----------------------------------------------------------------------
      check_prior_workflow: tool({
        description:
          "Check if prior workflow artifacts match the user's current intent. " +
          "Call this BEFORE select_mode when starting a new workflow to verify whether " +
          "the existing artifacts are relevant to what the user is asking for. " +
          "Returns either 'safe to resume' or 'suggest a different feature name'.",
        args: {
          feature_name: tool.schema
            .string()
            .describe(
              "The feature name to check for prior workflow state. " +
              "This should match what the user is asking to work on.",
            ),
          user_intent: tool.schema
            .string()
            .optional()
            .describe(
              "The user's current request/goal. If not provided, will be derived from the session context.",
            ),
        },
        async execute(
          args: { feature_name?: string; user_intent?: string },
          context: ToolExecuteContext,
        ) {
          const { store, log, subagentDispatcher } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID."

          const featureName = args.feature_name?.trim()
          if (!featureName) {
            return "Error: feature_name is required."
          }

          // Validate feature name format
          const validationError = validateFeatureName(featureName)
          if (validationError) {
            return `Error: ${validationError}`
          }

          // Check if feature directory exists
          const cwd = context.directory || process.cwd()
          const featureDir = join(cwd, ".openartisan", featureName)
          if (!existsSync(featureDir)) {
            return (
              `No prior workflow found for "${featureName}". ` +
              `Proceed with select_mode to start fresh.`
            )
          }

          // Mark that check_prior_workflow was called for this feature
          await store.update(sessionId, (draft) => {
            draft.priorWorkflowChecked = true
          })

          const state = store.get(sessionId)
          const priorState = await findPriorWorkflowState(store, featureName, log)

          // No prior state found
          if (!priorState) {
            return (
              `No prior workflow found for "${featureName}". ` +
              `Proceed with select_mode to start fresh.`
            )
          }

          // Prior state exists — use LLM to compare intents semantically
          const currentIntent = args.user_intent?.trim() || state?.intentBaseline || "unknown"
          const priorIntent = priorState.intentBaseline || "unknown"

          // Validate intents are not "unknown" before LLM call
          if (currentIntent === "unknown" || priorIntent === "unknown") {
            return (
              `Error: Cannot compare intents - one or both intents are unknown.\n` +
              `Current intent: ${currentIntent}\n` +
              `Prior intent: ${priorIntent}\n\n` +
              `Provide user_intent parameter or ensure intentBaseline is captured.`
            )
          }

          const priorPlanPath = priorState.artifactDiskPaths?.["plan"]

          // Use shared LLM comparison function
          const comparisonResult = await compareIntentsWithLLM({
            currentIntent,
            priorIntent,
            priorPlanPath,
            dispatcher: subagentDispatcher,
            parentModel: state?.sessionModel ?? undefined,
          })

          const { classification, explanation } = comparisonResult

          // Handle ERROR case first
          if (classification === "ERROR") {
            log.error("check_prior_workflow", { 
              featureName, 
              error: "LLM comparison failed", 
              detail: explanation 
            })
            return (
              `Error: Could not compare intents with prior workflow.\n` +
              `Reason: ${explanation}\n\n` +
              `Recommendation: Proceed with caution or use a different feature name.`
            )
          }

          // Log successful comparison
          log.info("check_prior_workflow", { 
            featureName, 
            classification, 
            currentIntent: currentIntent.slice(0, 100),
            priorIntent: priorIntent.slice(0, 100)
          })

          // Cache the prior state for select_mode to avoid redundant file reads
          await store.update(sessionId, (draft) => {
            draft.cachedPriorState = priorState
            draft.priorWorkflowChecked = true
          })

          if (classification === "DIFFERENT") {
            return (
              `Prior workflow found for "${featureName}" (last phase: ${priorState.phase}).\n\n` +
              `Current intent: "${currentIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n` +
              `Prior intent: "${priorIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n\n` +
              `LLM assessment: DIFFERENT\n` +
              `Explanation: ${explanation}\n\n` +
              `appears DIFFERENT. The prior workflow was for a different goal.\n\n` +
              `Recommendation: Use a more specific feature name, for example:\n` +
              `- "${featureName}-v2" to start fresh with a similar name\n` +
              `- A name that reflects the specific aspect you're working on\n\n` +
              `Or manually clear the prior state if you want to reuse this name.`
            )
          } else if (classification === "PARTIAL") {
            return (
              `Prior workflow found for "${featureName}" (last phase: ${priorState.phase}).\n\n` +
              `Current intent: "${currentIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n` +
              `Prior intent: "${priorIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n\n` +
              `LLM assessment: PARTIAL\n` +
              `Explanation: ${explanation}\n\n` +
              `The prior workflow only PARTIALLY covers your current request. ` +
              `You need to complete the remaining work.\n\n` +
              `Recommendation: Use a new feature name to continue the work, for example:\n` +
              `- "${featureName}-continue" to pick up where it left off\n` +
              `- "${featureName}-additional" to add the missing parts\n\n` +
              `The workflow will start fresh and you can reference the prior artifacts as needed.`
            )
          } else {
            // FULL
            return (
              `Prior workflow found for "${featureName}" (last phase: ${priorState.phase}).\n\n` +
              `Current intent: "${currentIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n` +
              `Prior intent: "${priorIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n\n` +
              `LLM assessment: FULL\n` +
              `Explanation: ${explanation}\n\n` +
              `appears RELEVANT and FULLY COVERS your request. ` +
              `Safe to resume with select_mode. The workflow will fast-forward to where it left off.`
            )
          }
        },
      }),
      select_mode: tool({
        description:
          "Select the workflow mode: GREENFIELD (new project, skips discovery), " +
          "REFACTOR (restructure existing project, runs discovery), " +
          "or INCREMENTAL (add/fix specific functionality, runs discovery, do-no-harm). " +
          "IMPORTANT: Call check_prior_workflow first to verify the feature name matches your intent. " +
          "If check_prior_workflow returns 'DIFFERENT' or 'PARTIAL', use a different feature name. " +
          "All plan artifacts are written to .openartisan/<feature_name>/ so multiple features can coexist in the same repo. " +
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
          context: ToolExecuteContext,
        ) {
          const { store, sm, log, notify, subagentDispatcher } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          // If at DONE, reset to MODE_SELECT to allow starting a fresh workflow.
          // This handles the case where the user wants to start a new workflow
          // after a prior one completed, without needing to send a chat message first.
          if (state.phase === "DONE") {
            const updatedState = await store.update(sessionId, (draft) => {
              draft.phase = "MODE_SELECT"
              draft.phaseState = "DRAFT"
              draft.iterationCount = 0
              draft.retryCount = 0
              draft.intentBaseline = null
              draft.userGateMessageReceived = false
              draft.currentTaskId = null
              draft.implDag = null
              draft.feedbackHistory = []
              draft.pendingRevisionSteps = null
              draft.escapePending = false
              draft.taskCompletionInProgress = null
              draft.taskReviewCount = 0
              draft.pendingFeedback = null
              draft.revisionBaseline = null
            })
            log.info("Auto-reset DONE -> MODE_SELECT for fresh workflow", { sessionId })
            // Use the returned state instead of mutating the stale reference
            return await this.execute(args, context)
          }

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

          // Validate feature name format
          const validationError = validateFeatureName(featureName)
          if (validationError) {
            return `Error: ${validationError}`
          }

          // Check if feature directory exists - enforce check_prior_workflow before proceeding
          const featureDir = join(context.directory || process.cwd(), ".openartisan", featureName)
          if (existsSync(featureDir) && !state.priorWorkflowChecked) {
            log.warn("select_mode blocked without check_prior_workflow", {
              featureName,
              detail: "Feature directory exists but check_prior_workflow was not called first",
            })
            return (
              `Error: Prior workflow artifacts detected for "${featureName}". ` +
              `Call check_prior_workflow first to verify intent alignment before select_mode.`
            )
          }

          // STEP 1: Check if this is an existing workflow (FIRST THING)
          // Use cached result from check_prior_workflow if available, otherwise read from disk
          let priorState = state.cachedPriorState
          if (!priorState) {
            priorState = await findPriorWorkflowState(store, featureName, log)
          } else {
            log.info("select_mode using cached prior state", { featureName })
          }
          
          // Clear cached prior state and consume the check_prior_workflow flag
          if (state.cachedPriorState || state.priorWorkflowChecked) {
            await store.update(sessionId, (draft) => {
              draft.cachedPriorState = null
              draft.priorWorkflowChecked = false
            })
          }
          
          const currentIntent = state.intentBaseline || "unknown"

          if (priorState) {
            // Prior workflow exists for this feature - check if complete
            const hasAllArtifacts = priorState.approvedArtifacts && 
              Object.keys(priorState.approvedArtifacts).length >= MIN_COMPLETE_ARTIFACTS

            if (hasAllArtifacts) {
              // Prior workflow is complete - check if it covers current intent
              // Use shared LLM comparison function
              const priorIntent = priorState.intentBaseline || ""
              const priorPlanPath = priorState.artifactDiskPaths?.["plan"]

              const comparisonResult = await compareIntentsWithLLM({
                currentIntent,
                priorIntent,
                priorPlanPath,
                dispatcher: subagentDispatcher,
                parentModel: state.sessionModel ?? undefined,
              })

              const { classification } = comparisonResult

              if (classification === "DIFFERENT" || classification === "PARTIAL") {
                return (
                  `Prior workflow found for "${featureName}" but it ${classification === "DIFFERENT" ? "is for a different goal" : "only partially covers your request"}.\n\n` +
                  `Current: "${currentIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n` +
                  `Prior: "${priorIntent.slice(0, MAX_INTENT_DISPLAY_CHARS)}"\n\n` +
                  `Use a different feature name to start fresh, e.g. "${featureName}-v2" or "${featureName}-continue".`
                )
              }
              
              // If FULL, fast-forward to skip completed phases
              if (classification === "FULL") {
                const ffResult = await computeFastForward(
                  mode,
                  priorState.approvedArtifacts || {},
                  priorState.artifactDiskPaths
                )

                log.info("select_mode fast-forward", {
                  featureName,
                  targetPhase: ffResult.targetPhase,
                  skippedPhases: ffResult.skippedPhases,
                })

                // Detect design doc
                const cwd = context.directory || process.cwd()
                const featureDesignDocPath = detectDesignDoc(cwd, featureName)

                // Apply fast-forward result
                const updatedState = await store.update(sessionId, (draft) => {
                  draft.mode = mode
                  draft.featureName = featureName
                  draft.phase = ffResult.targetPhase
                  draft.phaseState = ffResult.targetPhaseState
                  draft.iterationCount = 0
                  draft.retryCount = 0
                  if (featureDesignDocPath) {
                    draft.artifactDiskPaths = { ...draft.artifactDiskPaths, design: featureDesignDocPath }
                  }
                  if (draft.fileAllowlist.length > 0) {
                    draft.fileAllowlist = draft.fileAllowlist.map((p) =>
                      p.startsWith("/") ? p : resolve(cwd, p),
                    )
                  }
                })

                const designDocNote = featureDesignDocPath
                  ? ` Design document detected at \`${featureDesignDocPath}\`.`
                  : ""

                return (
                  `Mode: ${mode}\n` +
                  `Feature: ${featureName}\n\n` +
                  `${ffResult.message}\n\n` +
                  `Resuming at ${updatedState.phase}/${updatedState.phaseState}.${designDocNote}`
                )
              }
            }
          }

          // STEP 2: Transition to the next phase (if not fast-forwarding)
          // Refetch state after potential fast-forward update
          const currentState = store.get(sessionId) || state
          const outcome = sm.transition(currentState.phase, currentState.phaseState, "mode_selected", mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          logTransition(currentState, outcome, "select_mode", notify)

          // Detect design doc now that feature name is known (enables feature-scoped detection)
          const cwd = context.directory || process.cwd()
          const featureDesignDocPath = detectDesignDoc(cwd, featureName)

          await store.update(sessionId, (draft) => {
            draft.mode = mode
            draft.featureName = featureName
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.iterationCount = 0
            draft.retryCount = 0
            // Register design doc in artifact disk paths if detected
            if (featureDesignDocPath) {
              draft.artifactDiskPaths = { ...draft.artifactDiskPaths, design: featureDesignDocPath }
            }
            // Normalize fileAllowlist: if preserved from a prior cycle (pre-normalization-fix),
            // it may contain relative paths that fail validation when mode is INCREMENTAL.
            // Resolve them against the project directory now that cwd is available.
            if (draft.fileAllowlist.length > 0) {
              draft.fileAllowlist = draft.fileAllowlist.map((p) =>
                p.startsWith("/") ? p : resolve(cwd, p),
              )
            }
          })

          const designDocNote = featureDesignDocPath
            ? ` Design document detected at \`${featureDesignDocPath}\` — it will be used as a constraint for all subsequent phases.`
            : ""

          return buildSelectModeResponse(mode) + ` Artifacts will be written to \`.openartisan/${featureName}/\`.` + designDocNote
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
        async execute(args: { scan_summary: string }, context: ToolExecuteContext) {
          const { store, sm, notify } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          if (state.phase !== "DISCOVERY" || state.phaseState !== "SCAN") {
            return `Error: mark_scan_complete can only be called in DISCOVERY/SCAN (current: ${state.phase}/${state.phaseState}).`
          }

          const outcome = sm.transition(state.phase, state.phaseState, "scan_complete", state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          logTransition(state, outcome, "mark_scan_complete", notify)
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
        async execute(args: { analysis_summary: string }, context: ToolExecuteContext) {
          const { store, sm, log, notify, subagentDispatcher } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

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
              const report = await runDiscoveryFleet(
                subagentDispatcher,
                cwd,
                state.mode,
                sessionId ?? undefined,
                state.featureName,
                state.sessionModel ?? undefined,
              )
              fleetReport = report.combinedReport
              const successCount = report.scanners.filter((s) => s.success).length
              fleetMsg = `\n\n**Discovery fleet:** ${successCount}/${report.scanners.length} scanners completed.`
              if (successCount === 0) {
                fleetMsg += "\nManual fallback: draft conventions from README/CONTRIBUTING and direct code inspection, or re-run discovery after fixing the prompt/template error."
              }
            } catch (fleetErr) {
              // Non-fatal — fleet failure does not block conventions drafting
              const errMsg = fleetErr instanceof Error ? fleetErr.message : String(fleetErr)
              log.warn("Discovery fleet dispatch failed", { detail: errMsg })
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
              log.warn("Failed to write discovery report to disk")
            }
          }

          // Single atomic update: phase transition + fleet report together
          logTransition(state, outcome, "mark_analyze_complete", notify)
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
          context: ToolExecuteContext,
        ) {
          const { store, sm, log, notify, subagentDispatcher } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          if (state.phaseState !== "REVIEW") {
            return `Error: mark_satisfied can only be called in REVIEW state (current: ${state.phaseState}).`
          }

          // Review integrity check (Change 4): verify the artifact hasn't changed
          // since request_review was called. If it has, the isolated reviewer needs
          // to re-read the updated file.
          if (state.reviewArtifactHash) {
            const artifactKey = PHASE_TO_ARTIFACT[state.phase]
            const diskPath = artifactKey ? state.artifactDiskPaths[artifactKey] : null
            if (diskPath) {
              try {
                const currentContent = await readFile(diskPath, "utf-8")
                const currentHash = artifactHash(currentContent)
                if (currentHash !== state.reviewArtifactHash) {
                  return (
                    `Error: Artifact has changed since last request_review. ` +
                    `Call request_review again so the reviewer can evaluate the updated artifact.\n\n` +
                    `Expected hash: ${state.reviewArtifactHash}, current hash: ${currentHash}`
                  )
                }
              } catch { /* non-fatal — if file unreadable, skip hash check */ }
            }
          }

          // Layer 3: Dispatch isolated reviewer subagent.
          // The reviewer runs in a fresh ephemeral session that sees ONLY the
          // artifact files and acceptance criteria — never the authoring conversation.
          // This eliminates anchoring bias. If the reviewer call fails, fall back
          // to the agent's self-reported criteria (graceful degradation).
          const criteriaText = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, state.artifactDiskPaths?.design ?? null)
          const expectedBlocking = countExpectedBlockingCriteria(criteriaText)
          // Parse string scores to numbers — tool.schema has no .number() so
          // the schema declares score as string, but MarkSatisfiedArgs expects number.
          const parsedArgs: MarkSatisfiedArgs = {
            criteria_met: ensureAllowlistCriterion(
              args.criteria_met.map((c) => ({
                criterion: c.criterion,
                met: c.met,
                evidence: c.evidence,
                ...(c.severity ? { severity: c.severity } : {}),
                ...(c.score ? { score: parseInt(c.score, 10) } : {}),
              })),
              state,
            ),
          }
          // Iteration info for display in fail messages: "Review iteration X of Y"
          const iterationInfo = { current: state.iterationCount + 1, max: MAX_REVIEW_ITERATIONS }
          let result = evaluateMarkSatisfied(parsedArgs, expectedBlocking, iterationInfo) // fallback baseline (agent self-report)

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
              // Pass full user messages array for vision alignment evaluation
              const userMessages = state.userMessages || []

              reviewResult = await dispatchSelfReview(subagentDispatcher, {
                phase: state.phase,
                mode: state.mode,
                artifactPaths,
                criteriaText,
                ...(upstreamSummary ? { upstreamSummary } : {}),
                // Fallback: pass artifact content only if no disk path available
                ...(artifactContent ? { artifactContent } : {}),
                parentSessionId: sessionId ?? undefined,
                featureName: state.featureName,
                ...(userMessages.length > 0 ? { userMessages } : {}),
                ...(state.sessionModel ? { parentModel: state.sessionModel } : {}),
                ...(state.fileAllowlist.length > 0 ? { fileAllowlist: state.fileAllowlist } : {}),
                ...(Object.keys(state.approvedArtifacts).length > 0 ? { approvedArtifacts: state.approvedArtifacts } : {}),
                ...(Object.keys(state.artifactDiskPaths).length > 0 ? { artifactDiskPaths: state.artifactDiskPaths } : {}),
              })
            } catch (reviewErr) {
              // dispatchSelfReview should never throw (returns SelfReviewError),
              // but guard against unexpected runtime failures. Fall through to
              // use the agent's self-report as baseline.
              const errMsg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr)
              log.error("Self-review dispatch failed", { detail: errMsg })
            }

            if (reviewResult && !reviewResult.success) {
              log.warn(`Review ${iterationInfo.current}/${iterationInfo.max}: reviewer error — forcing revision cycle`)
              // When the isolated reviewer fails, don't silently fall back to self-report.
              // The agent's self-assessment is unreliable — it will self-report "all criteria met"
              // even when the artifact is clearly incomplete. Force the agent to REVISE with
              // explicit instructions to re-evaluate its work and address any issues before
              // re-submitting. This prevents the agent from getting a free pass to USER_GATE.
              result = {
                passed: false,
                unmetCriteria: [{
                  criterion: "Isolated reviewer could not evaluate",
                  met: false,
                  evidence: `Reviewer failed: ${reviewResult.errors?.join("; ") || "unknown error"}. Re-evaluate your work against all criteria, address any issues you find, and re-submit for review.`,
                  severity: "blocking" as const,
                }],
                metCount: 0,
                totalBlocking: expectedBlocking,
              }
            }

            if (reviewResult?.success) {
              const reviewerCriteria = ensureAllowlistCriterion(reviewResult.criteriaResults, state) as CriterionResult[]
              if (reviewerCriteria.length !== reviewResult.criteriaResults.length) {
                reviewResult = {
                  ...reviewResult,
                  satisfied: false,
                  criteriaResults: reviewerCriteria,
                }
              }
              // Isolated reviewer succeeded — use its verdict as authoritative truth.
              // Re-evaluate using the reviewer's criteria_results (same logic as agent path).
              // Pass expectedBlocking for cross-validation (same anti-gaming check as agent path).
              result = evaluateMarkSatisfied({
                criteria_met: reviewerCriteria.map((c) => ({
                  criterion: c.criterion,
                  met: c.met,
                  evidence: c.evidence,
                  severity: c.severity,
                  ...(typeof c.score === "number" ? { score: c.score } : {}),
                })),
              }, expectedBlocking, iterationInfo)

              // TUI toast: surface reviewer verdict to the user in real-time
              const metCount = reviewResult.criteriaResults.filter((c) => c.met).length
              const totalCount = reviewResult.criteriaResults.length
              const unmetCount = totalCount - metCount
              log.info(
                result.passed
                  ? `Review ${iterationInfo.current}/${iterationInfo.max}: PASSED (${metCount}/${totalCount} criteria met)`
                  : `Review ${iterationInfo.current}/${iterationInfo.max}: ${unmetCount} unmet criteria`,
              )

              // Agent rebuttal loop: when the review fails and we're one iteration
              // from the escalation cap, give the agent one chance to rebut criteria
              // that scored 7-8 (close to threshold). This avoids escalating to the
              // user over scope disagreements the reviewer might concede.
              const preEscalationIteration = state.iterationCount + 1 === MAX_REVIEW_ITERATIONS - 1
              if (!result.passed && preEscalationIteration) {
                // Find rebuttable criteria: unmet blocking with scores 7-8.
                // Design-invariant [D] criteria are NEVER rebuttable — they represent
                // binary structural questions from the design doc that require user
                // approval to deviate from, not quality judgments that can be argued.
                const rebuttableCriteria = result.unmetCriteria.filter(
                  (c) => typeof c.score === "number" && c.score >= 7 && c.score <= 8
                    && c.severity !== "design-invariant",
                )
                // Find agent's counterarguments for those same criteria
                const agentCounterargs = parsedArgs.criteria_met.filter((ac) =>
                  rebuttableCriteria.some((rc) => rc.criterion === ac.criterion) && ac.met,
                )
                if (rebuttableCriteria.length > 0 && agentCounterargs.length > 0) {
                  log.debug("Attempting rebuttal", { detail: `${rebuttableCriteria.length} criteria scoring 7-8` })
                  try {
                    const rebuttalResult = await dispatchRebuttal(subagentDispatcher, {
                      phase: state.phase,
                      mode: state.mode,
                      reviewerVerdict: rebuttableCriteria,
                      agentAssessment: agentCounterargs,
                      artifactPaths,
                      criteriaText,
                      parentSessionId: sessionId ?? undefined,
                      featureName: state.featureName,
                      parentModel: state.sessionModel ?? undefined,
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
                      }, expectedBlocking, iterationInfo)
                      if (result.passed) {
                        log.debug("Rebuttal accepted — review now passes")
                      } else {
                        log.debug("Rebuttal rejected — reviewer maintained position")
                      }
                    }
                    // If rebuttalResult.success === false, keep the original failing result
                  } catch (rebuttalErr) {
                    // Non-fatal — rebuttal failure does not change the review outcome
                    const errMsg = rebuttalErr instanceof Error ? rebuttalErr.message : String(rebuttalErr)
                    log.warn("Rebuttal dispatch failed", { detail: errMsg })
                  }
                }
              }
            }
            // If reviewer failed, result was set to "failed" above (forces revision).
            // If reviewer succeeded, result was set from reviewer's criteria.
            // If reviewer never ran (no criteriaText), result is agent's self-report.
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

          logTransition(state, outcome, `mark_satisfied/${event}`, notify)
          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.iterationCount = nextIterationCount
            draft.retryCount = 0
            // Store latest review results for the status file (Change 5)
            draft.latestReviewResults = parsedArgs.criteria_met.map((c) => ({
              criterion: c.criterion,
              met: c.met,
              evidence: c.evidence,
              ...(c.score !== undefined ? { score: String(c.score) } : {}),
            }))
            // Clear reviewArtifactHash when leaving REVIEW
            if (outcome.nextPhaseState !== "REVIEW") {
              draft.reviewArtifactHash = null
            }
            // Reset the user gate flag whenever we enter USER_GATE so the agent
            // cannot reuse a stale approval signal from a previous gate.
            if (outcome.nextPhaseState === "USER_GATE") {
              draft.userGateMessageReceived = false
            }
          })

          // Robot-artisan auto-approval: when the active agent is "robot-artisan"
          // and we've entered USER_GATE, dispatch an auto-approver instead of
          // waiting for human input. The auto-approver evaluates the artifact
          // and either approves (executing the phase transition inline) or returns
          // revision feedback for the agent to address.
          //
          // Fix: when the auto-approver approves, execute the approval state
          // transition HERE (inline), rather than returning an instruction for
          // the agent to call submit_feedback in a follow-up turn. The old
          // approach left the session at USER_GATE with no re-prompt mechanism:
          // the idle handler ignores USER_GATE (Fix 4 adds robot-artisan awareness
          // as a belt-and-suspenders safety net), so the session stalled silently
          // until the user poked it.
          const currentState = store.get(sessionId)
          if (
            outcome.nextPhaseState === "USER_GATE" &&
            currentState?.activeAgent === "robot-artisan"
          ) {
            try {
              const autoResult = await dispatchAutoApproval(subagentDispatcher, {
                phase: state.phase,
                mode: state.mode,
                artifactDiskPaths: state.artifactDiskPaths,
                featureName: state.featureName,
                conventionsPath: state.artifactDiskPaths["conventions"] ?? null,
                parentSessionId: sessionId ?? undefined,
                parentModel: state.sessionModel ?? undefined,
                isEscalation: hitIterationCap,
              })

              if (autoResult.success) {
                if (autoResult.approve) {
                  // Auto-approved: execute the phase transition inline so no follow-up
                  // submit_feedback call is needed. This eliminates the gap where the
                  // session would sit silently at USER_GATE waiting for the agent to act.
                  log.info("Robot-artisan: auto-approved inline", { detail: `confidence: ${autoResult.confidence.toFixed(2)}` })

                  const approveOutcome = sm.transition(state.phase, outcome.nextPhaseState, "user_approve", state.mode)
                  if (!approveOutcome.success) {
                    // SM rejected the transition — fall through to normal USER_GATE behavior
                    log.warn("Robot-artisan: inline approval SM transition failed", { detail: approveOutcome.message })
                  } else {
                    logTransition({ phase: state.phase, phaseState: outcome.nextPhaseState }, approveOutcome, "auto-approve/inline", notify)

                    // Forward-pass skip for the auto-approve path
                    const autoForwardSkip = computeForwardSkip(
                      approveOutcome.nextPhase,
                      state.mode,
                      state.fileAllowlist,
                    )
                    const autoEffectiveNextPhase = autoForwardSkip?.targetPhase ?? approveOutcome.nextPhase
                    const autoEffectiveNextPhaseState = autoForwardSkip?.targetPhaseState ?? approveOutcome.nextPhaseState

                    // Git checkpoint
                    const autoPhaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
                    const autoApprovalCount = state.approvalCount + 1
                    const autoExpectedFiles = deriveExpectedFiles(state)
                    const autoCheckpointOpts = {
                      phase: state.phase,
                      approvalCount: autoPhaseCount,
                      featureName: state.featureName,
                      expectedFiles: autoExpectedFiles,
                      ...(state.mode === "INCREMENTAL" ? { fileAllowlist: state.fileAllowlist } : {}),
                    }
                    const autoCheckpointResult = await createGitCheckpoint(
                      { cwd: context.directory || process.cwd() },
                      autoCheckpointOpts,
                    )

                    // Record artifact hash for the approved phase
                    const autoArtifactKey = PHASE_TO_ARTIFACT[state.phase]

                    await store.update(sessionId, (draft) => {
                      draft.phase = autoEffectiveNextPhase
                      draft.phaseState = autoEffectiveNextPhaseState
                      draft.approvalCount = autoApprovalCount
                      draft.phaseApprovalCounts[state.phase] = autoPhaseCount
                      draft.iterationCount = 0
                      draft.retryCount = 0
                      draft.userGateMessageReceived = false
                      if (autoCheckpointResult.success) {
                        draft.lastCheckpointTag = autoCheckpointResult.tag
                      }
                      if (autoArtifactKey) {
                        draft.approvedArtifacts[autoArtifactKey] = `approved-at-${Date.now()}`
                      }
                    })

                    const autoCheckpointMsg = autoCheckpointResult.success
                      ? ` Git checkpoint: \`${autoCheckpointResult.tag}\`.`
                      : ` (Git checkpoint failed: ${autoCheckpointResult.error})`
                    const autoForwardSkipMsg = autoForwardSkip ? `\n\n${autoForwardSkip.message}` : ""

                    return (
                      `**Auto-approved** (robot-artisan mode, confidence: ${autoResult.confidence.toFixed(2)}).${autoCheckpointMsg}\n\n` +
                      `${autoResult.reasoning}\n\n` +
                      `Advanced to **${autoEffectiveNextPhase}/${autoEffectiveNextPhaseState}**.` +
                      autoForwardSkipMsg
                    )
                  }
                } else {
                  // Auto-approve rejected: return revision feedback for the agent to address.
                  // Stay at USER_GATE — the agent must revise and re-submit.
                  log.info("Robot-artisan: auto-approve rejected", { detail: `confidence: ${autoResult.confidence.toFixed(2)}` })
                  return (
                    `**Auto-approve rejected** (robot-artisan mode, confidence: ${autoResult.confidence.toFixed(2)}).\n\n` +
                    `${autoResult.reasoning}\n\n` +
                    `**Required revisions:**\n${autoResult.feedback ?? "Address quality issues and re-submit."}\n\n` +
                    `Call \`submit_feedback\` with \`feedback_type: "revise"\` and the revision feedback in \`feedback_text\` to re-enter REVISE.`
                  )
                }
              }
              // autoResult.success === false — fall through to normal USER_GATE behavior
              log.warn("Robot-artisan: auto-approval failed, falling back to manual", { detail: autoResult.error })
            } catch (autoErr) {
              // Non-fatal — fall through to normal USER_GATE behavior
              const errMsg = autoErr instanceof Error ? autoErr.message : String(autoErr)
              log.warn("Robot-artisan: auto-approval dispatch error", { detail: errMsg })
            }
          }

          if (hitIterationCap) {
            // Build a structured verdict table for the user. The agent MUST
            // present this verbatim — not paraphrased — so the user sees the
            // reviewer's actual assessment, not the agent's interpretation.
            const verdictRows = result.unmetCriteria.map((c) => {
              const scoreCol = typeof c.score === "number" ? `${c.score}/10` : "—"
              const statusCol = c.met ? "MET" : "UNMET"
              return `| ${c.criterion} | ${statusCol} | ${scoreCol} | ${c.evidence} |`
            }).join("\n")
            const verdictTable = (
              `| Criterion | Status | Score | Reviewer Evidence |\n` +
              `|-----------|--------|-------|-------------------|\n` +
              verdictRows
            )

            log.warn(`Review escalation: ${result.unmetCriteria.length} unresolved criteria after ${MAX_REVIEW_ITERATIONS} iterations`)

            return (
              `Self-review reached the maximum of ${MAX_REVIEW_ITERATIONS} iterations without resolving all blocking criteria.\n\n` +
              `**IMPORTANT:** Present the following reviewer verdict table to the user EXACTLY as shown — do NOT paraphrase or summarize. ` +
              `The user needs the reviewer's actual scores and evidence to make an informed decision.\n\n` +
              `**Reviewer Verdict (${result.unmetCriteria.length} unresolved):**\n\n` +
              `${verdictTable}\n\n` +
              `Ask the user whether to:\n` +
              `1. **Approve** the artifact as-is (if they disagree with the reviewer's assessment)\n` +
              `2. **Revise** with specific guidance on which criteria to address\n`
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
          "Triggers an isolated per-task reviewer that runs tests, checks interface alignment, " +
          "and verifies no regressions. If the review passes, updates the DAG and returns the " +
          "next task. If the review fails, returns specific issues to fix before re-calling.",
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
          context: ToolExecuteContext,
        ) {
          const { store, log, notify, subagentDispatcher } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          if (state.phase !== "IMPLEMENTATION") {
            return `Error: mark_task_complete can only be called during the IMPLEMENTATION phase (current: ${state.phase}).`
          }

          if (state.phaseState !== "DRAFT" && state.phaseState !== "REVISE") {
            return `Error: mark_task_complete can only be called in DRAFT or REVISE state (current: ${state.phase}/${state.phaseState}).`
          }

          // Re-entry guard (14.1): prevent concurrent mark_task_complete calls.
          // Per-task review + DAG mutation is not atomic — concurrent calls could
          // corrupt the DAG or double-dispatch the same task.
          if (state.taskCompletionInProgress) {
            return (
              `Error: mark_task_complete is already in progress for task "${state.taskCompletionInProgress}". ` +
              `Wait for the current completion to finish before calling again.`
            )
          }

          // Set the re-entry guard and increment task review counter
          await store.update(sessionId, (draft) => {
            draft.taskCompletionInProgress = args.task_id
            draft.taskReviewCount += 1
          })

          // Everything below is wrapped in try/finally to guarantee the
          // re-entry guard is cleared on every exit path (success, failure, error).
          try {
            const result = processMarkTaskComplete(args, state.implDag, state.currentTaskId)

            if ("error" in result) return `Error: ${result.error}`

            // Per-task review: dispatch a lightweight subagent to verify the task
            // was implemented correctly before marking it complete in the DAG.
            // The reviewer runs tests, checks interface alignment, and verifies
            // no regressions. If the review fails, the task is NOT marked complete
            // and the agent must fix the issues before re-calling mark_task_complete.
            //
            // 14.4: Skip per-task review if the iteration cap has been reached.
            // The agent has tried MAX_TASK_REVIEW_ITERATIONS times — accept the task
            // and let the full implementation review catch outstanding issues.
            const reviewCapped = state.taskReviewCount + 1 >= MAX_TASK_REVIEW_ITERATIONS
            const taskNode = state.implDag?.find((t) => t.id === args.task_id)
            if (taskNode && !reviewCapped) {
              // Compute adjacent tasks for integration seam checking
              const adjacentTasks: AdjacentTask[] = []
              if (state.implDag) {
                // Upstream: tasks this task depends on (direct dependencies only)
                for (const depId of taskNode.dependencies) {
                  const dep = state.implDag.find((t) => t.id === depId)
                  if (dep) {
                    adjacentTasks.push({
                      id: dep.id,
                      description: dep.description,
                      category: dep.category,
                      status: dep.status,
                      direction: "upstream",
                    })
                  }
                }
                // Downstream: tasks that directly depend on this task
                for (const t of state.implDag) {
                  if (t.dependencies.includes(taskNode.id)) {
                    adjacentTasks.push({
                      id: t.id,
                      description: t.description,
                      category: t.category,
                      status: t.status,
                      direction: "downstream",
                    })
                  }
                }
              }

              let taskReviewResult: Awaited<ReturnType<typeof dispatchTaskReview>> | null = null
              try {
                taskReviewResult = await dispatchTaskReview(subagentDispatcher, {
                  task: taskNode,
                  implementationSummary: args.implementation_summary,
                  mode: state.mode,
                  cwd: context.directory || process.cwd(),
                  parentSessionId: sessionId ?? undefined,
                  featureName: state.featureName,
                  parentModel: state.sessionModel ?? undefined,
                  conventions: state.conventions,
                  artifactDiskPaths: state.artifactDiskPaths,
                  adjacentTasks: adjacentTasks.length > 0 ? adjacentTasks : undefined,
                  stateDir,
                })
              } catch (reviewErr) {
                // dispatchTaskReview should never throw (returns TaskReviewError),
                // but guard against unexpected runtime failures. Fall through to
                // accept the task (graceful degradation — full review catches issues later).
                const errMsg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr)
                log.warn("Task review dispatch failed", { detail: errMsg })
              }

              // If the task review succeeded and found issues, reject the completion.
              // The agent must fix the issues and re-call mark_task_complete.
              if (taskReviewResult?.success && !taskReviewResult.passed) {
                const issuesList = taskReviewResult.issues.map((i) => `  - ${i}`).join("\n")
                return (
                  `Task "${args.task_id}" did NOT pass the per-task review ` +
                  `(attempt ${state.taskReviewCount + 1}/${MAX_TASK_REVIEW_ITERATIONS}). ` +
                  `Fix the following issues before calling \`mark_task_complete\` again:\n\n` +
                  `**Issues found:**\n${issuesList}\n\n` +
                  `**Reviewer reasoning:** ${taskReviewResult.reasoning}\n\n` +
                  `Address each issue, ensure all tests pass, then re-call \`mark_task_complete\`.`
                )
              }
              // If taskReviewResult is null (dispatch failed) or success===false (error),
              // force the agent to re-evaluate instead of silently accepting.
              // The agent's self-assessment is unreliable — it will claim the task is done
              // even when it isn't. Force the agent to fix issues and re-submit.
              if (!taskReviewResult || !taskReviewResult.success) {
                log.warn(`Per-task review failed for ${args.task_id} — forcing re-evaluation`)
                return (
                  `Task "${args.task_id}" could not be reviewed — the reviewer returned an error.\n\n` +
                  `Re-evaluate your work against the task description and acceptance criteria. ` +
                  `Fix any issues you find, ensure all tests pass, then re-call \`mark_task_complete\`.`
                )
              }
            } else if (reviewCapped) {
              log.warn("Per-task review cap reached", {
                detail: `Task ${args.task_id}: ${MAX_TASK_REVIEW_ITERATIONS} attempts — bypassing review`,
              })
            }

            // Per-task drift check (14.2): after review passes, check if the
            // implementation has drifted from the plan in ways that affect
            // downstream tasks. If drift is detected, update their descriptions.
            // This is the X_ALIGN -> O_ASSESS path from the original design.
            if (taskNode && state.implDag && state.implDag.length > 1) {
              try {
                const driftResult = await dispatchDriftCheck(subagentDispatcher, {
                  task: taskNode,
                  implementationSummary: args.implementation_summary,
                  dagTasks: state.implDag,
                  parentSessionId: sessionId ?? undefined,
                  parentModel: state.sessionModel ?? undefined,
                })
                if (driftResult.success && driftResult.driftDetected) {
                  // Patch downstream task descriptions in the result nodes
                  for (const node of result.updatedNodes) {
                    const updated = driftResult.updatedDescriptions[node.id]
                    if (updated) {
                      node.description = updated
                    }
                  }
                  log.info("Per-task drift correction applied", {
                    detail: `${Object.keys(driftResult.updatedDescriptions).length} task description(s) updated after ${args.task_id}`,
                  })
                }
                // If driftResult.success is false, gracefully degrade — accept the task as-is
              } catch (driftErr) {
                const errMsg = driftErr instanceof Error ? driftErr.message : String(driftErr)
                log.warn("Drift check threw unexpectedly", { detail: errMsg })
                // Graceful degradation — accept the task as-is
              }
            }

            // Persist the updated DAG and set currentTaskId to the next dispatched task.
            // Reset taskReviewCount when moving to a new task (14.4).
            await store.update(sessionId, (draft) => {
              draft.implDag = result.updatedNodes
              draft.currentTaskId = result.nextTaskId
              if (result.nextTaskId !== args.task_id) {
                draft.taskReviewCount = 0
              }
            })

            // If all remaining tasks are blocked behind human gates, handle based on agent mode.
            if (result.awaitingHuman) {
              const currentState = store.get(sessionId)

              // Robot-artisan mode: auto-abort human-gated tasks and their dependents
              // instead of waiting for human resolution. The robot can't provision
              // infrastructure or configure credentials — it aborts those tasks and
              // continues with any remaining non-blocked work, or proceeds to review.
              if (currentState?.activeAgent === "robot-artisan" && currentState.implDag) {
                const dag = createImplDAG(Array.from(currentState.implDag))
                const humanGated = Array.from(dag.tasks).filter(
                  (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
                )
                const abortedIds: string[] = []

                for (const gate of humanGated) {
                  // Abort the gate task itself
                  gate.status = "aborted"
                  abortedIds.push(gate.id)
                  // Abort all dependents (transitively)
                  for (const dep of dag.getDependents(gate.id)) {
                    if (dep.status !== "complete" && dep.status !== "aborted") {
                      dep.status = "aborted"
                      abortedIds.push(dep.id)
                    }
                  }
                }

                const updatedNodes = Array.from(dag.tasks).map((t) => ({
                  ...t,
                  ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
                }))

                // Check if there's remaining non-blocked work
                const remaining = updatedNodes.filter(
                  (t) => t.status !== "complete" && t.status !== "aborted" && t.status !== "human-gated",
                )

                if (remaining.length > 0) {
                  // More work to do — stay in DRAFT with updated DAG
                  const nextReady = remaining.find(
                    (t) => t.status === "pending" && t.dependencies.every(
                      (dep) => updatedNodes.find((d) => d.id === dep)?.status === "complete",
                    ),
                  )
                  await store.update(sessionId, (draft) => {
                    draft.implDag = updatedNodes
                    draft.currentTaskId = nextReady?.id ?? null
                  })
                  log.info("Robot-artisan: auto-aborted human gates", {
                    detail: `${abortedIds.length} tasks aborted: ${abortedIds.join(", ")}`,
                  })
                  return (
                    result.responseMessage + "\n\n" +
                    `**Robot-artisan mode:** Auto-aborted ${humanGated.length} human-gated task(s) and ` +
                    `${abortedIds.length - humanGated.length} dependent(s): ${abortedIds.join(", ")}.\n` +
                    `These tasks require human action that cannot be automated.\n\n` +
                    (nextReady
                      ? `**Next task ready:** ${nextReady.id} — ${nextReady.description}\nContinue with this task.`
                      : `No more ready tasks. Call \`request_review\` to submit the partial implementation.`)
                  )
                } else {
                  // All remaining work is human-gated or aborted — proceed to review
                  await store.update(sessionId, (draft) => {
                    draft.implDag = updatedNodes
                    draft.currentTaskId = null
                  })
                  log.info("Robot-artisan: all remaining tasks human-gated, proceeding to review", {
                    detail: `${abortedIds.length} tasks aborted`,
                  })
                  return (
                    result.responseMessage + "\n\n" +
                    `**Robot-artisan mode:** Auto-aborted ${abortedIds.length} human-gated task(s) and dependents.\n` +
                    `All remaining work requires human action. Call \`request_review\` to submit the partial implementation for review.`
                  )
                }
              }

              // Artisan mode (or unknown): advance to USER_GATE for human resolution
              log.info("Auto-advancing to USER_GATE for human gate resolution")
              if (currentState && (currentState.phaseState === "DRAFT" || currentState.phaseState === "REVISE")) {
                // Transition through REVIEW → USER_GATE (skipping self-review since
                // the implementation isn't complete — we're just presenting human gates)
                await store.update(sessionId, (draft) => {
                  draft.phaseState = "USER_GATE"
                  draft.iterationCount = 0
                  draft.retryCount = 0
                  draft.userGateMessageReceived = false
                })
                logTransition(
                  currentState,
                  { phase: currentState.phase, phaseState: "USER_GATE" },
                  "mark_task_complete/awaiting-human",
                  notify,
                )
              }
            }

            return result.responseMessage
          } finally {
            // Clear the re-entry guard on every exit path
            try {
              await store.update(sessionId, (draft) => {
                draft.taskCompletionInProgress = null
              })
            } catch (cleanupErr) {
              log.warn("Failed to clear taskCompletionInProgress", {
                detail: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                sessionId,
              })
            }
          }
        },
      }),

      // -----------------------------------------------------------------------
      // resolve_human_gate — agent declares a task needs human action
      // -----------------------------------------------------------------------
      resolve_human_gate: tool({
        description:
          "Call when you encounter a task that requires human action before it can be implemented " +
          "(e.g. provisioning infrastructure, configuring credentials, signing up for external services). " +
          "This tool sets the task to 'human-gated' status with a description of what the user needs to do. " +
          "The scheduler will hold this task until the user resolves it at USER_GATE. " +
          "Only call this for tasks with category 'human-gate' in the implementation plan.",
        args: {
          task_id: tool.schema.string().describe(
            "The DAG task ID of the human-gate task being activated.",
          ),
          what_is_needed: tool.schema.string().describe(
            "Description of what the human needs to do (e.g. 'Configure AWS S3 credentials in .env').",
          ),
          why: tool.schema.string().describe(
            "Why this human action is needed for the implementation.",
          ),
          verification_steps: tool.schema.string().describe(
            "Steps the human can take to verify the gate is resolved (e.g. 'Run `aws s3 ls` to confirm access').",
          ),
        },
        async execute(
          args: { task_id: string; what_is_needed: string; why: string; verification_steps: string },
          context: ToolExecuteContext,
        ) {
          const { store, log, notify } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          if (state.phase !== "IMPLEMENTATION") {
            return `Error: resolve_human_gate can only be called during IMPLEMENTATION (current: ${state.phase}).`
          }

          if (!state.implDag || state.implDag.length === 0) {
            return "Error: No implementation DAG found. Cannot resolve human gate without a DAG."
          }

          const task = state.implDag.find((t) => t.id === args.task_id)
          if (!task) {
            const ids = state.implDag.map((t) => t.id).join(", ")
            return `Error: Task "${args.task_id}" not found in DAG. Valid IDs: ${ids}`
          }

          // Only human-gate tasks should be resolved this way
          if (task.category !== "human-gate") {
            return (
              `Error: Task "${args.task_id}" has category "${task.category ?? "standalone"}" — ` +
              `only tasks with category "human-gate" can be resolved via this tool.`
            )
          }

          // Task must be pending or already human-gated (idempotent)
          if (task.status !== "pending" && task.status !== "human-gated") {
            return (
              `Error: Task "${args.task_id}" has status "${task.status}" — ` +
              `only "pending" or "human-gated" tasks can be activated as human gates.`
            )
          }

          // Update the task in the DAG
          await store.update(sessionId, (draft) => {
            const dagTask = draft.implDag?.find((t) => t.id === args.task_id)
            if (dagTask) {
              dagTask.status = "human-gated"
              dagTask.humanGate = {
                whatIsNeeded: args.what_is_needed,
                why: args.why,
                verificationSteps: args.verification_steps,
                resolved: false,
              }
            }
          })

          log.info("Human gate activated", { detail: `${args.task_id}: ${args.what_is_needed}` })

          // Check if all remaining work is now blocked behind human gates
          const updatedState = store.get(sessionId)
          if (updatedState?.implDag) {
            const dag = createImplDAG(updatedState.implDag)
            const decision = nextSchedulerDecision(dag)
            if (decision.action === "awaiting-human") {
              // Robot-artisan mode: auto-abort human gates instead of advancing to USER_GATE
              if (updatedState.activeAgent === "robot-artisan") {
                const humanGated = Array.from(dag.tasks).filter(
                  (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
                )
                const abortedIds: string[] = []
                for (const gate of humanGated) {
                  gate.status = "aborted"
                  abortedIds.push(gate.id)
                  for (const dep of dag.getDependents(gate.id)) {
                    if (dep.status !== "complete" && dep.status !== "aborted") {
                      dep.status = "aborted"
                      abortedIds.push(dep.id)
                    }
                  }
                }
                const updatedNodes = Array.from(dag.tasks).map((t) => ({
                  ...t,
                  ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
                }))
                await store.update(sessionId, (draft) => {
                  draft.implDag = updatedNodes
                  draft.currentTaskId = null
                })
                log.info("Robot-artisan: auto-aborted human gates from resolve_human_gate", {
                  detail: `${abortedIds.length} tasks aborted`,
                })
                return (
                  `Human gate activated for task "${args.task_id}".\n\n` +
                  `**Robot-artisan mode:** Auto-aborted ${abortedIds.length} human-gated task(s) and dependents.\n` +
                  `These tasks require human action that cannot be automated.\n\n` +
                  `Call \`request_review\` to submit the partial implementation for review.`
                )
              }

              // Artisan mode: auto-advance to USER_GATE for human resolution
              await store.update(sessionId, (draft) => {
                draft.implDag = Array.from(dag.tasks).map((t) => ({
                  ...t,
                  ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
                }))
                draft.phaseState = "USER_GATE"
                draft.iterationCount = 0
                draft.retryCount = 0
                draft.userGateMessageReceived = false
                draft.currentTaskId = null
              })
              logTransition(
                updatedState,
                { phase: updatedState.phase, phaseState: "USER_GATE" },
                "resolve_human_gate/awaiting-human",
                notify,
              )

              const gateList = decision.humanGatedTasks
                .map((g) => `  - **${g.id}:** ${g.whatIsNeeded}`)
                .join("\n")
              return (
                `Human gate activated for task "${args.task_id}".\n\n` +
                `**All remaining work is blocked behind human gates.** ` +
                `Auto-advancing to USER_GATE for user resolution.\n\n` +
                `**Unresolved human gates:**\n${gateList}\n\n` +
                `Present these gates to the user and wait for their confirmation.`
              )
            }

            // Persist auto-transitioned human-gate tasks from scheduler
            await store.update(sessionId, (draft) => {
              draft.implDag = Array.from(dag.tasks).map((t) => ({
                ...t,
                ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
              }))
            })

            // There's still dispatchable work — tell the agent to continue
            if (decision.action === "dispatch") {
              return (
                `Human gate activated for task "${args.task_id}". ` +
                `The user will be asked to resolve it at the next USER_GATE.\n\n` +
                `**Next task ready:** ${decision.task.id} — ${decision.task.description}\n` +
                `Continue with the next task.`
              )
            }
          }

          return (
            `Human gate activated for task "${args.task_id}".\n` +
            `**What is needed:** ${args.what_is_needed}\n` +
            `**Verification:** ${args.verification_steps}\n\n` +
            `The user will be asked to resolve this gate at USER_GATE.`
          )
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
          context: ToolExecuteContext,
        ) {
          const { store, sm, log, notify } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          const validStates = ["DRAFT", "CONVENTIONS", "REVISE", "REVIEW"]
          if (!validStates.includes(state.phaseState)) {
            return `Error: request_review can only be called from DRAFT/CONVENTIONS/REVISE/REVIEW state (current: ${state.phaseState}).`
          }

          // Re-submit at REVIEW: the agent realized the artifact content is stale
          // or wrong and wants to update it before the reviewer sees it. Overwrite
          // the artifact on disk and restart the review cycle (reset iterationCount).
          // No state machine transition — we stay in REVIEW.
          if (state.phaseState === "REVIEW") {
            if (!args.artifact_content) {
              return (
                "Error: request_review at REVIEW state requires artifact_content — " +
                "you must provide the updated artifact text to replace the version on disk."
              )
            }
            let artifactDiskPath: string | null = null
            const artifactKey = PHASE_TO_ARTIFACT[state.phase]
            if (artifactKey && artifactKey !== "implementation") {
              try {
                const cwd = context.directory || process.cwd()
                artifactDiskPath = await writeArtifact(cwd, artifactKey, args.artifact_content, state.featureName)
              } catch (writeErr) {
                log.warn("Failed to re-write artifact to disk on re-submit")
              }
            }
            // Capture hash from disk after writing (same as main request_review path).
            // Without this, mark_satisfied compares against a stale hash and rejects.
            let reviewHash: string | null = null
            if (artifactDiskPath) {
              try {
                const diskContent = await readFile(artifactDiskPath, "utf-8")
                reviewHash = artifactHash(diskContent)
              } catch { /* non-fatal */ }
            } else if (args.artifact_content) {
              reviewHash = artifactHash(args.artifact_content)
            }
            await store.update(sessionId, (draft) => {
              draft.iterationCount = 0
              draft.retryCount = 0
              draft.reviewArtifactHash = reviewHash
              if (artifactDiskPath) {
                if (artifactKey) draft.artifactDiskPaths[artifactKey] = artifactDiskPath
              }
            })
            // Refetch state after update
            const updatedState = store.get(sessionId) || state
            const diskMsg = artifactDiskPath
              ? `\nArtifact updated on disk at \`${artifactDiskPath}\`.`
              : ""
            return (
              `Artifact re-submitted for ${updatedState.phase} review. The on-disk version has been updated.${diskMsg}\n\n` +
              `Review cycle restarted (iteration count reset to 0). ` +
              `Now call \`mark_satisfied\` with your criteria evaluation to proceed with the review.`
            )
          }

          // Hard gate: during IMPLEMENTATION, request_review is only allowed when
          // all agent-dispatchable DAG tasks are complete. Human-gated tasks are
          // excluded — the agent can request review to present human gates at USER_GATE.
          // This prevents the agent from skipping tasks and jumping straight to review.
          if (state.phase === "IMPLEMENTATION" && state.implDag && state.implDag.length > 0) {
            const dag = createImplDAG(Array.from(state.implDag))
            if (!dag.isComplete()) {
              const tasks = Array.from(dag.tasks)
              // Check if the only non-complete tasks are human-gated or aborted
              const agentIncomplete = tasks.filter(
                (t) => t.status !== "complete" && t.status !== "aborted" && t.status !== "human-gated",
              )
              if (agentIncomplete.length > 0) {
                const complete = tasks.filter((t) => t.status === "complete").length
                const total = tasks.length
                const pendingList = agentIncomplete.map((t) => `  - ${t.id}: ${t.description} (${t.status})`).join("\n")
                return (
                  `Error: Cannot request review — ${complete}/${total} DAG tasks are complete. ` +
                  `All agent tasks must be completed via \`mark_task_complete\` before requesting review.\n\n` +
                  `**Remaining agent tasks:**\n${pendingList}\n\n` +
                  `Complete the current task and call \`mark_task_complete\`, then continue with the remaining tasks.`
                )
              }
              // Only human-gated/aborted tasks remain — allow request_review to present gates at USER_GATE
            }
          }

          // Hard gate: artifact diff check for REVISE state.
          // Prevents the agent from calling request_review without actually making
          // changes to address the revision feedback. The baseline was captured
          // at REVISE entry by the submit_feedback handler.
          if (state.phaseState === "REVISE" && state.revisionBaseline) {
            try {
              const changed = await hasArtifactChanged(
                state.revisionBaseline,
                state.phase,
                args.artifact_content,
                state,
                context.directory || process.cwd(),
              )
              if (!changed) {
                // Cascade active (has remaining steps) → delegate to cascadeAutoSkip
                // which loops through consecutive no-op steps and fast-forwards to USER_GATE.
                // Only for actual cascades (pendingRevisionSteps non-null AND non-empty,
                // OR empty=last cascade step which cascadeAutoSkip handles).
                // null means "no cascade context" (standalone REVISE) → hard block.
                if (state.pendingRevisionSteps !== null) {
                  const skipMsg = await cascadeAutoSkip({ store, sm, log }, sessionId, context.directory || process.cwd())
                  if (skipMsg) return skipMsg
                  // cascadeAutoSkip returned null → couldn't determine skip
                  // (e.g., pendingRevisionSteps was [] and SM transitions failed).
                  // Fall through to hard block.
                }

                // Standalone REVISE (no cascade) or cascade skip failed — hard block
                return (
                  `Error: Cannot request review — no changes detected since entering REVISE. ` +
                  `The artifact appears unchanged from the baseline captured when revision began.\n\n` +
                  `You must actually modify the artifact to address the revision feedback before calling \`request_review\`. ` +
                  `Review the feedback, make the requested changes, then call \`request_review\` again.`
                )
              }
            } catch (diffErr) {
              // Non-fatal — if the diff check fails, allow through (graceful degradation).
              // The self-review will still evaluate quality.
              const errMsg = diffErr instanceof Error ? diffErr.message : String(diffErr)
              log.debug("Revision diff check failed", { detail: errMsg })
            }
          }

          const event = state.phaseState === "REVISE" ? "revision_complete"
                      : state.phaseState === "REVIEW" ? "self_review_pass"
                      : "draft_complete"
          const outcome = sm.transition(state.phase, state.phaseState, event, state.mode)
          if (!outcome.success) return `Error: ${outcome.message}`

          logTransition(state, outcome, `request_review/${event}`, notify)
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
                log.warn("Failed to write artifact draft to disk")
              }
            }
          }

          // Capture artifact hash for review integrity check (Change 4).
          // IMPORTANT: hash the FILE on disk, not the in-memory content.
          // writeFile and readFile may handle encoding differently (line endings, BOM).
          // Writing first then reading ensures the hash matches what mark_satisfied will see.
          let reviewHash: string | null = null
          if (artifactDiskPath) {
            try {
              const diskContent = await readFile(artifactDiskPath, "utf-8")
              reviewHash = artifactHash(diskContent)
            } catch { /* non-fatal — hash gate disabled if file unreadable */ }
          } else if (args.artifact_content) {
            // No disk write happened (e.g., implementation artifact) — hash in-memory
            reviewHash = artifactHash(args.artifact_content)
          } else {
            // No artifact_content and no disk write — try to hash existing file
            const artifactKey = PHASE_TO_ARTIFACT[state.phase]
            const diskPath = artifactKey ? state.artifactDiskPaths[artifactKey] : null
            if (diskPath) {
              try {
                const content = await readFile(diskPath, "utf-8")
                reviewHash = artifactHash(content)
              } catch { /* non-fatal — hash gate disabled if file unreadable */ }
            }
          }

          await store.update(sessionId, (draft) => {
            draft.phase = outcome.nextPhase
            draft.phaseState = outcome.nextPhaseState
            draft.retryCount = 0
            // Clear revision baseline — we're leaving REVISE
            draft.revisionBaseline = null
            // Capture artifact hash for review integrity (mark_satisfied checks this)
            draft.reviewArtifactHash = reviewHash
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
          resolved_human_gates: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "For IMPLEMENTATION/USER_GATE: list of human-gated task IDs that the user " +
              "confirms are resolved. Each listed task must have status 'human-gated'. " +
              "The user is confirming they have completed the required infrastructure/credential setup.",
            ),
        },
        async execute(
          args: {
            feedback_text: string
            feedback_type: "approve" | "revise"
            artifact_content?: string
            approved_files?: string[]
            resolved_human_gates?: string[]
          },
          context: ToolExecuteContext,
        ) {
          const { store, sm, log, notify, orchestrator } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          if (state.phaseState !== "USER_GATE" && state.phaseState !== "ESCAPE_HATCH") {
            return `Error: submit_feedback can only be called at USER_GATE or ESCAPE_HATCH (current: ${state.phaseState}).`
          }

          const result = processSubmitFeedback(args)

          if (result.feedbackType === "approve") {
            // Structural guard: approval is impossible in ESCAPE_HATCH state.
            // The state machine rejects user_approve in ESCAPE_HATCH, but we
            // catch it here with a clear error message before even trying.
            if (state.phaseState === "ESCAPE_HATCH") {
              return (
                "Error: Cannot approve while an escape hatch is pending. " +
                "You must respond to the escape hatch first (accept, provide alternative direction, or abort). " +
                "Call submit_feedback with feedback_type='revise' and your response."
              )
            }
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

            // Human gate resolution: when approving at IMPLEMENTATION/USER_GATE and there
            // are human-gated tasks, the user must explicitly list which gates they've resolved.
            // This is a special approval path — we resolve the gates and return to DRAFT to
            // continue implementation (not advance to the next phase).
            if (state.phase === "IMPLEMENTATION" && state.implDag && args.resolved_human_gates && args.resolved_human_gates.length > 0) {
              const dag = createImplDAG(Array.from(state.implDag))
              const resolvedIds: string[] = []
              const errors: string[] = []

              for (const gateId of args.resolved_human_gates) {
                const resolved = resolveHumanGate(dag, gateId)
                if (resolved) {
                  resolvedIds.push(gateId)
                } else {
                  const task = Array.from(dag.tasks).find((t) => t.id === gateId)
                  if (!task) {
                    errors.push(`Task "${gateId}" not found in DAG`)
                  } else if (task.status !== "human-gated") {
                    errors.push(`Task "${gateId}" is not human-gated (status: ${task.status})`)
                  }
                }
              }

              if (errors.length > 0) {
                return `Error resolving human gates:\n${errors.map((e) => `  - ${e}`).join("\n")}`
              }

              // Check if there's still work to do after resolving gates
              const nextDecision = nextSchedulerDecision(dag)
              const updatedNodes = Array.from(dag.tasks).map((t) => ({
                ...t,
                ...(t.humanGate ? { humanGate: { ...t.humanGate } } : {}),
              }))

              // Check for any remaining unresolved human gates
              const remainingGates = Array.from(dag.tasks).filter(
                (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
              )

              if (remainingGates.length > 0) {
                // Still have unresolved gates — warn the user
                const gateList = remainingGates
                  .map((t) => `  - **${t.id}:** ${t.humanGate?.whatIsNeeded ?? t.description}`)
                  .join("\n")

                await store.update(sessionId, (draft) => {
                  draft.implDag = updatedNodes
                  // Stay at USER_GATE — there are still unresolved gates
                  draft.userGateMessageReceived = false
                })

                return (
                  `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
                  `**${remainingGates.length} unresolved gate(s) remain:**\n${gateList}\n\n` +
                  `Please resolve these and call \`submit_feedback\` again with \`resolved_human_gates\`.` +
                  approvalWarning
                )
              }

              if (nextDecision.action === "complete") {
                // All tasks done — proceed to normal approval flow (fall through below)
                await store.update(sessionId, (draft) => {
                  draft.implDag = updatedNodes
                })
                // Don't return — fall through to normal approval path
              } else if (nextDecision.action === "dispatch") {
                // There's more implementation work to do — go back to DRAFT
                logTransition(state, { phase: "IMPLEMENTATION", phaseState: "DRAFT" }, "submit_feedback/human-gate-resolved", notify)

                await store.update(sessionId, (draft) => {
                  draft.implDag = updatedNodes
                  draft.phase = "IMPLEMENTATION"
                  draft.phaseState = "DRAFT"
                  draft.currentTaskId = nextDecision.task.id
                  draft.iterationCount = 0
                  draft.retryCount = 0
                  draft.userGateMessageReceived = false
                })

                return (
                  `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
                  `Returning to IMPLEMENTATION/DRAFT — downstream tasks are now unblocked.\n\n` +
                  `**Next task ready:**\n${nextDecision.prompt}\n\n` +
                  `Progress: ${nextDecision.progress.complete}/${nextDecision.progress.total} tasks complete.` +
                  approvalWarning
                )
              } else {
                // Blocked or error — persist what we have and report
                await store.update(sessionId, (draft) => {
                  draft.implDag = updatedNodes
                })
                return (
                  `Resolved ${resolvedIds.length} human gate(s): ${resolvedIds.join(", ")}.\n\n` +
                  `However, the scheduler reports: ${nextDecision.message}` +
                  approvalWarning
                )
              }
            }

            // Guard: block approval at IMPLEMENTATION/USER_GATE if unresolved human gates exist
            // and the user didn't provide resolved_human_gates. The user must explicitly confirm
            // each gate before the implementation can proceed.
            if (
              state.phase === "IMPLEMENTATION" &&
              state.implDag &&
              (!args.resolved_human_gates || args.resolved_human_gates.length === 0)
            ) {
              const unresolvedGates = state.implDag.filter(
                (t) => t.status === "human-gated" && (!t.humanGate || !t.humanGate.resolved),
              )
              if (unresolvedGates.length > 0) {
                const gateList = unresolvedGates
                  .map((t) => `  - **${t.id}:** ${t.humanGate?.whatIsNeeded ?? t.description}\n    Verify: ${t.humanGate?.verificationSteps ?? "N/A"}`)
                  .join("\n")
                return (
                  `Cannot approve — ${unresolvedGates.length} unresolved human gate(s):\n\n` +
                  `${gateList}\n\n` +
                  `Please complete the required actions above, then call \`submit_feedback\` with ` +
                  `\`resolved_human_gates\` listing the task IDs you've resolved.`
                )
              }
            }

            // Cascade-aware auto-advance: if pendingRevisionSteps are set, this
            // approval is for a cascade step — auto-advance to the next step's
            // REVISE instead of following the normal phase progression. This
            // prevents the user from having to approve each no-op cascade step
            // individually.
            if (state.pendingRevisionSteps && state.pendingRevisionSteps.length > 0) {
              const nextStep = state.pendingRevisionSteps[0]!
              const remainingSteps = state.pendingRevisionSteps.slice(1)

              // Capture baseline for the next cascade step
              let nextBaseline: WorkflowState["revisionBaseline"] = null
              try {
                nextBaseline = await captureRevisionBaseline(
                  nextStep.phase,
                  state,
                  context.directory || process.cwd(),
                )
              } catch { /* non-fatal */ }

              logTransition(state, { phase: nextStep.phase, phaseState: "REVISE" }, "submit_feedback/cascade-advance", notify)

              await store.update(sessionId, (draft) => {
                draft.phase = nextStep.phase
                draft.phaseState = "REVISE"
                draft.pendingRevisionSteps = remainingSteps
                draft.revisionBaseline = nextBaseline
                draft.retryCount = 0
                draft.iterationCount = 0
                draft.userGateMessageReceived = false
              })

              log.info("Cascade auto-advance on approval", { detail: `${state.phase}/USER_GATE → ${nextStep.phase}/REVISE` })

              // Deterministic auto-skip: check if this step (and subsequent steps)
              // can be skipped because no artifact changes are needed.
              const skipMsg = await cascadeAutoSkip({ store, sm, log }, sessionId, context.directory || process.cwd())
              if (skipMsg) return skipMsg + approvalWarning

              // Next step needs work — tell the agent to proceed
              const updatedState = store.get(sessionId)
              return (
                `**${state.phase}** approved — cascade continues.\n\n` +
                `Advancing to **${updatedState?.phase ?? nextStep.phase}/REVISE**. ` +
                `Apply the revision feedback to the ${(updatedState?.phase ?? nextStep.phase).toLowerCase()} artifact, ` +
                `then call \`request_review\` when done.` +
                (updatedState?.pendingRevisionSteps && updatedState.pendingRevisionSteps.length > 0
                  ? `\n\n**Cascade:** ${updatedState.pendingRevisionSteps.length} more step(s) after this: ${updatedState.pendingRevisionSteps.map((s) => s.artifact).join(" → ")}.`
                  : "\n\n**Final cascade step.**") +
                approvalWarning
              )
            }

            logTransition(state, outcome, "submit_feedback/approve", notify)

            // Forward-pass skip: in INCREMENTAL mode, if the fileAllowlist proves
            // the next phase has no relevant files (e.g. no interface files for
            // INTERFACES), skip directly past it. This avoids forcing the agent
            // through ceremony gates for phases where no work is needed.
            //
            // Fix: compute effectiveAllowlist from args.approved_files BEFORE calling
            // computeForwardSkip. The store.update() that persists fileAllowlist from
            // args.approved_files runs below this point (S2), so state.fileAllowlist
            // still holds the pre-approval value (an empty array) at this call site.
            // Using the stale value caused computeForwardSkip to always return null
            // at PLANNING approval time, forcing the agent through INTERFACES/TESTS/IMPL_PLAN
            // even when approved_files was intentionally empty (operational-only tasks).
            const effectiveAllowlist: string[] = (() => {
              if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && args.approved_files) {
                const cwd = context.directory || process.cwd()
                return args.approved_files.map((p) => p.startsWith("/") ? p : resolve(cwd, p))
              }
              return state.fileAllowlist
            })()
            const forwardSkip = computeForwardSkip(
              outcome.nextPhase,
              state.mode,
              effectiveAllowlist,
            )
            const effectiveNextPhase = forwardSkip?.targetPhase ?? outcome.nextPhase
            const effectiveNextPhaseState = forwardSkip?.targetPhaseState ?? outcome.nextPhaseState

            // Git checkpoint — use per-phase approval count for tag versioning (M11)
            const phaseCount = (state.phaseApprovalCounts[state.phase] ?? 0) + 1
            const newApprovalCount = state.approvalCount + 1
            const expectedFiles = deriveExpectedFiles(state)
            const checkpointOpts = {
              phase: state.phase,
              approvalCount: phaseCount,
              featureName: state.featureName,
              expectedFiles,
              ...(state.mode === "INCREMENTAL" ? { fileAllowlist: state.fileAllowlist } : {}),
            }
            const checkpointResult = await createGitCheckpoint(
              { cwd: context.directory || process.cwd() },
              checkpointOpts,
            )

            // S_DISK: Ensure artifact is on disk before recording the approved path.
            // In the new flow, the file was already written at request_review time.
            // We re-write only if artifact_content is provided AND no disk path exists yet
            // (backward compat for sessions started before this change, or for file-based phases
            // where the agent didn't call request_review with artifact_content).
            const artifactKey = PHASE_TO_ARTIFACT[state.phase]
            let artifactDiskPath: string | null = (artifactKey ? state.artifactDiskPaths[artifactKey] : undefined) ?? null
            if (!artifactDiskPath && args.artifact_content && artifactKey && artifactKey !== "implementation") {
              try {
                const cwd = context.directory || process.cwd()
                artifactDiskPath = await writeArtifact(cwd, artifactKey, args.artifact_content, state.featureName)
              } catch (writeErr) {
                // Non-fatal — disk write failure does not block the approval
                log.warn("Failed to write artifact to disk")
              }
            }

            await store.update(sessionId, (draft) => {
              draft.phase = effectiveNextPhase
              draft.phaseState = effectiveNextPhaseState
              draft.approvalCount = newApprovalCount
              draft.phaseApprovalCounts[state.phase] = phaseCount
              draft.iterationCount = 0
              draft.retryCount = 0
              // Reset after approval — the next USER_GATE starts fresh.
              draft.userGateMessageReceived = false
              draft.reviewArtifactHash = null
              draft.latestReviewResults = null
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
              // S2: Capture file allowlist at PLANNING approval in INCREMENTAL mode.
              // Normalize to absolute paths — the agent may pass relative paths
              // (e.g. ".gitignore" instead of "/project/.gitignore"). The validator
              // rejects relative paths, so we resolve them against the project dir.
              if (state.phase === "PLANNING" && state.mode === "INCREMENTAL" && args.approved_files) {
                const cwd = context.directory || process.cwd()
                draft.fileAllowlist = args.approved_files.map((p) =>
                  p.startsWith("/") ? p : resolve(cwd, p),
                )
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

            // Reject IMPL_PLAN approval without artifact_content — without a DAG,
            // the IMPLEMENTATION phase loses per-task review, dependency checking,
            // and drift detection. The agent must provide the implementation plan.
            if (state.phase === "IMPL_PLAN") {
              if (!args.artifact_content) {
                // No artifact_content — check if feedback_text contains a justification.
                // The agent may justify why per-task review isn't needed (e.g., trivial scope).
                // The reviewer will evaluate whether the justification holds up.
                const hasJustification = args.feedback_text.trim().length > 20 &&
                  /justification|no plan needed|per-task|brief scope|not needed|skip impl plan/i.test(args.feedback_text)
                if (!hasJustification) {
                  return (
                    "Error: IMPL_PLAN approval requires either `artifact_content` (the implementation plan) " +
                    "or a justification in `feedback_text` explaining why per-task review isn't needed. " +
                    "Re-call `submit_feedback` with the plan in `artifact_content`, or provide a justification " +
                    "in `feedback_text` (the reviewer will evaluate whether your reasoning holds up)."
                  )
                }
                // Justification accepted — skip DAG parsing (no artifact to parse)
              } else {
                const parseCheck = parseImplPlan(args.artifact_content)
                if (!parseCheck.success) {
                  return (
                    `Error: Failed to parse implementation plan into DAG: ${parseCheck.errors.join("; ")}. ` +
                    `Fix the plan format and re-submit approval with corrected \`artifact_content\`.`
                  )
                }
              }
            }

            const forwardSkipMsg = forwardSkip
              ? `\n\n${forwardSkip.message}`
              : ""
            if (forwardSkip) {
              log.info("Forward-pass skip", { detail: `Skipped ${forwardSkip.skippedPhases.length} phase(s): ${forwardSkip.skippedPhases.join(", ")} → ${forwardSkip.targetPhase}` })
            }

            return result.responseMessage + checkpointMsg + discoveryWarning + forwardSkipMsg + approvalWarning

          } else {
            // N3 fix: mode must be set before revision routing
            if (!state.mode) {
              return "Error: Cannot process revision feedback — workflow mode not yet selected."
            }

            // Route to the appropriate handler based on state context.
            // Three paths: escape hatch resolution, cascade continuation, normal revise.
            // ESCAPE_HATCH phaseState is the structural guard — replaces the old
            // procedural escapePending check for routing decisions.
            //
            // 14.5: Persist feedback text before orchestrator LLM calls so it
            // survives process crashes. Cleared after the handler completes.
            const needsOrchestrator = state.phaseState === "ESCAPE_HATCH" ||
              !(state.pendingRevisionSteps && state.pendingRevisionSteps.length > 0)
            if (needsOrchestrator) {
              await store.update(sessionId, (draft) => {
                draft.pendingFeedback = args.feedback_text
              })
            }

            let handlerOutcome
            try {
              if (state.phaseState === "ESCAPE_HATCH") {
                handlerOutcome = await handleEscapeHatch(args.feedback_text, state, sm, orchestrator)
              } else if (state.pendingRevisionSteps && state.pendingRevisionSteps.length > 0) {
                handlerOutcome = handleCascade(state, sm)
              } else {
                handlerOutcome = await handleNormalRevise(args.feedback_text, result.responseMessage, state, sm, orchestrator)
              }
            } finally {
              // Clear pendingFeedback after handler completes (success or failure)
              if (needsOrchestrator) {
                try {
                  await store.update(sessionId, (draft) => {
                    draft.pendingFeedback = null
                  })
                } catch (cleanupErr) {
                  log.warn("Failed to clear pendingFeedback", {
                    detail: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                    sessionId,
                  })
                }
              }
            }

            // Apply state mutations based on outcome
            if (handlerOutcome.action === "error") {
              return `Error: ${handlerOutcome.message}`
            }

            if (handlerOutcome.action === "abort") {
              // Return from ESCAPE_HATCH to USER_GATE (abort = discard the escape hatch)
              await store.update(sessionId, (draft) => {
                draft.phaseState = "USER_GATE"
                draft.escapePending = false
                draft.pendingRevisionSteps = null
                draft.retryCount = 0
                draft.iterationCount = 0
              })
              return handlerOutcome.message
            }

            if (handlerOutcome.action === "escape_represent") {
              // Transition to ESCAPE_HATCH — structural guard against escape hatch bypass.
              // The SM will reject user_approve in ESCAPE_HATCH, so the only way out is
              // user_feedback (the escape hatch response) → REVISE.
              const escapeTransition = sm.transition(state.phase, state.phaseState, "escape_hatch_triggered", state.mode)
              if (!escapeTransition.success) {
                // Should never happen — USER_GATE always has escape_hatch_triggered
                return `Error: Failed to transition to ESCAPE_HATCH: ${escapeTransition.message}`
              }
              logTransition(state, escapeTransition, "submit_feedback/escape_hatch_triggered", notify)
              await store.update(sessionId, (draft) => {
                draft.phase = escapeTransition.nextPhase
                draft.phaseState = escapeTransition.nextPhaseState
                draft.escapePending = true
                draft.pendingRevisionSteps = handlerOutcome.pendingRevisionSteps
                draft.retryCount = 0
              })
              return handlerOutcome.message
            }

            // action === "revise"
            const effectivePhaseState = handlerOutcome.targetPhaseState
            // Validate targetPhase supports the target phaseState
            const validStates = VALID_PHASE_STATES[handlerOutcome.targetPhase]
            if (!validStates || !validStates.includes(effectivePhaseState)) {
              return `Error: Orchestrator routed to invalid phase "${handlerOutcome.targetPhase}" which does not support ${effectivePhaseState}.`
            }
            logTransition(state, { phase: handlerOutcome.targetPhase, phaseState: effectivePhaseState }, `submit_feedback/${effectivePhaseState === "DRAFT" ? "backtrack" : "revise"}`, notify)

            // Capture revision baseline BEFORE updating state — this snapshot is
            // compared against the artifact at request_review time to verify that
            // the agent actually made changes during REVISE.
            // Skip baseline capture for backtrack (DRAFT) — we're restarting from scratch.
            let revisionBaseline: WorkflowState["revisionBaseline"] = null
            if (effectivePhaseState === "REVISE") {
              try {
                revisionBaseline = await captureRevisionBaseline(
                  handlerOutcome.targetPhase,
                  state,
                  context.directory || process.cwd(),
                )
              } catch (baselineErr) {
                // Non-fatal — if we can't capture a baseline, the diff gate
                // is disabled for this revision (graceful degradation).
                const errMsg = baselineErr instanceof Error ? baselineErr.message : String(baselineErr)
                log.debug("Failed to capture revision baseline", { detail: errMsg })
              }
            }

            await store.update(sessionId, (draft) => {
              draft.phase = handlerOutcome.targetPhase
              draft.phaseState = effectivePhaseState
              draft.pendingRevisionSteps = handlerOutcome.pendingRevisionSteps
              draft.revisionBaseline = revisionBaseline
              if (handlerOutcome.clearEscapePending) draft.escapePending = false
              if (handlerOutcome.newIntentBaseline !== undefined) {
                draft.intentBaseline = handlerOutcome.newIntentBaseline
              }
              draft.retryCount = 0
              // For backtrack, clear the approved status of the artifact being rewritten.
              // Otherwise the orchestrator sees a stale "approved" hash for an artifact
              // that's being restarted from scratch, which could mis-classify future
              // feedback as "already approved" instead of "being rewritten".
              if (effectivePhaseState === "DRAFT") {
                draft.iterationCount = 0
                draft.userGateMessageReceived = false
                const backtrackArtifact = PHASE_TO_ARTIFACT[handlerOutcome.targetPhase]
                if (backtrackArtifact) {
                  delete draft.approvedArtifacts[backtrackArtifact]
                }
              }
              // Record feedback in history for accumulated-drift detection (design doc §9)
              draft.feedbackHistory.push({
                phase: state.phase,
                feedback: args.feedback_text.slice(0, MAX_FEEDBACK_CHARS),
                timestamp: Date.now(),
              })
            })

            // Deterministic auto-skip at cascade entry: if this is a cascade
            // (pendingRevisionSteps exists), check whether the first step (and
            // subsequent steps) can be skipped because no changes are needed.
            // This prevents the agent from ever seeing no-op cascade phases
            // where tool guards would block it.
            if (handlerOutcome.pendingRevisionSteps.length > 0 || revisionBaseline) {
              const skipMsg = await cascadeAutoSkip({ store, sm, log }, sessionId, context.directory || process.cwd())
              if (skipMsg) return skipMsg
            }

            return handlerOutcome.message
          }
        },
      }),

      // propose_backtrack — agent proposes going back to an earlier phase
      // -----------------------------------------------------------------------
      propose_backtrack: tool({
        description:
          "Propose going back to an earlier workflow phase when you discover a fundamental " +
          "problem with a prior artifact that cannot be fixed in the current phase. " +
          "The orchestrator validates whether backtracking is warranted. " +
          "Only call this from DRAFT or REVISE state, in phases PLANNING through IMPLEMENTATION.",
        args: {
          target_phase: tool.schema
            .enum(["DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN"])
            .describe(
              "The phase you want to go back to. Must be earlier than the current phase. " +
              "The orchestrator may route to a different phase based on root cause analysis.",
            ),
          reason: tool.schema.string().describe(
            "Detailed explanation of why backtracking is needed. " +
            "Describe the specific flaw in the earlier artifact and why it cannot be fixed in the current phase.",
          ),
        },
        async execute(
          args: { target_phase: string; reason: string },
          context: ToolExecuteContext,
        ) {
          const { store, sm, log, orchestrator, notify } = ctx
          const sessionId = resolveSessionId(context)
          if (!sessionId) return "Error: Could not determine session ID from tool context."

          const state = await ensureState(store, sessionId, notify)
          await detectAgent(store, sessionId, context)

          const outcome = await handleProposeBacktrack(
            { target_phase: args.target_phase as Phase, reason: args.reason },
            state,
            orchestrator,
          )

          if (outcome.action === "error") return `Error: ${outcome.message}`
          if (outcome.action === "reject") return outcome.message

          // outcome.action === "execute" — apply state mutations
          const effectivePhaseState = outcome.targetPhaseState

          // Validate target supports the phaseState
          const validStates = VALID_PHASE_STATES[outcome.targetPhase]
          if (!validStates || !validStates.includes(effectivePhaseState)) {
            return `Error: Orchestrator routed to invalid phase "${outcome.targetPhase}" which does not support ${effectivePhaseState}.`
          }

          logTransition(
            state,
            { phase: outcome.targetPhase, phaseState: effectivePhaseState },
            `propose_backtrack/${outcome.classification}`,
            notify,
          )

          // Capture revision baseline for strategic (REVISE) — backtrack (DRAFT) restarts from scratch
          let revisionBaseline: WorkflowState["revisionBaseline"] = null
          if (effectivePhaseState === "REVISE") {
            try {
              revisionBaseline = await captureRevisionBaseline(
                outcome.targetPhase,
                state,
                context.directory || process.cwd(),
              )
            } catch {
              // Non-fatal — diff gate disabled for this revision
            }
          }

          await store.update(sessionId, (draft) => {
            draft.phase = outcome.targetPhase
            draft.phaseState = effectivePhaseState
            draft.pendingRevisionSteps = outcome.pendingRevisionSteps
            draft.revisionBaseline = revisionBaseline
            draft.retryCount = 0

            if (effectivePhaseState === "DRAFT") {
              // Backtrack-specific resets
              draft.iterationCount = 0
              draft.userGateMessageReceived = false
              const backtrackArtifact = PHASE_TO_ARTIFACT[outcome.targetPhase]
              if (backtrackArtifact) {
                delete draft.approvedArtifacts[backtrackArtifact]
              }
            }

            // If backtracking FROM IMPLEMENTATION, clear DAG state
            if (state.phase === "IMPLEMENTATION") {
              draft.implDag = null
              draft.currentTaskId = null
              draft.taskReviewCount = 0
              draft.taskCompletionInProgress = null
            }

            // Record in feedbackHistory for drift detection
            draft.feedbackHistory.push({
              phase: state.phase,
              feedback: `[propose_backtrack → ${outcome.targetPhase}] ${args.reason.slice(0, MAX_FEEDBACK_CHARS - 50)}`,
              timestamp: Date.now(),
            })
          })

          // Cascade auto-skip: check if pending steps can be skipped
          if (outcome.pendingRevisionSteps.length > 0 || revisionBaseline) {
            const skipMsg = await cascadeAutoSkip({ store, sm, log }, sessionId, context.directory || process.cwd())
            if (skipMsg) return skipMsg
          }

          return outcome.message
        },
      }),
    }, log),

    // Test-only: exposes the internal store for integration tests that need to
    // force state (e.g. setting phase to DONE without traversing all 8 phases).
    // Prefixed with underscore to signal internal-only use.
    _testStore: store,
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
