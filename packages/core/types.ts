/**
 * types.ts — All interfaces, enums, and data models for the open-artisan plugin.
 * No implementation here — pure type definitions only.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type WorkflowMode = "GREENFIELD" | "REFACTOR" | "INCREMENTAL"

export type Phase =
  | "MODE_SELECT"
  | "DISCOVERY"
  | "PLANNING"
  | "INTERFACES"
  | "TESTS"
  | "IMPL_PLAN"
  | "IMPLEMENTATION"
  | "DONE"

/**
 * Sub-states within a phase.
 * SCAN/ANALYZE/CONVENTIONS are only valid in the DISCOVERY phase.
 * DRAFT/REVIEW/USER_GATE/REVISE are valid in PLANNING, INTERFACES, TESTS, IMPL_PLAN, IMPLEMENTATION.
 * MODE_SELECT and DONE have no sub-state (use "DRAFT" as a sentinel).
 */
export type PhaseState =
  | "SCAN"
  | "ANALYZE"
  | "CONVENTIONS"
  | "DRAFT"
  | "REVIEW"
  | "USER_GATE"
  | "ESCAPE_HATCH"
  | "REVISE"

/**
 * Which PhaseStates are valid for each Phase.
 * Enforced by the state machine at transition time.
 */
export const VALID_PHASE_STATES: Record<Phase, PhaseState[]> = {
  MODE_SELECT: ["DRAFT"],
  DISCOVERY: ["SCAN", "ANALYZE", "CONVENTIONS", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  PLANNING: ["DRAFT", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  INTERFACES: ["DRAFT", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  TESTS: ["DRAFT", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  IMPL_PLAN: ["DRAFT", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  IMPLEMENTATION: ["DRAFT", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  DONE: ["DRAFT"],
}

export type WorkflowEvent =
  | "mode_selected"           // MODE_SELECT → DISCOVERY or PLANNING
  | "scan_complete"           // DISCOVERY/SCAN → DISCOVERY/ANALYZE
  | "analyze_complete"        // DISCOVERY/ANALYZE → DISCOVERY/CONVENTIONS
  | "draft_complete"          // */DRAFT → */REVIEW
  | "self_review_pass"        // */REVIEW → */USER_GATE
  | "self_review_fail"        // */REVIEW → */REVISE (address feedback, increments iterationCount)
  | "escalate_to_user"        // */REVIEW → */USER_GATE (iteration cap reached — M12)
  | "user_approve"            // */USER_GATE → next Phase/DRAFT (+ git checkpoint)
  | "user_feedback"           // */USER_GATE or */ESCAPE_HATCH → orchestrator → */REVISE
  | "escape_hatch_triggered"  // */USER_GATE → */ESCAPE_HATCH (strategic pivot detected)
  | "revision_complete"       // */REVISE → */REVIEW

export type ArtifactKey =
  | "design"
  | "conventions"
  | "plan"
  | "interfaces"
  | "tests"
  | "impl_plan"
  | "implementation"

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
 */
export const SCHEMA_VERSION = 22

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
   * null = no orchestrator call in flight.
   */
  pendingFeedback: string | null

  /**
   * Full conversation history of user messages.
   * Captured from chat.message hook and passed to self-review subagent.
   * Provides complete context beyond just intentBaseline.
   */
  userMessages: string[]

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
  concurrency: { maxParallelTasks: number }

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

export interface TransitionSuccess {
  success: true
  nextPhase: Phase
  nextPhaseState: PhaseState
}

export interface TransitionFailure {
  success: false
  /** Machine-readable error code */
  code: "INVALID_EVENT" | "INVARIANT_VIOLATED" | "INVALID_PHASE_STATE"
  /** Human-readable explanation */
  message: string
}

export type TransitionOutcome = TransitionSuccess | TransitionFailure

export interface StateMachine {
  /**
   * Compute the next state for a given event.
   * Pure function — does NOT mutate the state object.
   * Returns TransitionFailure if the transition is invalid or violates an invariant.
   *
   * Key invariant enforced: user_feedback and self_review_fail never produce
   * a nextPhaseState of "DRAFT". All feedback routes to REVISE.
   */
  transition(
    currentPhase: Phase,
    currentPhaseState: PhaseState,
    event: WorkflowEvent,
    mode: WorkflowMode | null,
  ): TransitionOutcome

  /** Returns all valid events in the given phase/state. When mode is provided,
   *  only events whose mode predicate matches are returned. */
  validEvents(phase: Phase, phaseState: PhaseState, mode?: WorkflowMode | null): WorkflowEvent[]

  /** True iff the state requires the agent to be idle, waiting for the user */
  isUserGate(phase: Phase, phaseState: PhaseState): boolean

  /** True iff the state is an auto-continuation state (agent should keep working) */
  isAgentActive(phase: Phase, phaseState: PhaseState): boolean
}

// ---------------------------------------------------------------------------
// Artifact dependency graph
// ---------------------------------------------------------------------------

export interface ArtifactGraph {
  /**
   * Returns all artifacts that depend on the given artifact (directly or transitively),
   * in topological order (nearest dependents first, farthest last).
   * In GREENFIELD mode, "conventions" is excluded from all results.
   */
  getDependents(artifact: ArtifactKey, mode: WorkflowMode): ArtifactKey[]

  /**
   * Returns the direct upstream dependencies of the given artifact.
   * In GREENFIELD mode, "conventions" is excluded.
   */
  getDependencies(artifact: ArtifactKey, mode: WorkflowMode): ArtifactKey[]

  /**
   * Returns the Phase that owns and produces the given artifact.
   */
  getOwningPhase(artifact: ArtifactKey): Phase

  /**
   * Returns the REVISE PhaseState target for the given artifact.
   * Always returns "REVISE" — but the Phase differs per artifact.
   */
  getReviseTarget(artifact: ArtifactKey): { phase: Phase; phaseState: "REVISE" }
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

/**
 * Tracks active session lifecycle and parent-child relationships.
 *
 * Replaces the ad-hoc `activeSession` wrapper and `childSessionParents` Map
 * with a single cohesive interface. Feature mapping is NOT in the registry —
 * use `store.get(sessionId)?.featureName` for that.
 *
 * Primary sessions get their own WorkflowState. Child sessions (subagent
 * reviewers, orchestrator, discovery fleet) inherit the parent's tool policy.
 */
export interface SessionRegistry {
  /** Register a primary session (will get its own WorkflowState). */
  registerPrimary(sessionId: string): void

  /** Register a child session that inherits from a parent. */
  registerChild(sessionId: string, parentId: string): void

  /** Unregister any session (primary or child). */
  unregister(sessionId: string): void

  /** Get the parent ID for a child session. null if primary or unknown. */
  getParent(sessionId: string): string | null

  /** True if the session is a registered child session. */
  isChild(sessionId: string): boolean

  /** Mark a session as the most recently active (updated on each tool call). */
  setActive(sessionId: string): void

  /** Get the most recently active primary session ID. */
  getActiveId(): string | undefined

  /** Count of all tracked sessions (primary + child). */
  count(): number
}

// ---------------------------------------------------------------------------
// State backend (persistence layer)
// ---------------------------------------------------------------------------

/**
 * Low-level persistence backend for per-feature workflow state.
 *
 * Implementations handle storage I/O and cross-process locking.
 * The SessionStateStore layer above handles in-memory caching, schema
 * migration, validation, and in-process serialization.
 *
 * Built-in implementations:
 * - FileSystemStateBackend: per-feature JSON files + lockfiles
 *
 * Future implementations could use SQLite, Redis, or JSON-RPC (bridge server).
 */
export interface StateBackend {
  /** Read raw JSON for a feature. Returns null if not found. */
  read(featureName: string): Promise<string | null>

  /** Write raw JSON for a feature. Creates storage location if needed. */
  write(featureName: string, data: string): Promise<void>

  /** Remove stored state for a feature. No-op if not found. */
  remove(featureName: string): Promise<void>

  /** List all feature names that have persisted state. */
  list(): Promise<string[]>

  /**
   * Acquire an exclusive lock for a feature.
   * Returns a release function that must be called when done.
   * Implementations may use lockfiles, database locks, etc.
   */
  lock(featureName: string): Promise<{ release(): Promise<void> }>
}

// ---------------------------------------------------------------------------
// Session state store
// ---------------------------------------------------------------------------

export interface StoreLoadResult {
  success: true
  count: number
}

export interface StoreLoadError {
  success: false
  error: string
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
 * Returns null if valid, or an error message describing the first violation found.
 *
 * Rules:
 * - schemaVersion must equal SCHEMA_VERSION
 * - sessionId must be a non-empty string
 * - phase must be a valid Phase value
 * - phaseState must be valid for the current phase (per VALID_PHASE_STATES)
 * - iterationCount, retryCount, approvalCount must all be >= 0
 * - fileAllowlist paths must start with "/" in INCREMENTAL mode
 */
export function validateWorkflowState(state: WorkflowState): string | null {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return `Invalid schemaVersion: expected ${SCHEMA_VERSION}, got ${state.schemaVersion}`
  }
  if (!state.sessionId || typeof state.sessionId !== "string") {
    return "Invalid sessionId: must be a non-empty string"
  }
  const validPhases = Object.keys(VALID_PHASE_STATES) as Phase[]
  if (!validPhases.includes(state.phase)) {
    return `Invalid phase: "${state.phase}"`
  }
  const validStates = VALID_PHASE_STATES[state.phase]
  if (!validStates.includes(state.phaseState)) {
    return `Invalid phaseState "${state.phaseState}" for phase "${state.phase}". Valid: ${validStates.join(", ")}`
  }
  if (state.mode !== null && state.mode !== "GREENFIELD" && state.mode !== "REFACTOR" && state.mode !== "INCREMENTAL") {
    return `Invalid mode: "${state.mode}". Must be null, "GREENFIELD", "REFACTOR", or "INCREMENTAL".`
  }
  if (state.iterationCount < 0) return "iterationCount must be >= 0"
  if (state.retryCount < 0) return "retryCount must be >= 0"
  if (state.approvalCount < 0) return "approvalCount must be >= 0"
  if (state.mode === "INCREMENTAL") {
    for (const path of state.fileAllowlist) {
      if (!path.startsWith("/")) {
        return `fileAllowlist path "${path}" must be an absolute path (start with "/")`
      }
    }
  }
  if (state.conventions !== null && typeof state.conventions !== "string") {
    return `conventions must be null or a string, got ${typeof state.conventions}`
  }
  if (typeof state.priorWorkflowChecked !== "boolean") {
    return `priorWorkflowChecked must be a boolean, got ${typeof state.priorWorkflowChecked}`
  }
  if (state.sessionModel !== null) {
    if (typeof state.sessionModel === "string") {
      // valid
    } else if (typeof state.sessionModel === "object" && !Array.isArray(state.sessionModel)) {
      if (!("modelID" in state.sessionModel) || typeof state.sessionModel.modelID !== "string") {
        return `sessionModel object must have a string modelID field`
      }
    } else {
      return `sessionModel must be null, a string, or an object with modelID, got ${typeof state.sessionModel}`
    }
  }
  if (state.currentTaskId !== null && typeof state.currentTaskId !== "string") {
    return `currentTaskId must be null or a string, got ${typeof state.currentTaskId}`
  }
  if (!Array.isArray(state.feedbackHistory)) {
    return `feedbackHistory must be an array, got ${typeof state.feedbackHistory}`
  }
  for (let i = 0; i < state.feedbackHistory.length; i++) {
    const entry = state.feedbackHistory[i]
    if (!entry || typeof entry !== "object") {
      return `feedbackHistory[${i}] must be an object`
    }
    if (typeof entry.phase !== "string") {
      return `feedbackHistory[${i}].phase must be a string`
    }
    if (typeof entry.feedback !== "string") {
      return `feedbackHistory[${i}].feedback must be a string`
    }
    if (typeof entry.timestamp !== "number" || entry.timestamp < 0) {
      return `feedbackHistory[${i}].timestamp must be a non-negative number`
    }
  }
  if (state.implDag !== null) {
    if (!Array.isArray(state.implDag)) {
      return `implDag must be null or an array, got ${typeof state.implDag}`
    }
    for (const node of state.implDag) {
      if (!node || typeof node !== "object") {
        return `implDag contains a non-object entry`
      }
      if (typeof node.id !== "string" || !node.id) {
        return `implDag task missing required "id" string field`
      }
      if (!Array.isArray(node.dependencies)) {
        return `implDag task "${node.id}" missing required "dependencies" array`
      }
      const validStatuses = ["pending", "in-flight", "complete", "aborted", "human-gated", "delegated"]
      if (typeof node.status !== "string" || !validStatuses.includes(node.status)) {
        return `implDag task "${node.id}" has invalid status "${node.status}"`
      }
      // v22: validate expectedFiles array
      if (node.expectedFiles !== undefined && node.expectedFiles !== null) {
        if (!Array.isArray(node.expectedFiles)) {
          return `implDag task "${node.id}" expectedFiles must be an array`
        }
        for (let j = 0; j < node.expectedFiles.length; j++) {
          if (typeof node.expectedFiles[j] !== "string") {
            return `implDag task "${node.id}" expectedFiles[${j}] must be a string`
          }
        }
      }
      // v12: validate optional category field
      if (node.category !== undefined && node.category !== null) {
        const validCategories = ["scaffold", "human-gate", "integration", "standalone"]
        if (typeof node.category !== "string" || !validCategories.includes(node.category)) {
          return `implDag task "${node.id}" has invalid category "${node.category}". Valid: ${validCategories.join(", ")}`
        }
      }
      // v12: validate humanGate field if present
      if (node.humanGate !== undefined && node.humanGate !== null) {
        const hg = node.humanGate
        if (typeof hg !== "object" || Array.isArray(hg)) {
          return `implDag task "${node.id}" humanGate must be an object`
        }
        if (typeof hg.whatIsNeeded !== "string") {
          return `implDag task "${node.id}" humanGate.whatIsNeeded must be a string`
        }
        if (typeof hg.why !== "string") {
          return `implDag task "${node.id}" humanGate.why must be a string`
        }
        if (typeof hg.verificationSteps !== "string") {
          return `implDag task "${node.id}" humanGate.verificationSteps must be a string`
        }
        if (typeof hg.resolved !== "boolean") {
          return `implDag task "${node.id}" humanGate.resolved must be a boolean`
        }
      }
      // v12: cross-field invariant — human-gated status requires humanGate metadata
      if (node.status === "human-gated" && (!node.humanGate || typeof node.humanGate !== "object")) {
        return `implDag task "${node.id}" has status "human-gated" but no humanGate metadata`
      }
    }
  }
  if (state.phaseApprovalCounts !== null && state.phaseApprovalCounts !== undefined) {
    if (typeof state.phaseApprovalCounts !== "object" || Array.isArray(state.phaseApprovalCounts)) {
      return `phaseApprovalCounts must be an object, got ${typeof state.phaseApprovalCounts}`
    }
    for (const [key, val] of Object.entries(state.phaseApprovalCounts)) {
      if (typeof val !== "number" || val < 0) {
        return `phaseApprovalCounts["${key}"] must be a non-negative number`
      }
    }
  }
  if (typeof state.escapePending !== "boolean") {
    return `escapePending must be a boolean, got ${typeof state.escapePending}`
  }
  if (state.pendingRevisionSteps !== null && !Array.isArray(state.pendingRevisionSteps)) {
    return `pendingRevisionSteps must be null or an array, got ${typeof state.pendingRevisionSteps}`
  }
  // M1: Cross-field invariant — escapePending requires pendingRevisionSteps
  if (state.escapePending && (state.pendingRevisionSteps === null || state.pendingRevisionSteps.length === 0)) {
    return `escapePending is true but pendingRevisionSteps is ${state.pendingRevisionSteps === null ? "null" : "empty"} — escape hatch requires pending steps`
  }
  // M2: Cross-field invariant — escapePending requires ESCAPE_HATCH phaseState
  // (structural guarantee: the state machine enforces this via the escape_hatch_triggered event)
  if (state.escapePending && state.phaseState !== "ESCAPE_HATCH") {
    return `escapePending is true but phaseState is "${state.phaseState}" — must be "ESCAPE_HATCH" (state machine should enforce this)`
  }
  if (typeof state.userGateMessageReceived !== "boolean") {
    return `userGateMessageReceived must be a boolean, got ${typeof state.userGateMessageReceived}`
  }
  if (state.reviewArtifactHash !== null && typeof state.reviewArtifactHash !== "string") {
    return `reviewArtifactHash must be a string or null, got ${typeof state.reviewArtifactHash}`
  }
  if (state.latestReviewResults !== null && !Array.isArray(state.latestReviewResults)) {
    return `latestReviewResults must be an array or null, got ${typeof state.latestReviewResults}`
  }
  if (state.artifactDiskPaths !== null && state.artifactDiskPaths !== undefined) {
    if (typeof state.artifactDiskPaths !== "object" || Array.isArray(state.artifactDiskPaths)) {
      return `artifactDiskPaths must be an object, got ${typeof state.artifactDiskPaths}`
    }
    for (const [key, val] of Object.entries(state.artifactDiskPaths)) {
      if (typeof val !== "string") {
        return `artifactDiskPaths["${key}"] must be a string, got ${typeof val}`
      }
      if (!val.startsWith("/")) {
        return `artifactDiskPaths["${key}"] must be an absolute path (start with "/"), got "${val}"`
      }
    }
  }
  if (state.featureName !== null && typeof state.featureName !== "string") {
    return `featureName must be null or a string, got ${typeof state.featureName}`
  }
  if (typeof state.featureName === "string" && state.featureName.length === 0) {
    return `featureName must not be an empty string (use null for no feature)`
  }
  // Security: featureName is used to construct artifact directory paths
  // (.openartisan/<featureName>/). Reject names containing path traversal
  // sequences or characters unsafe for directory names.
  // Sub-workflow feature names may contain "/" for nesting (e.g. "parent/sub/child").
  // Each segment is validated individually.
  if (typeof state.featureName === "string") {
    if (/\.\./.test(state.featureName)) {
      return `featureName must not contain ".." (path traversal), got "${state.featureName}"`
    }
    if (/\\/.test(state.featureName)) {
      return `featureName must not contain backslashes, got "${state.featureName}"`
    }
    if (state.featureName.startsWith("/") || state.featureName.endsWith("/")) {
      return `featureName must not start or end with "/", got "${state.featureName}"`
    }
    if (/\/\//.test(state.featureName)) {
      return `featureName must not contain consecutive slashes, got "${state.featureName}"`
    }
    const segments = state.featureName.split("/")
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === "sub" && i === 0) {
        // "sub" is reserved for nesting but only rejected as the TOP-LEVEL name.
        // It's allowed as an interior segment (e.g., "parent/sub/child").
        return `featureName "sub" is reserved (used for sub-workflow directory nesting). Choose a different name.`
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segments[i]!)) {
        return `featureName segment "${segments[i]}" must start with alphanumeric and contain only alphanumeric, dots, hyphens, and underscores, got "${state.featureName}"`
      }
    }
  }
  // v13: activeAgent
  if (state.activeAgent !== null && state.activeAgent !== undefined) {
    if (typeof state.activeAgent !== "string") {
      return `activeAgent must be null or a string, got ${typeof state.activeAgent}`
    }
    if (state.activeAgent.length === 0) {
      return `activeAgent must not be an empty string (use null for unknown/non-artisan agents)`
    }
  }
  // v14: taskCompletionInProgress
  if (state.taskCompletionInProgress !== null && state.taskCompletionInProgress !== undefined) {
    if (typeof state.taskCompletionInProgress !== "string") {
      return `taskCompletionInProgress must be null or a string, got ${typeof state.taskCompletionInProgress}`
    }
    if (state.taskCompletionInProgress.length === 0) {
      return `taskCompletionInProgress must not be an empty string (use null when no completion is in progress)`
    }
  }
  // v15: taskReviewCount
  if (typeof state.taskReviewCount !== "number" || state.taskReviewCount < 0 || !Number.isInteger(state.taskReviewCount)) {
    return `taskReviewCount must be a non-negative integer, got ${state.taskReviewCount}`
  }
  // v15: pendingFeedback
  if (state.pendingFeedback !== null && state.pendingFeedback !== undefined) {
    if (typeof state.pendingFeedback !== "string") {
      return `pendingFeedback must be null or a string, got ${typeof state.pendingFeedback}`
    }
  }
  // v11: revisionBaseline
  if (state.revisionBaseline !== null && state.revisionBaseline !== undefined) {
    const rb = state.revisionBaseline as Record<string, unknown>
    if (typeof rb !== "object" || Array.isArray(rb)) {
      return `revisionBaseline must be null or an object, got ${typeof rb}`
    }
    if (rb.type !== "content-hash" && rb.type !== "git-sha") {
      return `revisionBaseline.type must be "content-hash" or "git-sha", got "${rb.type}"`
    }
    if (rb.type === "content-hash" && typeof rb.hash !== "string") {
      return `revisionBaseline of type "content-hash" must have a string "hash" field`
    }
    if (rb.type === "git-sha" && typeof rb.sha !== "string") {
      return `revisionBaseline of type "git-sha" must have a string "sha" field`
    }
  }
  // v16: userMessages
  if (!Array.isArray(state.userMessages)) {
    return `userMessages must be an array, got ${typeof state.userMessages}`
  }
  for (let i = 0; i < state.userMessages.length; i++) {
    if (typeof state.userMessages[i] !== "string") {
      return `userMessages[${i}] must be a string`
    }
  }
  // Nullable string fields — validate type when non-null
  if (state.lastCheckpointTag !== null && typeof state.lastCheckpointTag !== "string") {
    return `lastCheckpointTag must be null or a string, got ${typeof state.lastCheckpointTag}`
  }
  if (state.orchestratorSessionId !== null && typeof state.orchestratorSessionId !== "string") {
    return `orchestratorSessionId must be null or a string, got ${typeof state.orchestratorSessionId}`
  }
  if (state.intentBaseline !== null && typeof state.intentBaseline !== "string") {
    return `intentBaseline must be null or a string, got ${typeof state.intentBaseline}`
  }
  if (state.modeDetectionNote !== null && typeof state.modeDetectionNote !== "string") {
    return `modeDetectionNote must be null or a string, got ${typeof state.modeDetectionNote}`
  }
  if (state.discoveryReport !== null && typeof state.discoveryReport !== "string") {
    return `discoveryReport must be null or a string, got ${typeof state.discoveryReport}`
  }
  // approvedArtifacts — validate as object with string values
  if (typeof state.approvedArtifacts !== "object" || Array.isArray(state.approvedArtifacts) || state.approvedArtifacts === null) {
    return `approvedArtifacts must be an object, got ${typeof state.approvedArtifacts}`
  }
  for (const [key, val] of Object.entries(state.approvedArtifacts)) {
    if (typeof val !== "string") {
      return `approvedArtifacts["${key}"] must be a string, got ${typeof val}`
    }
  }
  // cachedPriorState — validate shape when non-null (transient, cleared on load)
  if (state.cachedPriorState !== null && state.cachedPriorState !== undefined) {
    const cps = state.cachedPriorState as Record<string, unknown>
    if (typeof cps !== "object" || Array.isArray(cps)) {
      return `cachedPriorState must be null or an object, got ${typeof cps}`
    }
    if (typeof cps.phase !== "string") {
      return `cachedPriorState.phase must be a string`
    }
    if (typeof cps.artifactDiskPaths !== "object" || Array.isArray(cps.artifactDiskPaths) || cps.artifactDiskPaths === null) {
      return `cachedPriorState.artifactDiskPaths must be an object`
    }
  }
  // v21: parentWorkflow
  if (state.parentWorkflow !== null && state.parentWorkflow !== undefined) {
    const pw = state.parentWorkflow as Record<string, unknown>
    if (typeof pw !== "object" || Array.isArray(pw)) {
      return `parentWorkflow must be null or an object, got ${typeof pw}`
    }
    if (typeof pw.sessionId !== "string" || !pw.sessionId) {
      return `parentWorkflow.sessionId must be a non-empty string`
    }
    if (typeof pw.featureName !== "string" || !pw.featureName) {
      return `parentWorkflow.featureName must be a non-empty string`
    }
    if (typeof pw.taskId !== "string" || !pw.taskId) {
      return `parentWorkflow.taskId must be a non-empty string`
    }
  }
  // v21: childWorkflows
  if (!Array.isArray(state.childWorkflows)) {
    return `childWorkflows must be an array, got ${typeof state.childWorkflows}`
  }
  const validChildStatuses = ["pending", "running", "complete", "failed"]
  for (let i = 0; i < state.childWorkflows.length; i++) {
    const cw = state.childWorkflows[i]
    if (!cw || typeof cw !== "object") {
      return `childWorkflows[${i}] must be an object`
    }
    if (typeof cw.taskId !== "string" || !cw.taskId) {
      return `childWorkflows[${i}].taskId must be a non-empty string`
    }
    if (typeof cw.featureName !== "string" || !cw.featureName) {
      return `childWorkflows[${i}].featureName must be a non-empty string`
    }
    if (cw.sessionId !== null && (typeof cw.sessionId !== "string" || !cw.sessionId)) {
      return `childWorkflows[${i}].sessionId must be null or a non-empty string`
    }
    if (typeof cw.status !== "string" || !validChildStatuses.includes(cw.status)) {
      return `childWorkflows[${i}].status must be one of ${validChildStatuses.join(", ")}, got "${cw.status}"`
    }
    if (typeof cw.delegatedAt !== "string" || !cw.delegatedAt) {
      return `childWorkflows[${i}].delegatedAt must be a non-empty ISO timestamp string`
    }
  }
  // v21: concurrency
  if (!state.concurrency || typeof state.concurrency !== "object" || Array.isArray(state.concurrency)) {
    return `concurrency must be an object, got ${typeof state.concurrency}`
  }
  if (typeof state.concurrency.maxParallelTasks !== "number" || !Number.isInteger(state.concurrency.maxParallelTasks) || state.concurrency.maxParallelTasks < 1) {
    return `concurrency.maxParallelTasks must be a positive integer, got ${state.concurrency.maxParallelTasks}`
  }
  // v22: reviewArtifactFiles
  if (!Array.isArray(state.reviewArtifactFiles)) {
    return `reviewArtifactFiles must be an array, got ${typeof state.reviewArtifactFiles}`
  }
  for (let i = 0; i < state.reviewArtifactFiles.length; i++) {
    if (typeof state.reviewArtifactFiles[i] !== "string") {
      return `reviewArtifactFiles[${i}] must be a string`
    }
  }
  // v21 cross-field: running childWorkflows entries must reference a "delegated" DAG task
  if (state.implDag && state.childWorkflows.length > 0) {
    for (let i = 0; i < state.childWorkflows.length; i++) {
      const cw = state.childWorkflows[i]!
      if (cw.status === "running" || cw.status === "pending") {
        const dagTask = state.implDag.find((t) => t.id === cw.taskId)
        if (dagTask && dagTask.status !== "delegated") {
          return `childWorkflows[${i}] (taskId="${cw.taskId}") has status "${cw.status}" but the DAG task has status "${dagTask.status}" — expected "delegated"`
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * The Orchestrator routes user feedback through the artifact dependency graph
 * to determine which artifacts need revision and in what order.
 */
export interface Orchestrator {
  route(input: OrchestratorRouteInput): Promise<OrchestratorPlanResult>
}

export interface OrchestratorAssessSuccess {
  success: true
  affectedArtifacts: ArtifactKey[]
  rootCauseArtifact: ArtifactKey
  reasoning: string
}

export interface OrchestratorAssessError {
  success: false
  error: string
  /** Fall back to treating it as affecting the current phase's artifact only */
  fallbackArtifact: ArtifactKey
}

export type OrchestratorAssessResult = OrchestratorAssessSuccess | OrchestratorAssessError

export type DivergenceClass = "tactical" | "strategic" | "backtrack"

export interface OrchestratorDivergeSuccess {
  success: true
  classification: DivergenceClass
  triggerCriterion?: "scope_expansion" | "architectural_shift" | "cascade_depth" | "accumulated_drift" | "upstream_root_cause"
  reasoning: string
}

export interface OrchestratorDivergeError {
  success: false
  error: string
  /** Fall back to "tactical" on classification failure */
  fallback: "tactical"
}

export type OrchestratorDivergeResult = OrchestratorDivergeSuccess | OrchestratorDivergeError

export interface RevisionStep {
  artifact: ArtifactKey
  phase: Phase
  phaseState: "REVISE" | "DRAFT"
  instructions: string
}

export interface OrchestratorPlanResult {
  /** Ordered revision steps, earliest upstream artifact first */
  revisionSteps: RevisionStep[]
  /**
   * Whether the orchestrator classified this change as tactical, strategic, or backtrack.
   * tactical → agent proceeds autonomously to REVISE.
   * strategic → escape hatch is presented to the user before proceeding.
   * backtrack → route to an earlier phase's DRAFT state (scope change detected).
   * Callers MUST use this field rather than re-deriving from revisionSteps.length.
   */
  classification: "tactical" | "strategic" | "backtrack"
}

/**
 * Input to the orchestrator's route() method.
 * approvedArtifacts is passed through to the diverge call so it can detect
 * accumulated drift across multiple approved artifacts.
 */
export interface OrchestratorRouteInput {
  feedback: string
  currentPhase: Phase
  currentPhaseState: PhaseState
  mode: WorkflowMode
  /** Hashes of last-approved artifact content, for drift detection */
  approvedArtifacts: Partial<Record<ArtifactKey, string>>
}

/**
 * Dependencies injected into the orchestrator factory.
 * assess and diverge are async functions (LLM-backed) with explicit signatures
 * so they can be mocked cleanly in tests.
 */
export interface OrchestratorDeps {
  assess: (
    feedback: string,
    currentArtifact: ArtifactKey,
  ) => Promise<OrchestratorAssessResult>

  /**
   * approvedArtifacts is passed as second arg so the diverge implementation
   * can compute accumulated drift without needing the full WorkflowState.
   */
  diverge: (
    assessResult: OrchestratorAssessResult,
    approvedArtifacts: Partial<Record<ArtifactKey, string>>,
  ) => Promise<OrchestratorDivergeResult>

  graph: ArtifactGraph
}

// NOTE: EscapeHatchPresentation was removed — the codebase uses EscapeHatchSummary
// (defined in orchestrator/escape-hatch.ts) instead.

export type EscapeHatchChoice =
  | "accept_drift"
  | "alternative_direction"
  | "new_direction"
  | "abort_change"

// ---------------------------------------------------------------------------
// Self-review
// ---------------------------------------------------------------------------

export interface CriterionResult {
  criterion: string
  met: boolean
  evidence: string
  /**
   * Criterion severity level:
   * - "blocking"          — must be met; standard boolean criteria (default)
   * - "suggestion"        — non-blocking; reported but does not prevent advancement
   * - "design-invariant"  — must be met AND non-rebuttable; used for binary structural
   *                         questions from the design document (prefixed [D] in criteria text).
   *                         The rebuttal loop cannot upgrade these — a design invariant violation
   *                         requires the deviation register to be updated and user-approved.
   */
  severity: "blocking" | "suggestion" | "design-invariant"
  /**
   * Numeric quality score (1-10) for quality-dimension criteria (prefixed [Q]).
   * For [Q] criteria, `met` is derived: score >= 9 → met, score < 9 → not met.
   * Absent for standard boolean criteria.
   */
  score?: number
}

export interface SelfReviewSuccess {
  success: true
  satisfied: boolean
  criteriaResults: CriterionResult[]
}

export interface SelfReviewError {
  success: false
  error: string
}

export type SelfReviewResult = SelfReviewSuccess | SelfReviewError

// ---------------------------------------------------------------------------
// Agent rebuttal (pre-escalation negotiation with reviewer)
// ---------------------------------------------------------------------------

/**
 * When the review loop is one iteration from the escalation cap and the
 * reviewer's unmet criteria score 7-8 (close to threshold), the agent
 * gets one chance to rebut before escalation to USER_GATE.
 *
 * The rebuttal is dispatched as a fresh ephemeral session where the reviewer
 * sees its own prior verdict plus the agent's counterarguments, and either
 * revises scores upward or maintains its position.
 */
export interface RebuttalRequest {
  phase: Phase
  mode: WorkflowMode | null
  /** The reviewer's original failing criteria (unmet blocking only) */
  reviewerVerdict: CriterionResult[]
  /** The agent's own assessment of those same criteria (its counterarguments) */
  agentAssessment: Array<{
    criterion: string
    met: boolean
    evidence: string
    score?: number
  }>
  /** Artifact paths for the reviewer to re-check if needed */
  artifactPaths: string[]
  /** The full acceptance criteria text */
  criteriaText: string
  /** Parent session ID for TUI visibility */
  parentSessionId?: string
  /** Feature name for session title context */
  featureName?: string | null
  /** Parent model (if available) for subagent session creation */
  parentModel?: string | { modelID: string; providerID?: string }
}

export interface RebuttalSuccess {
  success: true
  /** The reviewer's revised criteria results after considering the rebuttal */
  revisedResults: CriterionResult[]
  /** Whether the reviewer conceded (all blocking now pass) */
  allResolved: boolean
}

export interface RebuttalError {
  success: false
  error: string
}

export type RebuttalResult = RebuttalSuccess | RebuttalError

// ---------------------------------------------------------------------------
// Tool argument shapes
// ---------------------------------------------------------------------------

export interface SelectModeArgs {
  mode: WorkflowMode
  /** Required feature subdirectory name for artifact isolation (kebab-case) */
  feature_name: string
}

export interface MarkSatisfiedArgs {
  criteria_met: Array<{
    criterion: string
    met: boolean
    evidence: string
    /**
     * Optional severity override. Defaults to "blocking" if not provided.
     * - "blocking"         — must be met to advance (default)
     * - "suggestion"       — advisory only, does not block advancement
     * - "design-invariant" — must be met AND cannot be rebutted (used for [D] criteria)
     */
    severity?: "blocking" | "suggestion" | "design-invariant"
    /**
     * Numeric quality score (1-10) for [Q] quality-dimension criteria.
     * For [Q] criteria: score >= 9 means met, score < 9 means not met.
     * The `met` field is overridden by the score for [Q] criteria.
     */
    score?: number
  }>
}

export interface RequestReviewArgs {
  /** Plain text summary of what was built in this phase */
  summary: string
  /** Description of the artifact(s) produced */
  artifact_description: string
  /**
   * The full text of the artifact being submitted for review.
   * Required for in-memory phases (PLANNING, DISCOVERY/CONVENTIONS, IMPL_PLAN) —
   * this is written to .openartisan/ immediately so the user can read it before
   * approving and the isolated reviewer can evaluate the real file rather than
   * an inline copy. For file-based phases (INTERFACES, TESTS, IMPLEMENTATION),
   * leave this empty — the agent reads/writes files directly.
   */
  artifact_content?: string
}

export interface MarkScanCompleteArgs {
  /** Brief summary of what was scanned and key observations */
  scan_summary: string
}

export interface MarkAnalyzeCompleteArgs {
  /** Brief summary of what was analyzed and key architectural/convention findings */
  analysis_summary: string
}

export interface SubmitFeedbackArgs {
  /** The user's raw feedback text */
  feedback_text: string
  /** Whether the user approved or is requesting a revision */
  feedback_type: "approve" | "revise"
  /**
   * Optional: full artifact content to store as conventions (for DISCOVERY/USER_GATE approval).
   * When approving the DISCOVERY phase, pass the complete conventions document text here.
   */
  artifact_content?: string
  /**
   * Optional: list of absolute file paths to allow writes to (for PLANNING/USER_GATE approval in INCREMENTAL mode).
   * When approving the PLANNING phase in INCREMENTAL mode, pass the approved file allowlist here.
   */
  approved_files?: string[]
  /**
   * Optional: list of human-gated task IDs that the user confirms are resolved.
   * Only valid at IMPLEMENTATION/USER_GATE. Each listed task must have status "human-gated".
   * The user is confirming they have completed the required infrastructure/credential setup.
   */
  resolved_human_gates?: string[]
}

export interface ResolveHumanGateArgs {
  /** The DAG task ID of the human-gate task being activated */
  task_id: string
  /** Description of what the human needs to do */
  what_is_needed: string
  /** Why this human action is needed for the implementation */
  why: string
  /** Steps the human can take to verify the gate is resolved */
  verification_steps: string
}

export interface SpawnSubWorkflowArgs {
  /** The DAG task ID to delegate to a child sub-workflow */
  task_id: string
  /** Feature name for the child workflow (kebab-case, used as directory name) */
  feature_name: string
}

// ---------------------------------------------------------------------------
// Phase tool restrictions
// ---------------------------------------------------------------------------

export interface PhaseToolPolicy {
  /** Tool names that are completely blocked in this phase */
  blocked: string[]

  /**
   * For write/edit tools: an optional predicate on the absolute file path.
   * If provided, the write/edit is only allowed when predicate returns true.
   * If not provided, write/edit follows the `blocked` list.
   */
  writePathPredicate?: (filePath: string) => boolean

  /**
   * For bash/shell tools: an optional predicate on the command string.
   * If provided, the bash command is only allowed when predicate returns true.
   * Used in INCREMENTAL mode to block bash-based file writes (>, >>, tee, sed -i).
   */
  bashCommandPredicate?: (command: string) => boolean

  /** Human-readable description of what IS allowed, for error messages */
  allowedDescription: string
}

// ---------------------------------------------------------------------------
// Git checkpoint
// ---------------------------------------------------------------------------

export interface GitCheckpointSuccess {
  success: true
  tag: string
  commitHash: string
  /**
   * Non-fatal warnings, e.g. unexpected files staged in INCREMENTAL mode.
   * Present only when there is something to warn about.
   */
  warnings?: string[]
}

export interface GitCheckpointError {
  success: false
  error: string
}

export type GitCheckpointResult = GitCheckpointSuccess | GitCheckpointError

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

export interface ModeDetectionResult {
  suggestedMode: WorkflowMode
  hasGitHistory: boolean
  /** Number of source files (non-gitignored, non-hidden) found */
  sourceFileCount: number
  reasoning: string
}
