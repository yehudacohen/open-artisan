import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createOpenArtisanServices, createPGliteOpenArtisanRepository, type DbPatchSuggestion, type OpenArtisanRepository } from "#core/open-artisan-db"
import { applyPatchSuggestionToWorktree, extractPatchTouchedPaths } from "#core/patch-suggestion-application"
import { workflowDbId } from "#core/runtime-persistence"
import { SCHEMA_VERSION, type WorkflowState } from "#core/types"

const tempDirs: string[] = []
const sharedTempDirs: string[] = []
const tempRepos: OpenArtisanRepository[] = []
let sharedDbDir: string | null = null
let schemaCounter = 0

afterEach(async () => {
  await Promise.all(tempRepos.splice(0).map((repo) => repo.dispose()))
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

afterAll(async () => {
  await Promise.all(sharedTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function now() {
  return new Date().toISOString()
}

function tempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix)).then((dir) => {
    tempDirs.push(dir)
    return dir
  })
}

async function sharedPGliteDir(): Promise<string> {
  if (!sharedDbDir) {
    sharedDbDir = await mkdtemp(join(tmpdir(), "oa-patch-db-shared-"))
    sharedTempDirs.push(sharedDbDir)
  }
  return sharedDbDir
}

function nextSchemaName(): string {
  schemaCounter++
  return `open_artisan_patch_${schemaCounter}`
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "patch-session",
    mode: "INCREMENTAL",
    phase: "IMPLEMENTATION",
    phaseState: "DRAFT",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: ["src/message.txt"],
    lastCheckpointTag: null,
    approvalCount: 0,
    orchestratorSessionId: null,
    intentBaseline: null,
    modeDetectionNote: null,
    discoveryReport: null,
    currentTaskId: "T1",
    feedbackHistory: [],
    backtrackContext: null,
    implDag: [
      {
        id: "T1",
        description: "Update message",
        dependencies: [],
        expectedTests: [],
        expectedFiles: ["src/message.txt"],
        estimatedComplexity: "small",
        status: "in-flight",
      },
    ],
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    userGateMessageReceived: false,
    reviewArtifactHash: null,
    latestReviewResults: null,
    artifactDiskPaths: {},
    featureName: "patch-application",
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

async function servicesFor(state: WorkflowState) {
  const dbDir = await sharedPGliteDir()
  const repo = createPGliteOpenArtisanRepository({ connection: { dataDir: dbDir }, schemaName: nextSchemaName() })
  tempRepos.push(repo)
  const services = createOpenArtisanServices(repo)
  const workflowId = workflowDbId(state)
  const created = await services.workflow.createWorkflow({
    id: workflowId,
    featureName: state.featureName ?? state.sessionId,
    mode: state.mode ?? "GREENFIELD",
    phase: state.phase,
    phaseState: state.phaseState,
    createdAt: now(),
    updatedAt: now(),
  })
  expect(created.ok).toBe(true)
  return services
}

function suggestion(state: WorkflowState, overrides: Partial<DbPatchSuggestion> = {}): DbPatchSuggestion {
  return {
    id: "patch-1",
    workflowId: workflowDbId(state),
    targetPath: "src/message.txt",
    summary: "Update greeting",
    suggestedPatch: [
      "diff --git a/src/message.txt b/src/message.txt",
      "--- a/src/message.txt",
      "+++ b/src/message.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
    status: "pending",
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  }
}

describe("applyPatchSuggestionToWorktree", () => {
  it("extracts every path touched by a unified diff", () => {
    expect(extractPatchTouchedPaths([
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "diff --git a/src/b.txt b/src/b.txt",
      "--- a/src/b.txt",
      "+++ b/src/b.txt",
      "",
    ].join("\n"))).toEqual(["src/a.txt", "src/b.txt"])
  })

  it("applies a routed current-task patch and records an application", async () => {
    const cwd = await tempDir("oa-patch-worktree-")
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(join(cwd, "src", "message.txt"), "old\n", "utf-8")

    const state = makeState()
    const services = await servicesFor(state)
    expect((await services.patchSuggestions.recordSuggestion(suggestion(state))).ok).toBe(true)

    const result = await applyPatchSuggestionToWorktree({
      services,
      state,
      cwd,
      patchSuggestionId: "patch-1",
      appliedBy: "agent",
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(cwd, "src", "message.txt"), "utf-8")).toBe("new\n")
    expect(result.application?.result).toBe("applied")
    const pending = await services.patchSuggestions.listSuggestions(workflowDbId(state), "pending")
    expect(pending.ok && pending.value).toEqual([])
    const fastForwards = await services.fastForward.listFastForwards(workflowDbId(state))
    expect(fastForwards.ok && fastForwards.value.map((record) => record.patchSuggestionIds)).toEqual([["patch-1"]])
  })

  it("rejects non-current-task routes unless forced", async () => {
    const cwd = await tempDir("oa-patch-worktree-")
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(join(cwd, "src", "message.txt"), "old\n", "utf-8")

    const state = makeState({ currentTaskId: "T2" })
    const services = await servicesFor(state)
    expect((await services.patchSuggestions.recordSuggestion(suggestion(state))).ok).toBe(true)

    const result = await applyPatchSuggestionToWorktree({ services, state, cwd, patchSuggestionId: "patch-1" })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("Pass force=true")
    expect(await readFile(join(cwd, "src", "message.txt"), "utf-8")).toBe("old\n")
    const applications = await services.patchSuggestions.listApplications("patch-1")
    expect(applications.ok && applications.value).toEqual([])
  })

  it("rejects patches that touch files outside the current task route", async () => {
    const cwd = await tempDir("oa-patch-worktree-")
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(join(cwd, "src", "message.txt"), "old\n", "utf-8")
    await writeFile(join(cwd, "src", "other.txt"), "old\n", "utf-8")

    const state = makeState({ fileAllowlist: ["src/message.txt", "src/other.txt"] })
    const services = await servicesFor(state)
    expect((await services.patchSuggestions.recordSuggestion(suggestion(state, {
      suggestedPatch: [
        "diff --git a/src/message.txt b/src/message.txt",
        "--- a/src/message.txt",
        "+++ b/src/message.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/other.txt b/src/other.txt",
        "--- a/src/other.txt",
        "+++ b/src/other.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    }))).ok).toBe(true)

    const result = await applyPatchSuggestionToWorktree({ services, state, cwd, patchSuggestionId: "patch-1" })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("src/other.txt")
    expect(await readFile(join(cwd, "src", "message.txt"), "utf-8")).toBe("old\n")
    expect(await readFile(join(cwd, "src", "other.txt"), "utf-8")).toBe("old\n")
  })

  it("rejects suggestions whose metadata target is not touched by the patch", async () => {
    const cwd = await tempDir("oa-patch-worktree-")
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(join(cwd, "src", "message.txt"), "old\n", "utf-8")
    await writeFile(join(cwd, "src", "other.txt"), "old\n", "utf-8")

    const state = makeState({ fileAllowlist: ["src/message.txt", "src/other.txt"] })
    const services = await servicesFor(state)
    expect((await services.patchSuggestions.recordSuggestion(suggestion(state, {
      suggestedPatch: [
        "diff --git a/src/other.txt b/src/other.txt",
        "--- a/src/other.txt",
        "+++ b/src/other.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    }))).ok).toBe(true)

    const result = await applyPatchSuggestionToWorktree({ services, state, cwd, patchSuggestionId: "patch-1" })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("metadata target src/message.txt is not touched")
    expect(await readFile(join(cwd, "src", "message.txt"), "utf-8")).toBe("old\n")
    expect(await readFile(join(cwd, "src", "other.txt"), "utf-8")).toBe("old\n")
    const applications = await services.patchSuggestions.listApplications("patch-1")
    expect(applications.ok && applications.value).toEqual([])
  })

  it("records failed applications when git apply validation fails", async () => {
    const cwd = await tempDir("oa-patch-worktree-")
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(join(cwd, "src", "message.txt"), "old\n", "utf-8")

    const state = makeState()
    const services = await servicesFor(state)
    expect((await services.patchSuggestions.recordSuggestion(suggestion(state, {
      suggestedPatch: [
        "diff --git a/src/message.txt b/src/message.txt",
        "--- a/src/message.txt",
        "+++ b/src/message.txt",
        "@@ -1 +1 @@",
        "-missing",
        "+new",
        "",
      ].join("\n"),
    }))).ok).toBe(true)

    const result = await applyPatchSuggestionToWorktree({ services, state, cwd, patchSuggestionId: "patch-1", appliedBy: "orchestrator" })

    expect(result.ok).toBe(false)
    expect(result.application?.result).toBe("failed")
    expect(result.application?.appliedBy).toBe("orchestrator")
    expect(await readFile(join(cwd, "src", "message.txt"), "utf-8")).toBe("old\n")
    const applications = await services.patchSuggestions.listApplications("patch-1")
    expect(applications.ok && applications.value.map((application) => application.result)).toEqual(["failed"])
    const pending = await services.patchSuggestions.listSuggestions(workflowDbId(state), "pending")
    expect(pending.ok && pending.value.map((item) => item.id)).toEqual(["patch-1"])
  })
})
