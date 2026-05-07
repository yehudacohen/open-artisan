/**
 * open-artisan-repository-pglite.ts — PGlite-backed repository for the DB runtime.
 *
 * The live runtime can opt into this repository through the DB-backed
 * StateBackend facade while adapters continue to use the WorkflowState contract.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { join } from "node:path"

import { Kysely, type Selectable } from "kysely"

import { acquireDatabaseOperationLease, asDatabaseOperationLeaseDb, createDatabaseOperationLeaseOwner } from "./database-operation-lease"
import { createPGliteDatabaseHandle } from "./pglite-connection-manager"
import { ensureOpenArtisanSchema } from "./open-artisan-repository-migrations"
import type { PGliteAccessQueue } from "./pglite-access-queue"
import {
  DEFAULT_OPEN_ARTISAN_DB_FILE_NAME,
  DEFAULT_OPEN_ARTISAN_DB_SCHEMA,
  OPEN_ARTISAN_ROADMAP_DOCUMENT_SCHEMA_VERSION,
  type OpenArtisanDatabase,
} from "./open-artisan-repository-schema"
import { DB_OPERATION_LEASE_MS, DB_OPERATION_LEASE_POLL_MS, DB_OPERATION_LEASE_TIMEOUT_MS } from "./constants"
import {
  openArtisanDbError,
  openArtisanDbOk,
  type BoundaryChangeAnalysis,
  type BoundaryChangeInput,
  type DbAgentLease,
  type DbArtifact,
  type DbArtifactApproval,
  type DbArtifactRoadmapLink,
  type DbArtifactVersion,
  type DbExecutionSlice,
  type DbFastForwardRecord,
  type DbFileClaim,
  type DbHumanGate,
  type DbPatchApplication,
  type DbPatchSuggestion,
  type DbPhaseReview,
  type DbRecordId,
  type DbReviewObservation,
  type DbRoadmapEdge,
  type DbRoadmapItem,
  type DbTask,
  type DbTaskDependency,
  type DbTaskExpectedTest,
  type DbTaskGraph,
  type DbTaskOwnedFile,
  type DbTaskReview,
  type DbWorkflow,
  type DbWorkflowEvent,
  type DbWorkflowEventSource,
  type DbWorkflowRoadmapLink,
  type DbWorktreeObservation,
  type IsoTimestamp,
  type JsonWorkflowImportResult,
  type OpenArtisanDbResult,
  type OpenArtisanRepository,
  type OpenArtisanRepositoryLock,
  type OpenArtisanRepositoryLockOptions,
  type PatchSuggestionStatus,
  type WorkflowProjection,
} from "./open-artisan-repository"
import type { TaskStatus } from "./dag"
import { SCHEMA_VERSION, validateWorkflowState, type WorkflowState } from "./workflow-state-types"
import { VALID_PHASE_STATES, type ArtifactKey, type Phase, type PhaseState } from "./workflow-primitives"
import type { RoadmapDocument } from "./roadmap-types"

export { OPEN_ARTISAN_DB_SCHEMA_VERSION } from "./open-artisan-repository-migrations"
export {
  DEFAULT_OPEN_ARTISAN_DB_FILE_NAME,
  DEFAULT_OPEN_ARTISAN_DB_SCHEMA,
  OPEN_ARTISAN_DB_TABLES,
  OPEN_ARTISAN_ROADMAP_DOCUMENT_SCHEMA_VERSION,
} from "./open-artisan-repository-schema"

export interface OpenArtisanPGliteRepositoryOptions {
  connection: {
    dataDir: string
    databaseFileName?: string
    debugName?: string
  }
  schemaName?: string
  accessQueue?: PGliteAccessQueue
}

type DbExecutor = Kysely<OpenArtisanDatabase>

class TransactionRollback<T> extends Error {
  readonly result: OpenArtisanDbResult<T>

  constructor(result: OpenArtisanDbResult<T>) {
    super("Open Artisan transaction rolled back")
    this.name = "TransactionRollback"
    this.result = result
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function edgeKey(edge: DbRoadmapEdge): string {
  return `${edge.fromItemId}->${edge.toItemId}:${edge.kind}`
}

function dbFailure<T>(message: string, error: unknown): OpenArtisanDbResult<T> {
  return openArtisanDbError(
    "storage-failure",
    error instanceof Error ? `${message}: ${error.message}` : message,
    true,
  )
}

function notFound<T>(message: string): OpenArtisanDbResult<T> {
  return openArtisanDbError("not-found", message, false)
}

function invalidInput<T>(message: string): OpenArtisanDbResult<T> {
  return openArtisanDbError("invalid-input", message, false)
}

function invalidState<T>(message: string): OpenArtisanDbResult<T> {
  return openArtisanDbError("invalid-state", message, false)
}

function validateDbWorkflowInput<T>(workflow: DbWorkflow): OpenArtisanDbResult<T> | null {
  if (!workflow.id.trim()) return invalidInput("Workflow id is required")
  if (!workflow.featureName.trim()) return invalidInput("Workflow featureName is required")
  if (!workflow.createdAt.trim() || !workflow.updatedAt.trim()) return invalidInput("Workflow timestamps are required")
  if (!["GREENFIELD", "REFACTOR", "INCREMENTAL"].includes(workflow.mode)) return invalidInput(`Invalid workflow mode ${workflow.mode}`)
  if (!(workflow.phase in VALID_PHASE_STATES)) return invalidInput(`Invalid workflow phase ${workflow.phase}`)
  if (!VALID_PHASE_STATES[workflow.phase].includes(workflow.phaseState)) {
    return invalidInput(`Invalid workflow phase state ${workflow.phase}/${workflow.phaseState}`)
  }
  return null
}

function rowRecord<T>(row: { record: unknown }): T {
  return clone(row.record as T)
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function transitionEventId(workflowId: string, createdAt: string, fromPhase: Phase, fromPhaseState: PhaseState, toPhase: Phase, toPhaseState: PhaseState): string {
  return `${workflowId}:transition:${createdAt}:${fromPhase}/${fromPhaseState}:${toPhase}/${toPhaseState}`
}

function buildPhaseTransitionEvent(input: {
  workflowId: string
  previousWorkflow: DbWorkflow
  nextPhase: Phase
  nextPhaseState: PhaseState
  createdAt: string
  reason: string
  source: DbWorkflowEventSource
}): DbWorkflowEvent {
  return {
    id: transitionEventId(
      input.workflowId,
      input.createdAt,
      input.previousWorkflow.phase,
      input.previousWorkflow.phaseState,
      input.nextPhase,
      input.nextPhaseState,
    ),
    workflowId: input.workflowId,
    event: "phase_transition",
    fromPhase: input.previousWorkflow.phase,
    fromPhaseState: input.previousWorkflow.phaseState,
    toPhase: input.nextPhase,
    toPhaseState: input.nextPhaseState,
    reason: input.reason,
    createdAt: input.createdAt,
    metadata: { source: input.source },
  }
}

function freshWorkflowState(sessionId: string): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    mode: null,
    phase: "MODE_SELECT",
    phaseState: "DRAFT",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    approvedArtifactFiles: {},
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
    backtrackContext: null,
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
  }
}

function buildImportedTaskGraph(state: WorkflowState, workflowId: string): DbTaskGraph | null {
  if (!state.implDag || state.implDag.length === 0) return null
  return {
    tasks: state.implDag.map((task) => ({
      id: `${workflowId}:${task.id}`,
      workflowId,
      taskKey: task.id,
      description: task.description,
      status: task.status,
      category: task.category ?? "standalone",
      complexity: task.estimatedComplexity,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })),
    dependencies: state.implDag.flatMap((task) =>
      task.dependencies.map((dependency) => ({
        workflowId,
        fromTaskId: `${workflowId}:${dependency}`,
        toTaskId: `${workflowId}:${task.id}`,
      })),
    ),
    ownedFiles: state.implDag.flatMap((task) =>
      task.expectedFiles.map((path) => ({ taskId: `${workflowId}:${task.id}`, path })),
    ),
    expectedTests: state.implDag.flatMap((task) =>
      task.expectedTests.map((path) => ({ taskId: `${workflowId}:${task.id}`, path })),
    ),
    roadmapLinks: [],
  }
}

function findTaskGraphCycle(graph: DbTaskGraph): string | null {
  const taskIds = new Set(graph.tasks.map((task) => task.id))
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const taskId of taskIds) {
    indegree.set(taskId, 0)
    outgoing.set(taskId, [])
  }
  for (const dependency of graph.dependencies) {
    if (!taskIds.has(dependency.fromTaskId) || !taskIds.has(dependency.toTaskId)) continue
    outgoing.get(dependency.fromTaskId)?.push(dependency.toTaskId)
    indegree.set(dependency.toTaskId, (indegree.get(dependency.toTaskId) ?? 0) + 1)
  }

  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([taskId]) => taskId)
  let visited = 0
  while (ready.length > 0) {
    const taskId = ready.shift()!
    visited++
    for (const next of outgoing.get(taskId) ?? []) {
      const nextCount = (indegree.get(next) ?? 0) - 1
      indegree.set(next, nextCount)
      if (nextCount === 0) ready.push(next)
    }
  }

  if (visited === taskIds.size) return null
  return [...indegree.entries()].filter(([, count]) => count > 0).map(([taskId]) => taskId).join(", ")
}

export function createPGliteOpenArtisanRepository(
  options: OpenArtisanPGliteRepositoryOptions,
): OpenArtisanRepository {
  const schemaName = options.schemaName ?? DEFAULT_OPEN_ARTISAN_DB_SCHEMA
  const dbPath = options.connection.databaseFileName
    ? join(options.connection.dataDir, options.connection.databaseFileName)
    : join(options.connection.dataDir, DEFAULT_OPEN_ARTISAN_DB_FILE_NAME)
  const transactionStorage = new AsyncLocalStorage<DbExecutor>()
  const leaseOwnerId = createDatabaseOperationLeaseOwner("open-artisan-repository")
  const dbHandle = createPGliteDatabaseHandle<OpenArtisanDatabase>({
    databasePath: dbPath,
    ...(options.accessQueue ? { accessQueue: options.accessQueue } : {}),
  })
  let initializedPromise: Promise<void> | null = null

  async function withDb<T>(label: string, run: (db: DbExecutor) => Promise<T>): Promise<T> {
    return dbHandle.run(run, label)
  }

  async function initializeSchema(db: DbExecutor): Promise<void> {
    await ensureOpenArtisanSchema({ db, databasePath: dbPath, schemaName })
  }

  async function ensureInitialized(db: DbExecutor): Promise<void> {
    if (!initializedPromise) {
      initializedPromise = initializeSchema(db).catch((error) => {
        initializedPromise = null
        throw error
      })
    }
    await initializedPromise
  }

  async function withTransaction<T>(db: DbExecutor, run: (tx: DbExecutor) => Promise<OpenArtisanDbResult<T>>): Promise<OpenArtisanDbResult<T>> {
    const activeTransaction = transactionStorage.getStore()
    if (activeTransaction) return run(activeTransaction)
    try {
      return await db.transaction().execute(async (tx) => {
        const result = await transactionStorage.run(tx as unknown as DbExecutor, () => run(tx as unknown as DbExecutor))
        if (!result.ok) throw new TransactionRollback(result)
        return result
      })
    } catch (error) {
      if (error instanceof TransactionRollback) return error.result as OpenArtisanDbResult<T>
      throw error
    }
  }

  function startQueuedLeaseRenewal(input: { leaseKey: string; ownerId: string; leaseMs: number; intervalMs: number }): () => void {
    const timer = setInterval(() => {
      const now = new Date().toISOString()
      const leaseExpiresAt = new Date(Date.now() + input.leaseMs).toISOString()
      void withDb("openartisan.renewRepositoryLock", async (db) => {
        await db.withSchema(schemaName)
          .updateTable("database_operation_locks")
          .set({ lease_expires_at: leaseExpiresAt, updated_at: now })
          .where("lock_key", "=", input.leaseKey)
          .where("owner_id", "=", input.ownerId)
          .execute()
      }).catch(() => {
        // Best-effort renewal. Release or expiry will let another owner proceed.
      })
    }, input.intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  async function acquireRepositoryLock(
    leaseKey: string,
    options: OpenArtisanRepositoryLockOptions = {},
  ): Promise<OpenArtisanDbResult<OpenArtisanRepositoryLock>> {
    const timeoutMs = options.timeoutMs ?? DB_OPERATION_LEASE_TIMEOUT_MS
    const pollMs = options.pollMs ?? DB_OPERATION_LEASE_POLL_MS
    const leaseMs = options.leaseMs ?? DB_OPERATION_LEASE_MS
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = null

    while (true) {
      try {
        return await withDb("openartisan.acquireRepositoryLock", async (db) => {
          await ensureInitialized(db)
          const lease = await acquireDatabaseOperationLease(asDatabaseOperationLeaseDb(db), schemaName, {
            leaseKey,
            ownerId: leaseOwnerId,
            timeoutMs: 0,
            pollMs: 0,
            leaseMs,
            renew: startQueuedLeaseRenewal,
          })
          return openArtisanDbOk({
            release: () => withDb("openartisan.releaseRepositoryLock", async () => {
              await lease.release()
            }),
          })
        })
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes("Timed out acquiring DB operation lease")) {
          return dbFailure(`Open Artisan DB lock acquisition failed for ${leaseKey}`, error)
        }
      }

      if (Date.now() >= deadline) {
        const suffix = lastError instanceof Error ? ` ${lastError.message}` : ""
        return openArtisanDbError("lock-timeout", `Timed out acquiring DB operation lease ${leaseKey}.${suffix}`, true)
      }
      await sleep(pollMs)
    }
  }

  async function withInitializedDb<T>(run: (db: DbExecutor) => Promise<OpenArtisanDbResult<T>>): Promise<OpenArtisanDbResult<T>> {
    const activeTransaction = transactionStorage.getStore()
    if (activeTransaction) {
      try {
        return await run(activeTransaction)
      } catch (error) {
        return dbFailure("Open Artisan DB transaction operation failed", error)
      }
    }

    try {
      return await withDb("openartisan.withInitializedDb", async (db) => {
        await ensureInitialized(db)
        const lease = await acquireDatabaseOperationLease(asDatabaseOperationLeaseDb(db), schemaName, {
          leaseKey: "open-artisan:repository-operation",
          ownerId: leaseOwnerId,
          renew: startQueuedLeaseRenewal,
        })
        try {
          return await run(db)
        } finally {
          await lease.release()
        }
      })
    } catch (error) {
      return dbFailure("Open Artisan DB operation failed", error)
    }
  }

  async function loadTaskGraph(db: DbExecutor, workflowId: string): Promise<DbTaskGraph | null> {
    const schemaDb = db.withSchema(schemaName)
    const taskRows = await schemaDb.selectFrom("tasks").selectAll().where("workflow_id", "=", workflowId).execute()
    if (taskRows.length === 0) return null
    const taskIds = taskRows.map((row) => row.id)
    const dependencies = await schemaDb.selectFrom("task_dependencies").selectAll().where("workflow_id", "=", workflowId).execute()
    const ownedFiles = await schemaDb.selectFrom("task_owned_files").selectAll().where("task_id", "in", taskIds).execute()
    const expectedTests = await schemaDb.selectFrom("task_expected_tests").selectAll().where("task_id", "in", taskIds).execute()
    const roadmapLinks = await schemaDb.selectFrom("task_roadmap_links").selectAll().where("task_id", "in", taskIds).execute()
    return {
      tasks: taskRows.map((row) => rowRecord<DbTask>(row)),
      dependencies: dependencies.map((row) => ({
        workflowId: row.workflow_id,
        fromTaskId: row.from_task_id,
        toTaskId: row.to_task_id,
      })),
      ownedFiles: ownedFiles.map((row) => ({ taskId: row.task_id, path: row.path })),
      expectedTests: expectedTests.map((row) => ({ taskId: row.task_id, path: row.path })),
      roadmapLinks: roadmapLinks.map((row) => ({ taskId: row.task_id, roadmapItemId: row.roadmap_item_id })),
    }
  }

  async function loadProjection(db: DbExecutor, workflowRow: Selectable<OpenArtisanDatabase["workflows"]>): Promise<WorkflowProjection> {
    const schemaDb = db.withSchema(schemaName)
    const artifacts = await schemaDb.selectFrom("artifacts").selectAll().where("workflow_id", "=", workflowRow.id).execute()
    const roadmapLinks = await schemaDb.selectFrom("workflow_roadmap_links").selectAll().where("workflow_id", "=", workflowRow.id).execute()
    const gates = await schemaDb
      .selectFrom("human_gates")
      .selectAll()
      .where("workflow_id", "=", workflowRow.id)
      .where("resolved", "=", false)
      .execute()
    const patches = await schemaDb
      .selectFrom("patch_suggestions")
      .selectAll()
      .where("workflow_id", "=", workflowRow.id)
      .where("status", "=", "pending")
      .execute()
    return {
      workflow: rowRecord<DbWorkflow>(workflowRow),
      roadmapItemIds: roadmapLinks.map((row) => row.roadmap_item_id),
      artifacts: artifacts.map((row) => rowRecord<DbArtifact>(row)),
      taskGraph: await loadTaskGraph(db, workflowRow.id),
      unresolvedHumanGates: gates.map((row) => rowRecord<DbHumanGate>(row)),
      pendingPatchSuggestions: patches.map((row) => rowRecord<DbPatchSuggestion>(row)),
    }
  }

  async function replaceTaskGraphInDb(db: DbExecutor, workflowId: string, graph: DbTaskGraph): Promise<OpenArtisanDbResult<DbTaskGraph>> {
    const schemaDb = db.withSchema(schemaName)
    const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", workflowId).executeTakeFirst()
    if (!workflow) return notFound(`Workflow ${workflowId} was not found`)

    const taskIds = new Set<string>()
    for (const task of graph.tasks) {
      if (task.workflowId !== workflowId) return invalidInput(`Task ${task.id} belongs to workflow ${task.workflowId}, not ${workflowId}`)
      if (taskIds.has(task.id)) return invalidInput(`Task graph contains duplicate task id ${task.id}`)
      taskIds.add(task.id)
    }
    for (const dependency of graph.dependencies) {
      if (dependency.workflowId !== workflowId) return invalidInput(`Task dependency belongs to workflow ${dependency.workflowId}, not ${workflowId}`)
      if (!taskIds.has(dependency.fromTaskId)) return invalidInput(`Task dependency references missing task ${dependency.fromTaskId}`)
      if (!taskIds.has(dependency.toTaskId)) return invalidInput(`Task dependency references missing task ${dependency.toTaskId}`)
    }
    for (const file of graph.ownedFiles) {
      if (!taskIds.has(file.taskId)) return invalidInput(`Task owned file references missing task ${file.taskId}`)
    }
    for (const test of graph.expectedTests) {
      if (!taskIds.has(test.taskId)) return invalidInput(`Task expected test references missing task ${test.taskId}`)
    }
    for (const link of graph.roadmapLinks) {
      if (!taskIds.has(link.taskId)) return invalidInput(`Task roadmap link references missing task ${link.taskId}`)
    }
    const cycleTaskIds = findTaskGraphCycle(graph)
    if (cycleTaskIds) return invalidInput(`Task graph contains a cycle involving: ${cycleTaskIds}`)
    const roadmapItemIds = unique(graph.roadmapLinks.map((link) => link.roadmapItemId))
    if (roadmapItemIds.length > 0) {
      const roadmapRows = await schemaDb.selectFrom("roadmap_items").select("id").where("id", "in", roadmapItemIds).execute()
      const existingRoadmapItemIds = new Set(roadmapRows.map((row) => row.id))
      const missingRoadmapItemId = roadmapItemIds.find((id) => !existingRoadmapItemIds.has(id))
      if (missingRoadmapItemId) return notFound(`Roadmap item ${missingRoadmapItemId} was not found`)
    }

    await schemaDb.deleteFrom("task_roadmap_links").where("task_id", "in", (eb) => eb.selectFrom("tasks").select("id").where("workflow_id", "=", workflowId)).execute()
    await schemaDb.deleteFrom("task_expected_tests").where("task_id", "in", (eb) => eb.selectFrom("tasks").select("id").where("workflow_id", "=", workflowId)).execute()
    await schemaDb.deleteFrom("task_owned_files").where("task_id", "in", (eb) => eb.selectFrom("tasks").select("id").where("workflow_id", "=", workflowId)).execute()
    await schemaDb.deleteFrom("task_dependencies").where("workflow_id", "=", workflowId).execute()
    await schemaDb.deleteFrom("tasks").where("workflow_id", "=", workflowId).execute()

    if (graph.tasks.length > 0) {
      await schemaDb.insertInto("tasks").values(graph.tasks.map((task) => ({
        id: task.id,
        workflow_id: workflowId,
        task_key: task.taskKey,
        status: task.status,
        record: clone(task),
        created_at: task.createdAt,
        updated_at: task.updatedAt,
      }))).execute()
    }
    if (graph.dependencies.length > 0) {
      await schemaDb.insertInto("task_dependencies").values(graph.dependencies.map((dependency) => ({
        workflow_id: workflowId,
        from_task_id: dependency.fromTaskId,
        to_task_id: dependency.toTaskId,
      }))).execute()
    }
    if (graph.ownedFiles.length > 0) {
      await schemaDb.insertInto("task_owned_files").values(graph.ownedFiles.map((file) => ({
        task_id: file.taskId,
        path: file.path,
      }))).execute()
    }
    if (graph.expectedTests.length > 0) {
      await schemaDb.insertInto("task_expected_tests").values(graph.expectedTests.map((test) => ({
        task_id: test.taskId,
        path: test.path,
      }))).execute()
    }
    if (graph.roadmapLinks.length > 0) {
      await schemaDb.insertInto("task_roadmap_links").values(graph.roadmapLinks.map((link) => ({
        task_id: link.taskId,
        roadmap_item_id: link.roadmapItemId,
      }))).execute()
    }
    return openArtisanDbOk(clone(graph))
  }

  async function analyzeBoundaryChangeInDb(db: DbExecutor, input: BoundaryChangeInput): Promise<OpenArtisanDbResult<BoundaryChangeAnalysis>> {
    const graph = await loadTaskGraph(db, input.workflowId)
    if (!graph) return notFound(`Workflow ${input.workflowId} has no task graph`)
    const task = graph.tasks.find((candidate) => candidate.id === input.taskId || candidate.taskKey === input.taskId)
    if (!task) return notFound(`Task ${input.taskId} was not found`)
    const taskId = task.id
    const addFiles = input.addFiles ?? []
    const ownershipConflicts = graph.ownedFiles
      .filter((file) => addFiles.includes(file.path) && file.taskId !== taskId)
      .map((file) => `${file.path} already owned by ${file.taskId}`)
    const impactedTaskIds = unique([taskId, ...graph.ownedFiles.filter((file) => addFiles.includes(file.path)).map((file) => file.taskId)])
    const completedTaskIdsToReset = graph.tasks
      .filter((candidate) => impactedTaskIds.includes(candidate.id) && candidate.status === "complete")
      .map((candidate) => candidate.id)
    return openArtisanDbOk({
      taskId,
      impactedTaskIds,
      completedTaskIdsToReset,
      ownershipConflicts,
      allowlistViolations: [],
      message: ownershipConflicts.length > 0
        ? `Boundary change affects ${impactedTaskIds.length} task(s) and has ownership conflicts.`
        : `Boundary change affects ${impactedTaskIds.length} task(s).`,
    })
  }

  async function declareHumanGateInDb(db: DbExecutor, gate: DbHumanGate): Promise<OpenArtisanDbResult<DbHumanGate>> {
    const schemaDb = db.withSchema(schemaName)
    const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", gate.workflowId).executeTakeFirst()
    if (!workflow) return notFound(`Workflow ${gate.workflowId} was not found`)
    const taskRow = await schemaDb.selectFrom("tasks").selectAll().where("id", "=", gate.taskId).where("workflow_id", "=", gate.workflowId).executeTakeFirst()
    if (!taskRow) return notFound(`Task ${gate.taskId} was not found`)
    const currentTask = rowRecord<DbTask>(taskRow)
    if (currentTask.category !== "human-gate") {
      return invalidState(`Task ${gate.taskId} has category ${currentTask.category}; only human-gate tasks can be declared as human gates`)
    }
    await schemaDb.insertInto("human_gates").values({
      id: gate.id,
      workflow_id: gate.workflowId,
      task_id: gate.taskId,
      resolved: gate.resolved,
      record: clone(gate),
      created_at: gate.createdAt,
      resolved_at: gate.resolvedAt ?? null,
    }).execute()
    if (!gate.resolved) {
      const task = { ...currentTask, status: "human-gated" as const, updatedAt: nowIso() }
      await schemaDb.updateTable("tasks").set({ status: task.status, record: clone(task), updated_at: task.updatedAt }).where("id", "=", task.id).execute()
    }
    return openArtisanDbOk(clone(gate))
  }

  const repo: OpenArtisanRepository = {
    initialize() {
      return withInitializedDb(async () => openArtisanDbOk(null))
    },

    dispose() {
      return (async () => {
        initializedPromise = null
        await dbHandle.dispose()
      })()
    },

    transaction<T>(run: (repository: OpenArtisanRepository) => Promise<OpenArtisanDbResult<T>>) {
      return withInitializedDb(async (db) => {
        let rollbackResult: OpenArtisanDbResult<T> | null = null
        try {
          return await db.transaction().execute(async (tx) => {
            return transactionStorage.run(tx as unknown as DbExecutor, async () => {
              const result = await run(repo)
              if (!result.ok) {
                rollbackResult = result
                throw new Error("OPEN_ARTISAN_TRANSACTION_ROLLBACK")
              }
              return result
            })
          })
        } catch (error) {
          if (rollbackResult) return rollbackResult
          throw error
        }
      })
    },

    lockWorkflowState(featureName, options) {
      return acquireRepositoryLock(`workflow-state:${featureName}`, options)
    },

    lockRoadmap(options) {
      return acquireRepositoryLock("roadmap:document", options)
    },

    createRoadmapItem(item: DbRoadmapItem) {
      return withInitializedDb(async (db) => {
        await db.withSchema(schemaName).insertInto("roadmap_items").values({
          id: item.id,
          feature_name: item.featureName ?? null,
          status: item.status,
          priority: item.priority,
          record: clone(item),
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        }).execute()
        return openArtisanDbOk(clone(item))
      })
    },

    replaceRoadmap(document: RoadmapDocument) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const itemIds = new Set(document.items.map((item) => item.id))
        for (const edge of document.edges) {
          if (!itemIds.has(edge.from)) return invalidInput(`Roadmap edge references missing item ${edge.from}`)
          if (!itemIds.has(edge.to)) return invalidInput(`Roadmap edge references missing item ${edge.to}`)
        }
        await schemaDb.deleteFrom("workflow_roadmap_links").execute()
        await schemaDb.deleteFrom("artifact_roadmap_links").execute()
        await schemaDb.deleteFrom("task_roadmap_links").execute()
        await schemaDb.deleteFrom("execution_slice_items").execute()
        await schemaDb.deleteFrom("roadmap_edges").execute()
        await schemaDb.deleteFrom("roadmap_items").execute()
        if (document.items.length > 0) {
          await schemaDb.insertInto("roadmap_items").values(document.items.map((item) => ({
            id: item.id,
            feature_name: item.featureName ?? null,
            status: item.status,
            priority: item.priority,
            record: clone(item),
            created_at: item.createdAt,
            updated_at: item.updatedAt,
          }))).execute()
        }
        if (document.edges.length > 0) {
          await schemaDb.insertInto("roadmap_edges").values(document.edges.map((edge) => ({
            edge_key: `${edge.from}->${edge.to}:${edge.kind}`,
            from_item_id: edge.from,
            to_item_id: edge.to,
            kind: edge.kind,
            record: clone({ fromItemId: edge.from, toItemId: edge.to, kind: edge.kind } satisfies DbRoadmapEdge),
          }))).execute()
        }
        return openArtisanDbOk(clone(document))
        })
      })
    },

    readRoadmap() {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const itemRows = await schemaDb.selectFrom("roadmap_items").selectAll().execute()
        const edgeRows = await schemaDb.selectFrom("roadmap_edges").selectAll().execute()
        if (itemRows.length === 0 && edgeRows.length === 0) return openArtisanDbOk(null)
        const document: RoadmapDocument = {
          schemaVersion: OPEN_ARTISAN_ROADMAP_DOCUMENT_SCHEMA_VERSION,
          items: itemRows.map((row) => rowRecord<DbRoadmapItem>(row)).map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            ...(item.description ? { description: item.description } : {}),
            status: item.status,
            priority: item.priority,
            ...(item.featureName ? { featureName: item.featureName } : {}),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
          edges: edgeRows.map((row) => rowRecord<DbRoadmapEdge>(row)).map((edge) => ({
            from: edge.fromItemId,
            to: edge.toItemId,
            kind: edge.kind,
          })),
        }
        return openArtisanDbOk(document)
      })
    },

    deleteRoadmap() {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        await schemaDb.deleteFrom("workflow_roadmap_links").execute()
        await schemaDb.deleteFrom("artifact_roadmap_links").execute()
        await schemaDb.deleteFrom("task_roadmap_links").execute()
        await schemaDb.deleteFrom("execution_slice_items").execute()
        await schemaDb.deleteFrom("roadmap_edges").execute()
        await schemaDb.deleteFrom("roadmap_items").execute()
        return openArtisanDbOk(null)
        })
      })
    },

    listRoadmapItems(query = {}) {
      return withInitializedDb(async (db) => {
        let builder = db.withSchema(schemaName).selectFrom("roadmap_items").selectAll()
        if (query.featureName !== undefined) {
          builder = query.featureName === null
            ? builder.where("feature_name", "is", null)
            : builder.where("feature_name", "=", query.featureName)
        }
        if (query.status !== undefined) builder = builder.where("status", "=", query.status)
        const rows = await builder.execute()
        const items = rows.map((row) => rowRecord<DbRoadmapItem>(row))
        return openArtisanDbOk(items)
      })
    },

    upsertRoadmapEdge(edge: DbRoadmapEdge) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const itemRows = await schemaDb.selectFrom("roadmap_items").select("id").where("id", "in", [edge.fromItemId, edge.toItemId]).execute()
        const itemIds = new Set(itemRows.map((row) => row.id))
        if (!itemIds.has(edge.fromItemId)) return notFound(`Roadmap item ${edge.fromItemId} was not found`)
        if (!itemIds.has(edge.toItemId)) return notFound(`Roadmap item ${edge.toItemId} was not found`)
        const key = edgeKey(edge)
        await schemaDb.deleteFrom("roadmap_edges").where("edge_key", "=", key).execute()
        await schemaDb.insertInto("roadmap_edges").values({
          edge_key: key,
          from_item_id: edge.fromItemId,
          to_item_id: edge.toItemId,
          kind: edge.kind,
          record: clone(edge),
        }).execute()
        return openArtisanDbOk(clone(edge))
        })
      })
    },

    listRoadmapEdges(itemId?: DbRecordId) {
      return withInitializedDb(async (db) => {
        let builder = db.withSchema(schemaName).selectFrom("roadmap_edges").selectAll()
        if (itemId !== undefined) {
          builder = builder.where((eb) => eb.or([
            eb("from_item_id", "=", itemId),
            eb("to_item_id", "=", itemId),
          ]))
        }
        const rows = await builder.execute()
        const edges = rows.map((row) => rowRecord<DbRoadmapEdge>(row))
        return openArtisanDbOk(edges)
      })
    },

    createExecutionSlice(slice: DbExecutionSlice, itemIds: DbRecordId[]) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const uniqueItemIds = unique(itemIds)
        if (uniqueItemIds.length > 0) {
          const itemRows = await schemaDb.selectFrom("roadmap_items").select("id").where("id", "in", uniqueItemIds).execute()
          const existingItemIds = new Set(itemRows.map((row) => row.id))
          const missingItemId = uniqueItemIds.find((id) => !existingItemIds.has(id))
          if (missingItemId) return notFound(`Roadmap item ${missingItemId} was not found`)
        }
        await schemaDb.insertInto("execution_slices").values({
          id: slice.id,
          feature_name: slice.featureName ?? null,
          status: slice.status,
          record: clone(slice),
          created_at: slice.createdAt,
          updated_at: slice.updatedAt,
        }).execute()
        if (uniqueItemIds.length > 0) {
          await schemaDb.insertInto("execution_slice_items").values(uniqueItemIds.map((itemId) => ({
            slice_id: slice.id,
            roadmap_item_id: itemId,
          }))).execute()
        }
        return openArtisanDbOk(clone(slice))
        })
      })
    },

    getExecutionSlice(sliceId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const row = await schemaDb.selectFrom("execution_slices").selectAll().where("id", "=", sliceId).executeTakeFirst()
        if (!row) return openArtisanDbOk(null)
        const links = await schemaDb.selectFrom("execution_slice_items").selectAll().where("slice_id", "=", sliceId).execute()
        return openArtisanDbOk({ slice: rowRecord<DbExecutionSlice>(row), itemIds: links.map((link) => link.roadmap_item_id) })
      })
    },

    createWorkflow(workflow: DbWorkflow) {
      const validationError = validateDbWorkflowInput<DbWorkflow>(workflow)
      if (validationError) return Promise.resolve(validationError)
      return withInitializedDb(async (db) => {
        await db.withSchema(schemaName).insertInto("workflows").values({
          id: workflow.id,
          feature_name: workflow.featureName,
          mode: workflow.mode,
          phase: workflow.phase,
          phase_state: workflow.phaseState,
          record: clone(workflow),
          state_snapshot: null,
          created_at: workflow.createdAt,
          updated_at: workflow.updatedAt,
        }).execute()
        return openArtisanDbOk(clone(workflow))
      })
    },

    listWorkflows() {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("workflows").selectAll().execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbWorkflow>(row)))
      })
    },

    getWorkflow(workflowId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const row = await db.withSchema(schemaName).selectFrom("workflows").selectAll().where("id", "=", workflowId).executeTakeFirst()
        return openArtisanDbOk(row ? await loadProjection(db, row) : null)
      })
    },

    getWorkflowByFeature(featureName: string) {
      return withInitializedDb(async (db) => {
        const row = await db.withSchema(schemaName).selectFrom("workflows").selectAll().where("feature_name", "=", featureName).executeTakeFirst()
        return openArtisanDbOk(row ? await loadProjection(db, row) : null)
      })
    },

    setWorkflowPhase(workflowId: DbRecordId, phase: Phase, phaseState: PhaseState) {
      if (!(phase in VALID_PHASE_STATES) || !VALID_PHASE_STATES[phase].includes(phaseState)) {
        return Promise.resolve(invalidInput<DbWorkflow>(`Invalid workflow phase state ${phase}/${phaseState}`))
      }
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const row = await schemaDb.selectFrom("workflows").selectAll().where("id", "=", workflowId).executeTakeFirst()
        if (!row) return notFound(`Workflow ${workflowId} was not found`)
        const previousWorkflow = rowRecord<DbWorkflow>(row)
        const updatedAt = nowIso()
        const workflow = { ...previousWorkflow, phase, phaseState, updatedAt }
        await schemaDb.updateTable("workflows").set({
          phase,
          phase_state: phaseState,
          record: clone(workflow),
          updated_at: workflow.updatedAt,
        }).where("id", "=", workflowId).execute()
        if (previousWorkflow.phase !== phase || previousWorkflow.phaseState !== phaseState) {
          const event = buildPhaseTransitionEvent({
            workflowId,
            previousWorkflow,
            nextPhase: phase,
            nextPhaseState: phaseState,
            reason: "setWorkflowPhase",
            createdAt: updatedAt,
            source: "repository-api",
          })
          await schemaDb.insertInto("workflow_events").values({
            id: event.id,
            workflow_id: event.workflowId,
            created_at: event.createdAt,
            record: clone(event),
          }).execute()
        }
        return openArtisanDbOk(workflow)
        })
      })
    },

    deleteWorkflow(workflowId: DbRecordId) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const taskRows = await schemaDb.selectFrom("tasks").select("id").where("workflow_id", "=", workflowId).execute()
        const taskIds = taskRows.map((task) => task.id)
        if (taskIds.length > 0) {
          await schemaDb.deleteFrom("task_roadmap_links").where("task_id", "in", taskIds).execute()
          await schemaDb.deleteFrom("task_expected_tests").where("task_id", "in", taskIds).execute()
          await schemaDb.deleteFrom("task_owned_files").where("task_id", "in", taskIds).execute()
        }
        const artifactRows = await schemaDb.selectFrom("artifacts").select("id").where("workflow_id", "=", workflowId).execute()
        const artifactIds = artifactRows.map((artifact) => artifact.id)
        if (artifactIds.length > 0) {
          const versionRows = await schemaDb.selectFrom("artifact_versions").select("id").where("artifact_id", "in", artifactIds).execute()
          const versionIds = versionRows.map((version) => version.id)
          if (versionIds.length > 0) await schemaDb.deleteFrom("artifact_approvals").where("artifact_version_id", "in", versionIds).execute()
          await schemaDb.deleteFrom("artifact_versions").where("artifact_id", "in", artifactIds).execute()
          await schemaDb.deleteFrom("artifact_roadmap_links").where("artifact_id", "in", artifactIds).execute()
        }
        const leaseRows = await schemaDb.selectFrom("agent_leases").select("id").where("workflow_id", "=", workflowId).execute()
        const leaseIds = leaseRows.map((lease) => lease.id)
        if (leaseIds.length > 0) await schemaDb.deleteFrom("file_claims").where("agent_lease_id", "in", leaseIds).execute()
        const taskReviewRows = await schemaDb.selectFrom("task_reviews").select("id").where("workflow_id", "=", workflowId).execute()
        const phaseReviewRows = await schemaDb.selectFrom("phase_reviews").select("id").where("workflow_id", "=", workflowId).execute()
        const reviewIds = [...taskReviewRows.map((review) => review.id), ...phaseReviewRows.map((review) => review.id)]
        if (reviewIds.length > 0) await schemaDb.deleteFrom("review_observations").where("review_id", "in", reviewIds).execute()
        const patchRows = await schemaDb.selectFrom("patch_suggestions").select("id").where("workflow_id", "=", workflowId).execute()
        const patchIds = patchRows.map((patch) => patch.id)
        if (patchIds.length > 0) await schemaDb.deleteFrom("patch_applications").where("patch_suggestion_id", "in", patchIds).execute()
        await schemaDb.deleteFrom("workflow_roadmap_links").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("workflow_events").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("task_dependencies").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("tasks").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("artifacts").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("task_reviews").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("phase_reviews").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("patch_suggestions").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("agent_leases").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("worktree_observations").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("human_gates").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("fast_forward_records").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("workflows").where("id", "=", workflowId).execute()
        return openArtisanDbOk(null)
        })
      })
    },

    appendWorkflowEvent(event: DbWorkflowEvent) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", event.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${event.workflowId} was not found`)
        await schemaDb.insertInto("workflow_events").values({
          id: event.id,
          workflow_id: event.workflowId,
          created_at: event.createdAt,
          record: clone(event),
        }).execute()
        return openArtisanDbOk(clone(event))
      })
    },

    listWorkflowEvents(workflowId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("workflow_events").selectAll().where("workflow_id", "=", workflowId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbWorkflowEvent>(row)))
      })
    },

    linkWorkflowToRoadmap(workflowId: DbRecordId, roadmapItemId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${workflowId} was not found`)
        const roadmapItem = await schemaDb.selectFrom("roadmap_items").select("id").where("id", "=", roadmapItemId).executeTakeFirst()
        if (!roadmapItem) return notFound(`Roadmap item ${roadmapItemId} was not found`)
        await schemaDb.insertInto("workflow_roadmap_links").values({
          workflow_id: workflowId,
          roadmap_item_id: roadmapItemId,
        }).onConflict((oc) => oc.columns(["workflow_id", "roadmap_item_id"]).doNothing()).execute()
        return openArtisanDbOk({ workflowId, roadmapItemId } satisfies DbWorkflowRoadmapLink)
      })
    },

    upsertArtifact(artifact: DbArtifact) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", artifact.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${artifact.workflowId} was not found`)
        await schemaDb.insertInto("artifacts").values({
          id: artifact.id,
          workflow_id: artifact.workflowId,
          artifact_key: artifact.artifactKey,
          current_version_id: artifact.currentVersionId ?? null,
          record: clone(artifact),
          created_at: artifact.createdAt,
          updated_at: artifact.updatedAt,
        }).onConflict((oc) => oc.column("id").doUpdateSet({
          workflow_id: artifact.workflowId,
          artifact_key: artifact.artifactKey,
          current_version_id: artifact.currentVersionId ?? null,
          record: clone(artifact),
          updated_at: artifact.updatedAt,
        })).execute()
        return openArtisanDbOk(clone(artifact))
      })
    },

    recordArtifactVersion(version: DbArtifactVersion) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const artifact = await schemaDb.selectFrom("artifacts").selectAll().where("id", "=", version.artifactId).executeTakeFirst()
        if (!artifact) return notFound(`Artifact ${version.artifactId} was not found`)
        await schemaDb.insertInto("artifact_versions").values({
          id: version.id,
          artifact_id: version.artifactId,
          content_hash: version.contentHash,
          record: clone(version),
          created_at: version.createdAt,
        }).execute()
        const updatedArtifact = { ...rowRecord<DbArtifact>(artifact), currentVersionId: version.id, updatedAt: nowIso() }
        await schemaDb.updateTable("artifacts").set({
          current_version_id: version.id,
          record: clone(updatedArtifact),
          updated_at: updatedArtifact.updatedAt,
        }).where("id", "=", version.artifactId).execute()
        return openArtisanDbOk(clone(version))
        })
      })
    },

    listArtifactVersions(artifactId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("artifact_versions").selectAll().where("artifact_id", "=", artifactId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbArtifactVersion>(row)))
      })
    },

    listArtifactApprovals(artifactVersionId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("artifact_approvals").selectAll().where("artifact_version_id", "=", artifactVersionId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbArtifactApproval>(row)))
      })
    },

    linkArtifactToRoadmap(artifactId: DbRecordId, roadmapItemId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const artifact = await schemaDb.selectFrom("artifacts").select("id").where("id", "=", artifactId).executeTakeFirst()
        if (!artifact) return notFound(`Artifact ${artifactId} was not found`)
        const roadmapItem = await schemaDb.selectFrom("roadmap_items").select("id").where("id", "=", roadmapItemId).executeTakeFirst()
        if (!roadmapItem) return notFound(`Roadmap item ${roadmapItemId} was not found`)
        await schemaDb.insertInto("artifact_roadmap_links").values({
          artifact_id: artifactId,
          roadmap_item_id: roadmapItemId,
        }).onConflict((oc) => oc.columns(["artifact_id", "roadmap_item_id"]).doNothing()).execute()
        return openArtisanDbOk({ artifactId, roadmapItemId } satisfies DbArtifactRoadmapLink)
      })
    },

    approveArtifact(approval: DbArtifactApproval) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const version = await schemaDb.selectFrom("artifact_versions").select("id").where("id", "=", approval.artifactVersionId).executeTakeFirst()
        if (!version) return notFound(`Artifact version ${approval.artifactVersionId} was not found`)
        await schemaDb.insertInto("artifact_approvals").values({
          id: approval.id,
          artifact_version_id: approval.artifactVersionId,
          record: clone(approval),
          created_at: approval.createdAt,
        }).execute()
        return openArtisanDbOk(clone(approval))
      })
    },

    replaceTaskGraph(workflowId: DbRecordId, graph: DbTaskGraph) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, (db) => replaceTaskGraphInDb(db, workflowId, graph))
      })
    },

    getTaskGraph(workflowId: DbRecordId) {
      return withInitializedDb(async (db) => openArtisanDbOk(await loadTaskGraph(db, workflowId)))
    },

    claimTask(workflowId: DbRecordId, taskId: DbRecordId, lease: DbAgentLease) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        if (lease.workflowId !== workflowId) return invalidInput(`Lease workflow ${lease.workflowId} does not match claimed workflow ${workflowId}`)
        if (lease.taskId && lease.taskId !== taskId) return invalidInput(`Lease task ${lease.taskId} does not match claimed task ${taskId}`)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${workflowId} was not found`)
        const taskRow = await schemaDb.selectFrom("tasks").selectAll().where("id", "=", taskId).where("workflow_id", "=", workflowId).executeTakeFirst()
        if (!taskRow) return notFound(`Task ${taskId} was not found`)
        await schemaDb.insertInto("agent_leases").values({
          id: lease.id,
          workflow_id: workflowId,
          session_id: lease.sessionId,
          task_id: taskId,
          expires_at: lease.expiresAt,
          record: clone(lease),
          created_at: lease.createdAt,
        }).execute()
        const task = { ...rowRecord<DbTask>(taskRow), currentAgentLeaseId: lease.id, status: "in-flight" as const, updatedAt: nowIso() }
        await schemaDb.updateTable("tasks").set({ status: task.status, record: clone(task), updated_at: task.updatedAt }).where("id", "=", taskId).where("workflow_id", "=", workflowId).execute()
        return openArtisanDbOk(clone(lease))
        })
      })
    },

    updateTaskStatus(taskId: DbRecordId, status: TaskStatus) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const row = await schemaDb.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirst()
        if (!row) return notFound(`Task ${taskId} was not found`)
        const task = { ...rowRecord<DbTask>(row), status, updatedAt: nowIso() }
        await schemaDb.updateTable("tasks").set({ status, record: clone(task), updated_at: task.updatedAt }).where("id", "=", taskId).execute()
        return openArtisanDbOk(task)
      })
    },

    analyzeBoundaryChange(input: BoundaryChangeInput) {
      return withInitializedDb((db) => analyzeBoundaryChangeInDb(db, input))
    },

    applyBoundaryChange(input: BoundaryChangeInput) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const analysis = await analyzeBoundaryChangeInDb(db, input)
        if (!analysis.ok) return analysis
        const graph = await loadTaskGraph(db, input.workflowId)
        if (!graph) return notFound(`Workflow ${input.workflowId} has no task graph`)
        const task = graph.tasks.find((candidate) => candidate.id === analysis.value.taskId)
        if (!task) return notFound(`Task ${analysis.value.taskId} was not found`)
        const removeFiles = new Set(input.removeFiles ?? [])
        const addFiles = input.addFiles ?? []
        const removeTests = new Set(input.removeExpectedTests ?? [])
        const addTests = input.addExpectedTests ?? []
        const nextOwnedFiles: DbTaskOwnedFile[] = [
          ...graph.ownedFiles.filter((file) => file.taskId !== task.id && !addFiles.includes(file.path)),
          ...unique([
            ...graph.ownedFiles.filter((file) => file.taskId === task.id).map((file) => file.path).filter((path) => !removeFiles.has(path)),
            ...addFiles,
          ]).map((path) => ({ taskId: task.id, path })),
        ]
        const nextExpectedTests: DbTaskExpectedTest[] = [
          ...graph.expectedTests.filter((test) => test.taskId !== task.id),
          ...unique([
            ...graph.expectedTests.filter((test) => test.taskId === task.id).map((test) => test.path).filter((path) => !removeTests.has(path)),
            ...addTests,
          ]).map((path) => ({ taskId: task.id, path })),
        ]
        const resetIds = new Set(analysis.value.completedTaskIdsToReset)
        const nextGraph: DbTaskGraph = {
          ...graph,
          tasks: graph.tasks.map((candidate) => resetIds.has(candidate.id) ? { ...candidate, status: "pending", updatedAt: nowIso() } : candidate),
          ownedFiles: nextOwnedFiles,
          expectedTests: nextExpectedTests,
        }
        return replaceTaskGraphInDb(db, input.workflowId, nextGraph).then((result) => result.ok ? analysis : result)
        })
      })
    },

    recordTaskReview(review: DbTaskReview, observations: DbReviewObservation[]) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", review.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${review.workflowId} was not found`)
        const task = await schemaDb.selectFrom("tasks").select("id").where("id", "=", review.taskId).where("workflow_id", "=", review.workflowId).executeTakeFirst()
        if (!task) return notFound(`Task ${review.taskId} was not found`)
        const mismatchedObservation = observations.find((observation) => observation.reviewId !== review.id)
        if (mismatchedObservation) return invalidInput(`Review observation ${mismatchedObservation.id} references ${mismatchedObservation.reviewId}, not ${review.id}`)
        await schemaDb.insertInto("task_reviews").values({
          id: review.id,
          workflow_id: review.workflowId,
          task_id: review.taskId,
          created_at: review.createdAt,
          record: clone(review),
        }).execute()
        if (observations.length > 0) {
          await schemaDb.insertInto("review_observations").values(observations.map((observation) => ({
            id: observation.id,
            review_id: observation.reviewId,
            kind: observation.kind,
            record: clone(observation),
          }))).execute()
        }
        return openArtisanDbOk(clone(review))
        })
      })
    },

    listTaskReviews(workflowId: DbRecordId, taskId?: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("task_reviews").selectAll().where("workflow_id", "=", workflowId).execute()
        const reviews = rows.map((row) => rowRecord<DbTaskReview>(row)).filter((review) => taskId === undefined || review.taskId === taskId)
        return openArtisanDbOk(reviews)
      })
    },

    recordPhaseReview(review: DbPhaseReview, observations: DbReviewObservation[]) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", review.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${review.workflowId} was not found`)
        if (review.artifactVersionId) {
          const version = await schemaDb.selectFrom("artifact_versions").select(["id", "artifact_id"]).where("id", "=", review.artifactVersionId).executeTakeFirst()
          if (!version) return notFound(`Artifact version ${review.artifactVersionId} was not found`)
          const artifact = await schemaDb.selectFrom("artifacts").select("id").where("id", "=", version.artifact_id).where("workflow_id", "=", review.workflowId).executeTakeFirst()
          if (!artifact) return invalidInput(`Artifact version ${review.artifactVersionId} does not belong to workflow ${review.workflowId}`)
        }
        const mismatchedObservation = observations.find((observation) => observation.reviewId !== review.id)
        if (mismatchedObservation) return invalidInput(`Review observation ${mismatchedObservation.id} references ${mismatchedObservation.reviewId}, not ${review.id}`)
        await schemaDb.insertInto("phase_reviews").values({
          id: review.id,
          workflow_id: review.workflowId,
          phase: review.phase,
          created_at: review.createdAt,
          record: clone(review),
        }).execute()
        if (observations.length > 0) {
          await schemaDb.insertInto("review_observations").values(observations.map((observation) => ({
            id: observation.id,
            review_id: observation.reviewId,
            kind: observation.kind,
            record: clone(observation),
          }))).execute()
        }
        return openArtisanDbOk(clone(review))
        })
      })
    },

    listPhaseReviews(workflowId: DbRecordId, phase?: Phase) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("phase_reviews").selectAll().where("workflow_id", "=", workflowId).execute()
        const reviews = rows.map((row) => rowRecord<DbPhaseReview>(row)).filter((review) => phase === undefined || review.phase === phase)
        return openArtisanDbOk(reviews)
      })
    },

    listReviewObservations(reviewId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("review_observations").selectAll().where("review_id", "=", reviewId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbReviewObservation>(row)))
      })
    },

    recordPatchSuggestion(suggestion: DbPatchSuggestion) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", suggestion.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${suggestion.workflowId} was not found`)
        if (suggestion.taskId) {
          const task = await schemaDb.selectFrom("tasks").select("id").where("id", "=", suggestion.taskId).where("workflow_id", "=", suggestion.workflowId).executeTakeFirst()
          if (!task) return notFound(`Task ${suggestion.taskId} was not found`)
        }
        if (suggestion.reviewObservationId) {
          const observation = await schemaDb.selectFrom("review_observations").select(["id", "review_id"]).where("id", "=", suggestion.reviewObservationId).executeTakeFirst()
          if (!observation) return notFound(`Review observation ${suggestion.reviewObservationId} was not found`)
          const taskReview = await schemaDb.selectFrom("task_reviews").select("id").where("id", "=", observation.review_id).where("workflow_id", "=", suggestion.workflowId).executeTakeFirst()
          const phaseReview = await schemaDb.selectFrom("phase_reviews").select("id").where("id", "=", observation.review_id).where("workflow_id", "=", suggestion.workflowId).executeTakeFirst()
          if (!taskReview && !phaseReview) return invalidInput(`Review observation ${suggestion.reviewObservationId} does not belong to workflow ${suggestion.workflowId}`)
        }
        await schemaDb.insertInto("patch_suggestions").values({
          id: suggestion.id,
          workflow_id: suggestion.workflowId,
          status: suggestion.status,
          record: clone(suggestion),
          created_at: suggestion.createdAt,
          updated_at: suggestion.updatedAt,
        }).execute()
        return openArtisanDbOk(clone(suggestion))
      })
    },

    updatePatchSuggestionStatus(patchSuggestionId: DbRecordId, status: PatchSuggestionStatus, updatedAt: IsoTimestamp) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const row = await schemaDb.selectFrom("patch_suggestions").selectAll().where("id", "=", patchSuggestionId).executeTakeFirst()
        if (!row) return notFound(`Patch suggestion ${patchSuggestionId} was not found`)
        const suggestion = { ...rowRecord<DbPatchSuggestion>(row), status, updatedAt }
        await schemaDb.updateTable("patch_suggestions").set({ status, record: clone(suggestion), updated_at: updatedAt }).where("id", "=", patchSuggestionId).execute()
        return openArtisanDbOk(clone(suggestion))
      })
    },

    listPatchSuggestions(workflowId: DbRecordId, status?: PatchSuggestionStatus) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("patch_suggestions").selectAll().where("workflow_id", "=", workflowId).execute()
        const suggestions = rows.map((row) => rowRecord<DbPatchSuggestion>(row)).filter((suggestion) => status === undefined || suggestion.status === status)
        return openArtisanDbOk(suggestions)
      })
    },

    applyPatchSuggestion(application: DbPatchApplication) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const row = await schemaDb.selectFrom("patch_suggestions").selectAll().where("id", "=", application.patchSuggestionId).executeTakeFirst()
        if (!row) return notFound(`Patch suggestion ${application.patchSuggestionId} was not found`)
        await schemaDb.insertInto("patch_applications").values({
          id: application.id,
          patch_suggestion_id: application.patchSuggestionId,
          record: clone(application),
          created_at: application.createdAt,
        }).execute()
        if (application.result === "applied") {
          const suggestion = { ...rowRecord<DbPatchSuggestion>(row), status: "applied" as const, updatedAt: nowIso() }
          await schemaDb.updateTable("patch_suggestions").set({ status: suggestion.status, record: clone(suggestion), updated_at: suggestion.updatedAt }).where("id", "=", suggestion.id).execute()
        }
        return openArtisanDbOk(clone(application))
        })
      })
    },

    listPatchApplications(patchSuggestionId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("patch_applications").selectAll().where("patch_suggestion_id", "=", patchSuggestionId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbPatchApplication>(row)))
      })
    },

    declareHumanGate(gate: DbHumanGate) {
      return withInitializedDb((db) => withTransaction(db, (db) => declareHumanGateInDb(db, gate)))
    },

    resolveHumanGate(gateId: DbRecordId, resolvedAt: string) {
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const row = await schemaDb.selectFrom("human_gates").selectAll().where("id", "=", gateId).executeTakeFirst()
        if (!row) return notFound(`Human gate ${gateId} was not found`)
        const gate = { ...rowRecord<DbHumanGate>(row), resolved: true, resolvedAt }
        await schemaDb.updateTable("human_gates").set({ resolved: true, resolved_at: resolvedAt, record: clone(gate) }).where("id", "=", gateId).execute()
        const taskRow = await schemaDb.selectFrom("tasks").selectAll().where("id", "=", gate.taskId).executeTakeFirst()
        if (taskRow) {
          const task = { ...rowRecord<DbTask>(taskRow), status: "complete" as const, updatedAt: nowIso() }
          await schemaDb.updateTable("tasks").set({ status: task.status, record: clone(task), updated_at: task.updatedAt }).where("id", "=", task.id).execute()
        }
        return openArtisanDbOk(gate)
        })
      })
    },

    listHumanGates(workflowId: DbRecordId, resolved?: boolean) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("human_gates").selectAll().where("workflow_id", "=", workflowId).execute()
        const gates = rows.map((row) => rowRecord<DbHumanGate>(row)).filter((gate) => resolved === undefined || gate.resolved === resolved)
        return openArtisanDbOk(gates)
      })
    },

    recordAgentLease(lease: DbAgentLease) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", lease.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${lease.workflowId} was not found`)
        const existingLease = await schemaDb.selectFrom("agent_leases").select(["id", "workflow_id"]).where("id", "=", lease.id).executeTakeFirst()
        if (existingLease && existingLease.workflow_id !== lease.workflowId) {
          return invalidState(`Agent lease ${lease.id} already belongs to workflow ${existingLease.workflow_id}`)
        }
        if (lease.taskId) {
          const task = await schemaDb.selectFrom("tasks").select("id").where("id", "=", lease.taskId).where("workflow_id", "=", lease.workflowId).executeTakeFirst()
          if (!task) return notFound(`Task ${lease.taskId} was not found`)
        }
        await schemaDb.insertInto("agent_leases").values({
          id: lease.id,
          workflow_id: lease.workflowId,
          session_id: lease.sessionId,
          task_id: lease.taskId ?? null,
          expires_at: lease.expiresAt,
          record: clone(lease),
          created_at: lease.createdAt,
        }).onConflict((oc) => oc.column("id").doUpdateSet({
          workflow_id: lease.workflowId,
          session_id: lease.sessionId,
          task_id: lease.taskId ?? null,
          expires_at: lease.expiresAt,
          record: clone(lease),
        })).execute()
        return openArtisanDbOk(clone(lease))
      })
    },

    listAgentLeases(workflowId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("agent_leases").selectAll().where("workflow_id", "=", workflowId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbAgentLease>(row)))
      })
    },

    recordFileClaim(claim: DbFileClaim) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const lease = await schemaDb.selectFrom("agent_leases").select("id").where("id", "=", claim.agentLeaseId).executeTakeFirst()
        if (!lease) return notFound(`Agent lease ${claim.agentLeaseId} was not found`)
        const existingClaim = await schemaDb.selectFrom("file_claims").select(["id", "agent_lease_id"]).where("id", "=", claim.id).executeTakeFirst()
        if (existingClaim && existingClaim.agent_lease_id !== claim.agentLeaseId) {
          return invalidState(`File claim ${claim.id} already belongs to agent lease ${existingClaim.agent_lease_id}`)
        }
        await schemaDb.insertInto("file_claims").values({
          id: claim.id,
          agent_lease_id: claim.agentLeaseId,
          path: claim.path,
          mode: claim.mode,
          record: clone(claim),
          created_at: claim.createdAt,
        }).onConflict((oc) => oc.column("id").doUpdateSet({
          agent_lease_id: claim.agentLeaseId,
          path: claim.path,
          mode: claim.mode,
          record: clone(claim),
        })).execute()
        return openArtisanDbOk(clone(claim))
      })
    },

    listFileClaims(agentLeaseId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("file_claims").selectAll().where("agent_lease_id", "=", agentLeaseId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbFileClaim>(row)))
      })
    },

    recordWorktreeObservation(observation: DbWorktreeObservation) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", observation.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${observation.workflowId} was not found`)
        if (observation.taskId) {
          const task = await schemaDb.selectFrom("tasks").select("id").where("id", "=", observation.taskId).where("workflow_id", "=", observation.workflowId).executeTakeFirst()
          if (!task) return notFound(`Task ${observation.taskId} was not found`)
        }
        if (observation.agentLeaseId) {
          const lease = await schemaDb.selectFrom("agent_leases").select("id").where("id", "=", observation.agentLeaseId).where("workflow_id", "=", observation.workflowId).executeTakeFirst()
          if (!lease) return notFound(`Agent lease ${observation.agentLeaseId} was not found`)
        }
        await schemaDb.insertInto("worktree_observations").values({
          id: observation.id,
          workflow_id: observation.workflowId,
          path: observation.path,
          classification: observation.classification,
          record: clone(observation),
          created_at: observation.createdAt,
        }).execute()
        return openArtisanDbOk(clone(observation))
      })
    },

    listWorktreeObservations(workflowId: DbRecordId, classification?: DbWorktreeObservation["classification"]) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("worktree_observations").selectAll().where("workflow_id", "=", workflowId).execute()
        const observations = rows.map((row) => rowRecord<DbWorktreeObservation>(row)).filter((observation) => classification === undefined || observation.classification === classification)
        return openArtisanDbOk(observations)
      })
    },

    recordFastForward(record: DbFastForwardRecord) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const workflow = await schemaDb.selectFrom("workflows").select("id").where("id", "=", record.workflowId).executeTakeFirst()
        if (!workflow) return notFound(`Workflow ${record.workflowId} was not found`)
        const patchSuggestionIds = unique(record.patchSuggestionIds)
        if (patchSuggestionIds.length > 0) {
          const patchRows = await schemaDb.selectFrom("patch_suggestions").select("id").where("id", "in", patchSuggestionIds).where("workflow_id", "=", record.workflowId).execute()
          const existingPatchIds = new Set(patchRows.map((row) => row.id))
          const missingPatchId = patchSuggestionIds.find((id) => !existingPatchIds.has(id))
          if (missingPatchId) return notFound(`Patch suggestion ${missingPatchId} was not found`)
        }
        await schemaDb.insertInto("fast_forward_records").values({
          id: record.id,
          workflow_id: record.workflowId,
          record: clone(record),
          created_at: record.createdAt,
        }).execute()
        return openArtisanDbOk(clone(record))
      })
    },

    listFastForwards(workflowId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const rows = await db.withSchema(schemaName).selectFrom("fast_forward_records").selectAll().where("workflow_id", "=", workflowId).execute()
        return openArtisanDbOk(rows.map((row) => rowRecord<DbFastForwardRecord>(row)))
      })
    },

    importWorkflowState(state: WorkflowState) {
      const validationError = validateWorkflowState(state)
      if (validationError) return Promise.resolve(invalidInput<JsonWorkflowImportResult>(String(validationError)))
      return withInitializedDb(async (db) => {
        return withTransaction(db, async (db) => {
        const featureName = state.featureName ?? state.sessionId
        const workflowId = `workflow:${featureName}`
        const schemaDb = db.withSchema(schemaName)
        const existingWorkflowRow = await schemaDb.selectFrom("workflows").selectAll().where("id", "=", workflowId).executeTakeFirst()
        const previousWorkflow = existingWorkflowRow ? rowRecord<DbWorkflow>(existingWorkflowRow) : null
        const timestamp = nowIso()
        const workflow: DbWorkflow = {
          id: workflowId,
          featureName,
          mode: state.mode ?? "GREENFIELD",
          phase: state.phase,
          phaseState: state.phaseState,
          createdAt: previousWorkflow ? previousWorkflow.createdAt : timestamp,
          updatedAt: timestamp,
        }
        const oldTasks = await schemaDb.selectFrom("tasks").select("id").where("workflow_id", "=", workflowId).execute()
        const oldTaskIds = oldTasks.map((task) => task.id)
        if (oldTaskIds.length > 0) {
          await schemaDb.deleteFrom("task_roadmap_links").where("task_id", "in", oldTaskIds).execute()
          await schemaDb.deleteFrom("task_expected_tests").where("task_id", "in", oldTaskIds).execute()
          await schemaDb.deleteFrom("task_owned_files").where("task_id", "in", oldTaskIds).execute()
        }
        await schemaDb.deleteFrom("task_dependencies").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("tasks").where("workflow_id", "=", workflowId).execute()
        await schemaDb.deleteFrom("human_gates").where("workflow_id", "=", workflowId).execute()
        await schemaDb.insertInto("workflows").values({
          id: workflow.id,
          feature_name: workflow.featureName,
          mode: workflow.mode,
          phase: workflow.phase,
          phase_state: workflow.phaseState,
          record: clone(workflow),
          state_snapshot: clone(state),
          created_at: workflow.createdAt,
          updated_at: workflow.updatedAt,
        }).onConflict((oc) => oc.column("id").doUpdateSet({
          feature_name: workflow.featureName,
          mode: workflow.mode,
          phase: workflow.phase,
          phase_state: workflow.phaseState,
          record: clone(workflow),
          state_snapshot: clone(state),
          updated_at: workflow.updatedAt,
        })).execute()
        if (previousWorkflow && (previousWorkflow.phase !== workflow.phase || previousWorkflow.phaseState !== workflow.phaseState)) {
          const event = buildPhaseTransitionEvent({
            workflowId,
            previousWorkflow,
            nextPhase: workflow.phase,
            nextPhaseState: workflow.phaseState,
            reason: "WorkflowState compatibility import",
            createdAt: timestamp,
            source: "compatibility-import",
          })
          await schemaDb.insertInto("workflow_events").values({
            id: event.id,
            workflow_id: event.workflowId,
            created_at: event.createdAt,
            record: clone(event),
          }).execute()
        }
        const graph = buildImportedTaskGraph(state, workflowId)
        if (graph) {
          const graphResult = await replaceTaskGraphInDb(db, workflowId, graph)
          if (!graphResult.ok) return graphResult
          for (const task of state.implDag ?? []) {
            if (task.humanGate) {
              const gate: DbHumanGate = {
                id: `${workflowId}:${task.id}:gate`,
                workflowId,
                taskId: `${workflowId}:${task.id}`,
                whatIsNeeded: task.humanGate.whatIsNeeded,
                why: task.humanGate.why,
                verificationSteps: task.humanGate.verificationSteps,
                resolved: task.humanGate.resolved,
                ...(task.humanGate.resolvedAt ? { resolvedAt: task.humanGate.resolvedAt } : {}),
                createdAt: nowIso(),
              }
              const gateResult = await declareHumanGateInDb(db, gate)
              if (!gateResult.ok) return gateResult
            }
          }
        }
        return openArtisanDbOk({ workflowId, featureName, warnings: [] })
        })
      })
    },

    exportWorkflowState(workflowId: DbRecordId) {
      return withInitializedDb(async (db) => {
        const schemaDb = db.withSchema(schemaName)
        const row = await schemaDb.selectFrom("workflows").selectAll().where("id", "=", workflowId).executeTakeFirst()
        if (!row) return notFound(`Workflow ${workflowId} was not found`)
        const workflow = rowRecord<DbWorkflow>(row)
        const state = row.state_snapshot ? clone(row.state_snapshot as WorkflowState) : freshWorkflowState(workflow.id)
        state.sessionId = state.sessionId || workflow.id
        state.mode = workflow.mode
        state.phase = workflow.phase
        state.phaseState = workflow.phaseState
        state.featureName = workflow.featureName
        const artifactRows = await schemaDb.selectFrom("artifacts").selectAll().where("workflow_id", "=", workflow.id).execute()
        for (const artifactRow of artifactRows) {
          const artifact = rowRecord<DbArtifact>(artifactRow)
          const currentVersionId = artifact.currentVersionId ?? artifactRow.current_version_id
          if (!currentVersionId) continue
          const versionRow = await schemaDb.selectFrom("artifact_versions").selectAll().where("id", "=", currentVersionId).executeTakeFirst()
          if (!versionRow) continue
          const version = rowRecord<DbArtifactVersion>(versionRow)
          if (version.diskPath) {
            state.artifactDiskPaths[artifact.artifactKey] = version.diskPath
          }
          const approvals = await schemaDb.selectFrom("artifact_approvals").select("id").where("artifact_version_id", "=", currentVersionId).execute()
          if (approvals.length > 0) {
            state.approvedArtifacts[artifact.artifactKey] = version.contentHash
          }
        }
        const graph = await loadTaskGraph(db, workflow.id)
        if (graph) {
          const gateRows = await schemaDb.selectFrom("human_gates").selectAll().where("workflow_id", "=", workflow.id).execute()
          const gatesByTaskId = new Map(gateRows.map((gateRow) => {
            const gate = rowRecord<DbHumanGate>(gateRow)
            return [gate.taskId, gate] as const
          }))
          state.implDag = graph.tasks.map((task) => ({
            id: task.taskKey,
            description: task.description,
            dependencies: graph.dependencies.filter((dependency) => dependency.toTaskId === task.id).map((dependency) => graph.tasks.find((candidate) => candidate.id === dependency.fromTaskId)?.taskKey ?? dependency.fromTaskId),
            expectedTests: graph.expectedTests.filter((test) => test.taskId === task.id).map((test) => test.path),
            expectedFiles: graph.ownedFiles.filter((file) => file.taskId === task.id).map((file) => file.path),
            estimatedComplexity: task.complexity,
            status: task.status,
            category: task.category,
            ...(gatesByTaskId.has(task.id)
              ? {
                  humanGate: {
                    whatIsNeeded: gatesByTaskId.get(task.id)!.whatIsNeeded,
                    why: gatesByTaskId.get(task.id)!.why,
                    verificationSteps: gatesByTaskId.get(task.id)!.verificationSteps,
                    resolved: gatesByTaskId.get(task.id)!.resolved,
                    ...(gatesByTaskId.get(task.id)!.resolvedAt ? { resolvedAt: gatesByTaskId.get(task.id)!.resolvedAt } : {}),
                  },
                }
              : {}),
          }))
        }
        return openArtisanDbOk(state)
      })
    },
  }

  return repo
}
