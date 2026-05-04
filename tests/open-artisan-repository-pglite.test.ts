import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { PGlite } from "@electric-sql/pglite"
import { Kysely } from "kysely"
import { PGliteDialect } from "kysely-pglite-dialect"

import {
  DEFAULT_OPEN_ARTISAN_DB_FILE_NAME,
  createPGliteOpenArtisanRepository,
  createOpenArtisanDbRoadmapStateBackend,
  createOpenArtisanDbStateBackend,
  createOpenArtisanServices,
  exportLegacyWorkflowState,
  importLegacyWorkflowState,
  openArtisanDbError,
  type DbHumanGate,
  type DbPatchApplication,
  type DbPatchSuggestion,
  type DbTaskGraph,
  type DbWorkflow,
  type DatabaseOperationQueue,
  type OpenArtisanDbResult,
} from "#core/open-artisan-db"
import { createFileSystemStateBackend } from "#core/state-backend-fs"
import { SCHEMA_VERSION, type WorkflowState } from "#core/types"

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "oa-db-"))
  tempDirs.push(dir)
  return createPGliteOpenArtisanRepository({ connection: { dataDir: dir } })
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "oa-db-"))
  tempDirs.push(dir)
  return dir
}

function now() {
  return new Date().toISOString()
}

function valueOf<T>(result: OpenArtisanDbResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function workflow(overrides: Partial<DbWorkflow> = {}): DbWorkflow {
  return {
    id: "workflow-1",
    featureName: "db-runtime",
    mode: "INCREMENTAL",
    phase: "IMPLEMENTATION",
    phaseState: "SCHEDULING",
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  }
}

function taskGraph(workflowId = "workflow-1"): DbTaskGraph {
  return {
    tasks: [
      {
        id: "task-1",
        workflowId,
        taskKey: "T1",
        description: "Provision external service",
        status: "pending",
        category: "human-gate",
        complexity: "small",
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: "task-2",
        workflowId,
        taskKey: "T2",
        description: "Use service",
        status: "complete",
        category: "integration",
        complexity: "medium",
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    dependencies: [{ workflowId, fromTaskId: "task-1", toTaskId: "task-2" }],
    ownedFiles: [
      { taskId: "task-1", path: "infra/setup.md" },
      { taskId: "task-2", path: "src/service.ts" },
    ],
    expectedTests: [{ taskId: "task-2", path: "tests/service.test.ts" }],
    roadmapLinks: [],
  }
}

function legacyState(): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "legacy-session",
    mode: "INCREMENTAL",
    phase: "IMPLEMENTATION",
    phaseState: "HUMAN_GATE",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: ["/tmp/project/src/service.ts"],
    lastCheckpointTag: null,
    approvalCount: 0,
    orchestratorSessionId: null,
    intentBaseline: null,
    modeDetectionNote: null,
    discoveryReport: null,
    currentTaskId: null,
    feedbackHistory: [],
    backtrackContext: null,
    implDag: [
      {
        id: "T1",
        description: "Provision external service",
        dependencies: [],
        expectedTests: [],
        expectedFiles: ["infra/setup.md"],
        estimatedComplexity: "small",
        status: "human-gated",
        category: "human-gate",
        humanGate: {
          whatIsNeeded: "Provision service",
          why: "External prerequisite",
          verificationSteps: "Run service health check",
          resolved: false,
        },
      },
    ],
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
    artifactDiskPaths: {},
    featureName: "legacy-feature",
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
  }
}

describe("PGlite Open Artisan repository", () => {
  it("records ordered schema migrations", async () => {
    const dir = tempDir()
    const repo = createPGliteOpenArtisanRepository({ connection: { dataDir: dir } })
    expect((await repo.initialize()).ok).toBe(true)

    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite(join(dir, DEFAULT_OPEN_ARTISAN_DB_FILE_NAME))) })
    const rows = await db.withSchema("open_artisan").selectFrom("schema_migrations").select("version").orderBy("version").execute()
    await db.destroy()

    expect(rows.map((row: { version: number }) => row.version)).toEqual([1, 2])
  })

  it("uses injectable operation queues and exposes explicit disposal", async () => {
    const dir = tempDir()
    const scopes: string[] = []
    const queue: DatabaseOperationQueue = {
      run: async (scope, run) => {
        scopes.push(scope)
        return run()
      },
    }
    const repo = createPGliteOpenArtisanRepository({ connection: { dataDir: dir }, operationQueue: queue })

    expect((await repo.initialize()).ok).toBe(true)
    await repo.dispose()

    expect(scopes).toContain(join(dir, DEFAULT_OPEN_ARTISAN_DB_FILE_NAME))
  })

  it("takes over stale database operation locks", async () => {
    const dir = tempDir()
    const repo = createPGliteOpenArtisanRepository({ connection: { dataDir: dir } })
    expect((await repo.initialize()).ok).toBe(true)

    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite(join(dir, DEFAULT_OPEN_ARTISAN_DB_FILE_NAME))) })
    await db.withSchema("open_artisan").insertInto("database_operation_locks").values({
      lock_key: "open-artisan:repository-operation",
      owner_id: "stale-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
    }).execute()
    await db.destroy()

    expect((await repo.createWorkflow(workflow())).ok).toBe(true)

    const readDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite(join(dir, DEFAULT_OPEN_ARTISAN_DB_FILE_NAME))) })
    const lockRows = await readDb.withSchema("open_artisan").selectFrom("database_operation_locks").selectAll().execute()
    await readDb.destroy()
    expect(lockRows).toEqual([])
  })

  it("serializes concurrent repository instances that share one PGlite database", async () => {
    const dir = tempDir()
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const repo = createPGliteOpenArtisanRepository({ connection: { dataDir: dir } })
      return repo.createWorkflow(workflow({
        id: `workflow-${index}`,
        featureName: `db-runtime-${index}`,
      }))
    }))

    expect(results.every((result) => result.ok)).toBe(true)
    const listed = valueOf(await createPGliteOpenArtisanRepository({ connection: { dataDir: dir } }).listWorkflows())
    expect(listed).toHaveLength(8)
  })

  it("persists workflows and task graph projections", async () => {
    const repo = tempRepo()
    const created = await repo.createWorkflow(workflow())
    expect(created.ok).toBe(true)

    const graphResult = await repo.replaceTaskGraph("workflow-1", taskGraph())
    expect(graphResult.ok).toBe(true)

    const projection = await repo.getWorkflowByFeature("db-runtime")
    expect(projection.ok).toBe(true)
    expect(projection.ok && projection.value?.workflow.phase).toBe("IMPLEMENTATION")
    expect(projection.ok && projection.value?.taskGraph?.tasks.map((task) => task.taskKey)).toEqual(["T1", "T2"])
  })

  it("rolls back transactions when an operation returns an error result", async () => {
    const repo = tempRepo()
    const result = await repo.transaction(async (tx) => {
      await tx.createWorkflow(workflow({ id: "rolled-back", featureName: "rolled-back" }))
      return openArtisanDbError("invalid-input", "force rollback", false)
    })

    expect(result.ok).toBe(false)
    const projection = await repo.getWorkflow("rolled-back")
    expect(projection.ok && projection.value).toBeNull()
  })

  it("resolves human gates and updates task status", async () => {
    const repo = tempRepo()
    await repo.createWorkflow(workflow())
    await repo.replaceTaskGraph("workflow-1", taskGraph())

    const gate: DbHumanGate = {
      id: "gate-1",
      workflowId: "workflow-1",
      taskId: "task-1",
      whatIsNeeded: "Provision service",
      why: "Required for integration",
      verificationSteps: "Run health check",
      resolved: false,
      createdAt: now(),
    }
    expect((await repo.declareHumanGate(gate)).ok).toBe(true)
    let projection = await repo.getWorkflow("workflow-1")
    expect(projection.ok && projection.value?.unresolvedHumanGates.length).toBe(1)
    expect(projection.ok && projection.value?.taskGraph?.tasks.find((task) => task.id === "task-1")?.status).toBe("human-gated")

    expect((await repo.resolveHumanGate("gate-1", now())).ok).toBe(true)
    projection = await repo.getWorkflow("workflow-1")
    expect(projection.ok && projection.value?.unresolvedHumanGates.length).toBe(0)
    expect(projection.ok && projection.value?.taskGraph?.tasks.find((task) => task.id === "task-1")?.status).toBe("complete")
  })

  it("rejects human-gate declarations for non-human-gate tasks", async () => {
    const repo = tempRepo()
    await repo.createWorkflow(workflow())
    await repo.replaceTaskGraph("workflow-1", taskGraph())

    const result = await repo.declareHumanGate({
      id: "bad-gate",
      workflowId: "workflow-1",
      taskId: "task-2",
      whatIsNeeded: "Approve dirty worktree risk",
      why: "Not a real prerequisite",
      verificationSteps: "N/A",
      resolved: false,
      createdAt: now(),
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe("invalid-state")
    expect(valueOf(await repo.listHumanGates("workflow-1")).length).toBe(0)
  })

  it("rejects human-gate declarations for missing tasks without writing a gate", async () => {
    const repo = tempRepo()
    await repo.createWorkflow(workflow())

    const result = await repo.declareHumanGate({
      id: "missing-task-gate",
      workflowId: "workflow-1",
      taskId: "missing-task",
      whatIsNeeded: "Provision service",
      why: "Required",
      verificationSteps: "Verify",
      resolved: false,
      createdAt: now(),
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe("not-found")
    expect(valueOf(await repo.listHumanGates("workflow-1")).length).toBe(0)
  })

  it("persists artifact, roadmap, event, review, lease, worktree, and fast-forward query surfaces", async () => {
    const repo = tempRepo()
    await repo.createWorkflow(workflow())

    const roadmapItem = {
      id: "roadmap-1",
      kind: "feature" as const,
      title: "DB runtime",
      status: "todo" as const,
      priority: 10,
      featureName: "db-runtime",
      createdAt: now(),
      updatedAt: now(),
    }
    expect((await repo.createRoadmapItem(roadmapItem)).ok).toBe(true)
    expect((await repo.linkWorkflowToRoadmap("workflow-1", "roadmap-1")).ok).toBe(true)
    expect(valueOf(await repo.listRoadmapItems({ featureName: "db-runtime" })).length).toBe(1)

    const event = {
      id: "event-1",
      workflowId: "workflow-1",
      event: "repository_import" as const,
      createdAt: now(),
      reason: "test",
    }
    expect((await repo.appendWorkflowEvent(event)).ok).toBe(true)
    expect(valueOf(await repo.listWorkflowEvents("workflow-1")).map((item) => item.id)).toEqual(["event-1"])

    const artifact = {
      id: "artifact-1",
      workflowId: "workflow-1",
      artifactKey: "plan" as const,
      createdAt: now(),
      updatedAt: now(),
    }
    const missingArtifactVersion = await repo.recordArtifactVersion({ id: "missing-version", artifactId: "missing-artifact", contentHash: "missing", createdAt: now() })
    expect(missingArtifactVersion.ok).toBe(false)
    expect(!missingArtifactVersion.ok && missingArtifactVersion.error.code).toBe("not-found")
    expect((await repo.upsertArtifact(artifact)).ok).toBe(true)
    expect((await repo.linkArtifactToRoadmap("artifact-1", "roadmap-1")).ok).toBe(true)
    const version = { id: "version-1", artifactId: "artifact-1", contentHash: "abc", diskPath: "/tmp/plan.md", createdAt: now() }
    expect((await repo.recordArtifactVersion(version)).ok).toBe(true)
    const approval = { id: "approval-1", artifactVersionId: "version-1", approvedBy: "user" as const, createdAt: now() }
    expect((await repo.approveArtifact(approval)).ok).toBe(true)
    expect(valueOf(await repo.listArtifactVersions("artifact-1")).map((item) => item.id)).toEqual(["version-1"])
    expect(valueOf(await repo.listArtifactApprovals("version-1")).map((item) => item.id)).toEqual(["approval-1"])

    const review = { id: "review-1", workflowId: "workflow-1", taskId: "task-1", recommendation: "pass_with_suggestions" as const, passed: true, createdAt: now() }
    const observation = { id: "obs-1", reviewId: "review-1", kind: "patch_suggestion" as const, severity: "info" as const, message: "Consider cleanup" }
    expect((await repo.recordTaskReview(review, [observation])).ok).toBe(true)
    expect(valueOf(await repo.listTaskReviews("workflow-1")).map((item) => item.id)).toEqual(["review-1"])
    expect(valueOf(await repo.listReviewObservations("review-1")).map((item) => item.id)).toEqual(["obs-1"])

    const lease = { id: "lease-1", workflowId: "workflow-1", agentKind: "opencode" as const, sessionId: "s1", heartbeatAt: now(), expiresAt: now(), createdAt: now() }
    expect((await repo.recordAgentLease(lease)).ok).toBe(true)
    expect((await repo.recordFileClaim({ id: "claim-1", agentLeaseId: "lease-1", path: "src/service.ts", mode: "write" as const, createdAt: now() })).ok).toBe(true)
    expect(valueOf(await repo.listAgentLeases("workflow-1")).map((item) => item.id)).toEqual(["lease-1"])
    expect(valueOf(await repo.listFileClaims("lease-1")).map((item) => item.id)).toEqual(["claim-1"])

    expect((await repo.recordWorktreeObservation({ id: "wt-1", workflowId: "workflow-1", path: "build/cache", status: "untracked" as const, classification: "generated" as const, createdAt: now() })).ok).toBe(true)
    expect(valueOf(await repo.listWorktreeObservations("workflow-1", "generated")).map((item) => item.id)).toEqual(["wt-1"])

    expect((await repo.recordFastForward({ id: "ff-1", workflowId: "workflow-1", fromPhase: "TESTS", fromPhaseState: "USER_GATE", toPhase: "IMPL_PLAN", toPhaseState: "DRAFT", reason: "patch only", patchSuggestionIds: [], createdAt: now() })).ok).toBe(true)
    expect(valueOf(await repo.listFastForwards("workflow-1")).map((item) => item.id)).toEqual(["ff-1"])
  })

  it("analyzes boundary changes and tracks pending patch suggestions", async () => {
    const repo = tempRepo()
    await repo.createWorkflow(workflow())
    await repo.replaceTaskGraph("workflow-1", taskGraph())

    const analysis = await repo.analyzeBoundaryChange({
      workflowId: "workflow-1",
      taskId: "task-1",
      addFiles: ["src/service.ts"],
      reason: "Reviewer found ownership overlap",
    })
    expect(analysis.ok && analysis.value.ownershipConflicts).toEqual(["src/service.ts already owned by task-2"])
    expect(analysis.ok && analysis.value.completedTaskIdsToReset).toEqual(["task-2"])

    const suggestion: DbPatchSuggestion = {
      id: "patch-1",
      workflowId: "workflow-1",
      targetPath: "src/service.ts",
      summary: "Tighten validation",
      suggestedPatch: "diff --git a/src/service.ts b/src/service.ts",
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
    }
    expect((await repo.recordPatchSuggestion(suggestion)).ok).toBe(true)
    let projection = await repo.getWorkflow("workflow-1")
    expect(projection.ok && projection.value?.pendingPatchSuggestions.map((patch) => patch.id)).toEqual(["patch-1"])

    const application: DbPatchApplication = {
      id: "application-1",
      patchSuggestionId: "patch-1",
      appliedBy: "orchestrator",
      result: "applied",
      createdAt: now(),
    }
    expect((await repo.applyPatchSuggestion(application)).ok).toBe(true)
    projection = await repo.getWorkflow("workflow-1")
    expect(projection.ok && projection.value?.pendingPatchSuggestions.length).toBe(0)
  })

  it("rejects orphan patch application records", async () => {
    const repo = tempRepo()
    await repo.createWorkflow(workflow())

    const result = await repo.applyPatchSuggestion({
      id: "orphan-application",
      patchSuggestionId: "missing-patch",
      appliedBy: "agent",
      result: "applied",
      createdAt: now(),
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe("not-found")
    expect(valueOf(await repo.listPatchApplications("missing-patch"))).toEqual([])
  })

  it("imports and exports legacy workflow-state snapshots", async () => {
    const repo = tempRepo()
    const imported = await repo.importWorkflowState(legacyState())
    expect(imported.ok).toBe(true)
    const workflowId = imported.ok ? imported.value.workflowId : ""

    const projection = await repo.getWorkflow(workflowId)
    expect(projection.ok && projection.value?.workflow.featureName).toBe("legacy-feature")
    expect(projection.ok && projection.value?.unresolvedHumanGates.length).toBe(1)

    const exported = await repo.exportWorkflowState(workflowId)
    expect(exported.ok).toBe(true)
    expect(exported.ok && exported.value.featureName).toBe("legacy-feature")
    expect(exported.ok && exported.value.implDag?.[0]?.humanGate?.whatIsNeeded).toBe("Provision service")
  })

  it("preserves runtime review and observation facts across compatibility state imports", async () => {
    const repo = tempRepo()
    const workflowId = valueOf(await repo.importWorkflowState(legacyState())).workflowId
    const createdAt = now()
    expect((await repo.appendWorkflowEvent({ id: "runtime-event-1", workflowId, event: "repository_import", createdAt })).ok).toBe(true)
    expect((await repo.upsertArtifact({ id: "runtime-artifact-1", workflowId, artifactKey: "plan", createdAt, updatedAt: createdAt })).ok).toBe(true)
    expect((await repo.recordArtifactVersion({ id: "runtime-artifact-version-1", artifactId: "runtime-artifact-1", contentHash: "hash-1", diskPath: "/tmp/plan.md", createdAt })).ok).toBe(true)
    expect((await repo.approveArtifact({ id: "runtime-artifact-approval-1", artifactVersionId: "runtime-artifact-version-1", approvedBy: "user", createdAt })).ok).toBe(true)
    expect((await repo.recordAgentLease({ id: "runtime-lease-1", workflowId, agentKind: "hermes", sessionId: "session-1", taskId: `${workflowId}:T1`, heartbeatAt: createdAt, expiresAt: createdAt, createdAt })).ok).toBe(true)
    expect((await repo.recordFileClaim({ id: "runtime-claim-1", agentLeaseId: "runtime-lease-1", path: "src/service.ts", mode: "write", createdAt })).ok).toBe(true)
    const review = { id: "runtime-review-1", workflowId, taskId: `${workflowId}:T1`, recommendation: "fail" as const, passed: false, createdAt: now() }
    const observation = { id: "runtime-observation-1", reviewId: review.id, kind: "blocking_issue" as const, severity: "blocking" as const, message: "Needs fix" }
    expect((await repo.recordTaskReview(review, [observation])).ok).toBe(true)
    expect((await repo.recordWorktreeObservation({ id: "runtime-wt-1", workflowId, path: "dist/out.js", status: "untracked" as const, classification: "generated" as const, createdAt: now() })).ok).toBe(true)
    expect((await repo.recordFastForward({ id: "runtime-ff-1", workflowId, fromPhase: "PLANNING", fromPhaseState: "USER_GATE", toPhase: "INTERFACES", toPhaseState: "DRAFT", reason: "verified prior artifact", patchSuggestionIds: [], createdAt: now() })).ok).toBe(true)

    const nextState = legacyState()
    nextState.phaseState = "SCHEDULING"
    nextState.artifactDiskPaths.plan = "/tmp/stale-plan.md"
    nextState.approvedArtifacts.plan = "stale-hash"
    expect((await repo.importWorkflowState(nextState)).ok).toBe(true)

    expect(valueOf(await repo.listTaskReviews(workflowId)).map((item) => item.id)).toEqual(["runtime-review-1"])
    expect(valueOf(await repo.listReviewObservations("runtime-review-1")).map((item) => item.id)).toEqual(["runtime-observation-1"])
    expect(valueOf(await repo.listWorktreeObservations(workflowId)).map((item) => item.id)).toEqual(["runtime-wt-1"])
    expect(valueOf(await repo.listFastForwards(workflowId)).map((item) => item.id)).toEqual(["runtime-ff-1"])
    expect(valueOf(await repo.listWorkflowEvents(workflowId)).map((item) => item.id)).toEqual(["runtime-event-1"])
    const projection = valueOf(await repo.getWorkflow(workflowId))
    expect(projection?.artifacts.map((item) => item.id)).toEqual(["runtime-artifact-1"])
    expect(projection?.artifacts[0]?.currentVersionId).toBe("runtime-artifact-version-1")
    expect(valueOf(await repo.listArtifactVersions("runtime-artifact-1")).map((item) => item.id)).toEqual(["runtime-artifact-version-1"])
    expect(valueOf(await repo.listAgentLeases(workflowId)).map((item) => item.id)).toEqual(["runtime-lease-1"])
    expect(valueOf(await repo.listFileClaims("runtime-lease-1")).map((item) => item.id)).toEqual(["runtime-claim-1"])

    const exported = valueOf(await repo.exportWorkflowState(workflowId))
    expect(exported.artifactDiskPaths.plan).toBe("/tmp/plan.md")
    expect(exported.approvedArtifacts.plan).toBe("hash-1")
  })

  it("exports DB-derived human gate status after imported snapshot changes", async () => {
    const repo = tempRepo()
    const imported = await importLegacyWorkflowState(repo, legacyState())
    expect(imported.ok).toBe(true)
    const workflowId = imported.ok ? imported.value.workflowId : ""

    expect((await repo.resolveHumanGate(`${workflowId}:T1:gate`, "2026-05-01T00:00:00.000Z")).ok).toBe(true)
    const exported = await exportLegacyWorkflowState(repo, workflowId)
    expect(exported.ok).toBe(true)
    expect(exported.ok && exported.value.implDag?.[0]?.status).toBe("complete")
    expect(exported.ok && exported.value.implDag?.[0]?.humanGate?.resolved).toBe(true)
  })

  it("exposes repository-backed StateBackend compatibility", async () => {
    const repo = tempRepo()
    const dir = mkdtempSync(join(tmpdir(), "oa-db-backend-"))
    tempDirs.push(dir)
    const backend = createOpenArtisanDbStateBackend(repo, dir)
    const state = legacyState()

    await backend.write("legacy-feature", JSON.stringify(state))
    await expect(backend.write("wrong-feature", JSON.stringify(state))).rejects.toThrow("feature mismatch")
    expect(await backend.list()).toEqual(["legacy-feature"])
    const raw = await backend.read("legacy-feature")
    expect(raw).toBeString()
    expect(raw ? JSON.parse(raw).featureName : null).toBe("legacy-feature")
    await backend.remove("legacy-feature")
    expect(await backend.read("legacy-feature")).toBeNull()
  })

  it("imports legacy filesystem workflow state into the DB compatibility backend", async () => {
    const repo = tempRepo()
    const dir = mkdtempSync(join(tmpdir(), "oa-db-legacy-fs-"))
    tempDirs.push(dir)
    const filesystemBackend = createFileSystemStateBackend(dir)
    const state = legacyState()
    state.phaseState = "REVIEW"
    state.implDag![0]!.status = "complete"
    state.implDag![0]!.category = "integration"
    delete state.implDag![0]!.humanGate
    await filesystemBackend.write("legacy-feature", JSON.stringify(state, null, 2))

    const backend = createOpenArtisanDbStateBackend(repo, dir, { legacyFallback: filesystemBackend })

    expect(await backend.list()).toEqual(["legacy-feature"])
    const raw = await backend.read("legacy-feature")
    expect(raw).toBeString()
    const imported = valueOf(await repo.exportWorkflowState("workflow:legacy-feature"))
    expect(imported.phaseState).toBe("REVIEW")
    expect(imported.implDag?.[0]?.id).toBe("T1")
    expect(imported.implDag?.[0]?.status).toBe("complete")
  })

  it("mirrors DB compatibility writes back to legacy filesystem workflow state", async () => {
    const repo = tempRepo()
    const dir = mkdtempSync(join(tmpdir(), "oa-db-legacy-mirror-"))
    tempDirs.push(dir)
    const filesystemBackend = createFileSystemStateBackend(dir)
    const backend = createOpenArtisanDbStateBackend(repo, dir, { legacyFallback: filesystemBackend })
    const state = legacyState()
    state.phaseState = "REVIEW"

    await backend.write("legacy-feature", JSON.stringify(state, null, 2))

    const raw = await filesystemBackend.read("legacy-feature")
    expect(raw).toBeString()
    expect(raw ? JSON.parse(raw).phaseState : null).toBe("REVIEW")
  })

  it("exposes repository-backed RoadmapStateBackend compatibility", async () => {
    const repo = tempRepo()
    const dir = mkdtempSync(join(tmpdir(), "oa-roadmap-db-backend-"))
    tempDirs.push(dir)
    const backend = createOpenArtisanDbRoadmapStateBackend(repo, dir)
    const document = {
      schemaVersion: 1,
      items: [{ id: "roadmap-1", kind: "feature" as const, title: "DB", status: "todo" as const, priority: 5, createdAt: now(), updatedAt: now() }],
      edges: [],
    }

    expect((await backend.createRoadmap(document)).ok).toBe(true)
    const read = await backend.readRoadmap()
    expect(read.ok && read.value?.items.map((item) => item.id)).toEqual(["roadmap-1"])
    expect((await backend.deleteRoadmap()).ok).toBe(true)
    const deleted = await backend.readRoadmap()
    expect(deleted.ok && deleted.value).toBeNull()
  })

  it("provides thin service seams over repository operations", async () => {
    const repo = tempRepo()
    const services = createOpenArtisanServices(repo)

    expect((await services.workflow.createWorkflow(workflow())).ok).toBe(true)
    expect(valueOf(await services.workflow.listWorkflows()).map((item) => item.id)).toEqual(["workflow-1"])
    expect((await services.workflow.setPhase("workflow-1", "TESTS", "DRAFT")).ok).toBe(true)
    expect((await services.executionSlices.createSlice({ id: "slice-1", title: "Slice", status: "active", createdAt: now(), updatedAt: now() }, ["roadmap-1"])).ok).toBe(true)
    expect(valueOf(await services.executionSlices.getSlice("slice-1"))?.itemIds).toEqual(["roadmap-1"])
    expect((await services.taskGraph.replaceTaskGraph("workflow-1", taskGraph())).ok).toBe(true)
    expect(valueOf(await services.taskGraph.getTaskGraph("workflow-1"))?.tasks.map((task) => task.id)).toEqual(["task-1", "task-2"])
    expect((await services.roadmap.createItem({ id: "roadmap-1", kind: "feature", title: "DB", status: "todo", priority: 1, createdAt: now(), updatedAt: now() })).ok).toBe(true)
    expect((await services.roadmap.upsertEdge({ fromItemId: "roadmap-1", toItemId: "roadmap-1", kind: "depends-on" })).ok).toBe(true)
    expect(valueOf(await services.roadmap.listEdges("roadmap-1")).length).toBe(1)
    expect(valueOf(await services.roadmap.listItems()).map((item) => item.id)).toEqual(["roadmap-1"])
    expect((await services.workflow.linkRoadmap("workflow-1", "roadmap-1")).ok).toBe(true)
    expect((await services.artifacts.upsertArtifact({ id: "artifact-1", workflowId: "workflow-1", artifactKey: "plan", createdAt: now(), updatedAt: now() })).ok).toBe(true)
    expect((await services.artifacts.linkRoadmap("artifact-1", "roadmap-1")).ok).toBe(true)
    expect((await services.artifacts.recordVersion({ id: "version-1", artifactId: "artifact-1", contentHash: "hash", createdAt: now() })).ok).toBe(true)
    expect((await services.artifacts.approve({ id: "approval-1", artifactVersionId: "version-1", approvedBy: "user", createdAt: now() })).ok).toBe(true)
    expect(valueOf(await services.artifacts.listVersions("artifact-1")).map((item) => item.id)).toEqual(["version-1"])
    expect(valueOf(await services.artifacts.listApprovals("version-1")).map((item) => item.id)).toEqual(["approval-1"])
    expect((await services.humanGates.declareGate({ id: "gate-1", workflowId: "workflow-1", taskId: "task-1", whatIsNeeded: "Provision", why: "Needed", verificationSteps: "Verify", resolved: false, createdAt: now() })).ok).toBe(true)
    expect(valueOf(await services.humanGates.listGates("workflow-1", false)).map((item) => item.id)).toEqual(["gate-1"])
    expect((await services.humanGates.resolveGate("gate-1", now())).ok).toBe(true)
    expect(valueOf(await services.humanGates.listGates("workflow-1", true)).map((item) => item.id)).toEqual(["gate-1"])
    expect((await services.workflow.deleteWorkflow("workflow-1")).ok).toBe(true)
  })
})
