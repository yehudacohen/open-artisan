import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { handleInit, handleSessionCreated } from "#bridge/methods/lifecycle"
import { handleToolExecute } from "#bridge/methods/tool-execute"
import type { BridgeContext } from "#bridge/server"
import type { EngineContext } from "#core/engine-context"

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
    pinoLogger: null,
    shuttingDown: false,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-parallel-"))
  ctx = makeBridgeContext()
  await handleInit({ projectDir: tmpDir }, ctx)
  await handleSessionCreated({ sessionId: "s1", agent: "hermes" }, ctx)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("bridge parallel scheduler handling", () => {
  it("surfaces explicit unsupported fallback during human gate resolution", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "INCREMENTAL"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.concurrency.maxParallelTasks = 2
      d.implDag = [
        {
          id: "T1",
          description: "Human gate",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "human-gated",
          category: "human-gate",
          humanGate: { whatIsNeeded: "Resolve", why: "Needed", verificationSteps: "Check", resolved: false },
        },
        {
          id: "T2",
          description: "Task 2",
          dependencies: ["T1"],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "pending",
          isolation: { mode: "isolated-worktree", ownershipKey: "T2", writablePaths: ["src/t2.ts"], safeForParallelDispatch: true },
        },
        {
          id: "T3",
          description: "Task 3",
          dependencies: ["T1"],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "pending",
          isolation: { mode: "isolated-worktree", ownershipKey: "T3", writablePaths: ["src/t3.ts"], safeForParallelDispatch: true },
        },
      ]
    })

    const result = await handleToolExecute({
      name: "submit_feedback",
      args: { feedback_type: "approve", feedback_text: "approved", resolved_human_gates: ["T1"] },
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx) as string

    expect(result).toContain("Parallel runtime unsupported")
    expect(result).toContain("sequential")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("DRAFT")
    expect(state?.currentTaskId).toBe("T2")
  })
})
