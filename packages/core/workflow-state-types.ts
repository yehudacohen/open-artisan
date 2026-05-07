/**
 * workflow-state-types.ts — Workflow state, store, and validation contracts.
 */

import type { RevisionStep } from "./orchestrator-types"
import { VALID_PHASE_STATES } from "./workflow-primitives"
import type { ArtifactKey, Phase, PhaseState, WorkflowMode } from "./workflow-primitives"
import { createImplDAG } from "./dag"

// ---------------------------------------------------------------------------
// Core workflow state
// ---------------------------------------------------------------------------

/**
 * All absolute file paths in fileAllowlist must start with "/".
 * approvalCount, iterationCount, retryCount must be >= 0.
 * schemaVersion must equal SCHEMA_VERSION at load time, else state is discarded.
 *
 * Schema changelog:
 *   v1: initial schema (all fields through lastCheckpointTag/approvalCount)
 *   v2: added orchestratorSessionId, intentBaseline, escapePending, pendingRevisionSteps;
 *       added OrchestratorPlanResult.classification field
 *   v3: added modeDetectionNote (separate from intentBaseline to avoid field overloading)
 *   v4: added discoveryReport (assembled output from parallel scanner fleet)
 *   v5: added implDag (serialized DAG from approved IMPL_PLAN artifact)
 *   v6: added currentTaskId (active DAG task pointer), feedbackHistory (accumulated drift tracking)
 *   v7: added phaseApprovalCounts (per-phase approval counter for tag versioning)
 *   v8: added userGateMessageReceived (prevents agent from self-approving without real user input)
 *   v9: added artifactDiskPaths (absolute paths of artifact files written to .openartisan/ dir)
 *   v10: added featureName (subdirectory under .openartisan/ for multi-feature isolation)
 *   v11: added revisionBaseline (artifact hash at REVISE entry, used as diff gate)
 *   v12: added TaskCategory/HumanGateInfo on implDag nodes, "human-gated" TaskStatus,
 *        for stub detection, human gate mechanism, and plan structuring
 *   v13: added activeAgent (tracks which agent file is driving the session —
 *        "artisan", "robot-artisan", or null until an agent is detected)
 *   v14: added taskCompletionInProgress (re-entry guard for mark_task_complete —
 *        prevents concurrent per-task review + DAG mutations from corrupting state)
 *   v15: added taskReviewCount (per-task review iteration cap — prevents infinite
 *        review loops when a task repeatedly fails per-task review),
 *        added pendingFeedback (crash-safe feedback persistence — stores feedback
 *        text during orchestrator LLM calls so it survives process crashes)
 *   v16: added userMessages (full user message history for self-review alignment)
 *   v17: added cachedPriorState (cache for check_prior_workflow → select_mode)
 *   v18: added priorWorkflowChecked and sessionModel (enforce tool ordering and
 *        propagate parent model to subagents)
 *   v19: added reviewArtifactHash and latestReviewResults (stale-artifact
 *        detection in mark_satisfied, status file review rendering)
 *   v20: storage format change — per-feature files (.openartisan/<featureName>/
 *        workflow-state.json) instead of single-file (.opencode/workflow-state.json).
 *        No new WorkflowState fields. Legacy single-file migrated on load().
 *   v21: added parentWorkflow, childWorkflows, concurrency for nested sub-workflows.
 *        Added "delegated" TaskStatus (treated like "in-flight" for dependencies).
 *   v22: added reviewArtifactFiles (orchestrator-driven artifact tracking for review).
 *        Added expectedFiles to implDag TaskNode (parsed from IMPL_PLAN "Files:" field).
 *        The reviewer now receives explicit file paths from the orchestrator instead
 *        of scanning directories with heuristics.
 *   v23: expanded the structural workflow contract with new PhaseState / WorkflowEvent values
 *        and persisted BacktrackContext provenance on WorkflowState.
 *   v24: added approvedArtifactFiles so source-file artifacts approved via
 *        request_review artifact_files remain the downstream source of truth.
 */
export const SCHEMA_VERSION = 24

/**
 * Runtime concurrency policy for nested or delegated workflow execution.
 * maxParallelTasks is configuration, not live scheduler state.
 */
export interface WorkflowConcurrency {
  maxParallelTasks: number
}

export type UserAuthoredText = string

/**
 * Persisted provenance for a structural backtrack/redraft flow.
 *
 * - sourcePhase: the phase where the backtrack was proposed
 * - targetPhase: the earlier phase that now owns the redraft
 * - reason: user-authored rationale carried into prompts/recovery.
 *   Treat as sensitive operational context and avoid echoing it into low-signal logs.
 */
export interface BacktrackContext {
  sourcePhase: Phase
  targetPhase: Phase
  reason: UserAuthoredText
}

export interface WorkflowState {
  /** Schema version for forward-compatibility. Must equal SCHEMA_VERSION. */
  schemaVersion: typeof SCHEMA_VERSION

  /** The OpenCode session ID this state belongs to */
  sessionId: string

  /** Which workflow mode was selected (null until mode_selected fires) */
  mode: WorkflowMode | null

  /** Current high-level phase */
  phase: Phase

  /** Sub-state within the current phase */
  phaseState: PhaseState

  /** How many self-review iterations have happened in the current phase/state */
  iterationCount: number

  /** How many times the idle handler has re-prompted without a state change */
  retryCount: number

  /**
   * Semantic hashes of approved artifact content at last user gate.
   * Format: SHA-256 hex of the artifact text, truncated to 16 chars.
   * Used for accumulated-drift detection in O_DIVERGE.
   */
  approvedArtifacts: Partial<Record<ArtifactKey, string>>

  /**
   * Absolute file paths that were reviewed and approved for each artifact key.
   * This is the source-file counterpart to artifactDiskPaths: INTERFACES and
   * TESTS often approve project files rather than .openartisan markdown mirrors.
   * Downstream review and prompt context should prefer these paths over legacy
   * single-file mirrors when present.
   */
  approvedArtifactFiles?: Partial<Record<ArtifactKey, string[]>>

  /**
   * The full approved conventions document text.
   * null in GREENFIELD mode or before D_USER approval.
   * Injected into system prompt for all subsequent phases.
   */
  conventions: string | null

  /**
   * Absolute paths of files the agent may write/edit.
   * Only populated in INCREMENTAL mode, from the approved plan.
   * Empty array = no write restrictions (GREENFIELD/REFACTOR modes).
   */
  fileAllowlist: string[]

  /** Git tag of the last user-approved checkpoint, e.g. "workflow/plan-v1" */
  lastCheckpointTag: string | null

  /** Monotonically increasing count of user approvals (>= 0). Used for tag version suffix. */
  approvalCount: number

  /**
   * Session ID of the dedicated orchestrator sub-session.
   * Created on first orchestrator invocation, reused thereafter.
   */
  orchestratorSessionId: string | null

  /**
   * The user's original intent statement.
   * Captured from first user message, updated by O_INTENT_UPDATE.
   * Never used for mode-detection output — use modeDetectionNote for that.
   */
  intentBaseline: string | null

  /**
   * Advisory mode-detection suggestion produced at session.created.
   * Shown in MODE_SELECT system prompt only. Never overwritten by user messages.
   * Separate from intentBaseline to avoid field overloading.
   */
  modeDetectionNote: string | null

  /**
   * Combined Markdown output from the parallel discovery scanner fleet.
   * Populated at the DISCOVERY/ANALYZE → DISCOVERY/CONVENTIONS transition.
   * null in GREENFIELD mode or before the fleet runs.
   * Injected into the CONVENTIONS drafting system prompt.
   */
  discoveryReport: string | null

  /**
   * The ID of the task currently being executed by the agent in the IMPLEMENTATION phase.
   * Set when the scheduler dispatches a task, cleared on task completion.
   * null before IMPLEMENTATION phase or when no task is actively being worked on.
   */
  currentTaskId: string | null

  /**
   * History of all feedback received during the workflow session.
   * Used for accumulated-drift detection in O_DIVERGE (design doc §9 trigger criterion).
   * Each entry records the phase, feedback text, and timestamp.
   */
  feedbackHistory: Array<{ phase: Phase; feedback: string; timestamp: number }>

  /**
   * Persisted provenance for a structural backtrack/redraft flow.
   * Present while a REDRAFT lineage is still relevant for prompts and resume recovery.
   * Cleared after the redraft is approved or superseded by a later explicit backtrack.
   * Optional in in-memory fixtures and older transient callers; persisted state should
   * normalize absent values to null during migration/load.
   */
  backtrackContext?: BacktrackContext | null

  /**
   * Serialized ImplDAG — the parsed task graph from the approved IMPL_PLAN artifact.
   * Populated at IMPL_PLAN/USER_GATE approval. null before that gate.
   * The sequential scheduler reads this to find the next ready task.
   * Stored as a plain object (TaskNode[]) for JSON serializability.
   */
  implDag: import("./dag").TaskNode[] | null

  /**
   * Per-phase approval counts for tag versioning (M11).
   * Tracks how many times each phase has been approved. Used to generate
   * phase-specific tag versions (e.g. workflow/planning-v2 on second approval of PLANNING).
   */
  phaseApprovalCounts: Partial<Record<Phase, number>>

  /**
   * When the orchestrator detects a strategic change, this is set to true
   * and the workflow stays at USER_GATE waiting for the user's escape hatch response.
   * Cleared when the escape hatch is resolved (accept, alternative, or abort).
   */
  escapePending: boolean

  /**
   * The orchestrator's pending revision plan, waiting for escape hatch resolution.
   * Only set when escapePending is true. Cleared after the plan is executed or aborted.
   */
  pendingRevisionSteps: RevisionStep[] | null

  /**
   * True when a real user message has been received while in USER_GATE state.
   * Set by the chat.message hook when a user message arrives at USER_GATE.
   * Reset to false on every state transition that enters USER_GATE.
   * Checked by submit_feedback(approve) — approval is blocked unless this is true,
   * preventing the agent from self-approving without actual user input.
   */
  userGateMessageReceived: boolean

  /**
   * SHA-256 hash (16 hex chars) of the artifact content when request_review was last called.
   * Used by mark_satisfied to detect if the artifact changed since the reviewer last saw it.
   * If the artifact changed, mark_satisfied rejects and requires request_review to be called again.
   * Reset to null on state transitions out of REVIEW.
   */
  reviewArtifactHash: string | null

  /**
   * Latest self-review results from mark_satisfied. Stored so the status file can render them.
   * Array of criterion results or null if no review has happened yet.
   */
  latestReviewResults: Array<{ criterion: string; met: boolean; evidence: string; score?: string }> | null

  /**
   * Absolute file paths of plan artifacts written to .openartisan/ under the project root.
   * Populated at approval time in submit_feedback and at mark_analyze_complete (for discoveryReport).
   * The agent reads these files via tools to retrieve artifact content rather than relying on
   * inline context injection, avoiding loss of information in long contexts.
   *
   * Keys correspond to ArtifactKey values. Implementation files are not tracked here
   * (they are written to the project by the agent directly).
   */
  artifactDiskPaths: Partial<Record<ArtifactKey, string>>

  /**
   * Optional subdirectory name under .openartisan/ for this workflow session.
   * When set, all artifacts are written to .openartisan/<featureName>/ instead of
   * .openartisan/ directly. This enables multiple concurrent workflows (different features)
   * to coexist in the same repo without colliding on plan.md, conventions.md, etc.
   * Set at select_mode time. null = use flat .openartisan/ layout (legacy/default).
   */
  featureName: string | null

  /**
   * Snapshot of the artifact state captured at the moment the workflow enters REVISE.
   * Used as a diff gate by request_review: if the artifact has not changed since this
   * baseline, the agent is blocked from transitioning to REVIEW (it must actually make
   * changes to address the revision feedback).
   *
   * For in-memory phases (PLANNING, DISCOVERY, IMPL_PLAN): stores a SHA-256 content hash
   * of the artifact file on disk (from artifactDiskPaths).
   * For file-based phases (INTERFACES, TESTS, IMPLEMENTATION): stores a SHA-256 content hash
   * of `git diff` output (NOT a commit SHA — the type name "git-sha" is legacy). This prevents
   * false positives during cascades where the agent hasn't committed yet.
   *
   * null when not in REVISE state or when the baseline could not be captured.
   */
  revisionBaseline: { type: "content-hash"; hash: string } | { type: "git-sha"; sha: string } | null

  /**
   * The name of the agent file currently driving this session.
   * Set when a custom tool's execute() context contains `context.agent`.
   * Used by the tool guard to go dormant for non-artisan agents (Plan, Build)
   * and by robot-artisan mode for auto-approval at USER_GATE.
   *
   * Values: "artisan", "robot-artisan", or null (unknown / not yet detected).
   * Unknown sessions stay dormant until an artisan agent is detected or the
   * workflow is explicitly activated via a workflow tool call.
   */
  activeAgent: string | null

  /**
   * Re-entry guard for mark_task_complete. Set to the task_id when
   * mark_task_complete begins processing (before per-task review dispatch).
   * Cleared when processing completes (success, failure, or error).
   * Concurrent calls are rejected while this is non-null.
   *
   * null = no mark_task_complete call in progress.
   */
  taskCompletionInProgress: string | null

  /**
   * Number of times mark_task_complete has been called for the current task
   * without the task passing per-task review. Reset to 0 when currentTaskId
   * changes (new task dispatched). When this exceeds MAX_TASK_REVIEW_ITERATIONS,
   * per-task review is bypassed and the task is accepted (the full implementation
   * review at request_review will catch issues).
   */
  taskReviewCount: number

  /**
   * User feedback text persisted before orchestrator LLM calls (assess/diverge).
   * If the process crashes during the orchestrator call, this field preserves
   * the feedback so it can be replayed on restart.
   * Treat as user-provided sensitive text; do not surface outside workflow review
   * and prompt-building paths without explicit need.
   * null = no orchestrator call in flight.
   */
  pendingFeedback: UserAuthoredText | null

  /**
   * Full conversation history of user messages.
   * Captured from chat.message hook and passed to self-review subagent.
   * Provides complete context beyond just intentBaseline.
   * Treat entries as user-provided sensitive text rather than operational metadata.
   */
  userMessages: UserAuthoredText[]

  /**
   * Cached result from check_prior_workflow to avoid redundant file reads in select_mode.
   * Set by check_prior_workflow, consumed by select_mode, cleared after use.
   * null = no cached result available.
   */
  cachedPriorState: { intentBaseline: string | null; phase: string; artifactDiskPaths: Record<string, string>; approvedArtifacts?: Record<string, string> } | null

  /**
   * Flag indicating check_prior_workflow was called for this session.
   * Used to enforce check_prior_workflow → select_mode dependency when
   * prior state exists. Cleared after select_mode consumes it.
   */
  priorWorkflowChecked: boolean

  /**
   * The active model for the parent session (if provided by OpenCode).
   * Propagated to subagent sessions when available.
   * Can be a string (model ID) or an object with modelID and providerID.
   */
  sessionModel: string | { modelID: string; providerID?: string } | null

  // ── Sub-workflow fields (Phase 3) ──────────────────────────────────

  /**
   * Link to the parent workflow that spawned this sub-workflow.
   * null for top-level workflows. Set by spawn_sub_workflow.
   * - sessionId: the parent's session ID
   * - featureName: the parent's feature name (for state lookup)
   * - taskId: which task in the parent's DAG was delegated to this child
   */
  parentWorkflow: { sessionId: string; featureName: string; taskId: string } | null

  /**
   * Child workflows spawned from this workflow's DAG tasks.
   * Each entry tracks a delegated task → child workflow mapping.
   * - taskId: the task in THIS workflow's DAG that was delegated
   * - featureName: the child's feature name (for state lookup)
   * - sessionId: the child's session ID (null if not yet started)
   * - status: lifecycle state of the child workflow
   */
  childWorkflows: Array<{
    taskId: string
    featureName: string
    sessionId: string | null
    status: "pending" | "running" | "complete" | "failed"
    /** ISO timestamp of when this task was delegated. Used for timeout detection. */
    delegatedAt: string
  }>

  /**
   * Concurrency configuration for this workflow.
   * - maxParallelTasks: how many DAG tasks can run simultaneously (Phase 6)
   * Set at select_mode time. Defaults to sequential (1).
   */
  concurrency: WorkflowConcurrency

  // ── Orchestrator-driven artifact tracking (v22) ────────────────────

  /**
   * Accumulated file paths for the current review cycle.
   * For IMPLEMENTATION: populated automatically by mark_task_complete from
   * each task's expectedFiles (defined in the IMPL_PLAN). The orchestrator
   * derives these from the approved plan — no directory scanning needed.
   * For INTERFACES/TESTS: populated by request_review from the agent's
   * artifact_files parameter.
   *
   * The agent can supplement with additional files via request_review's
   * artifact_files parameter. These are merged with the orchestrator-derived
   * files and passed directly to the isolated reviewer.
   *
   * Reset when the review cycle resets (e.g., entering a new DRAFT phase).
   */
  reviewArtifactFiles: string[]
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export * from "./state-machine-types"

// ---------------------------------------------------------------------------
// Structural workflow contracts
// ---------------------------------------------------------------------------

export * from "./structural-workflow-types"

// ---------------------------------------------------------------------------
// Artifact dependency graph
// ---------------------------------------------------------------------------

export * from "./artifact-types"

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

export * from "./session-registry-types"

export type { StateBackend, StateBackendError } from "./state-backend-types"

// ---------------------------------------------------------------------------
// Roadmap types and contracts
// ---------------------------------------------------------------------------

export * from "./roadmap-types"

// ---------------------------------------------------------------------------
// Session state store
// ---------------------------------------------------------------------------

export interface StoreLoadResult {
  success: true
  count: number
}

/**
 * Session-state store load failure.
 *
 * Keep the public runtime contract string-first for compatibility with existing
 * callers and implementations. Optional structured fields may be added by newer
 * producers, but they are not required by the interface artifact.
 */
export interface StoreLoadError {
  success: false
  error: string
  code?: "STORE_LOAD_FAILED"
  message?: string
}

export interface SessionStateStore {
  /**
   * Get state for a session, or null if not found.
   *
   * IMPORTANT: Returns a direct reference to the internal state object for
   * performance (called on every tool call). Do NOT mutate the returned object —
   * use update() for all mutations. Treat the return value as read-only.
   */
  get(sessionId: string): WorkflowState | null

  /**
   * Find a workflow state by feature name.
   * Searches all sessions for one with matching featureName.
   * Returns a defensive clone of the state if found, null otherwise.
   */
  findByFeatureName(featureName: string): WorkflowState | null

  /**
   * Find a workflow state by feature name, falling back to persisted storage.
   * Use this for cross-client resume flows where another process may have written
   * the feature state after this store instance was loaded.
   */
  findPersistedByFeatureName(featureName: string): Promise<WorkflowState | null>

  /**
   * Create a fresh state for a new session and persist it.
   * Errors: throws if sessionId already exists.
   */
  create(sessionId: string): Promise<WorkflowState>

  /**
   * Apply a mutation to an existing state and persist it atomically.
   * The mutator receives a draft copy; after it returns, the result is validated
   * and persisted. Returns the new state.
   * Errors: throws if sessionId not found, or if mutation produces invalid state.
   */
  update(
    sessionId: string,
    mutator: (draft: WorkflowState) => void,
  ): Promise<WorkflowState>

  /**
   * Load all persisted states from disk on plugin startup.
   * States with wrong schemaVersion are silently discarded.
   */
  load(): Promise<StoreLoadResult | StoreLoadError>

  /**
   * Migrate state from one sessionId to another (for resume across sessions).
   * Moves the in-memory entry from oldSessionId to newSessionId, updates
   * the sessionId field, and persists. Removes the old session entry.
   * Errors: throws if oldSessionId not found or newSessionId already has non-fresh state.
   */
  migrateSession(oldSessionId: string, newSessionId: string): Promise<WorkflowState>

  /**
   * Remove state for a deleted session from memory and disk.
   * No-op if sessionId not found.
   */
  delete(sessionId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// State validation
// ---------------------------------------------------------------------------

/**
 * Validates that a WorkflowState object is internally consistent.
 * Returns null if valid, or a structured validation error describing the first violation found.
 *
 * Rules:
 * - schemaVersion must equal SCHEMA_VERSION
 * - sessionId must be a non-empty string
 * - phase must be a valid Phase value
 * - phaseState must be valid for the current phase (per VALID_PHASE_STATES)
 * - iterationCount, retryCount, approvalCount must all be >= 0
 * - fileAllowlist paths must start with "/" in INCREMENTAL mode
 */
/**
 * Structured validation error contract for workflow-state shape/invariant failures.
 *
 * Decision note: this remains String-compatible because existing runtime/tests rely
 * on thrown/returned string behavior. The interface still exposes explicit `code`
 * and `message` fields so callers have a structured error shape without changing the
 * compatibility contract in this phase.
 */
export type WorkflowStateValidationError = string & {
  code: "INVALID_WORKFLOW_STATE"
  message: string
}

function workflowStateValidationError(message: string): WorkflowStateValidationError {
  return message as WorkflowStateValidationError
}

export function validateWorkflowState(state: WorkflowState): WorkflowStateValidationError | null {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return workflowStateValidationError(`Invalid schemaVersion: expected ${SCHEMA_VERSION}, got ${state.schemaVersion}`)
  }
  if (!state.sessionId || typeof state.sessionId !== "string") {
    return workflowStateValidationError("Invalid sessionId: must be a non-empty string")
  }
  const validPhases = Object.keys(VALID_PHASE_STATES) as Phase[]
  if (!validPhases.includes(state.phase)) {
    return workflowStateValidationError(`Invalid phase: "${state.phase}"`)
  }
  const validStates = VALID_PHASE_STATES[state.phase]
  if (!validStates.includes(state.phaseState)) {
    return workflowStateValidationError(`Invalid phaseState "${state.phaseState}" for phase "${state.phase}". Valid: ${validStates.join(", ")}`)
  }
  if (state.mode !== null && state.mode !== "GREENFIELD" && state.mode !== "REFACTOR" && state.mode !== "INCREMENTAL") {
    return workflowStateValidationError(`Invalid mode: "${state.mode}". Must be null, "GREENFIELD", "REFACTOR", or "INCREMENTAL".`)
  }
  if (state.iterationCount < 0) return workflowStateValidationError("iterationCount must be >= 0")
  if (state.retryCount < 0) return workflowStateValidationError("retryCount must be >= 0")
  if (state.approvalCount < 0) return workflowStateValidationError("approvalCount must be >= 0")
  if (state.mode === "INCREMENTAL") {
    for (const path of state.fileAllowlist) {
      if (!path.startsWith("/")) {
        return workflowStateValidationError(`fileAllowlist path "${path}" must be an absolute path (start with "/")`)
      }
    }
  }
  if (state.conventions !== null && typeof state.conventions !== "string") {
    return workflowStateValidationError(`conventions must be null or a string, got ${typeof state.conventions}`)
  }
  if (typeof state.priorWorkflowChecked !== "boolean") {
    return workflowStateValidationError(`priorWorkflowChecked must be a boolean, got ${typeof state.priorWorkflowChecked}`)
  }
  if (state.sessionModel !== null) {
    if (typeof state.sessionModel === "string") {
      // valid
    } else if (typeof state.sessionModel === "object" && !Array.isArray(state.sessionModel)) {
      if (!("modelID" in state.sessionModel) || typeof state.sessionModel.modelID !== "string") {
        return workflowStateValidationError(`sessionModel object must have a string modelID field`)
      }
    } else {
      return workflowStateValidationError(`sessionModel must be null, a string, or an object with modelID, got ${typeof state.sessionModel}`)
    }
  }
  if (state.currentTaskId !== null && typeof state.currentTaskId !== "string") {
    return workflowStateValidationError(`currentTaskId must be null or a string, got ${typeof state.currentTaskId}`)
  }
  if (state.phase !== "IMPLEMENTATION" && state.currentTaskId !== null) {
    return workflowStateValidationError(`currentTaskId must be null outside IMPLEMENTATION, got "${state.currentTaskId}" in ${state.phase}`)
  }
  if (!Array.isArray(state.feedbackHistory)) {
    return workflowStateValidationError(`feedbackHistory must be an array, got ${typeof state.feedbackHistory}`)
  }
  for (let i = 0; i < state.feedbackHistory.length; i++) {
    const entry = state.feedbackHistory[i]
    if (!entry || typeof entry !== "object") {
      return workflowStateValidationError(`feedbackHistory[${i}] must be an object`)
    }
    if (typeof entry.phase !== "string") {
      return workflowStateValidationError(`feedbackHistory[${i}].phase must be a string`)
    }
    if (typeof entry.feedback !== "string") {
      return workflowStateValidationError(`feedbackHistory[${i}].feedback must be a string`)
    }
    if (typeof entry.timestamp !== "number" || entry.timestamp < 0) {
      return workflowStateValidationError(`feedbackHistory[${i}].timestamp must be a non-negative number`)
    }
  }
  if (state.backtrackContext != null) {
    if (typeof state.backtrackContext !== "object" || Array.isArray(state.backtrackContext)) {
      return workflowStateValidationError(`backtrackContext must be null or an object`)
    }
    if (state.phaseState !== "REDRAFT") {
      return workflowStateValidationError(`backtrackContext may only be present while phaseState is "REDRAFT", got "${state.phaseState}"`)
    }
    if (typeof state.backtrackContext.sourcePhase !== "string") {
      return workflowStateValidationError(`backtrackContext.sourcePhase must be a Phase string`)
    }
    if (typeof state.backtrackContext.targetPhase !== "string") {
      return workflowStateValidationError(`backtrackContext.targetPhase must be a Phase string`)
    }
    if (!validPhases.includes(state.backtrackContext.sourcePhase as Phase)) {
      return workflowStateValidationError(`backtrackContext.sourcePhase has invalid phase "${state.backtrackContext.sourcePhase}"`)
    }
    if (!validPhases.includes(state.backtrackContext.targetPhase as Phase)) {
      return workflowStateValidationError(`backtrackContext.targetPhase has invalid phase "${state.backtrackContext.targetPhase}"`)
    }
    if (typeof state.backtrackContext.reason !== "string" || state.backtrackContext.reason.trim().length === 0) {
      return workflowStateValidationError(`backtrackContext.reason must be a non-empty string`)
    }
    if (state.backtrackContext.targetPhase === "MODE_SELECT" || state.backtrackContext.targetPhase === "DONE") {
      return workflowStateValidationError(`backtrackContext.targetPhase must be an artifact-authoring phase, got "${state.backtrackContext.targetPhase}"`)
    }
  }
  if (state.implDag !== null) {
    if (!Array.isArray(state.implDag)) {
      return workflowStateValidationError(`implDag must be null or an array, got ${typeof state.implDag}`)
    }
    for (const node of state.implDag) {
      if (!node || typeof node !== "object") {
        return workflowStateValidationError(`implDag contains a non-object entry`)
      }
      if (typeof node.id !== "string" || !node.id) {
        return workflowStateValidationError(`implDag task missing required "id" string field`)
      }
      if (!Array.isArray(node.dependencies)) {
        return workflowStateValidationError(`implDag task "${node.id}" missing required "dependencies" array`)
      }
      if (!Array.isArray(node.expectedTests)) {
        return workflowStateValidationError(`implDag task "${node.id}" missing required "expectedTests" array`)
      }
      const validStatuses = ["pending", "in-flight", "complete", "aborted", "human-gated", "delegated"]
      if (typeof node.status !== "string" || !validStatuses.includes(node.status)) {
        return workflowStateValidationError(`implDag task "${node.id}" has invalid status "${node.status}"`)
      }
      // v22: validate expectedFiles array
      if (node.expectedFiles !== undefined && node.expectedFiles !== null) {
        if (!Array.isArray(node.expectedFiles)) {
          return workflowStateValidationError(`implDag task "${node.id}" expectedFiles must be an array`)
        }
        for (let j = 0; j < node.expectedFiles.length; j++) {
          if (typeof node.expectedFiles[j] !== "string") {
            return workflowStateValidationError(`implDag task "${node.id}" expectedFiles[${j}] must be a string`)
          }
        }
      }
      // v12: validate optional category field
      if (node.category !== undefined && node.category !== null) {
        const validCategories = ["scaffold", "human-gate", "integration", "standalone"]
        if (typeof node.category !== "string" || !validCategories.includes(node.category)) {
          return workflowStateValidationError(`implDag task "${node.id}" has invalid category "${node.category}". Valid: ${validCategories.join(", ")}`)
        }
      }
      // v12: validate humanGate field if present
      if (node.humanGate !== undefined && node.humanGate !== null) {
        const hg = node.humanGate
        if (typeof hg !== "object" || Array.isArray(hg)) {
          return workflowStateValidationError(`implDag task "${node.id}" humanGate must be an object`)
        }
        if (typeof hg.whatIsNeeded !== "string") {
          return workflowStateValidationError(`implDag task "${node.id}" humanGate.whatIsNeeded must be a string`)
        }
        if (typeof hg.why !== "string") {
          return workflowStateValidationError(`implDag task "${node.id}" humanGate.why must be a string`)
        }
        if (typeof hg.verificationSteps !== "string") {
          return workflowStateValidationError(`implDag task "${node.id}" humanGate.verificationSteps must be a string`)
        }
        if (typeof hg.resolved !== "boolean") {
          return workflowStateValidationError(`implDag task "${node.id}" humanGate.resolved must be a boolean`)
        }
      }
      // v12: cross-field invariant — human-gated status requires humanGate metadata
      if (node.status === "human-gated" && (!node.humanGate || typeof node.humanGate !== "object")) {
        return workflowStateValidationError(`implDag task "${node.id}" has status "human-gated" but no humanGate metadata`)
      }
    }
    try {
      const dagValidation = createImplDAG(state.implDag).validate()
      if (!dagValidation.valid) {
        return workflowStateValidationError(`implDag graph invalid: ${dagValidation.errors.join("; ")}`)
      }
    } catch (error) {
      return workflowStateValidationError(`implDag graph validation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (state.phaseApprovalCounts !== null && state.phaseApprovalCounts !== undefined) {
    if (typeof state.phaseApprovalCounts !== "object" || Array.isArray(state.phaseApprovalCounts)) {
      return workflowStateValidationError(`phaseApprovalCounts must be an object, got ${typeof state.phaseApprovalCounts}`)
    }
    for (const [key, val] of Object.entries(state.phaseApprovalCounts)) {
      if (typeof val !== "number" || val < 0) {
        return workflowStateValidationError(`phaseApprovalCounts["${key}"] must be a non-negative number`)
      }
    }
  }
  if (typeof state.escapePending !== "boolean") {
    return workflowStateValidationError(`escapePending must be a boolean, got ${typeof state.escapePending}`)
  }
  if (state.pendingRevisionSteps !== null && !Array.isArray(state.pendingRevisionSteps)) {
    return workflowStateValidationError(`pendingRevisionSteps must be null or an array, got ${typeof state.pendingRevisionSteps}`)
  }
  // M1: Cross-field invariant — escapePending requires pendingRevisionSteps
  if (state.escapePending && (state.pendingRevisionSteps === null || state.pendingRevisionSteps.length === 0)) {
    return workflowStateValidationError(`escapePending is true but pendingRevisionSteps is ${state.pendingRevisionSteps === null ? "null" : "empty"} — escape hatch requires pending steps`)
  }
  // M2: Cross-field invariant — escapePending requires ESCAPE_HATCH phaseState
  // (structural guarantee: the state machine enforces this via the escape_hatch_triggered event)
  if (state.escapePending && state.phaseState !== "ESCAPE_HATCH") {
    return workflowStateValidationError(`escapePending is true but phaseState is "${state.phaseState}" — must be "ESCAPE_HATCH" (state machine should enforce this)`)
  }
  if (typeof state.userGateMessageReceived !== "boolean") {
    return workflowStateValidationError(`userGateMessageReceived must be a boolean, got ${typeof state.userGateMessageReceived}`)
  }
  if (state.reviewArtifactHash !== null && typeof state.reviewArtifactHash !== "string") {
    return workflowStateValidationError(`reviewArtifactHash must be a string or null, got ${typeof state.reviewArtifactHash}`)
  }
  if (state.latestReviewResults !== null && !Array.isArray(state.latestReviewResults)) {
    return workflowStateValidationError(`latestReviewResults must be an array or null, got ${typeof state.latestReviewResults}`)
  }
  if (state.artifactDiskPaths !== null && state.artifactDiskPaths !== undefined) {
    if (typeof state.artifactDiskPaths !== "object" || Array.isArray(state.artifactDiskPaths)) {
      return workflowStateValidationError(`artifactDiskPaths must be an object, got ${typeof state.artifactDiskPaths}`)
    }
    for (const [key, val] of Object.entries(state.artifactDiskPaths)) {
      if (typeof val !== "string") {
        return workflowStateValidationError(`artifactDiskPaths["${key}"] must be a string, got ${typeof val}`)
      }
      if (!val.startsWith("/")) {
        return workflowStateValidationError(`artifactDiskPaths["${key}"] must be an absolute path (start with "/"), got "${val}"`)
      }
    }
  }
  // approvedArtifactFiles — validate as object with absolute string path arrays
  if (state.approvedArtifactFiles !== undefined && (typeof state.approvedArtifactFiles !== "object" || Array.isArray(state.approvedArtifactFiles) || state.approvedArtifactFiles === null)) {
    return workflowStateValidationError(`approvedArtifactFiles must be an object, got ${typeof state.approvedArtifactFiles}`)
  }
  for (const [key, val] of Object.entries(state.approvedArtifactFiles ?? {})) {
    if (!Array.isArray(val)) {
      return workflowStateValidationError(`approvedArtifactFiles["${key}"] must be an array`)
    }
    for (let i = 0; i < val.length; i++) {
      const path = val[i]
      if (typeof path !== "string") {
        return workflowStateValidationError(`approvedArtifactFiles["${key}"][${i}] must be a string`)
      }
      if (!path.startsWith("/")) {
        return workflowStateValidationError(`approvedArtifactFiles["${key}"][${i}] must be an absolute path (start with "/"), got "${path}"`)
      }
    }
  }
  if (state.featureName !== null && typeof state.featureName !== "string") {
    return workflowStateValidationError(`featureName must be null or a string, got ${typeof state.featureName}`)
  }
  if (typeof state.featureName === "string" && state.featureName.length === 0) {
    return workflowStateValidationError(`featureName must not be an empty string (use null for no feature)`)
  }
  // Security: featureName is used to construct artifact directory paths
  // (.openartisan/<featureName>/). Reject names containing path traversal
  // sequences or characters unsafe for directory names.
  // Sub-workflow feature names may contain "/" for nesting (e.g. "parent/sub/child").
  // Each segment is validated individually.
  if (typeof state.featureName === "string") {
    if (/\.\./.test(state.featureName)) {
      return workflowStateValidationError(`featureName must not contain ".." (path traversal), got "${state.featureName}"`)
    }
    if (/\\/.test(state.featureName)) {
      return workflowStateValidationError(`featureName must not contain backslashes, got "${state.featureName}"`)
    }
    if (state.featureName.startsWith("/") || state.featureName.endsWith("/")) {
      return workflowStateValidationError(`featureName must not start or end with "/", got "${state.featureName}"`)
    }
    if (/\/\//.test(state.featureName)) {
      return workflowStateValidationError(`featureName must not contain consecutive slashes, got "${state.featureName}"`)
    }
    const segments = state.featureName.split("/")
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === "sub" && i === 0) {
        // "sub" is reserved for nesting but only rejected as the TOP-LEVEL name.
        // It's allowed as an interior segment (e.g., "parent/sub/child").
        return workflowStateValidationError(`featureName "sub" is reserved (used for sub-workflow directory nesting). Choose a different name.`)
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segments[i]!)) {
        return workflowStateValidationError(`featureName segment "${segments[i]}" must start with alphanumeric and contain only alphanumeric, dots, hyphens, and underscores, got "${state.featureName}"`)
      }
    }
  }
  // v13: activeAgent
  if (state.activeAgent !== null && state.activeAgent !== undefined) {
    if (typeof state.activeAgent !== "string") {
      return workflowStateValidationError(`activeAgent must be null or a string, got ${typeof state.activeAgent}`)
    }
    if (state.activeAgent.length === 0) {
      return workflowStateValidationError(`activeAgent must not be an empty string (use null for unknown/non-artisan agents)`)
    }
  }
  // v14: taskCompletionInProgress
  if (state.taskCompletionInProgress !== null && state.taskCompletionInProgress !== undefined) {
    if (typeof state.taskCompletionInProgress !== "string") {
      return workflowStateValidationError(`taskCompletionInProgress must be null or a string, got ${typeof state.taskCompletionInProgress}`)
    }
    if (state.taskCompletionInProgress.length === 0) {
      return workflowStateValidationError(`taskCompletionInProgress must not be an empty string (use null when no completion is in progress)`)
    }
    if (state.phase !== "IMPLEMENTATION") {
      return workflowStateValidationError(`taskCompletionInProgress must be null outside IMPLEMENTATION, got "${state.taskCompletionInProgress}" in ${state.phase}`)
    }
    if (state.currentTaskId !== state.taskCompletionInProgress) {
      return workflowStateValidationError(`taskCompletionInProgress "${state.taskCompletionInProgress}" must match currentTaskId while review is pending`)
    }
  }
  // v15: taskReviewCount
  if (typeof state.taskReviewCount !== "number" || state.taskReviewCount < 0 || !Number.isInteger(state.taskReviewCount)) {
    return workflowStateValidationError(`taskReviewCount must be a non-negative integer, got ${state.taskReviewCount}`)
  }
  if (state.phase !== "IMPLEMENTATION" && state.taskReviewCount !== 0) {
    return workflowStateValidationError(`taskReviewCount must be 0 outside IMPLEMENTATION, got ${state.taskReviewCount} in ${state.phase}`)
  }
  // v15: pendingFeedback
  if (state.pendingFeedback !== null && state.pendingFeedback !== undefined) {
    if (typeof state.pendingFeedback !== "string") {
      return workflowStateValidationError(`pendingFeedback must be null or a string, got ${typeof state.pendingFeedback}`)
    }
  }
  // v11: revisionBaseline
  if (state.revisionBaseline !== null && state.revisionBaseline !== undefined) {
    const rb = state.revisionBaseline as Record<string, unknown>
    if (typeof rb !== "object" || Array.isArray(rb)) {
      return workflowStateValidationError(`revisionBaseline must be null or an object, got ${typeof rb}`)
    }
    if (rb.type !== "content-hash" && rb.type !== "git-sha") {
      return workflowStateValidationError(`revisionBaseline.type must be "content-hash" or "git-sha", got "${rb.type}"`)
    }
    if (rb.type === "content-hash" && typeof rb.hash !== "string") {
      return workflowStateValidationError(`revisionBaseline of type "content-hash" must have a string "hash" field`)
    }
    if (rb.type === "git-sha" && typeof rb.sha !== "string") {
      return workflowStateValidationError(`revisionBaseline of type "git-sha" must have a string "sha" field`)
    }
  }
  // v16: userMessages
  if (!Array.isArray(state.userMessages)) {
    return workflowStateValidationError(`userMessages must be an array, got ${typeof state.userMessages}`)
  }
  for (let i = 0; i < state.userMessages.length; i++) {
    if (typeof state.userMessages[i] !== "string") {
      return workflowStateValidationError(`userMessages[${i}] must be a string`)
    }
  }
  // Nullable string fields — validate type when non-null
  if (state.lastCheckpointTag !== null && typeof state.lastCheckpointTag !== "string") {
    return workflowStateValidationError(`lastCheckpointTag must be null or a string, got ${typeof state.lastCheckpointTag}`)
  }
  if (state.orchestratorSessionId !== null && typeof state.orchestratorSessionId !== "string") {
    return workflowStateValidationError(`orchestratorSessionId must be null or a string, got ${typeof state.orchestratorSessionId}`)
  }
  if (state.intentBaseline !== null && typeof state.intentBaseline !== "string") {
    return workflowStateValidationError(`intentBaseline must be null or a string, got ${typeof state.intentBaseline}`)
  }
  if (state.modeDetectionNote !== null && typeof state.modeDetectionNote !== "string") {
    return workflowStateValidationError(`modeDetectionNote must be null or a string, got ${typeof state.modeDetectionNote}`)
  }
  if (state.discoveryReport !== null && typeof state.discoveryReport !== "string") {
    return workflowStateValidationError(`discoveryReport must be null or a string, got ${typeof state.discoveryReport}`)
  }
  // approvedArtifacts — validate as object with string values
  if (typeof state.approvedArtifacts !== "object" || Array.isArray(state.approvedArtifacts) || state.approvedArtifacts === null) {
    return workflowStateValidationError(`approvedArtifacts must be an object, got ${typeof state.approvedArtifacts}`)
  }
  for (const [key, val] of Object.entries(state.approvedArtifacts)) {
    if (typeof val !== "string") {
      return workflowStateValidationError(`approvedArtifacts["${key}"] must be a string, got ${typeof val}`)
    }
  }
  // cachedPriorState — validate shape when non-null (transient, cleared on load)
  if (state.cachedPriorState !== null && state.cachedPriorState !== undefined) {
    const cps = state.cachedPriorState as Record<string, unknown>
    if (typeof cps !== "object" || Array.isArray(cps)) {
      return workflowStateValidationError(`cachedPriorState must be null or an object, got ${typeof cps}`)
    }
    if (typeof cps.phase !== "string") {
      return workflowStateValidationError(`cachedPriorState.phase must be a string`)
    }
    if (typeof cps.artifactDiskPaths !== "object" || Array.isArray(cps.artifactDiskPaths) || cps.artifactDiskPaths === null) {
      return workflowStateValidationError(`cachedPriorState.artifactDiskPaths must be an object`)
    }
  }
  // v21: parentWorkflow
  if (state.parentWorkflow !== null && state.parentWorkflow !== undefined) {
    const pw = state.parentWorkflow as Record<string, unknown>
    if (typeof pw !== "object" || Array.isArray(pw)) {
      return workflowStateValidationError(`parentWorkflow must be null or an object, got ${typeof pw}`)
    }
    if (typeof pw.sessionId !== "string" || !pw.sessionId) {
      return workflowStateValidationError(`parentWorkflow.sessionId must be a non-empty string`)
    }
    if (typeof pw.featureName !== "string" || !pw.featureName) {
      return workflowStateValidationError(`parentWorkflow.featureName must be a non-empty string`)
    }
    if (typeof pw.taskId !== "string" || !pw.taskId) {
      return workflowStateValidationError(`parentWorkflow.taskId must be a non-empty string`)
    }
  }
  if (state.implDag !== null) {
    const taskIds = new Set(state.implDag.map((task) => task.id))
    if (state.currentTaskId !== null && !taskIds.has(state.currentTaskId)) {
      return workflowStateValidationError(`currentTaskId "${state.currentTaskId}" does not exist in implDag`)
    }
    const currentTask = state.currentTaskId !== null
      ? state.implDag.find((task) => task.id === state.currentTaskId) ?? null
      : null
    if (
      currentTask &&
      (currentTask.status === "complete" || currentTask.status === "aborted") &&
      state.taskCompletionInProgress !== state.currentTaskId
    ) {
      return workflowStateValidationError(`currentTaskId "${state.currentTaskId}" cannot point to a terminal task with status "${currentTask.status}"`)
    }
    if (state.taskCompletionInProgress !== null && !taskIds.has(state.taskCompletionInProgress)) {
      return workflowStateValidationError(`taskCompletionInProgress "${state.taskCompletionInProgress}" does not exist in implDag`)
    }
    if (state.phase === "DONE") {
      const unfinished = state.implDag.filter((task) => task.status !== "complete" && task.status !== "aborted")
      if (unfinished.length > 0) {
        return workflowStateValidationError(`DONE cannot contain unresolved implDag work: ${unfinished.map((task) => task.id).join(", ")}`)
      }
    }
  }
  // v21: childWorkflows
  if (!Array.isArray(state.childWorkflows)) {
    return workflowStateValidationError(`childWorkflows must be an array, got ${typeof state.childWorkflows}`)
  }
  const validChildStatuses = ["pending", "running", "complete", "failed"]
  for (let i = 0; i < state.childWorkflows.length; i++) {
    const cw = state.childWorkflows[i]
    if (!cw || typeof cw !== "object") {
      return workflowStateValidationError(`childWorkflows[${i}] must be an object`)
    }
    if (typeof cw.taskId !== "string" || !cw.taskId) {
      return workflowStateValidationError(`childWorkflows[${i}].taskId must be a non-empty string`)
    }
    if (typeof cw.featureName !== "string" || !cw.featureName) {
      return workflowStateValidationError(`childWorkflows[${i}].featureName must be a non-empty string`)
    }
    if (cw.sessionId !== null && (typeof cw.sessionId !== "string" || !cw.sessionId)) {
      return workflowStateValidationError(`childWorkflows[${i}].sessionId must be null or a non-empty string`)
    }
    if (typeof cw.status !== "string" || !validChildStatuses.includes(cw.status)) {
      return workflowStateValidationError(`childWorkflows[${i}].status must be one of ${validChildStatuses.join(", ")}, got "${cw.status}"`)
    }
    if (typeof cw.delegatedAt !== "string" || !cw.delegatedAt) {
      return workflowStateValidationError(`childWorkflows[${i}].delegatedAt must be a non-empty ISO timestamp string`)
    }
  }
  // v21: concurrency
  if (!state.concurrency || typeof state.concurrency !== "object" || Array.isArray(state.concurrency)) {
    return workflowStateValidationError(`concurrency must be an object, got ${typeof state.concurrency}`)
  }
  if (typeof state.concurrency.maxParallelTasks !== "number" || !Number.isInteger(state.concurrency.maxParallelTasks) || state.concurrency.maxParallelTasks < 1) {
    return workflowStateValidationError(`concurrency.maxParallelTasks must be a positive integer, got ${state.concurrency.maxParallelTasks}`)
  }
  // v22: reviewArtifactFiles
  if (!Array.isArray(state.reviewArtifactFiles)) {
    return workflowStateValidationError(`reviewArtifactFiles must be an array, got ${typeof state.reviewArtifactFiles}`)
  }
  for (let i = 0; i < state.reviewArtifactFiles.length; i++) {
    if (typeof state.reviewArtifactFiles[i] !== "string") {
      return workflowStateValidationError(`reviewArtifactFiles[${i}] must be a string`)
    }
  }
  // v21 cross-field: running childWorkflows entries must reference a "delegated" DAG task
  if (state.implDag && state.childWorkflows.length > 0) {
    for (let i = 0; i < state.childWorkflows.length; i++) {
      const cw = state.childWorkflows[i]!
      if (cw.status === "running" || cw.status === "pending") {
        const dagTask = state.implDag.find((t) => t.id === cw.taskId)
        if (dagTask && dagTask.status !== "delegated") {
          return workflowStateValidationError(`childWorkflows[${i}] (taskId="${cw.taskId}") has status "${cw.status}" but the DAG task has status "${dagTask.status}" — expected "delegated"`)
        }
      }
    }
  }
  return null
}
