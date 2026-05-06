/**
 * Tests for persistent workflow status rendering.
 */
import { describe, expect, it } from "bun:test"
import { generateStatusMarkdown } from "#core/status-writer"
import { SCHEMA_VERSION, type WorkflowState } from "#core/workflow-state-types"

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "status-test",
    mode: "INCREMENTAL",
    phase: "IMPLEMENTATION",
    phaseState: "USER_GATE",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: [],
    lastCheckpointTag: null,
    approvalCount: 0,
    orchestratorSessionId: null,
    intentBaseline: null,
    modeDetectionNote: null,
    discoveryReport: null,
    currentTaskId: null,
    feedbackHistory: [],
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
    artifactDiskPaths: {},
    featureName: "status-feature",
    revisionBaseline: null,
    activeAgent: null,
    taskCompletionInProgress: null,
    taskReviewCount: 0,
    pendingFeedback: null,
    userMessages: [],
    cachedPriorState: null,
    priorWorkflowChecked: false,
    sessionModel: null,
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
    ...overrides,
  }
}

describe("generateStatusMarkdown", () => {
  it("lists artifact documents, review files, and review evidence at gates", () => {
    const markdown = generateStatusMarkdown(makeState({
      artifactDiskPaths: {
        plan: "/project/.openartisan/status-feature/plan.md",
        impl_plan: "/project/.openartisan/status-feature/impl-plan.md",
      },
      reviewArtifactFiles: [
        "packages/core/status-writer.ts",
        "tests/status-writer.test.ts",
      ],
      latestReviewResults: [{
        criterion: "Expected tests pass",
        met: true,
        evidence: "Ran `bun test tests/status-writer.test.ts`; result: 2 pass, 0 fail.",
      }],
    }))

    expect(markdown).toContain("## Review Assets")
    expect(markdown).toContain("plan: `/project/.openartisan/status-feature/plan.md`")
    expect(markdown).toContain("`packages/core/status-writer.ts`")
    expect(markdown).toContain("## Review Evidence")
    expect(markdown).toContain("Expected tests pass")
    expect(markdown).toContain("Ran `bun test tests/status-writer.test.ts`")
    expect(markdown).toContain("| plan | saved |")
  })

  it("lists unresolved human gates with verification steps", () => {
    const markdown = generateStatusMarkdown(makeState({
      implDag: [{
        id: "T1",
        description: "Configure external service",
        dependencies: [],
        expectedTests: [],
        expectedFiles: [],
        estimatedComplexity: "small",
        status: "human-gated",
        category: "human-gate",
        humanGate: {
          whatIsNeeded: "Provision the test database",
          why: "The integration test needs a real endpoint",
          verificationSteps: "Run `psql $DATABASE_URL -c 'select 1'`",
          resolved: false,
        },
      }],
    }))

    expect(markdown).toContain("## Human Gates")
    expect(markdown).toContain("Provision the test database")
    expect(markdown).toContain("The integration test needs a real endpoint")
    expect(markdown).toContain("Run `psql $DATABASE_URL -c 'select 1'`")
  })

  it("keeps final implementation review evidence visible after approval", () => {
    const markdown = generateStatusMarkdown(makeState({
      phase: "DONE",
      phaseState: "DRAFT",
      approvedArtifacts: {
        implementation: "approved-at-1",
      },
      reviewArtifactFiles: ["docs/full-execution-plan.md"],
      latestReviewResults: [{
        criterion: "Final implementation review",
        met: true,
        evidence: "24 of 24 blocking criteria met before approval.",
      }],
    }))

    expect(markdown).toContain("| implementation | approved |")
    expect(markdown).toContain("All blocking criteria met")
    expect(markdown).toContain("Final implementation review")
    expect(markdown).toContain("24 of 24 blocking criteria met before approval")
    expect(markdown).toContain("`docs/full-execution-plan.md`")
    expect(markdown).not.toContain("No review results yet")
  })
})
