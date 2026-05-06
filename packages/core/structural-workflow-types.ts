import type { RevisionStep } from "./orchestrator-types"
import type {
  AnalyzeTaskBoundaryChangeArgs,
  ApplyTaskBoundaryChangeArgs,
  TaskBoundaryChangeAnalysisResult,
  TaskBoundaryChangeApplyResult,
} from "./tool-types"
import type { BacktrackContext } from "./workflow-state-types"
import type { ArtifactKey, Phase, PhaseState, WorkflowEvent, WorkflowMode } from "./workflow-primitives"

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

/**
 * Feature-level TESTS contract for structural-state-machine-rigor.
 *
 * This makes the approved override explicit at the interface layer: for this feature,
 * the public contract under test is the executable seam registry itself, not a generic
 * interface-only import rule and not a pure expected-failure-only suite style.
 */
export type InterfaceErrorPattern =
  | "ok-result-union"
  | "success-result-union"
  | "throws-typed-error"
  | "string-null-legacy-validation"

/**
 * Explicitly records the compatibility patterns this repository already exposes.
 *
 * The structural-state-machine-rigor feature extends these existing contracts instead of
 * forcing a repo-wide error-pattern rewrite during INTERFACES. Reviewer/tooling consumers
 * can use this declaration to distinguish deliberate compatibility seams from accidental drift.
 */
export interface LegacyInterfaceCompatibilityPolicy {
  policyName: "open-artisan-interface-compatibility"
  featureName: "structural-state-machine-rigor"
  canonicalPatternForNewStructuralContracts: "success-result-union"
  approvedLegacyPatterns: InterfaceErrorPattern[]
  compatibilitySeams: Array<{
    seam: string
    pattern: InterfaceErrorPattern
    rationale: string
  }>
  decision: string
  alternativesConsidered: string[]
  tradeoffs: string[]
}

export interface StructuralWorkflowExecutableTestingPolicy {
  featureName: "structural-state-machine-rigor"
  appliesAtPhase: "TESTS"
  publicContractKind: "supported-executable-seam-registry"
  defaultImportPolicy: SupportedExecutableSeamImportPolicy
  defaultSuiteStyle: SupportedExecutableSeamSuiteStyle
  displacesGenericInterfaceOnlyRule: true
  displacesExpectedFailureOnlyRule: true
  /** Runtime owner modules that are explicitly approved as public seams for TESTS. */
  approvedRuntimeOwnerModules: string[]
  /** Named seam kinds that TESTS must treat as the public contract surface. */
  approvedSeamKinds: SupportedExecutableSeamKind[]
  decision: string
  alternativesConsidered: string[]
  tradeoffs: string[]
}

export const LEGACY_INTERFACE_COMPATIBILITY_POLICY: LegacyInterfaceCompatibilityPolicy = {
  policyName: "open-artisan-interface-compatibility",
  featureName: "structural-state-machine-rigor",
  canonicalPatternForNewStructuralContracts: "success-result-union",
  approvedLegacyPatterns: [
    "ok-result-union",
    "success-result-union",
    "throws-typed-error",
    "string-null-legacy-validation",
  ],
  compatibilitySeams: [
    {
      seam: "StateMachine and related transition helpers",
      pattern: "ok-result-union",
      rationale: "Existing transition legality/runtime helper seams already use ok-based discriminated unions and downstream runtime code depends on that shape.",
    },
    {
      seam: "Roadmap validation helpers",
      pattern: "string-null-legacy-validation",
      rationale: "Roadmap validation is an existing local helper seam whose runtime contract was explicitly preserved to avoid breaking current behavior and tests during INTERFACES.",
    },
    {
      seam: "StateBackend and SessionRegistry mutation-style methods",
      pattern: "throws-typed-error",
      rationale: "These low-level storage/session graph seams document typed thrown errors rather than result unions because their existing consumers already rely on mutation/throw semantics.",
    },
  ],
  decision:
    "Preserve existing repository compatibility seams while requiring new structural-state-machine-rigor contracts to use explicit typed policies and structured result/error declarations.",
  alternativesConsidered: [
    "force a repo-wide single error pattern in INTERFACES",
    "hide legacy patterns and leave the mixed contracts undocumented",
  ],
  tradeoffs: [
    "keeps compatibility with already-approved runtime contracts",
    "documents mixed patterns explicitly so later work does not mistake them for accidental drift",
    "defers a repo-wide error normalization refactor to a dedicated future change instead of smuggling it into this feature",
  ],
}

export const STRUCTURAL_WORKFLOW_EXECUTABLE_TESTING_POLICY: StructuralWorkflowExecutableTestingPolicy = {
  featureName: "structural-state-machine-rigor",
  appliesAtPhase: "TESTS",
  publicContractKind: "supported-executable-seam-registry",
  defaultImportPolicy: "owner-module-public-runtime-contract",
  defaultSuiteStyle: "mixed-characterization-and-target-state",
  displacesGenericInterfaceOnlyRule: true,
  displacesExpectedFailureOnlyRule: true,
  approvedRuntimeOwnerModules: [
    "#core/state-machine",
    "#core/hooks/tool-guard",
    "#core/tools/request-review",
    "#core/session-state",
    "#core/scheduler",
    "#bridge/methods/tool-execute",
    "packages/adapter-hermes/hermes_adapter/workflow_tools.py",
    "#claude-code/src/hook-handlers",
    "#plugin/index",
    "#core/hooks/system-transform",
  ],
  approvedSeamKinds: [
    "state-machine",
    "phase-tool-policy",
    "request-review-file-artifact",
    "session-state-validation",
    "scheduler-parallel-contract",
    "bridge-runtime",
    "hermes-post-tool-continuation",
    "claude-hook-phase-gating",
    "task-boundary-revision-workflow",
    "workflow-guidance-legality",
  ],
  decision:
    "Treat the supported executable seam registry as the public TESTS contract so runnable suites can verify real workflow wiring, adapter parity, persistence repair, and structural state behavior.",
  alternativesConsidered: [
    "generic interface-only imports for all tests",
    "pure expected-failure-only specification suites",
    "deferring runtime seam verification to IMPLEMENTATION only",
  ],
  tradeoffs: [
    "binds TESTS to named runtime owner modules intentionally",
    "permits characterization/regression coverage where preserving existing runtime behavior is part of the contract",
    "removes ambiguity about whether generic TESTS rubric defaults still apply to this feature",
  ],
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
