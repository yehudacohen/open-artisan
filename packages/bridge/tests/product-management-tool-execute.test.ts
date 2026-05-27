import { afterEach, beforeEach, expect, it, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { handleInit, handleSessionCreated } from "#bridge/methods/lifecycle"
import { handleToolExecute } from "#bridge/methods/tool-execute"
import type { BridgeContext } from "#bridge/server"
import type { EngineContext } from "#core/engine-context"
import { pgliteShardDescribe } from "../../../tests/helpers/pglite-shard-gate"

setDefaultTimeout(90_000)
process.env["OPENARTISAN_SESSION_STORE_OPERATION_TIMEOUT_MS"] = "120000"
process.env["OPENARTISAN_PGLITE_QUEUE_WAIT_TIMEOUT_MS"] = "120000"

let tmpDir: string
let ctx: BridgeContext

function makeBridgeContext(): BridgeContext {
  let engine: EngineContext | null = null
  let policyVersion = 0
  return {
    get engine() { return engine },
    get policyVersion() { return policyVersion },
    bumpPolicyVersion() { policyVersion++ },
    setEngine(e: EngineContext) { engine = e },
    stateDir: null,
    projectDir: null,
    capabilities: { selfReview: "agent-only", orchestrator: false, discoveryFleet: false },
    runtimeBackendKind: "filesystem",
    runtimeBackendInfo: { backendKind: "filesystem", stateDir: null, pgliteDataDir: null, pgliteDatabaseFileName: null, pgliteSchemaName: null },
    roadmapBackend: null,
    roadmapService: null,
    openArtisanServices: null,
    pinoLogger: null,
    shuttingDown: false,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-product-management-"))
  ctx = makeBridgeContext()
  await handleInit({
    projectDir: tmpDir,
    persistence: { kind: "db", pglite: { dataDir: join(tmpDir, ".openartisan", "runtime-db") } },
  }, ctx)
  await handleSessionCreated({ sessionId: "s1", agent: "hermes" }, ctx)
})

afterEach(async () => {
  await ctx.runtimeBackendDispose?.()
  await rm(tmpDir, { recursive: true, force: true })
})

pgliteShardDescribe("bridge product-management tool execution", () => {
  it("assesses product-management requests through tool.execute with typed decisions", async () => {
    const response = await handleToolExecute({
      name: "product_management_assess_request",
      args: {
        request: "we should file a bug for this edge case and keep reviewing",
        feature_name: "autonomous-product-management",
        include_workflow_candidates: true,
      },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    const parsed = JSON.parse(response as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.decision).toBe("queue-roadmap-item")
    expect(parsed.value.suggestedToolCalls.map((call: { toolName: string }) => call.toolName)).toContain("product_management_queue_item")
  })

  it("routes USER_GATE execution decisions through ask-user instead of workflow switching", async () => {
    await ctx.engine!.store.update("s1", (state) => {
      state.featureName = "autonomous-product-management"
      state.mode = "INCREMENTAL"
      state.phase = "PLANNING"
      state.phaseState = "USER_GATE"
      state.userGateMessageReceived = true
      state.roadmapContext = {
        roadmapItemIds: ["apm-1"],
        roadmapItems: [],
        edges: [],
        featureName: "autonomous-product-management",
        executionSliceId: "apm-slice-1",
        attachedAt: "2026-05-21T00:00:00.000Z",
      }
    })

    const response = await handleToolExecute({
      name: "product_management_assess_request",
      args: {
        request: "switch to another workflow now",
        feature_name: "autonomous-product-management",
        include_workflow_candidates: true,
      },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    const parsed = JSON.parse(response as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.decision).toBe("ask-user")
    expect(parsed.value.suggestedToolCalls.map((call: { toolName: string }) => call.toolName)).not.toContain("select_mode")
    expect(parsed.value.requiredGates).toEqual([{ kind: "user-approval", reason: "workflow is waiting at a user gate" }])
  })

  it("lists work through tool.execute including active, frozen, and abandoned lifecycle context", async () => {
    const response = await handleToolExecute({
      name: "product_management_list_work",
      args: {
        lifecycles: ["active", "frozen", "abandoned"],
        max_candidates: 10,
      },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    const parsed = JSON.parse(response as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.candidates).toBeArray()
    expect(parsed.value.diagnostics).toBeArray()
  })

  it("queues product-management items through tool.execute without advancing workflow gates", async () => {
    const before = JSON.parse(JSON.stringify(ctx.engine!.store.get("s1")))

    const response = await handleToolExecute({
      name: "product_management_queue_item",
      args: {
        title: "Capture gate-safe chat",
        description: "A user noticed a follow-up while reviewing an artifact.",
        kind: "follow-up",
        priority: 5,
        source: { workflowId: "workflow-1", sessionId: "s1", artifactKey: "plan" },
        discovered_while: {
          request: "file this for later",
          currentFeatureName: "autonomous-product-management",
          currentPhase: before.phase,
          currentPhaseState: before.phaseState,
          currentMode: before.mode ?? "INCREMENTAL",
        },
      },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    const parsed = JSON.parse(response as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.queuedNode.requestedKind).toBe("follow-up")
    expect(parsed.value.currentWorkflowUnchanged).toBe(true)
    const after = ctx.engine!.store.get("s1")
    expect(after).not.toBeNull()
    expect(after!.phase).toBe(before.phase)
    expect(after!.phaseState).toBe(before.phaseState)
  })

  it("returns typed invalid-input errors for malformed product-management queue requests", async () => {
    const response = await handleToolExecute({
      name: "product_management_queue_item",
      args: { title: "Missing required fields", kind: "idea" },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    const parsed = JSON.parse(response as string)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("invalid-input")
    expect(parsed.error.retryable).toBe(false)
  })

  it("returns typed invalid-input errors for malformed assess/list requests", async () => {
    const assessResponse = await handleToolExecute({
      name: "product_management_assess_request",
      args: { request: "" },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)
    const listResponse = await handleToolExecute({
      name: "product_management_list_work",
      args: { max_candidates: 0 },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)

    expect(JSON.parse(assessResponse as string)).toMatchObject({ ok: false, error: { code: "invalid-input", retryable: false } })
    expect(JSON.parse(listResponse as string)).toMatchObject({ ok: false, error: { code: "invalid-input", retryable: false } })
  })
})
