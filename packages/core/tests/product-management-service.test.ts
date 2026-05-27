import { describe, expect, it } from "bun:test"

import type {
  ProductManagementLogEventPayload,
  ProductManagementMetricEvent,
  ProductManagementService,
  ProductManagementServiceDependencies,
} from "#core/product-management-types"
import type { RoadmapItem } from "#core/roadmap-types"

const roadmapItems: RoadmapItem[] = [
  {
    id: "active-1",
    kind: "feature",
    title: "Active product-management feature",
    status: "todo",
    priority: 10,
    featureName: "active-product-work",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  },
  {
    id: "frozen-1",
    kind: "debt",
    title: "Frozen historical context",
    description: "lifecycle:frozen",
    status: "done",
    priority: 100,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  },
  {
    id: "abandoned-1",
    kind: "chore",
    title: "Abandoned old approach",
    description: "lifecycle:abandoned",
    status: "dropped",
    priority: 99,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  },
]

function makeRoadmap(overrides: Record<string, unknown> = {}) {
  return {
    async createItem(item: unknown) {
      return { ok: true, value: item }
    },
    async upsertEdge(edge: unknown) {
      return { ok: true, value: edge }
    },
    async listItems() {
      return { ok: true, value: roadmapItems }
    },
    async listEdges() {
      return { ok: true, value: [{ from: "active-1", to: "frozen-1", kind: "depends-on" }] }
    },
    ...overrides,
  }
}

function makeWorkflow(): NonNullable<ProductManagementServiceDependencies["workflow"]> {
  return {} as NonNullable<ProductManagementServiceDependencies["workflow"]>
}

type TestProductManagementDeps = Omit<Partial<ProductManagementServiceDependencies>, "currentWorkflow" | "roadmap"> & {
  currentWorkflow?: Record<string, unknown>
  roadmap?: unknown
}

async function loadService(deps: TestProductManagementDeps = {}): Promise<ProductManagementService> {
  const modulePath = "#core/product-management-service"
  const module = await import(modulePath) as {
    createProductManagementService(input: ProductManagementServiceDependencies): ProductManagementService
  }

  return module.createProductManagementService({
    ...deps,
    currentWorkflow: {
      workflowId: "workflow-1",
      featureName: "autonomous-product-management",
      mode: "INCREMENTAL",
      phase: "PLANNING",
      phaseState: "USER_GATE",
      roadmapItemIds: ["apm-1"],
      unresolvedHumanGateCount: 0,
      pendingPatchSuggestionCount: 0,
      activeFileClaims: [],
      safeToSwitch: false,
      blockedReasons: ["at user gate"],
      ...deps.currentWorkflow,
    },
  } as ProductManagementServiceDependencies)
}

describe("product-management service", () => {
  it("reports product-management health from available service dependencies", async () => {
    const readyService = await loadService({ roadmap: makeRoadmap(), workflow: makeWorkflow() })
    const degradedService = await loadService()

    await expect(readyService.health()).resolves.toEqual({ status: "ready", signals: [], diagnostics: [] })
    await expect(degradedService.health()).resolves.toEqual({
      status: "degraded",
      signals: ["missing-roadmap-service", "degraded-context", "missing-workflow-service"],
      diagnostics: [expect.stringContaining("product-management context degraded")],
    })
  })

  it("emits operational logs and metrics without recording user request text", async () => {
    const logs: ProductManagementLogEventPayload[] = []
    const metrics: ProductManagementMetricEvent[] = []
    const service = await loadService({
      roadmap: makeRoadmap(),
      workflow: makeWorkflow(),
      emitLog(event) { logs.push(event) },
      emitMetric(event) { metrics.push(event) },
    })

    const assessment = await service.assessRequest({ request: "file a bug with private customer text", featureName: "autonomous-product-management" })
    const work = await service.listWork({ roadmapItemIds: ["active-1"], maxCandidates: 10 })
    const queued = await service.queueItem({ title: "Telemetry follow-up", description: "Capture observability evidence.", kind: "follow-up" })

    expect(assessment.ok).toBe(true)
    expect(work.ok).toBe(true)
    expect(queued.ok).toBe(true)
    expect(metrics.map((event) => event.name)).toEqual([
      "product-management.assess-request",
      "product-management.list-work",
      "product-management.queue-item",
    ])
    expect(metrics.find((event) => event.name === "product-management.assess-request")?.decision).toBe("queue-roadmap-item")
    expect(metrics.find((event) => event.name === "product-management.list-work")?.candidateCount).toBe(2)
    expect(metrics.find((event) => event.name === "product-management.queue-item")?.queuedItemKind).toBe("follow-up")
    expect(logs).toEqual([
      expect.objectContaining({
        signal: "queued-item-created",
        status: "ready",
        featureName: "autonomous-product-management",
        roadmapItemIds: ["apm-1"],
        userRequestLogged: false,
      }),
    ])
    expect(logs[0]?.message).not.toContain("private customer text")
  })

  it("emits degraded telemetry when roadmap persistence is unavailable", async () => {
    const logs: ProductManagementLogEventPayload[] = []
    const metrics: ProductManagementMetricEvent[] = []
    const service = await loadService({
      emitLog(event) { logs.push(event) },
      emitMetric(event) { metrics.push(event) },
    })

    const assessment = await service.assessRequest({ request: "file a bug with private customer text" })
    const work = await service.listWork({ maxCandidates: 5 })
    const queued = await service.queueItem({ title: "Unavailable roadmap", description: "Should fail safely.", kind: "bug" })

    expect(assessment.ok).toBe(true)
    expect(work.ok).toBe(true)
    expect(queued.ok).toBe(false)
    expect(logs.map((event) => event.signal)).toEqual(["missing-roadmap-service", "missing-roadmap-service", "missing-roadmap-service"])
    expect(logs.every((event) => event.status === "degraded" && event.userRequestLogged === false)).toBe(true)
    expect(logs.map((event) => event.message).join(" ")).not.toContain("private customer text")
    expect(metrics).toEqual([
      expect.objectContaining({ name: "product-management.assess-request", status: "degraded", decision: "queue-roadmap-item" }),
      expect.objectContaining({ name: "product-management.list-work", status: "degraded", candidateCount: 1 }),
      expect.objectContaining({ name: "product-management.queue-item", status: "degraded", queuedItemKind: "bug" }),
    ])
  })

  it("queues follow-up product memory without mutating the current workflow", async () => {
    const createdItems: unknown[] = []
    const roadmap = {
      async createItem(item: unknown) {
        createdItems.push(item)
        return { ok: true, value: item }
      },
      async upsertEdge(edge: unknown) {
        return { ok: true, value: edge }
      },
      async listItems() {
        return { ok: true, value: [] }
      },
      async listEdges() {
        return { ok: true, value: [] }
      },
    }
    const service = await loadService({ roadmap })

    const result = await service.queueItem({
      title: "Capture gate-safe chat",
      description: "A user noticed a follow-up at USER_GATE.",
      kind: "follow-up",
      priority: 6,
      source: {
        workflowId: "workflow-1",
        featureName: "autonomous-product-management",
        sessionId: "session-1",
        taskId: "task-005",
        artifactKey: "plan",
        artifactPath: ".openartisan/autonomous-product-management/plan.md",
        messageId: "message-1",
      },
      discoveredWhile: {
        request: "file this for later",
        currentFeatureName: "autonomous-product-management",
        currentPhase: "PLANNING",
        currentPhaseState: "USER_GATE",
        currentMode: "INCREMENTAL",
        currentTaskId: "task-005",
        roadmapItemIds: ["apm-1"],
        executionSliceId: "apm-slice-1",
      },
      suggestedEdges: [{ from: "queued-1", to: "apm-1", kind: "depends-on" }],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.queuedNode.requestedKind).toBe("follow-up")
      expect(result.value.queuedNode.persistedKind).toBe("chore")
      expect(result.value.currentWorkflowUnchanged).toBe(true)
      expect(result.value.currentWorkflow?.phase).toBe("PLANNING")
      expect(result.value.currentWorkflow?.phaseState).toBe("USER_GATE")
      expect(result.value.provenance).toEqual(expect.arrayContaining([
        { source: "user-request", reference: "message-1" },
        { source: "workflow-state", reference: "workflow:workflow-1 feature:autonomous-product-management session:session-1 task:task-005" },
        { source: "artifact", reference: "artifactKey:plan artifactPath:.openartisan/autonomous-product-management/plan.md" },
        { source: "workflow-state", reference: "feature:autonomous-product-management phase:PLANNING state:USER_GATE task:task-005 slice:apm-slice-1" },
        { source: "roadmap", reference: "apm-1" },
      ]))
    }
    expect(createdItems).toHaveLength(1)
    expect((createdItems[0] as { description?: string }).description).toContain("sourceWorkflowId:workflow-1")
    expect((createdItems[0] as { description?: string }).description).toContain("sourceSessionId:session-1")
    expect((createdItems[0] as { description?: string }).description).toContain("sourceTaskId:task-005")
    expect((createdItems[0] as { description?: string }).description).toContain("sourceArtifactKey:plan")
    expect((createdItems[0] as { description?: string }).description).toContain("sourceArtifactPath:.openartisan/autonomous-product-management/plan.md")
    expect((createdItems[0] as { description?: string }).description).toContain("discoveredRoadmapItemIds:apm-1")
  })

  it("returns a typed storage failure when queueing has no roadmap service", async () => {
    const service = await loadService()

    const result = await service.queueItem({
      title: "Capture unavailable roadmap",
      description: "Queueing needs durable product memory.",
      kind: "bug",
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: "storage-failure",
        message: expect.stringContaining("roadmap"),
        retryable: false,
      },
    })
  })

  it("queues every accepted product-management item kind with persistence-compatible roadmap kinds", async () => {
    const service = await loadService({ roadmap: makeRoadmap() })
    const expectedPersistedKinds = {
      feature: "feature",
      bug: "bug",
      issue: "bug",
      debt: "debt",
      chore: "chore",
      "follow-up": "chore",
    } as const

    const entries = Object.entries(expectedPersistedKinds) as Array<[keyof typeof expectedPersistedKinds, (typeof expectedPersistedKinds)[keyof typeof expectedPersistedKinds]]>
    for (const [kind, persistedKind] of entries) {
      const result = await service.queueItem({
        title: `Queue ${kind}`,
        description: `Queue ${kind} from product-management chat.`,
        kind: kind as keyof typeof expectedPersistedKinds,
        suggestedEdges: [{ from: `queued-${kind}`, to: "apm-1", kind: "depends-on" }],
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.queuedNode.requestedKind).toBe(kind)
        expect(result.value.queuedNode.persistedKind).toBe(persistedKind)
        expect(result.value.suggestedEdges).toEqual([{ from: `queued-${kind}`, to: "apm-1", kind: "depends-on" }])
      }
    }
  })

  it("assesses product-management chat as queue-roadmap-item instead of artifact feedback", async () => {
    const service = await loadService({
      roadmap: {
        async listItems() {
          return { ok: true, value: [] }
        },
        async listEdges() {
          return { ok: true, value: [] }
        },
      },
    })

    const result = await service.assessRequest({
      request: "we should file a bug for this edge case and continue the review",
      featureName: "autonomous-product-management",
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.decision).toBe("queue-roadmap-item")
      expect(result.value.suggestedToolCalls.map((call) => call.toolName)).toContain("product_management_queue_item")
      expect(result.value.requiredGates).toEqual([])
    }
  })

  it("lists active, frozen, and abandoned roadmap nodes while blocking historical nodes from normal execution", async () => {
    const service = await loadService({ roadmap: makeRoadmap() })

    const result = await service.listWork({ lifecycles: ["active", "frozen", "abandoned"], maxCandidates: 10 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.candidates.map((candidate) => candidate.roadmapNode?.item.id)).toEqual(expect.arrayContaining(["active-1", "frozen-1", "abandoned-1"]))
      expect(result.value.candidates.find((candidate) => candidate.roadmapNode?.item.id === "active-1")?.safeToStart).toBe(true)
      expect(result.value.candidates.find((candidate) => candidate.roadmapNode?.item.id === "frozen-1")?.status).toBe("frozen")
      expect(result.value.candidates.find((candidate) => candidate.roadmapNode?.item.id === "frozen-1")?.safeToStart).toBe(false)
      expect(result.value.candidates.find((candidate) => candidate.roadmapNode?.item.id === "abandoned-1")?.status).toBe("abandoned")
      expect(result.value.candidates.find((candidate) => candidate.roadmapNode?.item.id === "abandoned-1")?.safeToStart).toBe(false)
    }
  })

  it("keeps safety gates ahead of roadmap priority when listing work", async () => {
    const service = await loadService({ roadmap: makeRoadmap() })

    const result = await service.listWork({ minPriority: 1, maxCandidates: 10 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const frozen = result.value.candidates.find((candidate) => candidate.roadmapNode?.item.id === "frozen-1")
      expect(frozen?.priority).toBe(100)
      expect(frozen?.safeToStart).toBe(false)
      expect(frozen?.reasons.join(" ")).toContain("frozen")
    }
  })

  it("returns repository-backed candidates for every requested status", async () => {
    const service = await loadService({
      roadmap: makeRoadmap({
        async listItems(query?: { featureName?: string; status?: string }) {
          return {
            ok: true,
            value: roadmapItems.filter((item) => {
              if (query?.featureName && item.featureName !== query.featureName) return false
              if (query?.status && item.status !== query.status) return false
              return true
            }),
          }
        },
      }),
    })

    const result = await service.listWork({ statuses: ["todo", "done"], lifecycles: ["active", "frozen"], maxCandidates: 10 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.candidates.map((candidate) => candidate.roadmapNode?.item.id)).toEqual(expect.arrayContaining(["active-1", "frozen-1"]))
    }
  })

  it("filters listed roadmap work to selected roadmap item ids without hiding the active workflow", async () => {
    const service = await loadService({ roadmap: makeRoadmap() })

    const result = await service.listWork({ roadmapItemIds: ["frozen-1"], lifecycles: ["active", "frozen", "abandoned"], maxCandidates: 10 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.candidates.map((candidate) => candidate.roadmapNode?.item.id).filter(Boolean)).toEqual(["frozen-1"])
      expect(result.value.candidates.some((candidate) => candidate.workflow?.featureName === "autonomous-product-management")).toBe(true)
    }
  })

  it("requires explicit roadmap mutation before continuing selected frozen or abandoned roadmap nodes", async () => {
    const service = await loadService({ roadmap: makeRoadmap(), currentWorkflow: { phaseState: "DRAFT", safeToSwitch: true, blockedReasons: [] } })

    const frozen = await service.assessRequest({ request: "continue the current workflow", roadmapItemIds: ["frozen-1"] })
    const abandoned = await service.assessRequest({ request: "switch to active-product-work next", roadmapItemIds: ["abandoned-1"] })

    expect(frozen.ok).toBe(true)
    if (frozen.ok) {
      expect(frozen.value.decision).toBe("continue-current-workflow")
      expect(frozen.value.requiredGates).toEqual([{ kind: "roadmap-mutation", reason: "selected roadmap node frozen-1 is frozen" }])
      expect(frozen.value.suggestedToolCalls).toEqual([])
      expect(frozen.value.diagnostics.join(" ")).toContain("selected roadmap node frozen-1 is frozen with priority 100")
    }
    expect(abandoned.ok).toBe(true)
    if (abandoned.ok) {
      expect(abandoned.value.decision).toBe("switch-workflow")
      expect(abandoned.value.requiredGates).toEqual([{ kind: "roadmap-mutation", reason: "selected roadmap node abandoned-1 is abandoned" }])
      expect(abandoned.value.suggestedToolCalls).toEqual([])
      expect(abandoned.value.diagnostics.join(" ")).toContain("selected roadmap node abandoned-1 is abandoned with priority 99")
    }
  })

  it("assesses workflow-control requests without silently performing gated mutations", async () => {
    const service = await loadService({ roadmap: makeRoadmap(), currentWorkflow: { phaseState: "DRAFT", safeToSwitch: true, blockedReasons: [] } })
    const cases = [
      { request: "continue the current workflow", decision: "continue-current-workflow" },
      { request: "revise the current artifact with more queueing detail", decision: "revise-current-artifact" },
      { request: "backtrack to planning for the allowlist", decision: "backtrack-current-artifact" },
      { request: "we need to edit an unapproved file", decision: "request-allowlist-expansion" },
      { request: "create a new roadmap node for reporting", decision: "propose-roadmap-item" },
      { request: "add a dependency edge from active-1 to apm-1", decision: "propose-roadmap-edge" },
      { request: "freeze active-1 as historical context", decision: "freeze-roadmap-node" },
      { request: "abandon active-1 because the approach is obsolete", decision: "abandon-roadmap-node" },
      { request: "switch to active-product-work next", decision: "switch-workflow" },
      { request: "reopen frozen-1", decision: "reopen-roadmap-node" },
      { request: "supersede abandoned-1", decision: "supersede-roadmap-node" },
      { request: "not sure whether this should interrupt current work", decision: "ask-user" },
    ] as const

    for (const testCase of cases) {
      const result = await service.assessRequest({ request: testCase.request, featureName: "autonomous-product-management" })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.decision).toBe(testCase.decision)
        expect(result.value.rationale).toBeString()
        if (testCase.decision === "revise-current-artifact") {
          expect(result.value.suggestedToolCalls.map((call) => call.toolName)).toContain("submit_feedback")
        } else {
          expect(result.value.suggestedToolCalls.every((call) => call.toolName !== "submit_feedback")).toBe(true)
        }
      }
    }
  })

  it("keeps workflow safety invariants ahead of product-management decisions", async () => {
    const cases = [
      {
        request: "switch to active-product-work now",
        currentWorkflow: { phaseState: "USER_GATE", blockedReasons: ["workflow is waiting at a user gate"] },
        forbiddenTool: "select_mode",
        requiredGate: "user-approval",
      },
      {
        request: "continue the current workflow",
        currentWorkflow: { phaseState: "USER_GATE", blockedReasons: ["workflow is waiting at a user gate"] },
        forbiddenTool: "select_mode",
        requiredGate: "user-approval",
      },
      {
        request: "switch to active-product-work now",
        currentWorkflow: { phaseState: "ESCAPE_HATCH", blockedReasons: ["escape hatch requires user decision"] },
        forbiddenTool: "select_mode",
        requiredGate: "user-approval",
      },
      {
        request: "switch to active-product-work now",
        currentWorkflow: { phaseState: "DRAFT", unresolvedHumanGateCount: 1, blockedReasons: ["unresolved human gate"] },
        forbiddenTool: "select_mode",
        requiredGate: "human-gate",
      },
      {
        request: "switch to active-product-work now",
        currentWorkflow: { phaseState: "TASK_REVIEW", blockedReasons: ["task review pending"] },
        forbiddenTool: "select_mode",
        requiredGate: "task-review",
      },
      {
        request: "switch to active-product-work now",
        currentWorkflow: { phaseState: "DRAFT", activeFileClaims: ["packages/core/product-management-service.ts"], blockedReasons: ["active file claim"] },
        forbiddenTool: "select_mode",
        requiredGate: "workflow-switch",
      },
      {
        request: "edit packages/core/unapproved.ts for this workflow",
        currentWorkflow: { phase: "IMPLEMENTATION", phaseState: "SCHEDULING", blockedReasons: ["allowlist approval required"] },
        forbiddenTool: "apply_task_boundary_change",
        requiredGate: "allowlist-approval",
      },
      {
        request: "rewrite completed task task-1 instead of creating corrective work",
        currentWorkflow: { phase: "IMPLEMENTATION", phaseState: "SCHEDULING", currentTaskId: "task-1", blockedReasons: ["completed task history is immutable"] },
        forbiddenTool: "mark_task_complete",
        requiredGate: "artifact-review",
      },
    ] as const

    for (const testCase of cases) {
      const service = await loadService({
        roadmap: makeRoadmap(),
        currentWorkflow: {
          ...testCase.currentWorkflow,
          blockedReasons: [...testCase.currentWorkflow.blockedReasons],
          ...("activeFileClaims" in testCase.currentWorkflow ? { activeFileClaims: [...testCase.currentWorkflow.activeFileClaims] } : {}),
        },
      })
      const result = await service.assessRequest({ request: testCase.request, featureName: "autonomous-product-management" })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.decision).toBe("ask-user")
        expect(result.value.suggestedToolCalls.map((call) => call.toolName)).not.toContain(testCase.forbiddenTool)
        expect(result.value.requiredGates.map((gate) => gate.kind)).toContain(testCase.requiredGate)
        expect(result.value.diagnostics.join(" ")).toContain(testCase.currentWorkflow.blockedReasons[0])
      }
    }
  })

  it("returns degraded context diagnostics for assessment and listing when roadmap projections are unavailable", async () => {
    const service = await loadService()

    const assessment = await service.assessRequest({ request: "what should we do next?" })
    const workList = await service.listWork({ maxCandidates: 5 })

    expect(assessment.ok).toBe(true)
    expect(workList.ok).toBe(true)
    if (assessment.ok) expect(assessment.value.diagnostics.join(" ")).toContain("degraded")
    if (workList.ok) expect(workList.value.diagnostics.join(" ")).toContain("degraded")
  })

  it("degrades list work to attached roadmap context and current workflow when roadmap persistence is unavailable", async () => {
    const service = await loadService({
      roadmapContext: {
        graph: { nodes: [], edges: [], activeNodeIds: ["active-1"], frozenNodeIds: ["frozen-1"], abandonedNodeIds: [] },
        items: roadmapItems,
        edges: [{ from: "active-1", to: "frozen-1", kind: "depends-on" }],
        selectedItemIds: ["active-1", "frozen-1"],
      },
    })

    const workList = await service.listWork({ roadmapItemIds: ["active-1"], maxCandidates: 10 })

    expect(workList.ok).toBe(true)
    if (workList.ok) {
      expect(workList.value.candidates.map((candidate) => candidate.roadmapNode?.item.id).filter(Boolean)).toEqual(["active-1"])
      expect(workList.value.candidates.some((candidate) => candidate.workflow?.featureName === "autonomous-product-management")).toBe(true)
      expect(workList.value.diagnostics).toEqual(expect.arrayContaining(["using attached roadmap context fallback", "using current workflow context fallback"]))
    }
  })

  it("uses workflow, roadmap, and repository context in assessment and listing", async () => {
    const module = await import("#core/product-management-service") as {
      createProductManagementService(input: Record<string, unknown>): ProductManagementService
    }
    const currentWorkflow = {
      workflowId: "workflow-1",
      featureName: "autonomous-product-management",
      mode: "INCREMENTAL",
      phase: "IMPLEMENTATION",
      phaseState: "SCHEDULING",
      roadmapItemIds: ["active-1"],
      unresolvedHumanGateCount: 0,
      pendingPatchSuggestionCount: 0,
      activeFileClaims: [],
      safeToSwitch: true,
      blockedReasons: [],
    }
    const service = module.createProductManagementService({
      roadmap: makeRoadmap(),
      currentWorkflow,
      roadmapContext: {
        graph: { nodes: [], edges: [], activeNodeIds: ["active-1"], frozenNodeIds: ["frozen-1"], abandonedNodeIds: ["abandoned-1"] },
        items: roadmapItems,
        edges: [{ from: "active-1", to: "frozen-1", kind: "depends-on" }],
        selectedItemIds: ["active-1"],
      },
      humanGates: { async listGates() { return { ok: true, value: [{ id: "gate-1" }] } } },
      patchSuggestions: { async listSuggestions() { return { ok: true, value: [{ id: "patch-1" }, { id: "patch-2" }] } } },
      agentLeases: {
        async listLeases() { return { ok: true, value: [{ id: "lease-1" }] } },
        async listFileClaims() { return { ok: true, value: [{ path: "packages/core/product-management-service.ts" }] } },
      },
    })

    const assessment = await service.assessRequest({
      request: "what should we do next?",
      roadmapItemIds: ["active-1"],
      includeWorkflowCandidates: true,
    })
    const work = await service.listWork({ lifecycles: ["active"], maxCandidates: 10 })

    expect(assessment.ok).toBe(true)
    if (assessment.ok) {
      const diagnostics = assessment.value.diagnostics.join(" ")
      expect(diagnostics).toContain("workflow candidate autonomous-product-management is safe")
      expect(diagnostics).toContain("roadmap context contains 1 active, 1 frozen, and 1 abandoned nodes")
      expect(diagnostics).toContain("selected roadmap nodes available: 1/1")
      expect(diagnostics).toContain("unresolved human gates: 1")
      expect(diagnostics).toContain("pending patch suggestions: 2")
      expect(diagnostics).toContain("active file claims from agent leases: 1")
      expect(assessment.value.rejectedAlternatives.length).toBeGreaterThan(0)
      expect(assessment.value.provenance.map((entry) => entry.source)).toEqual(expect.arrayContaining(["workflow-state", "roadmap"]))
    }
    expect(work.ok).toBe(true)
    if (work.ok) {
      expect(work.value.candidates.some((candidate) => candidate.workflow?.featureName === "autonomous-product-management")).toBe(true)
    }
  })
})
