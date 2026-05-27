import type { RoadmapEdge, RoadmapItem, RoadmapItemKind, RoadmapItemStatus } from "./roadmap-types"
import type { DbRoadmapEdge, DbRoadmapItem } from "./open-artisan-repository"
import type {
  ProductManagementAssessRequestInput,
  ProductManagementDecision,
  ProductManagementDecisionKind,
  ProductManagementListWorkInput,
  ProductManagementMetricEvent,
  ProductManagementOperationalSignal,
  ProductManagementProvenance,
  ProductManagementQueueItemInput,
  ProductManagementQueueItemResult,
  ProductManagementQueuedItemKind,
  ProductManagementResult,
  ProductManagementRoadmapNodeLifecycle,
  ProductManagementService,
  ProductManagementServiceDependencies,
  ProductManagementToolCallSuggestion,
  ProductManagementWorkCandidate,
  ProductManagementWorkList,
  ProductManagementWorkflowSummary,
} from "./product-management-types"

const DEFAULT_MAX_CANDIDATES = 20

function ok<T>(value: T): ProductManagementResult<T> {
  return { ok: true, value }
}

function error(code: "invalid-input" | "not-found" | "storage-failure", message: string, retryable = false): ProductManagementResult<never> {
  return { ok: false, error: { code, message, retryable } }
}

async function emitMetric(deps: ProductManagementServiceDependencies, event: ProductManagementMetricEvent): Promise<void> {
  await deps.emitMetric?.(event)
}

async function emitLog(deps: ProductManagementServiceDependencies, signal: ProductManagementOperationalSignal, message: string): Promise<void> {
  await deps.emitLog?.({
    signal,
    status: signal === "missing-roadmap-service" || signal === "degraded-context" ? "degraded" : "ready",
    ...(deps.currentWorkflow?.featureName ? { featureName: deps.currentWorkflow.featureName } : {}),
    ...(deps.currentWorkflow?.roadmapItemIds.length ? { roadmapItemIds: deps.currentWorkflow.roadmapItemIds } : {}),
    message,
    userRequestLogged: false,
  })
}

function queueKindToRoadmapKind(kind: ProductManagementQueuedItemKind): RoadmapItemKind {
  switch (kind) {
    case "feature":
      return "feature"
    case "bug":
    case "issue":
      return "bug"
    case "debt":
      return "debt"
    case "chore":
    case "follow-up":
      return "chore"
  }
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "queued-item"
}

function toRoadmapItem(item: DbRoadmapItem | RoadmapItem): RoadmapItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ...(item.description !== undefined ? { description: item.description } : {}),
    status: item.status,
    priority: item.priority,
    ...(item.featureName !== undefined ? { featureName: item.featureName } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

function toRoadmapEdge(edge: DbRoadmapEdge | RoadmapEdge): RoadmapEdge {
  if ("from" in edge) return edge
  return { from: edge.fromItemId, to: edge.toItemId, kind: edge.kind }
}

function lifecycleForItem(item: RoadmapItem): ProductManagementRoadmapNodeLifecycle {
  const description = item.description?.toLowerCase() ?? ""
  if (item.status === "dropped" || description.includes("lifecycle:abandoned")) return "abandoned"
  if (item.status === "done" || description.includes("lifecycle:frozen")) return "frozen"
  if (item.status === "in-progress") return "active"
  return "active"
}

function statusForItem(item: RoadmapItem): ProductManagementWorkCandidate["status"] {
  const lifecycle = lifecycleForItem(item)
  if (lifecycle === "frozen" || lifecycle === "abandoned") return lifecycle
  if (item.status === "in-progress") return "active"
  if (item.status === "blocked") return "blocked"
  if (item.status === "done") return "complete"
  if (item.status === "dropped") return "dropped"
  return "ready"
}

function candidateForItem(item: RoadmapItem): ProductManagementWorkCandidate {
  const lifecycle = lifecycleForItem(item)
  const status = statusForItem(item)
  const safeToStart = lifecycle === "active" && (item.status === "todo" || item.status === "in-progress")
  const reason = safeToStart ? "roadmap node is active" : `roadmap node is ${lifecycle}`
  const reasons = [reason]
  return {
    roadmapNode: { item, lifecycle, reason },
    status,
    priority: item.priority,
    safeToStart,
    reasons,
  }
}

function candidateForWorkflow(workflow: ProductManagementWorkflowSummary): ProductManagementWorkCandidate {
  return {
    workflow,
    status: workflow.safeToSwitch ? "active" : "gated",
    priority: workflow.safeToSwitch ? 1 : 0,
    safeToStart: workflow.safeToSwitch,
    reasons: workflow.safeToSwitch ? ["workflow is safe to continue or switch"] : workflow.blockedReasons,
  }
}

function rejectedAlternativesForDecision(decision: ProductManagementDecisionKind): ProductManagementDecision["rejectedAlternatives"] {
  switch (decision) {
    case "queue-roadmap-item":
      return [
        { decision: "revise-current-artifact", reason: "Product-memory capture must not revise the gated artifact unless the user asks for artifact changes." },
        { decision: "switch-workflow", reason: "Queueing preserves the active workflow instead of switching execution context." },
      ]
    case "revise-current-artifact":
      return [{ decision: "queue-roadmap-item", reason: "The request targets the current artifact rather than future product memory." }]
    case "switch-workflow":
      return [{ decision: "queue-roadmap-item", reason: "The request asks to change active execution context, not just remember future work." }]
    case "ask-user":
      return [{ decision: "continue-current-workflow", reason: "Available context is insufficient or a safety gate blocks autonomous action." }]
    default:
      return [{ decision: "continue-current-workflow", reason: `The request is better represented as ${decision}.` }]
  }
}

function toolForDecision(decision: ProductManagementDecisionKind): ProductManagementToolCallSuggestion[] {
  switch (decision) {
    case "queue-roadmap-item":
      return [{ toolName: "product_management_queue_item", reason: "Capture this as product memory without mutating the current workflow." }]
    case "propose-roadmap-item":
      return [{ toolName: "roadmap_upsert_item", reason: "Create or propose a roadmap node through the roadmap tool surface." }]
    case "propose-roadmap-edge":
      return [{ toolName: "roadmap_upsert_edge", reason: "Connect roadmap nodes explicitly through a roadmap edge." }]
    case "freeze-roadmap-node":
    case "abandon-roadmap-node":
    case "reopen-roadmap-node":
    case "supersede-roadmap-node":
      return [{ toolName: "roadmap_update_item_status", reason: "Use explicit roadmap lifecycle/status mutation tooling." }]
    case "revise-current-artifact":
      return [{ toolName: "submit_feedback", reason: "Artifact revisions must go through the active user gate." }]
    case "backtrack-current-artifact":
      return [{ toolName: "propose_backtrack", reason: "Backtracking must be routed through the workflow backtrack tool." }]
    case "request-allowlist-expansion":
      return [{ toolName: "request_allowlist_expansion", reason: "File scope expansion requires explicit allowlist approval." }]
    case "switch-workflow":
      return [{ toolName: "select_mode", reason: "Workflow switching must be explicit and gated by workflow state." }]
    case "continue-current-workflow":
    case "ask-user":
      return []
  }
}

function appendMetadata(lines: string[], key: string, value: string | string[] | undefined): void {
  if (Array.isArray(value)) {
    if (value.length > 0) lines.push(`${key}:${value.join(",")}`)
    return
  }
  if (value?.trim()) lines.push(`${key}:${value}`)
}

function queueItemDescription(input: ProductManagementQueueItemInput): string {
  const metadata = [`requestedKind:${input.kind}`]
  appendMetadata(metadata, "sourceWorkflowId", input.source?.workflowId)
  appendMetadata(metadata, "sourceFeatureName", input.source?.featureName)
  appendMetadata(metadata, "sourceSessionId", input.source?.sessionId)
  appendMetadata(metadata, "sourceTaskId", input.source?.taskId)
  appendMetadata(metadata, "sourceArtifactKey", input.source?.artifactKey)
  appendMetadata(metadata, "sourceArtifactPath", input.source?.artifactPath)
  appendMetadata(metadata, "sourceMessageId", input.source?.messageId)
  appendMetadata(metadata, "discoveredFeatureName", input.discoveredWhile?.currentFeatureName)
  appendMetadata(metadata, "discoveredPhase", input.discoveredWhile?.currentPhase)
  appendMetadata(metadata, "discoveredPhaseState", input.discoveredWhile?.currentPhaseState)
  appendMetadata(metadata, "discoveredMode", input.discoveredWhile?.currentMode)
  appendMetadata(metadata, "discoveredTaskId", input.discoveredWhile?.currentTaskId)
  appendMetadata(metadata, "discoveredRoadmapItemIds", input.discoveredWhile?.roadmapItemIds)
  appendMetadata(metadata, "executionSliceId", input.discoveredWhile?.executionSliceId)
  return `${input.description}\n\n${metadata.join("\n")}`
}

function queueItemProvenance(input: ProductManagementQueueItemInput): ProductManagementProvenance[] {
  const provenance: ProductManagementProvenance[] = [{ source: "user-request", reference: input.source?.messageId ?? input.title }]
  const sourceWorkflowParts = [
    input.source?.workflowId ? `workflow:${input.source.workflowId}` : undefined,
    input.source?.featureName ? `feature:${input.source.featureName}` : undefined,
    input.source?.sessionId ? `session:${input.source.sessionId}` : undefined,
    input.source?.taskId ? `task:${input.source.taskId}` : undefined,
  ].filter((part): part is string => part !== undefined)
  if (sourceWorkflowParts.length > 0) provenance.push({ source: "workflow-state", reference: sourceWorkflowParts.join(" ") })
  const artifactParts = [
    input.source?.artifactKey ? `artifactKey:${input.source.artifactKey}` : undefined,
    input.source?.artifactPath ? `artifactPath:${input.source.artifactPath}` : undefined,
  ].filter((part): part is string => part !== undefined)
  if (artifactParts.length > 0) provenance.push({ source: "artifact", reference: artifactParts.join(" ") })
  if (input.discoveredWhile) {
    const discoveredParts = [
      input.discoveredWhile.currentFeatureName ? `feature:${input.discoveredWhile.currentFeatureName}` : undefined,
      input.discoveredWhile.currentPhase ? `phase:${input.discoveredWhile.currentPhase}` : undefined,
      input.discoveredWhile.currentPhaseState ? `state:${input.discoveredWhile.currentPhaseState}` : undefined,
      input.discoveredWhile.currentTaskId ? `task:${input.discoveredWhile.currentTaskId}` : undefined,
      input.discoveredWhile.executionSliceId ? `slice:${input.discoveredWhile.executionSliceId}` : undefined,
    ].filter((part): part is string => part !== undefined)
    if (discoveredParts.length > 0) provenance.push({ source: "workflow-state", reference: discoveredParts.join(" ") })
    if (input.discoveredWhile.roadmapItemIds?.length) provenance.push({ source: "roadmap", reference: input.discoveredWhile.roadmapItemIds.join(",") })
  }
  return provenance
}

function buildDecision(
  decision: ProductManagementDecisionKind,
  rationale: string,
  input: ProductManagementAssessRequestInput,
  diagnostics: string[] = [],
  currentWorkflow?: ProductManagementWorkflowSummary,
): ProductManagementDecision {
  return {
    decision,
    rationale,
    confidence: decision === "ask-user" ? "medium" : "high",
    ...(input.featureName ? { targetFeatureName: input.featureName } : {}),
    ...(input.roadmapItemIds ? { targetRoadmapItemIds: input.roadmapItemIds } : {}),
    suggestedToolCalls: toolForDecision(decision),
    requiredGates: [],
    rejectedAlternatives: rejectedAlternativesForDecision(decision),
    provenance: [
      { source: "user-request", reference: input.request.slice(0, 120) },
      ...(currentWorkflow ? [{ source: "workflow-state" as const, reference: `${currentWorkflow.featureName}:${currentWorkflow.phase}/${currentWorkflow.phaseState}` }] : []),
      ...(input.roadmapItemIds?.length ? [{ source: "roadmap" as const, reference: input.roadmapItemIds.join(",") }] : []),
    ],
    diagnostics,
  }
}

async function buildContextDiagnostics(
  deps: ProductManagementServiceDependencies,
  input: ProductManagementAssessRequestInput,
  currentWorkflow: ProductManagementWorkflowSummary | undefined,
): Promise<string[]> {
  const diagnostics: string[] = []
  if (input.includeWorkflowCandidates && currentWorkflow) {
    diagnostics.push(`workflow candidate ${currentWorkflow.featureName} is ${currentWorkflow.safeToSwitch ? "safe" : "blocked"}`)
  }
  if (deps.roadmapContext) {
    diagnostics.push(
      `roadmap context contains ${deps.roadmapContext.graph.activeNodeIds.length} active, ` +
      `${deps.roadmapContext.graph.frozenNodeIds.length} frozen, and ${deps.roadmapContext.graph.abandonedNodeIds.length} abandoned nodes`,
    )
  }
  if (input.roadmapItemIds?.length && deps.roadmap) {
    const listed = await deps.roadmap.listItems()
    if (listed.ok) {
      const requested = new Set(input.roadmapItemIds)
      diagnostics.push(`selected roadmap nodes available: ${listed.value.filter((item) => requested.has(item.id)).length}/${input.roadmapItemIds.length}`)
    } else {
      diagnostics.push(`roadmap context unavailable: ${listed.error.message}`)
    }
  }
  if (currentWorkflow?.workflowId && deps.humanGates) {
    const gates = await deps.humanGates.listGates(currentWorkflow.workflowId, false)
    diagnostics.push(gates.ok ? `unresolved human gates: ${gates.value.length}` : `human-gate context unavailable: ${gates.error.message}`)
  }
  if (currentWorkflow?.workflowId && deps.patchSuggestions) {
    const suggestions = await deps.patchSuggestions.listSuggestions(currentWorkflow.workflowId, "pending")
    diagnostics.push(suggestions.ok ? `pending patch suggestions: ${suggestions.value.length}` : `patch-suggestion context unavailable: ${suggestions.error.message}`)
  }
  if (currentWorkflow?.workflowId && deps.agentLeases) {
    const leases = await deps.agentLeases.listLeases(currentWorkflow.workflowId)
    if (leases.ok) {
      let fileClaimCount = 0
      for (const lease of leases.value) {
        const claims = await deps.agentLeases.listFileClaims(lease.id)
        if (claims.ok) fileClaimCount += claims.value.length
      }
      diagnostics.push(`active file claims from agent leases: ${fileClaimCount}`)
    } else {
      diagnostics.push(`agent-lease context unavailable: ${leases.error.message}`)
    }
  }
  return diagnostics
}

async function selectedRoadmapDiagnostics(
  deps: ProductManagementServiceDependencies,
  input: ProductManagementAssessRequestInput,
): Promise<{ diagnostics: string[]; unsafeLifecycleReason?: string }> {
  if (!input.roadmapItemIds?.length || !deps.roadmap) return { diagnostics: [] }
  const listed = await deps.roadmap.listItems()
  if (!listed.ok) return { diagnostics: [`roadmap lifecycle context unavailable: ${listed.error.message}`] }
  const requested = new Set(input.roadmapItemIds)
  const selected = listed.value.map(toRoadmapItem).filter((item) => requested.has(item.id))
  const diagnostics = selected.map((item) => `selected roadmap node ${item.id} is ${lifecycleForItem(item)} with priority ${item.priority}`)
  const unsafe = selected.find((item) => lifecycleForItem(item) !== "active")
  return {
    diagnostics,
    ...(unsafe ? { unsafeLifecycleReason: `selected roadmap node ${unsafe.id} is ${lifecycleForItem(unsafe)}` } : {}),
  }
}

function safetyGateForWorkflow(currentWorkflow: ProductManagementWorkflowSummary | undefined): null | {
  reason: string
  gate: ProductManagementDecision["requiredGates"][number]
} {
  if (!currentWorkflow) return null
  const firstReason = currentWorkflow.blockedReasons[0] ?? "workflow is not at a safe boundary"
  if (currentWorkflow.phaseState === "USER_GATE") return { reason: firstReason, gate: { kind: "user-approval", reason: firstReason } }
  if (currentWorkflow.phaseState === "ESCAPE_HATCH") return { reason: firstReason, gate: { kind: "user-approval", reason: firstReason } }
  if (currentWorkflow.unresolvedHumanGateCount > 0) return { reason: firstReason, gate: { kind: "human-gate", reason: firstReason } }
  if (currentWorkflow.phaseState === "TASK_REVIEW") return { reason: firstReason, gate: { kind: "task-review", reason: firstReason } }
  if (currentWorkflow.activeFileClaims.length > 0) return { reason: firstReason, gate: { kind: "workflow-switch", reason: firstReason } }
  if (firstReason.includes("allowlist")) return { reason: firstReason, gate: { kind: "allowlist-approval", reason: firstReason } }
  if (firstReason.includes("completed task")) return { reason: firstReason, gate: { kind: "artifact-review", reason: firstReason } }
  return null
}

function classifyRequest(input: ProductManagementAssessRequestInput, currentWorkflow: ProductManagementWorkflowSummary | undefined): ProductManagementDecision {
  const request = input.request.toLowerCase()
  const safetyGate = safetyGateForWorkflow(currentWorkflow)
  const requestsCurrentContinuation = request === "continue" || request.includes("continue current") || request.includes("continue the current")
  if (safetyGate && (request.includes("switch") || request.includes("edit") || request.includes("rewrite") || request.includes("interrupt") || requestsCurrentContinuation)) {
    const decision = buildDecision("ask-user", "Current workflow safety gates must be resolved before product-management action can proceed.", input, [safetyGate.reason], currentWorkflow)
    decision.requiredGates = [safetyGate.gate]
    decision.suggestedToolCalls = []
    return decision
  }

  let decision: ProductManagementDecisionKind = "ask-user"
  if (request.includes("file a bug") || request.includes("handle it later") || request.includes("for later")) decision = "queue-roadmap-item"
  else if (request.includes("continue")) decision = "continue-current-workflow"
  else if (request.includes("revise")) decision = "revise-current-artifact"
  else if (request.includes("backtrack")) decision = "backtrack-current-artifact"
  else if (request.includes("unapproved file") || request.includes("allowlist")) decision = "request-allowlist-expansion"
  else if (request.includes("new roadmap node") || request.includes("create a new roadmap node")) decision = "propose-roadmap-item"
  else if (request.includes("dependency edge") || request.includes("new edge")) decision = "propose-roadmap-edge"
  else if (request.includes("supersede")) decision = "supersede-roadmap-node"
  else if (request.includes("freeze")) decision = "freeze-roadmap-node"
  else if (request.includes("abandon")) decision = "abandon-roadmap-node"
  else if (request.includes("switch")) decision = "switch-workflow"
  else if (request.includes("reopen")) decision = "reopen-roadmap-node"
  else if (request.includes("queue")) decision = "queue-roadmap-item"

  return buildDecision(decision, `Classified product-management request as ${decision}.`, input, [], currentWorkflow)
}

export function createProductManagementService(deps: ProductManagementServiceDependencies): ProductManagementService {
  const maxCandidates = deps.options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES

  return {
    async health() {
      const signals: ProductManagementOperationalSignal[] = []
      if (!deps.roadmap) signals.push("missing-roadmap-service", "degraded-context")
      if (!deps.workflow) signals.push("missing-workflow-service")
      return {
        status: signals.length === 0 ? "ready" : "degraded",
        signals,
        diagnostics: signals.length === 0 ? [] : [`product-management context degraded: ${signals.join(", ")}`],
      }
    },

    async assessRequest(input) {
      if (!input.request.trim()) return error("invalid-input", "request is required")
      const decision = classifyRequest(input, deps.currentWorkflow)
      decision.diagnostics.push(...await buildContextDiagnostics(deps, input, deps.currentWorkflow))
      const selectedContext = await selectedRoadmapDiagnostics(deps, input)
      decision.diagnostics.push(...selectedContext.diagnostics)
      if (selectedContext.unsafeLifecycleReason && (decision.decision === "continue-current-workflow" || decision.decision === "switch-workflow")) {
        decision.requiredGates.push({ kind: "roadmap-mutation", reason: selectedContext.unsafeLifecycleReason })
        decision.rejectedAlternatives.push({ decision: decision.decision, reason: selectedContext.unsafeLifecycleReason })
        decision.suggestedToolCalls = []
      }
      if (!deps.roadmap) {
        decision.diagnostics.push("degraded context: roadmap service unavailable")
        await emitLog(deps, "missing-roadmap-service", "assess_request running without roadmap persistence")
      }
      await emitMetric(deps, {
        name: "product-management.assess-request",
        status: deps.roadmap ? "ready" : "degraded",
        decision: decision.decision,
        requiredGateCount: decision.requiredGates.length,
      })
      return ok(decision)
    },

    async listWork(input) {
      const diagnostics: string[] = []
      if (!deps.roadmap) {
        diagnostics.push("degraded context: roadmap service unavailable")
        const lifecycles = new Set(input.lifecycles ?? ["active", "frozen", "abandoned"])
        const statuses = new Set<RoadmapItemStatus>(input.statuses ?? [])
        const selectedIds = new Set(input.roadmapItemIds ?? [])
        const roadmapCandidates = (deps.roadmapContext?.items ?? [])
          .map((item) => candidateForItem(toRoadmapItem(item)))
          .filter((candidate) => selectedIds.size === 0 || selectedIds.has(candidate.roadmapNode!.item.id))
          .filter((candidate) => lifecycles.has(candidate.roadmapNode!.lifecycle))
          .filter((candidate) => statuses.size === 0 || statuses.has(candidate.roadmapNode!.item.status))
          .filter((candidate) => input.minPriority === undefined || candidate.priority >= input.minPriority)
        const workflowCandidates = deps.currentWorkflow ? [candidateForWorkflow(deps.currentWorkflow)] : []
        const candidates = [...roadmapCandidates, ...workflowCandidates]
          .sort((a, b) => Number(b.safeToStart) - Number(a.safeToStart) || b.priority - a.priority)
          .slice(0, input.maxCandidates ?? maxCandidates)
        if (deps.roadmapContext) diagnostics.push("using attached roadmap context fallback")
        if (deps.currentWorkflow) diagnostics.push("using current workflow context fallback")
        await emitLog(deps, "missing-roadmap-service", "list_work running without roadmap persistence")
        await emitMetric(deps, {
          name: "product-management.list-work",
          status: "degraded",
          candidateCount: candidates.length,
        })
        return ok({ candidates, diagnostics })
      }

      const statusFilters = input.statuses ?? []
      const listed = await deps.roadmap.listItems(input.featureName || statusFilters.length === 1
        ? { ...(input.featureName ? { featureName: input.featureName } : {}), ...(statusFilters.length === 1 ? { status: statusFilters[0] } : {}) }
        : undefined)
      if (!listed.ok) return error("storage-failure", listed.error.message, listed.error.retryable)

      const lifecycles = new Set(input.lifecycles ?? ["active", "frozen", "abandoned"])
      const statuses = new Set<RoadmapItemStatus>(input.statuses ?? [])
      const selectedIds = new Set(input.roadmapItemIds ?? [])
      const roadmapCandidates = listed.value
        .map((item) => candidateForItem(toRoadmapItem(item)))
        .filter((candidate) => selectedIds.size === 0 || selectedIds.has(candidate.roadmapNode!.item.id))
        .filter((candidate) => lifecycles.has(candidate.roadmapNode!.lifecycle))
        .filter((candidate) => statuses.size === 0 || statuses.has(candidate.roadmapNode!.item.status))
        .filter((candidate) => input.minPriority === undefined || candidate.priority >= input.minPriority)
      const workflowCandidates = deps.currentWorkflow ? [candidateForWorkflow(deps.currentWorkflow)] : []
      const candidates = [...roadmapCandidates, ...workflowCandidates]
        .sort((a, b) => Number(b.safeToStart) - Number(a.safeToStart) || b.priority - a.priority)
        .slice(0, input.maxCandidates ?? maxCandidates)
      await emitMetric(deps, {
        name: "product-management.list-work",
        status: "ready",
        candidateCount: candidates.length,
      })

      return ok({ candidates, diagnostics } satisfies ProductManagementWorkList)
    },

    async queueItem(input) {
      if (!input.title.trim()) return error("invalid-input", "title is required")
      if (!input.description.trim()) return error("invalid-input", "description is required")
      if (!deps.roadmap) {
        await emitLog(deps, "missing-roadmap-service", "queue_item requires roadmap persistence")
        await emitMetric(deps, {
          name: "product-management.queue-item",
          status: "degraded",
          queuedItemKind: input.kind,
        })
        return error("storage-failure", "roadmap service is required to queue product-management items")
      }

      const persistedKind = queueKindToRoadmapKind(input.kind)
      const now = new Date().toISOString()
      const item: RoadmapItem = {
        id: `pm-${slug(input.title)}-${Date.now()}`,
        kind: persistedKind,
        title: input.title,
        description: queueItemDescription(input),
        status: "todo",
        priority: input.priority ?? 5,
        ...(input.source?.featureName ? { featureName: input.source.featureName } : {}),
        createdAt: now,
        updatedAt: now,
      }

      const created = await deps.roadmap.createItem(item)
      if (!created.ok) return error("storage-failure", created.error.message, created.error.retryable)
      await emitLog(deps, "queued-item-created", `queued product-management item ${item.id}`)
      await emitMetric(deps, {
        name: "product-management.queue-item",
        status: "ready",
        queuedItemKind: input.kind,
      })
      const createdItem = toRoadmapItem(created.value as DbRoadmapItem | RoadmapItem)
      const suggestedEdges = input.suggestedEdges ?? []
      const result: ProductManagementQueueItemResult = {
        queuedNode: {
          node: { item: createdItem, lifecycle: "proposed", reason: "queued from product-management chat" },
          requestedKind: input.kind,
          persistedKind,
        },
        appliedEdges: [],
        suggestedEdges: suggestedEdges.map(toRoadmapEdge),
        provenance: queueItemProvenance(input),
        diagnostics: [deps.currentWorkflow ? `current workflow remains at ${deps.currentWorkflow.phase}/${deps.currentWorkflow.phaseState}` : "no active workflow context"],
        followUpWorkflowActionRequired: false,
        currentWorkflowUnchanged: true,
        ...(deps.currentWorkflow ? { currentWorkflow: deps.currentWorkflow } : {}),
      }
      return ok(result)
    },
  }
}
