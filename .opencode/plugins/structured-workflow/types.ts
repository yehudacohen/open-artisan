/**
 * types.ts — All interfaces, enums, and data models for the structured-workflow plugin.
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
  | "REVISE"

/**
 * Which PhaseStates are valid for each Phase.
 * Enforced by the state machine at transition time.
 */
export const VALID_PHASE_STATES: Record<Phase, PhaseState[]> = {
  MODE_SELECT: ["DRAFT"],
  DISCOVERY: ["SCAN", "ANALYZE", "CONVENTIONS", "REVIEW", "USER_GATE", "REVISE"],
  PLANNING: ["DRAFT", "REVIEW", "USER_GATE", "REVISE"],
  INTERFACES: ["DRAFT", "REVIEW", "USER_GATE", "REVISE"],
  TESTS: ["DRAFT", "REVIEW", "USER_GATE", "REVISE"],
  IMPL_PLAN: ["DRAFT", "REVIEW", "USER_GATE", "REVISE"],
  IMPLEMENTATION: ["DRAFT", "REVIEW", "USER_GATE", "REVISE"],
  DONE: ["DRAFT"],
}

export type WorkflowEvent =
  | "mode_selected"        // MODE_SELECT → DISCOVERY or PLANNING
  | "scan_complete"        // DISCOVERY/SCAN → DISCOVERY/ANALYZE
  | "analyze_complete"     // DISCOVERY/ANALYZE → DISCOVERY/CONVENTIONS
  | "draft_complete"       // */DRAFT → */REVIEW
  | "self_review_pass"     // */REVIEW → */USER_GATE
  | "self_review_fail"     // */REVIEW → */REVIEW (loop, increments iterationCount)
  | "user_approve"         // */USER_GATE → next Phase/DRAFT (+ git checkpoint)
  | "user_feedback"        // */USER_GATE → orchestrator → */REVISE
  | "revision_complete"    // */REVISE → */REVIEW

export type ArtifactKey =
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
 */
export const SCHEMA_VERSION = 5

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
   * Serialized ImplDAG — the parsed task graph from the approved IMPL_PLAN artifact.
   * Populated at IMPL_PLAN/USER_GATE approval. null before that gate.
   * The sequential scheduler reads this to find the next ready task.
   * Stored as a plain object (TaskNode[]) for JSON serializability.
   */
  implDag: import("./dag").TaskNode[] | null

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

  /** Returns all valid events in the given phase/state */
  validEvents(phase: Phase, phaseState: PhaseState): WorkflowEvent[]

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
  /** Get state for a session, or null if not found */
  get(sessionId: string): WorkflowState | null

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
  const validPhases: Phase[] = [
    "MODE_SELECT", "DISCOVERY", "PLANNING", "INTERFACES",
    "TESTS", "IMPL_PLAN", "IMPLEMENTATION", "DONE",
  ]
  if (!validPhases.includes(state.phase)) {
    return `Invalid phase: "${state.phase}"`
  }
  const validStates = VALID_PHASE_STATES[state.phase]
  if (!validStates.includes(state.phaseState)) {
    return `Invalid phaseState "${state.phaseState}" for phase "${state.phase}". Valid: ${validStates.join(", ")}`
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
  if (typeof state.escapePending !== "boolean") {
    return `escapePending must be a boolean, got ${typeof state.escapePending}`
  }
  if (state.pendingRevisionSteps !== null && !Array.isArray(state.pendingRevisionSteps)) {
    return `pendingRevisionSteps must be null or an array, got ${typeof state.pendingRevisionSteps}`
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

export type DivergenceClass = "tactical" | "strategic"

export interface OrchestratorDivergeSuccess {
  success: true
  classification: DivergenceClass
  triggerCriterion?: "scope_expansion" | "architectural_shift" | "cascade_depth" | "accumulated_drift"
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
  phaseState: "REVISE"
  instructions: string
}

export interface OrchestratorPlanResult {
  /** Ordered revision steps, earliest upstream artifact first */
  revisionSteps: RevisionStep[]
  /**
   * Whether the orchestrator classified this change as tactical or strategic.
   * tactical → agent proceeds autonomously to REVISE.
   * strategic → escape hatch is presented to the user before proceeding.
   * Callers MUST use this field rather than re-deriving from revisionSteps.length.
   */
  classification: "tactical" | "strategic"
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

export interface EscapeHatchPresentation {
  originalIntent: string
  detectedDivergence: string
  proposedChangePlan: string
  impactAssessment: string
}

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
  severity: "blocking" | "suggestion"
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
// Tool argument shapes
// ---------------------------------------------------------------------------

export interface SelectModeArgs {
  mode: WorkflowMode
}

export interface MarkSatisfiedArgs {
  criteria_met: Array<{
    criterion: string
    met: boolean
    evidence: string
    /**
     * Optional severity override. Defaults to "blocking" if not provided.
     * "suggestion" criteria do not block advancement; they are advisory only.
     */
    severity?: "blocking" | "suggestion"
  }>
}

export interface RequestReviewArgs {
  /** Plain text summary of what was built in this phase */
  summary: string
  /** Description of the artifact(s) produced */
  artifact_description: string
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
