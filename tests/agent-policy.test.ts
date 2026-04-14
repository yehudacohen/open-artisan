import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extractAgentName,
  isArtisanAgent,
  isWorkflowSessionActive,
  normalizeAgentName,
  persistActiveAgent,
} from "#core/agent-policy"
import { createSessionStateStore } from "#core/session-state"
import { createFileSystemStateBackend } from "#core/state-backend-fs"
import { SCHEMA_VERSION, type WorkflowState } from "#core/types"

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "s1",
    mode: null,
    phase: "MODE_SELECT",
    phaseState: "DRAFT",
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
    featureName: null,
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

describe("agent-policy", () => {
  it("normalizes agent names", () => {
    expect(normalizeAgentName(" Robot-Artisan ")).toBe("robot-artisan")
    expect(normalizeAgentName(42)).toBeNull()
  })

  it("detects artisan agents", () => {
    expect(isArtisanAgent("artisan")).toBe(true)
    expect(isArtisanAgent("robot-artisan")).toBe(true)
    expect(isArtisanAgent("build")).toBe(false)
  })

  it("extracts nested agent metadata", () => {
    expect(extractAgentName({ info: { agent: "Build" } })).toBe("build")
    expect(extractAgentName({ properties: { session: { agentId: "artisan" } } })).toBe("artisan")
  })

  it("treats unknown MODE_SELECT sessions as dormant", () => {
    expect(isWorkflowSessionActive(makeState())).toBe(false)
  })

  it("treats non-artisan sessions as dormant", () => {
    expect(isWorkflowSessionActive(makeState({ activeAgent: "build" }))).toBe(false)
  })

  it("treats persisted workflow state as active even without agent metadata", () => {
    expect(isWorkflowSessionActive(makeState({ phase: "PLANNING" }))).toBe(true)
  })

  it("persists normalized agent names to session state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-policy-"))
    const store = createSessionStateStore(createFileSystemStateBackend(dir))
    await store.create("s1")

    const persisted = await persistActiveAgent(store, "s1", " Build ")

    expect(persisted).toBe("build")
    expect(store.get("s1")?.activeAgent).toBe("build")
  })
})
