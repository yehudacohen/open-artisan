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
  | "REDRAFT"
  | "SKIP_CHECK"
  | "CASCADE_CHECK"
  | "SCHEDULING"
  | "TASK_REVIEW"
  | "TASK_REVISE"
  | "HUMAN_GATE"
  | "DELEGATED_WAIT"

/**
 * Which PhaseStates are valid for each Phase.
 * Enforced by the state machine at transition time.
 */
export const VALID_PHASE_STATES: Record<Phase, PhaseState[]> = {
  MODE_SELECT: ["DRAFT"],
  DISCOVERY: ["SCAN", "ANALYZE", "CONVENTIONS", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  PLANNING: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  INTERFACES: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  TESTS: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  IMPL_PLAN: ["DRAFT", "REDRAFT", "SKIP_CHECK", "CASCADE_CHECK", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE"],
  IMPLEMENTATION: ["DRAFT", "REVIEW", "USER_GATE", "ESCAPE_HATCH", "REVISE", "SCHEDULING", "TASK_REVIEW", "TASK_REVISE", "HUMAN_GATE", "DELEGATED_WAIT"],
  DONE: ["DRAFT"],
}

export type WorkflowEvent =
  | "mode_selected"           // MODE_SELECT → DISCOVERY or PLANNING
  | "scan_complete"           // DISCOVERY/SCAN → DISCOVERY/ANALYZE
  | "analyze_complete"        // DISCOVERY/ANALYZE → DISCOVERY/CONVENTIONS
  | "draft_complete"          // */DRAFT or */REDRAFT → */REVIEW
  | "self_review_pass"        // */REVIEW → */USER_GATE
  | "self_review_fail"        // */REVIEW → */REVISE (address feedback, increments iterationCount)
  | "escalate_to_user"        // */REVIEW → */USER_GATE (iteration cap reached — M12)
  | "user_approve"            // */USER_GATE → next structural state
  | "user_feedback"           // */USER_GATE or */ESCAPE_HATCH → orchestrator → */REVISE
  | "escape_hatch_triggered"  // */USER_GATE → */ESCAPE_HATCH (strategic pivot detected)
  | "revision_complete"       // */REVISE or */TASK_REVISE → corresponding review state
  | "phase_skipped"
  | "cascade_step_skipped"
  | "task_review_pass"
  | "task_review_fail"
  | "human_gate_resolved"
  | "delegated_task_completed"
  | "scheduling_complete"

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
 *   v23: expanded the structural workflow contract with new PhaseState / WorkflowEvent values
 *        and persisted BacktrackContext provenance on WorkflowState.
 */
export const SCHEMA_VERSION = 23

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

/**
 * Successful pure FSM transition lookup.
 */
export interface TransitionSuccess {
  ok: true
  nextPhase: Phase
  nextPhaseState: PhaseState
}

/**
 * Structured transition failure contract for illegal FSM event/state combinations.
 */
export interface TransitionFailure {
  ok: false
  /** Machine-readable error code */
  code: "INVALID_EVENT" | "INVARIANT_VIOLATED" | "INVALID_PHASE_STATE"
  /** Human-readable explanation */
  message: string
}

/**
 * Result of a pure FSM transition lookup.
 */
export type TransitionOutcome = TransitionSuccess | TransitionFailure

/**
 * Shared structural transition-descriptor seam chosen by the approved plan.
 *
 * Alternatives considered and rejected:
 * - direct adapter-owned `draft.phase` / `draft.phaseState` rewrites
 * - new durable persisted helper states for AUTO_APPROVE / CHECKPOINTING / RESUME_CHECK
 *
 * Tradeoff: descriptors add contract surface area, but they make adapter parity,
 * resume repair, tests, and review dispatch explicit enough that later phases do not
 * need to guess at structural workflow meaning.
 */
export interface StructuralTransitionDescriptor {
  /** Stable identifier for this descriptor instance. */
  id: string
  /** Optional kind tag for adapters that need to branch by lifecycle meaning. */
  kind?: "redraft" | "skip" | "cascade" | "scheduling" | "task-review" | "human-gate" | "delegated-wait"
  source: { phase: Phase; phaseState: PhaseState }
  target: { phase: Phase; phaseState: PhaseState }
  triggeringEvent: WorkflowEvent
  rationale: string
  requiredArtifactFiles: string[]
  blockedOn: null | "human-action" | "delegated-sub-workflow" | "reviewer" | "bridge-runtime"
  /**
   * Tradeoff summary for the chosen structural path.
   * Keep as a flat string array so tests and adapters can record decisions without
   * constructing extra nested objects during early wiring.
   */
  tradeoffs: string[]
  currentTaskId?: string | null
  reviewArtifactFiles?: string[]
  childWorkflowIds?: string[]
  backtrackContext?: BacktrackContext | null
  humanGate?: {
    taskId: string
    whatIsNeeded: string
    verificationSteps?: string
  }
}

/**
 * Structured error contract for descriptor-planning and structural transition failures.
 */
export interface StructuralTransitionError {
  /** Human-readable explanation of what went wrong */
  message: string
  /** Machine-readable failure category used by tests, adapters, and guard logic */
  code:
    | "not-found"
    | "INVALID_SKIP_TARGET"
    | "INVALID_CASCADE_TARGET"
    | "INVALID_IMPLEMENTATION_LIFECYCLE"
    | "MISSING_HUMAN_GATE_CONTEXT"
    | "MISSING_DELEGATED_WORKFLOW"
    | "UNRESUMABLE_STRUCTURAL_STATE"
}

export type StructuralTransitionResult =
  | { success: true; value: StructuralTransitionDescriptor }
  | { success: false; error: StructuralTransitionError }

/**
 * Input snapshot consumed by shared structural transition planners.
 * Encodes the runtime relationships a descriptor may depend on without exposing
 * adapter-owned mutable state directly.
 */
export interface StructuralTransitionInput {
  currentPhase: Phase
  currentPhaseState: PhaseState
  mode: WorkflowMode
  approvedArtifacts: Partial<Record<ArtifactKey, string>>
  pendingRevisionSteps: RevisionStep[] | null
  currentTaskId: string | null
  reviewArtifactFiles: string[]
  childWorkflowIds: string[]
  backtrackContext: BacktrackContext | null
}

export interface StructuralTransitionDescriptorStore {
  createDescriptor(descriptor: StructuralTransitionDescriptor): Promise<StructuralTransitionResult>
  readDescriptor(id: string): Promise<StructuralTransitionResult>
  updateDescriptor(id: string, descriptor: StructuralTransitionDescriptor): Promise<StructuralTransitionResult>
  deleteDescriptor(id: string): Promise<StructuralTransitionResult>
  listDescriptors(): Promise<{ success: true; value: StructuralTransitionDescriptor[] } | { success: false; error: StructuralTransitionError }>
}

/**
 * Planner contract for deriving shared structural transition descriptors from the
 * current workflow snapshot.
 */
export interface StructuralTransitionPlanner {
  computeRedraftDescriptor(input: StructuralTransitionInput): Promise<StructuralTransitionResult>
  computePhaseSkipDescriptor(input: StructuralTransitionInput): Promise<StructuralTransitionResult>
  computeCascadeDescriptor(input: StructuralTransitionInput): Promise<StructuralTransitionResult>
  computeSchedulingDescriptor(input: StructuralTransitionInput): Promise<StructuralTransitionResult>
  computeTaskReviewDescriptor(input: StructuralTransitionInput): Promise<StructuralTransitionResult>
  computeHumanGateDescriptor(input: StructuralTransitionInput): Promise<StructuralTransitionResult>
  computeDelegatedWaitDescriptor(input: StructuralTransitionInput): Promise<StructuralTransitionResult>
}

export type StructuralWorkflowHealthStatus = "healthy" | "degraded" | "blocked" | "stalled" | "bridge-unavailable"

export type StructuralWorkflowIssueKind =
  | "adapter-parity-drift"
  | "continuation-stall"
  | "review-failure"
  | "bridge-state-issue"
  | "human-gate-block"
  | "delegated-wait"

export interface StructuralWorkflowHealthCheck {
  featureName?: string
  phase?: Phase
  phaseState?: PhaseState
  status: StructuralWorkflowHealthStatus
  issues?: Array<{ kind: StructuralWorkflowIssueKind; message: string }>
  issueKind?: StructuralWorkflowIssueKind
  currentTaskId?: string | null
  diagnosticsPaths?: string[]
  reviewArtifactFiles?: string[]
}

/**
 * Snapshot of workflow-health counters and active-state metrics exposed by the
 * structural workflow runtime for diagnostics, parity checks, and regression tests.
 */
export interface StructuralWorkflowMetricsSnapshot {
  featureName?: string
  activePhase?: Phase
  activePhaseState?: PhaseState
  transitionCount?: number
  skippedPhaseCount?: number
  cascadeSkipCount?: number
  taskReviewFailureCount?: number
  humanGateCount?: number
  delegatedWaitCount?: number
  stallCount?: number
  activeNonGateStates: number
  structuralTransitionsApplied: number
  directMutationBypassDetections: number
}

export interface StructuralWorkflowLogEvent {
  kind:
    | "structural-transition-applied"
    | "phase-skipped"
    | "cascade-skipped"
    | "task-review-failed"
    | "human-gate-entered"
    | "delegated-wait-entered"
    | "stall-detected"
    | "bridge-state-issue"
  event?:
    | "state-transition"
    | "phase-skipped"
    | "cascade-skipped"
    | "task-review-failed"
    | "human-gate-entered"
    | "delegated-wait-entered"
    | "stall-detected"
    | "bridge-state-issue"
  featureName?: string
  phase: Phase
  phaseState: PhaseState
  descriptorKind?: StructuralTransitionDescriptor["kind"]
  message: string
}

export interface StructuralWorkflowDiagnosticsConfig {
  debugEnabled?: boolean
  reviewTimeoutSeconds?: number
  includeTraceIds?: boolean
  includeTransitionDescriptors?: boolean
  includeRuntimeHealthSummary?: boolean
  diagnosticsPaths?: Array<
    | ".openartisan/openartisan-errors.log"
    | ".openartisan/.bridge-meta.json"
    | ".openartisan/.bridge-clients.json"
    | ".openartisan/.bridge-pid"
    | ".openartisan/.bridge.sock"
  >
}

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
 * Structured persistence error contract for legacy thrown StateBackend failures.
 *
 * Decision note: existing runtime code currently throws at this seam instead of
 * returning a result union. The interface therefore documents the thrown error
 * shape explicitly without changing the established runtime contract in this phase.
 */
export interface StateBackendError {
  code: "STATE_BACKEND_IO_ERROR" | "STATE_BACKEND_LOCK_ERROR"
  message: string
  retryable: boolean
  cause?: unknown
}

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
  /**
   * Read raw JSON for a feature. Returns null if not found.
   * @throws StateBackendError when storage I/O fails.
   */
  read(featureName: string): Promise<string | null>

  /**
   * Write raw JSON for a feature. Creates storage location if needed.
   * @throws StateBackendError when storage I/O fails.
   */
  write(featureName: string, data: string): Promise<void>

  /**
   * Remove stored state for a feature. No-op if not found.
   * @throws StateBackendError when storage I/O fails.
   */
  remove(featureName: string): Promise<void>

  /**
   * List all feature names that have persisted state.
   * @throws StateBackendError when storage I/O fails.
   */
  list(): Promise<string[]>

  /**
   * Acquire an exclusive lock for a feature.
   * Returns a release function that must be called when done.
   * Implementations may use lockfiles, database locks, etc.
   * @throws StateBackendError when locking fails.
   */
  lock(featureName: string): Promise<{ release(): Promise<void> }>
}

// ---------------------------------------------------------------------------
// Roadmap types and contracts
// ---------------------------------------------------------------------------

export type RoadmapItemKind = "feature" | "bug" | "debt" | "chore"

export type RoadmapItemStatus =
  | "todo"
  | "in-progress"
  | "blocked"
  | "done"
  | "dropped"

export type RoadmapEdgeKind = "depends-on"

export type RoadmapErrorCode =
  | "not-found"
  | "invalid-document"
  | "invalid-slice"
  | "schema-mismatch"
  | "lock-timeout"
  | "storage-failure"

export interface RoadmapError {
  code: RoadmapErrorCode
  message: string
  retryable: boolean
  details?: {
    itemId?: string
    edge?: { from: string; to: string }
    schemaVersion?: number
  }
}

export type RoadmapResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RoadmapError }

export function roadmapOk<T>(value: T): RoadmapResult<T> {
  return { ok: true, value }
}

export function roadmapError(
  code: RoadmapErrorCode,
  message: string,
  retryable: boolean,
  details?: RoadmapError["details"],
): RoadmapResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
  }
}

/**
 * A single roadmap node tracked by the standalone roadmap store.
 * featureName is optional because not every roadmap item maps 1:1 to a workflow feature.
 */
export interface RoadmapItem {
  id: string
  kind: RoadmapItemKind
  title: string
  description?: string
  status: RoadmapItemStatus
  priority: number
  featureName?: string
  createdAt: string
  updatedAt: string
}

/**
 * A typed dependency edge between two roadmap items.
 */
export interface RoadmapEdge {
  from: string
  to: string
  kind: RoadmapEdgeKind
}

/**
 * Full roadmap document persisted by filesystem or PGlite backends.
 */
export interface RoadmapDocument {
  schemaVersion: number
  items: RoadmapItem[]
  edges: RoadmapEdge[]
}

export type RoadmapPersistenceKind = "filesystem" | "pglite"

export interface RoadmapPGliteConnectionOptions {
  dataDir: string
  databaseFileName?: string
  debugName?: string
}

export interface RoadmapPGliteRepositoryOptions {
  connection: RoadmapPGliteConnectionOptions
  schemaName?: string
  lockTimeoutMs?: number
  lockPollMs?: number
}

/**
 * Typed roadmap persistence/query boundary for Postgres-friendly adapters.
 * Bridge-owned services compose this repository rather than exposing it directly to callers.
 */
export interface RoadmapRepository {
  initialize(): Promise<RoadmapResult<null>>
  createRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  readRoadmap(): Promise<RoadmapResult<RoadmapDocument | null>>
  updateRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  deleteRoadmap(): Promise<RoadmapResult<null>>
  queryRoadmapItems(query: RoadmapQuery): Promise<RoadmapResult<RoadmapItem[]>>
}

/**
 * Bridge-owned assembly input for roadmap services/backends.
 * Keeps roadmap backend selection/configuration separate from WorkflowState persistence.
 */
export interface RoadmapServiceFactoryOptions {
  stateDir: string
  persistence: {
    kind: RoadmapPersistenceKind
    pglite?: RoadmapPGliteRepositoryOptions
  }
}

/**
 * Standalone roadmap persistence. Separate from WorkflowState persistence.
 * Implementations must not store roadmap state in per-feature workflow-state files.
 */
export interface RoadmapStateBackend {
  createRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  readRoadmap(): Promise<RoadmapResult<RoadmapDocument | null>>
  updateRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>>
  deleteRoadmap(): Promise<RoadmapResult<null>>
  lockRoadmap(): Promise<RoadmapResult<{ release(): Promise<void> }>>
}

export interface RoadmapQuery {
  itemIds?: string[]
  kinds?: RoadmapItemKind[]
  statuses?: RoadmapItemStatus[]
  featureName?: string
  minPriority?: number
}

export function matchesRoadmapQuery(item: RoadmapItem, query: RoadmapQuery): boolean {
  if (query.itemIds && !query.itemIds.includes(item.id)) return false
  if (query.kinds && !query.kinds.includes(item.kind)) return false
  if (query.statuses && !query.statuses.includes(item.status)) return false
  if (query.featureName !== undefined && item.featureName !== query.featureName) return false
  if (query.minPriority !== undefined && item.priority < query.minPriority) return false
  return true
}

export interface DerivedExecutionSlice {
  roadmapItemIds: string[]
  roadmapItems: RoadmapItem[]
  edges: RoadmapEdge[]
  featureName?: string
}

export interface RoadmapSliceService {
  queryRoadmap(query: RoadmapQuery): Promise<RoadmapResult<RoadmapItem[]>>
  deriveExecutionSlice(input: {
    roadmapItemIds: string[]
    featureName?: string
  }): Promise<RoadmapResult<DerivedExecutionSlice>>
}

export interface WorkflowRoadmapLink {
  featureName: string
  roadmapItemIds: string[]
}

/**
 * Validates that a RoadmapDocument is internally consistent.
 * Returns null if valid, or an error message describing the first violation found.
 */
export function validateRoadmapDocument(document: RoadmapDocument): string | null {
  if (!Number.isInteger(document.schemaVersion) || document.schemaVersion < 1) {
    return `RoadmapDocument.schemaVersion must be a positive integer, got ${document.schemaVersion}`
  }
  if (!Array.isArray(document.items)) {
    return `RoadmapDocument.items must be an array, got ${typeof document.items}`
  }
  if (!Array.isArray(document.edges)) {
    return `RoadmapDocument.edges must be an array, got ${typeof document.edges}`
  }

  const validKinds: RoadmapItemKind[] = ["feature", "bug", "debt", "chore"]
  const validStatuses: RoadmapItemStatus[] = ["todo", "in-progress", "blocked", "done", "dropped"]
  const itemIds = new Set<string>()

  for (let i = 0; i < document.items.length; i++) {
    const item = document.items[i]
    if (!item || typeof item !== "object") {
      return `RoadmapDocument.items[${i}] must be an object`
    }
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      return `RoadmapDocument.items[${i}].id must be a non-empty string`
    }
    if (itemIds.has(item.id)) {
      return `Duplicate RoadmapItem.id "${item.id}"`
    }
    itemIds.add(item.id)
    if (!validKinds.includes(item.kind)) {
      return `RoadmapDocument.items[${i}].kind must be one of ${validKinds.join(", ")}, got "${item.kind}"`
    }
    if (typeof item.title !== "string" || item.title.trim().length === 0) {
      return `RoadmapDocument.items[${i}].title must be a non-empty string`
    }
    if (item.description !== undefined && typeof item.description !== "string") {
      return `RoadmapDocument.items[${i}].description must be a string when provided`
    }
    if (!validStatuses.includes(item.status)) {
      return `RoadmapDocument.items[${i}].status must be one of ${validStatuses.join(", ")}, got "${item.status}"`
    }
    if (typeof item.priority !== "number" || !Number.isFinite(item.priority)) {
      return `RoadmapDocument.items[${i}].priority must be a finite number`
    }
    if (item.featureName !== undefined && (typeof item.featureName !== "string" || item.featureName.trim().length === 0)) {
      return `RoadmapDocument.items[${i}].featureName must be a non-empty string when provided`
    }
    if (typeof item.createdAt !== "string" || item.createdAt.length === 0) {
      return `RoadmapDocument.items[${i}].createdAt must be a non-empty string`
    }
    if (typeof item.updatedAt !== "string" || item.updatedAt.length === 0) {
      return `RoadmapDocument.items[${i}].updatedAt must be a non-empty string`
    }
  }

  const seenEdges = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const itemId of Array.from(itemIds)) {
    adjacency.set(itemId, [])
  }

  for (let i = 0; i < document.edges.length; i++) {
    const edge = document.edges[i]
    if (!edge || typeof edge !== "object") {
      return `RoadmapDocument.edges[${i}] must be an object`
    }
    if (typeof edge.from !== "string" || edge.from.trim().length === 0) {
      return `RoadmapDocument.edges[${i}].from must be a non-empty string`
    }
    if (typeof edge.to !== "string" || edge.to.trim().length === 0) {
      return `RoadmapDocument.edges[${i}].to must be a non-empty string`
    }
    if (edge.kind !== "depends-on") {
      return `RoadmapDocument.edges[${i}].kind must be "depends-on", got "${edge.kind}"`
    }
    if (!itemIds.has(edge.from)) {
      return `RoadmapDocument.edges[${i}].from references missing item "${edge.from}"`
    }
    if (!itemIds.has(edge.to)) {
      return `RoadmapDocument.edges[${i}].to references missing item "${edge.to}"`
    }
    if (edge.from === edge.to) {
      return `RoadmapDocument.edges[${i}] must not self-reference "${edge.from}"`
    }
    const edgeKey = `${edge.from}->${edge.to}:${edge.kind}`
    if (seenEdges.has(edgeKey)) {
      return `Duplicate RoadmapEdge "${edgeKey}"`
    }
    seenEdges.add(edgeKey)
    adjacency.get(edge.from)?.push(edge.to)
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const stack: string[] = []

  const findCycle = (node: string): string[] | null => {
    visiting.add(node)
    stack.push(node)

    for (const next of adjacency.get(node) ?? []) {
      if (visiting.has(next)) {
        const cycleStart = stack.indexOf(next)
        return [...stack.slice(cycleStart), next]
      }
      if (visited.has(next)) {
        continue
      }
      const cycle = findCycle(next)
      if (cycle) {
        return cycle
      }
    }

    stack.pop()
    visiting.delete(node)
    visited.add(node)
    return null
  }

  for (const itemId of Array.from(itemIds)) {
    if (visited.has(itemId)) {
      continue
    }
    const cycle = findCycle(itemId)
    if (cycle) {
      return `RoadmapDocument.edges must form a DAG; found cycle "${cycle.join("->")}"`
    }
  }

  return null
}

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
export interface WorkflowStateValidationError extends String {
  code: "INVALID_WORKFLOW_STATE"
  message: string
}

function workflowStateValidationError(message: string): WorkflowStateValidationError {
  const error = new String(message) as unknown as WorkflowStateValidationError
  error.code = "INVALID_WORKFLOW_STATE"
  error.message = message
  return error
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
  code?: "ORCHESTRATOR_ASSESS_FAILED"
  message?: string
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
  code?: "ORCHESTRATOR_DIVERGE_FAILED"
  message?: string
  /** Fall back to "tactical" on classification failure */
  fallback: "tactical"
}

export type OrchestratorDivergeResult = OrchestratorDivergeSuccess | OrchestratorDivergeError

export interface RevisionStep {
  artifact: ArtifactKey
  phase: Phase
  phaseState: "REVISE" | "DRAFT" | "REDRAFT"
  instructions: string
}

export interface OrchestratorPlanResult {
  /** Ordered revision steps, earliest upstream artifact first */
  revisionSteps: RevisionStep[]
  /**
   * Whether the orchestrator classified this change as tactical, strategic, or backtrack.
   * tactical → agent proceeds autonomously to REVISE.
   * strategic → escape hatch is presented to the user before proceeding.
   * backtrack → route to an earlier phase's REDRAFT state (scope change detected).
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
  code?: "SELF_REVIEW_FAILED"
  message?: string
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
  code?: "REBUTTAL_FAILED"
  message?: string
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
   * Files on disk that are the review source of truth.
   * Public callers must write artifacts to disk first and submit them by path.
   * Inline artifact content is intentionally not part of the public contract.
   */
  artifact_files?: string[]
}

/**
 * Explicit file-based review source of truth.
 *
 * Decision note: the approved workflow direction is that public review callers
 * submit on-disk artifact files, not inline artifact text. An alternative would
 * keep a dual public contract (`artifact_content` or `artifact_files`), but that
 * weakens the structural review source of truth and encourages adapter-specific
 * divergence. The public contract therefore exposes file-based review inputs only.
 */
export interface FileArtifactReviewSource {
  artifact_files: string[]
}

/**
 * Public executable seam metadata.
 *
 * Decision note: the supported public runtime contract for this feature is a
 * named seam registry, not direct imports from abstract-only type declarations.
 * For seams listed here, the `ownerModule` is itself the approved public runtime
 * boundary for executable TESTS-phase coverage. That means a seam-oriented test may
 * import the runtime owner module directly when the goal is to verify real wiring,
 * adapter parity, and boundary behavior rather than helper-only type conformance.
 *
 * The generic workflow rule "tests import from interfaces, not from implementations"
 * still applies to ordinary features whose public contract is an interface/type module.
 * This feature is different: the approved public contract is the seam registry below,
 * and each descriptor names the concrete runtime boundary that TESTS should target.
 */
export type SupportedExecutableSeamKind =
  | "state-machine"
  | "phase-tool-policy"
  | "request-review-file-artifact"
  | "session-state-validation"
  | "scheduler-parallel-contract"
  | "bridge-runtime"
  | "hermes-post-tool-continuation"
  | "claude-hook-phase-gating"
  | "task-boundary-revision-workflow"
  | "workflow-guidance-legality"

export type SupportedExecutableSeamErrorPattern =
  | "TransitionOutcome"
  | "StructuralTransitionResult"
  | "RoadmapResult"
  | "validation-string-null"
  | "throws"

/**
 * TESTS-phase import policy for an approved executable seam.
 *
 * - `owner-module-public-runtime-contract`: the named runtime owner module is the
 *   public seam, so executable tests should target that module directly.
 * - `interface-only`: traditional contract shape where tests should stay on the
 *   abstract interface/type surface and avoid implementation imports.
 *
 * Decision note: for this feature's runtime seam registry, `owner-module-public-runtime-contract`
 * is not a loophole or implementation leak. It is the approved public test boundary for
 * adapter/runtime parity coverage.
 */
export type SupportedExecutableSeamImportPolicy =
  | "owner-module-public-runtime-contract"
  | "interface-only"

/**
 * TESTS-phase suite style allowed for an approved executable seam.
 *
 * - `target-state-only`: only future-state/specification tests that would fail until the
 *   implementation lands.
 * - `characterization-regression`: tests may capture current runtime behavior to prevent
 *   regressions while later phases structuralize the implementation.
 * - `mixed-characterization-and-target-state`: both characterization/regression tests and
 *   target-state assertions are required because the seam must simultaneously preserve
 *   working runtime behavior and expose newly required structural behavior.
 */
export type SupportedExecutableSeamSuiteStyle =
  | "target-state-only"
  | "characterization-regression"
  | "mixed-characterization-and-target-state"

/**
 * Explicit testing-contract summary for executable seam-based features.
 * This lets earlier phases record when seam-oriented runtime imports are not an
 * accidental implementation leak but the approved public-test contract.
 *
 * For this feature, a seam may also explicitly bless mixed characterization +
 * target-state suites. That means TESTS is allowed to carry forward regression
 * coverage for already-working runtime behavior while also adding future-state
 * assertions for newly structuralized workflow behavior.
 */
export interface SupportedExecutableSeamTestingContract {
  seamKind: SupportedExecutableSeamKind
  importPolicy: SupportedExecutableSeamImportPolicy
  suiteStyle: SupportedExecutableSeamSuiteStyle
  /**
   * When true, the generic workflow rule "tests import from interfaces, not implementations"
   * is intentionally displaced by this seam's approved owner-module public runtime contract.
   */
  displacesGenericInterfaceOnlyRule?: boolean
  /**
   * When true, the generic TESTS-phase expectation that all reviewed tests be pure
   * expected-failure/specification tests is intentionally displaced by an approved
   * characterization/regression or mixed suite style for this seam.
   */
  displacesExpectedFailureOnlyRule?: boolean
  rationale: string
  alternativesConsidered: string[]
  tradeoffs: string[]
}

export interface SupportedExecutableSeamDescriptor {
  kind: SupportedExecutableSeamKind
  ownerModule: string
  primaryInterface: string
  errorPattern: SupportedExecutableSeamErrorPattern
  runtimeCoverageExpectedAt: "TESTS" | "IMPLEMENTATION"
  /** Approved TESTS-phase import boundary for this seam. */
  importPolicy?: SupportedExecutableSeamImportPolicy
  /** Approved TESTS-phase suite style for this seam. */
  suiteStyle?: SupportedExecutableSeamSuiteStyle
  /** Whether this seam intentionally displaces the generic interface-only import rule. */
  displacesGenericInterfaceOnlyRule?: boolean
  /** Whether this seam intentionally displaces the generic expected-failure-only rule. */
  displacesExpectedFailureOnlyRule?: boolean
  decision: string
  alternativesConsidered: string[]
  tradeoffs: string[]
}

/**
 * Concrete approved executable seam registry for this feature.
 *
 * Each entry is the interface-level source of truth for which runtime owner module is
 * the supported public seam, what error/result pattern tests should expect, and whether
 * the suite is allowed to mix characterization/regression coverage with target-state
 * structural assertions.
 */
export const SUPPORTED_EXECUTABLE_SEAM_DESCRIPTORS: readonly SupportedExecutableSeamDescriptor[] = [
  {
    kind: "state-machine",
    ownerModule: "#core/state-machine",
    primaryInterface: "StateMachine",
    errorPattern: "TransitionOutcome",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "mixed-characterization-and-target-state",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Exercise the real FSM owner module because structural-state legality is itself the public runtime contract.",
    alternativesConsidered: ["interface-only helper assertions", "adapter-only integration coverage"],
    tradeoffs: ["couples tests to the shared runtime owner module", "catches illegal transition drift earlier"],
  },
  {
    kind: "phase-tool-policy",
    ownerModule: "#core/hooks/tool-guard",
    primaryInterface: "PhaseToolPolicy",
    errorPattern: "StructuralTransitionResult",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "mixed-characterization-and-target-state",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Tool legality is a runtime seam owned by the guard policy module, not a prose-only convention.",
    alternativesConsidered: ["prompt-only assertions", "implementation-phase-only verification"],
    tradeoffs: ["tests concrete policy outputs directly", "prevents silent phase-policy regressions"],
  },
  {
    kind: "request-review-file-artifact",
    ownerModule: "#core/tools/request-review",
    primaryInterface: "RequestReviewArgs",
    errorPattern: "StructuralTransitionResult",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "characterization-regression",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "File-based review submission is a public runtime contract and must remain executable through the request_review owner module.",
    alternativesConsidered: ["types-only contract checks"],
    tradeoffs: ["keeps review-source-of-truth behavior executable", "binds tests to the public owner module intentionally"],
  },
  {
    kind: "session-state-validation",
    ownerModule: "#core/session-state",
    primaryInterface: "SessionStateStore",
    errorPattern: "validation-string-null",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "mixed-characterization-and-target-state",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Resume repair and validation are public structural seams because stale persisted state must recover truthfully.",
    alternativesConsidered: ["state-machine-only tests"],
    tradeoffs: ["covers persistence repair directly", "requires runtime fixture setup"],
  },
  {
    kind: "scheduler-parallel-contract",
    ownerModule: "#core/scheduler",
    primaryInterface: "WorkflowConcurrency",
    errorPattern: "StructuralTransitionResult",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "characterization-regression",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Scheduler parallelism/isolation is an executable contract and must be locked by runtime tests.",
    alternativesConsidered: ["single-threaded helper tests only"],
    tradeoffs: ["requires concurrency-sensitive assertions", "catches slot/isolation regressions"],
  },
  {
    kind: "bridge-runtime",
    ownerModule: "#bridge/methods/tool-execute",
    primaryInterface: "BridgeContext",
    errorPattern: "StructuralTransitionResult",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "mixed-characterization-and-target-state",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Bridge JSON-RPC/runtime wiring is an approved executable seam for parity testing.",
    alternativesConsidered: ["core-only tests", "OpenCode-only tests"],
    tradeoffs: ["tests bridge handler owners directly", "makes adapter parity drift visible"],
  },
  {
    kind: "hermes-post-tool-continuation",
    ownerModule: "packages/adapter-hermes/hermes_adapter/workflow_tools.py",
    primaryInterface: "HermesContinuationSeam",
    errorPattern: "throws",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "mixed-characterization-and-target-state",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Hermes immediate continuation is an adapter-owned public seam and must be covered through the adapter runtime path.",
    alternativesConsidered: ["bridge idle tests only"],
    tradeoffs: ["Python adapter tests are required", "captures transport-specific continuation truth"],
  },
  {
    kind: "claude-hook-phase-gating",
    ownerModule: "#claude-code/src/hook-handlers",
    primaryInterface: "ClaudeHookPhaseGatingSeam",
    errorPattern: "throws",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "characterization-regression",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Claude hook gating is a public adapter seam whose runtime behavior must stay aligned with shared workflow meaning.",
    alternativesConsidered: ["bridge-only parity tests"],
    tradeoffs: ["exercises hook owners directly", "keeps Claude parity visible despite different runtime model"],
  },
  {
    kind: "task-boundary-revision-workflow",
    ownerModule: "#plugin/index",
    primaryInterface: "TaskBoundaryRevisionSeam",
    errorPattern: "StructuralTransitionResult",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "mixed-characterization-and-target-state",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Analyze/apply boundary revision is a public runtime seam spanning OpenCode and bridge entrypoints, not a private implementation detail.",
    alternativesConsidered: ["types-only argument tests", "implementation-phase-only verification"],
    tradeoffs: ["requires runtime fixture DAGs/allowlists", "prevents hidden ownership-regression gaps"],
  },
  {
    kind: "workflow-guidance-legality",
    ownerModule: "#core/hooks/system-transform",
    primaryInterface: "WorkflowGuidanceLegalitySeam",
    errorPattern: "throws",
    runtimeCoverageExpectedAt: "TESTS",
    importPolicy: "owner-module-public-runtime-contract",
    suiteStyle: "mixed-characterization-and-target-state",
    displacesGenericInterfaceOnlyRule: true,
    displacesExpectedFailureOnlyRule: true,
    decision: "Prompt/tool-legality consistency is a public workflow contract and must be asserted through the prompt-building owner module.",
    alternativesConsidered: ["manual prompt inspection", "tool-guard-only tests"],
    tradeoffs: ["tests prompt content concretely", "catches impossible-guidance regressions early"],
  },
]

export interface WorkflowPromptPart {
  type: "text"
  text: string
  id?: string
}

export interface WorkflowIdleDecision {
  action: "reprompt" | "escalate" | "ignore"
  message?: string
  retryCount?: number
}

export interface ClaudeHookResultContract {
  stdout: string | null
  stderr: string | null
  exitCode: number
}

/**
 * Adapter-facing executable seam summary for Hermes continuation behavior.
 */
export interface HermesContinuationSeam {
  kind: "hermes-post-tool-continuation"
  idleDecision: WorkflowIdleDecision
  decision: string
  tradeoffs: string[]
}

/**
 * Adapter-facing executable seam summary for Claude hook phase gating.
 */
export interface ClaudeHookPhaseGatingSeam {
  kind: "claude-hook-phase-gating"
  stop: ClaudeHookResultContract
  preToolUse: ClaudeHookResultContract
  decision: string
  tradeoffs: string[]
}

/**
 * Adapter-facing executable seam summary for implementation-time task-boundary revision.
 *
 * This seam records that the public runtime contract is the analyze/apply workflow-tool
 * pair together with the task-boundary argument shapes in this module. It exists so
 * earlier phases can bless runtime coverage of the boundary-revision path as a supported
 * executable seam rather than an implementation leak.
 */
export interface TaskBoundaryRevisionSeam {
  kind: "task-boundary-revision-workflow"
  analyzeArgs: AnalyzeTaskBoundaryChangeArgs
  analyzeResult: TaskBoundaryChangeAnalysisResult
  applyArgs: ApplyTaskBoundaryChangeArgs
  applyResult: TaskBoundaryChangeApplyResult
  decision: string
  tradeoffs: string[]
}

/**
 * Adapter-facing executable seam summary for prompt/tool legality consistency.
 *
 * This seam captures the structural rule that phase guidance and prompt-building must
 * never recommend a workflow tool that is illegal in the current phase/sub-state.
 * It exists because this feature treats impossible guidance paths as workflow defects,
 * not as operator-discoverable quirks.
 */
export interface WorkflowGuidanceLegalitySeam {
  kind: "workflow-guidance-legality"
  phase: Phase
  phaseState: PhaseState
  legalEscalationPath: string
  forbiddenToolRecommendation?: string
  decision: string
  tradeoffs: string[]
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
   * Optional: list of absolute file paths to allow writes to (for PLANNING/USER_GATE approval in INCREMENTAL mode).
   * When approving the PLANNING phase in INCREMENTAL mode, pass the approved file allowlist here.
   * This is the full replacement allowlist approved at the planning gate, not an incremental patch.
   */
  approved_files?: string[]
  /**
   * Optional: list of human-gated task IDs that the user confirms are resolved.
   * Only valid at IMPLEMENTATION/HUMAN_GATE. Each listed task must have status "human-gated".
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

/**
 * Input contract for implementation-time task-boundary analysis.
 *
 * Path fields use branded absolute-path types so later phases can distinguish
 * ownership/test file references from arbitrary free-form strings.
 */
export interface AnalyzeTaskBoundaryChangeArgs {
  /** The task whose ownership boundary is being revised */
  task_id: string
  /** Absolute file paths to add to the task's owned file set */
  add_files?: AbsoluteFilePath[]
  /** Absolute file paths to remove from the task's owned file set */
  remove_files?: AbsoluteFilePath[]
  /** Expected test file paths to add to the task */
  add_expected_tests?: AbsoluteFilePath[]
  /** Expected test file paths to remove from the task */
  remove_expected_tests?: AbsoluteFilePath[]
  /**
   * Why the boundary change is needed.
   * Must be a non-empty user/agent-authored explanation that can be surfaced in review.
   */
  reason: NonEmptyBoundaryChangeReason
}

/**
 * Apply-time acknowledgement contract for a previously analyzed task-boundary revision.
 */
export interface ApplyTaskBoundaryChangeArgs extends AnalyzeTaskBoundaryChangeArgs {
  /** Explicit acknowledgement of which tasks are expected to be impacted by the change */
  expected_impacted_tasks?: string[]
  /** Explicit acknowledgement of which completed tasks are expected to be reset */
  expected_reset_tasks?: string[]
}

/** Absolute project file path approved for ownership/test targeting in boundary-revision flows. */
export type AbsoluteFilePath = string & { readonly __absoluteFilePathBrand: "AbsoluteFilePath" }

/** Non-empty human/agent-authored rationale carried through boundary-revision review. */
export type NonEmptyBoundaryChangeReason = string & { readonly __nonEmptyBoundaryChangeReasonBrand: "NonEmptyBoundaryChangeReason" }

export type TaskBoundaryChangeConflictKind =
  | "task-not-found"
  | "file-overlap"
  | "expected-test-overlap"
  | "dependency-adjacency-change"
  | "parallelism-break"
  | "allowlist-violation"
  | "completed-task-reset-required"
  | "illegal-phase"
  | "review-acknowledgement-mismatch"

/**
 * A concrete incompatibility or review-surface hazard discovered while analyzing
 * a proposed task-boundary revision.
 */
export interface TaskBoundaryChangeConflict {
  kind: TaskBoundaryChangeConflictKind
  message: string
  taskIds?: string[]
  filePaths?: AbsoluteFilePath[]
  expectedTests?: AbsoluteFilePath[]
}

/**
 * Full impact analysis for a proposed task-boundary revision.
 *
 * This is the public analysis contract that later TESTS/IMPLEMENTATION work relies on
 * when determining whether a boundary change is legal, what it invalidates, and which
 * downstream tasks/reviews are affected.
 */
export interface TaskBoundaryChangeAnalysis {
  taskId: string
  impactedTaskIds: string[]
  completedTaskIdsToReset: string[]
  overlappingOwnedFiles: AbsoluteFilePath[]
  overlappingExpectedTests: AbsoluteFilePath[]
  addFiles: AbsoluteFilePath[]
  removeFiles: AbsoluteFilePath[]
  addExpectedTests: AbsoluteFilePath[]
  removeExpectedTests: AbsoluteFilePath[]
  preservesAllowlist: boolean
  preservesDependencyOrdering: boolean
  preservesParallelism: boolean
  conflicts: TaskBoundaryChangeConflict[]
  rationale: NonEmptyBoundaryChangeReason
}

export interface TaskBoundaryChangeError extends String {
  code:
    | "TASK_BOUNDARY_CHANGE_NOT_ALLOWED"
    | "TASK_BOUNDARY_CHANGE_INVALID_ARGS"
    | "TASK_BOUNDARY_CHANGE_CONFLICT"
    | "TASK_BOUNDARY_CHANGE_ACKNOWLEDGEMENT_MISMATCH"
  message: string
  error: string
}

export type TaskBoundaryChangeAnalysisResult =
  | { success: true; analysis: TaskBoundaryChangeAnalysis }
  | { success: false; error: TaskBoundaryChangeError }

export type TaskBoundaryChangeApplyResult =
  | {
      success: true
      analysis: TaskBoundaryChangeAnalysis
      updatedNodes: import("./dag").TaskNode[]
      message: string
    }
  | { success: false; error: TaskBoundaryChangeError }

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
  code?: "GIT_CHECKPOINT_FAILED"
  message?: string
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
