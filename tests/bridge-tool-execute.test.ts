/**
 * Tests for bridge tool.execute — dispatches tool calls through the bridge.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join, resolve } from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { handleInit, handleSessionCreated } from "#bridge/methods/lifecycle"
import { handleToolExecute, handleTaskGetReviewContext, handlePhaseGetReviewContext, handleAutoApproveContext } from "#bridge/methods/tool-execute"
import type { BridgeContext } from "#bridge/server"
import type { EngineContext } from "#core/engine-context"
import { workflowDbId } from "#core/runtime-persistence"

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
    capabilities: { selfReview: "isolated" as const, orchestrator: true, discoveryFleet: true },
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
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-tools-"))
  ctx = makeBridgeContext()
  await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" } }, ctx)
  await handleSessionCreated({ sessionId: "s1" }, ctx)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function exec(name: string, args: Record<string, unknown> = {}) {
  return handleToolExecute({
    name,
    args,
    context: { sessionId: "s1", directory: tmpDir },
  }, ctx) as Promise<string>
}

async function writeImplPlanArtifact(featureName: string, content: string) {
  const artifactPath = join(tmpDir, ".openartisan", featureName, "impl-plan.md")
  await Bun.write(artifactPath, content)
  await ctx.engine!.store.update("s1", (d) => {
    d.artifactDiskPaths.impl_plan = artifactPath
  })
  return artifactPath
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("tool.execute — dispatch", () => {
  it("returns error for unknown tool", async () => {
    const result = await exec("nonexistent_tool")
    expect(result).toContain("Unknown tool")
    expect(result).toContain("nonexistent_tool")
  })

  it("rejects missing tool name", async () => {
    await expect(handleToolExecute({
      args: {},
      context: { sessionId: "s1", directory: tmpDir },
    }, ctx)).rejects.toThrow("name is required")
  })

  it("rejects missing sessionId", async () => {
    await expect(handleToolExecute({
      name: "select_mode",
      args: {},
      context: {},
    }, ctx)).rejects.toThrow("sessionId")
  })
})

// ---------------------------------------------------------------------------
// select_mode
// ---------------------------------------------------------------------------

describe("tool.execute — select_mode", () => {
  it("transitions from MODE_SELECT to PLANNING in GREENFIELD", async () => {
    const result = await exec("select_mode", { mode: "GREENFIELD", feature_name: "my-feature" })
    expect(result).toContain("GREENFIELD")
    expect(result).toContain("PLANNING")

    const state = ctx.engine!.store.get("s1")
    expect(state?.mode).toBe("GREENFIELD")
    expect(state?.phase).toBe("PLANNING")
    expect(state?.featureName).toBe("my-feature")
  })

  it("transitions to DISCOVERY for REFACTOR", async () => {
    const result = await exec("select_mode", { mode: "REFACTOR", feature_name: "refactor-feat" })
    expect(result).toContain("REFACTOR")

    const state = ctx.engine!.store.get("s1")
    expect(state?.mode).toBe("REFACTOR")
    expect(state?.phase).toBe("DISCOVERY")
  })

  it("rejects invalid mode", async () => {
    const result = await exec("select_mode", { mode: "INVALID", feature_name: "x" })
    expect(result).toContain("Error")
  })

  it("rejects when not in MODE_SELECT", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "my-feat" })
    // Same feature remains bound to the existing workflow
    const result = await exec("select_mode", { mode: "GREENFIELD", feature_name: "my-feat" })
    expect(result).toContain("Error")
    expect(result).toContain("MODE_SELECT")
  })

  it("switches to a different feature by parking the current workflow", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "my-feat" })
    const result = await exec("select_mode", { mode: "REFACTOR", feature_name: "other" })
    expect(result).toContain("Switched to new workflow \"other\"")

    const current = ctx.engine!.store.get("s1")
    expect(current?.featureName).toBe("other")
    expect(current?.phase).toBe("DISCOVERY")

    const parked = ctx.engine!.store.findByFeatureName("my-feat")
    expect(parked?.featureName).toBe("my-feat")
    expect(parked?.phase).toBe("PLANNING")
    expect(parked?.sessionId).not.toBe("s1")
  })

  it("rejects missing feature_name", async () => {
    const result = await exec("select_mode", { mode: "GREENFIELD" })
    expect(result).toContain("Error")
    expect(result).toContain("feature_name")
  })

  it("rejects invalid feature_name format", async () => {
    const result = await exec("select_mode", { mode: "GREENFIELD", feature_name: "../bad" })
    expect(result).toContain("Error")
    expect(result).toContain("..")
  })

  it("rejects reserved feature_name 'sub'", async () => {
    const result = await exec("select_mode", { mode: "GREENFIELD", feature_name: "sub" })
    expect(result).toContain("Error")
    expect(result).toContain("reserved")
  })

  it("bumps policyVersion", async () => {
    const before = ctx.policyVersion
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "test" })
    expect(ctx.policyVersion).toBeGreaterThan(before)
  })
})

// ---------------------------------------------------------------------------
// mark_scan_complete
// ---------------------------------------------------------------------------

describe("tool.execute — mark_scan_complete", () => {
  it("transitions from DISCOVERY/SCAN to DISCOVERY/ANALYZE", async () => {
    // First get to DISCOVERY/SCAN
    await exec("select_mode", { mode: "REFACTOR", feature_name: "scan-feat" })
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("DISCOVERY")
    expect(state?.phaseState).toBe("SCAN")

    const result = await exec("mark_scan_complete", { scan_summary: "Found 10 files" })
    expect(result).toContain("ANALYZE")
  })

  it("rejects when not at DISCOVERY/SCAN", async () => {
    // At MODE_SELECT — wrong phase
    const result = await exec("mark_scan_complete", { scan_summary: "test" })
    expect(result).toContain("Error")
  })
})

// ---------------------------------------------------------------------------
// SubagentDispatcher-dependent tools
// ---------------------------------------------------------------------------

describe("tool.execute — SubagentDispatcher-dependent tools", () => {
  it("mark_analyze_complete returns SubagentDispatcher requirement when discovery fleet is enabled", async () => {
    const isolatedCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" }, capabilities: { selfReview: "isolated", orchestrator: true, discoveryFleet: true } }, isolatedCtx)
    await handleSessionCreated({ sessionId: "iso" }, isolatedCtx)
    const result = await handleToolExecute({
      name: "mark_analyze_complete",
      args: {},
      context: { sessionId: "iso", directory: tmpDir },
    }, isolatedCtx) as string
    expect(result).toContain("requires")
    expect(result).toContain("SubagentDispatcher")
  })

  it("mark_satisfied returns SubagentDispatcher requirement when isolated self-review is enabled", async () => {
    const isolatedCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" }, capabilities: { selfReview: "isolated", orchestrator: true, discoveryFleet: true } }, isolatedCtx)
    await handleSessionCreated({ sessionId: "iso", agent: "artisan" }, isolatedCtx)
    await isolatedCtx.engine!.store.update("iso", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "REVIEW"
    })
    const result = await handleToolExecute({
      name: "mark_satisfied",
      args: { criteria_met: Array.from({ length: 16 }, (_, i) => ({ criterion: `C${i}`, met: true, evidence: "ok", severity: "blocking" })) },
      context: { sessionId: "iso", directory: tmpDir },
    }, isolatedCtx) as string
    expect(result).toContain("requires")
  })

  it("propose_backtrack returns SubagentDispatcher requirement when orchestrator is enabled", async () => {
    const isolatedCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" }, capabilities: { selfReview: "isolated", orchestrator: true, discoveryFleet: true } }, isolatedCtx)
    await handleSessionCreated({ sessionId: "iso", agent: "artisan" }, isolatedCtx)
    await isolatedCtx.engine!.store.update("iso", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
    })
    const result = await handleToolExecute({
      name: "propose_backtrack",
      args: { target_phase: "PLANNING", reason: "Need replanning" },
      context: { sessionId: "iso", directory: tmpDir },
    }, isolatedCtx) as string
    expect(result).toContain("requires")
  })

  it("spawn_sub_workflow returns SubagentDispatcher requirement", async () => {
    const result = await exec("spawn_sub_workflow")
    expect(result).toContain("requires")
  })

  it("spawn_sub_workflow does not mutate parent state without adapter-managed child session creation", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "delegated-wait-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.featureName = "delegated-wait-feat"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Delegate me", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T2"
    })

    const result = await exec("spawn_sub_workflow", { task_id: "T2", feature_name: "child-delegate" })
    expect(result).toContain("requires adapter-managed child session creation")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("DRAFT")
    expect(state?.childWorkflows.length).toBe(0)
    expect(state?.implDag?.find((task) => task.id === "T2")?.status).toBe("pending")
  })

  it("persists approved source artifact files separately from stale markdown mirrors", async () => {
    const staleMirror = join(tmpDir, ".openartisan", "typed-resource-aspects", "interfaces.md")
    const sourceArtifact = join(tmpDir, "src", "core", "aspects", "types.ts")
    await mkdir(join(tmpDir, ".openartisan", "typed-resource-aspects"), { recursive: true })
    await mkdir(join(tmpDir, "src", "core", "aspects"), { recursive: true })
    await Bun.write(staleMirror, "# stale interfaces mirror\n")
    await Bun.write(sourceArtifact, "export interface RevisedAspectContract {}\n")
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "INTERFACES"
      d.phaseState = "USER_GATE"
      d.featureName = "typed-resource-aspects"
      d.userGateMessageReceived = true
      d.artifactDiskPaths.interfaces = staleMirror
      d.reviewArtifactFiles = [sourceArtifact]
    })

    const result = await exec("submit_feedback", { feedback_type: "approve", feedback_text: "approved" })
    expect(result).toContain("Approved")
    const state = ctx.engine!.store.get("s1")
    expect(state?.approvedArtifactFiles?.interfaces).toEqual([sourceArtifact])
  })
})

describe("tool.execute — task boundary revision workflow", () => {
  it("analyzes an ownership change and reports impacted tasks", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "boundary-analyze" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.mode = "INCREMENTAL"
      d.featureName = "boundary-analyze"
      d.fileAllowlist = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/tests/a.test.ts", "/repo/tests/b.test.ts"]
      d.implDag = [
        { id: "T1", description: "Done task", dependencies: [], expectedFiles: ["/repo/src/a.ts"], expectedTests: ["/repo/tests/a.test.ts"], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Target task", dependencies: ["T1"], expectedFiles: ["/repo/src/b.ts"], expectedTests: ["/repo/tests/b.test.ts"], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T2"
    })

    const result = await exec("analyze_task_boundary_change", {
      task_id: "T2",
      add_files: ["/repo/src/a.ts"],
      remove_files: ["/repo/src/b.ts"],
      reason: "T2 must absorb the runtime seam already exercised by review.",
    })

    expect(result).toContain("T1")
    expect(result).toContain("T2")
    expect(result).toContain("completed task")
  })

  it("reports allowlist violations when an added file is outside the approved allowlist", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "boundary-allowlist" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.mode = "INCREMENTAL"
      d.featureName = "boundary-allowlist"
      d.fileAllowlist = ["/repo/src/b.ts", "/repo/tests/b.test.ts"]
      d.implDag = [
        { id: "T2", description: "Target task", dependencies: [], expectedFiles: ["/repo/src/b.ts"], expectedTests: ["/repo/tests/b.test.ts"], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T2"
    })

    const result = await exec("analyze_task_boundary_change", {
      task_id: "T2",
      add_files: ["/repo/src/outside.ts"],
      reason: "Need to test the planning escalation path.",
    })

    expect(result).toContain("allowlist")
    expect(result).toContain("/repo/src/outside.ts")
  })

  it("applies an ownership change and resets completed impacted tasks", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "boundary-apply" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.mode = "INCREMENTAL"
      d.featureName = "boundary-apply"
      d.fileAllowlist = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/tests/a.test.ts", "/repo/tests/b.test.ts"]
      d.implDag = [
        { id: "T1", description: "Done task", dependencies: [], expectedFiles: ["/repo/src/a.ts"], expectedTests: ["/repo/tests/a.test.ts"], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Target task", dependencies: ["T1"], expectedFiles: ["/repo/src/b.ts"], expectedTests: ["/repo/tests/b.test.ts"], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T2"
    })

    const result = await exec("apply_task_boundary_change", {
      task_id: "T2",
      add_files: ["/repo/src/a.ts"],
      remove_files: ["/repo/src/b.ts"],
      expected_impacted_tasks: ["T1", "T2"],
      expected_reset_tasks: ["T1"],
      reason: "T2 must absorb the runtime seam already exercised by review.",
    })

    expect(result).toContain("applied")
    const state = ctx.engine!.store.get("s1")
    const t1 = state?.implDag?.find((t) => t.id === "T1")
    const t2 = state?.implDag?.find((t) => t.id === "T2")
    expect(t1?.expectedFiles).not.toContain("/repo/src/a.ts")
    expect(t1?.status).toBe("pending")
    expect(t2?.expectedFiles).toContain("/repo/src/a.ts")
    expect(t2?.expectedFiles).not.toContain("/repo/src/b.ts")
  })
})

// ---------------------------------------------------------------------------
// submit_feedback
// ---------------------------------------------------------------------------

describe("tool.execute — submit_feedback", () => {
  it("approve transitions to next phase", async () => {
    // Get to a USER_GATE state
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "fb-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "Looks good",
    })
    expect(result).toContain("Approved")
    expect(result).toContain("Continue immediately in this same turn")
    expect(result).toContain("do not stop")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).not.toBe("USER_GATE")
    expect(state?.approvedArtifacts.plan).toBeTruthy()
  })

  it("rejects submit_feedback artifact_content", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "fb-artifact-content" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "Looks good",
      artifact_content: "# Plan\n",
    })

    expect(result).toContain("submit_feedback no longer accepts artifact_content")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("USER_GATE")
  })

  it("does not mutate USER_GATE into REVISE for status or experience questions", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "fb-meta-question" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
    })

    const result = await exec("submit_feedback", {
      feedback_type: "revise",
      feedback_text: "have we implemented all the implementation tasks? How has your experience with open-artisan been?",
    })

    expect(result).toContain("clarification/status question")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("USER_GATE")
    expect(state?.feedbackHistory).toHaveLength(0)
  })

  it("does not mutate ESCAPE_HATCH for clarification questions", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "fb-escape-meta" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "PLANNING"
      d.phaseState = "ESCAPE_HATCH"
      d.escapePending = true
      d.pendingRevisionSteps = [{ artifact: "plan", phase: "PLANNING", phaseState: "REVISE", instructions: "revise" }]
      d.userGateMessageReceived = true
    })

    const result = await exec("submit_feedback", {
      feedback_type: "revise",
      feedback_text: "What is the escape hatch and what are my options?",
    })

    expect(result).toContain("escape-hatch clarification")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("ESCAPE_HATCH")
    expect(state?.escapePending).toBe(true)
  })

  it("parses IMPL_PLAN into DAG on approval", async () => {
    // Get to IMPL_PLAN/USER_GATE
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "dag-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPL_PLAN"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
    })

    const implPlan = `# Implementation Plan

## Tasks

### T1: Set up project structure
- **Dependencies:** none
- **Files:** src/setup.ts
- **Complexity:** small
- **Tests:** tests/setup.test.ts

### T2: Implement core logic
- **Dependencies:** T1
- **Files:** src/core.ts
- **Complexity:** medium
- **Tests:** tests/core.test.ts
`

    await writeImplPlanArtifact("dag-feat", implPlan)

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })
    expect(result).toContain("Approved")
    expect(result).toContain("IMPLEMENTATION")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.implDag).not.toBeNull()
    expect(state?.implDag?.length).toBeGreaterThanOrEqual(1)
    expect(state?.implDag?.[0]?.expectedTests).toEqual(["tests/setup.test.ts"])
    expect(state?.implDag?.[1]?.expectedTests).toEqual(["tests/core.test.ts"])
    expect(state?.currentTaskId).not.toBeNull()
    expect(state?.approvedArtifacts.impl_plan).toBeTruthy()
  })

  it("rejects IMPL_PLAN approval when the plan cannot be parsed into a DAG", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "bad-dag-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPL_PLAN"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
    })

    const badPlan = `# Implementation Plan\n\n## Tasks\n\n### Not a task heading\n- **Dependencies:** none\n`

    await writeImplPlanArtifact("bad-dag-feat", badPlan)

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("Error: Failed to parse implementation plan into DAG")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPL_PLAN")
    expect(state?.phaseState).toBe("USER_GATE")
    expect(state?.implDag).toBeNull()
  })

  it("rejects IMPL_PLAN approval when task scope exceeds the approved INCREMENTAL allowlist", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "bad-contract-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPL_PLAN"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.fileAllowlist = [resolve(tmpDir, "src/allowed.ts"), resolve(tmpDir, "tests/allowed.test.ts")]
    })

    const implPlan = `# Implementation Plan

## Task T1: Out of scope work
**Dependencies:** none
**Files:** src/other.ts
**Expected tests:** tests/other.test.ts
**Complexity:** medium
`

    await writeImplPlanArtifact("bad-contract-feat", implPlan)

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("IMPL_PLAN approval failed executable-contract validation")
    expect(result).toContain("outside the approved INCREMENTAL allowlist")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPL_PLAN")
    expect(state?.phaseState).toBe("USER_GATE")
  })

  it("derives missing INCREMENTAL allowlist from the approved plan at IMPL_PLAN approval time", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "impl-allowlist-recovery-feat" })
    const planPath = join(tmpDir, ".openartisan", "impl-allowlist-recovery-feat", "plan.md")
    await Bun.write(planPath, "# Planning\n\n## Narrow allowlist\n- src/allowed.ts\n- tests/allowed.test.ts\n")
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPL_PLAN"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.featureName = "impl-allowlist-recovery-feat"
      d.artifactDiskPaths.plan = planPath
      d.fileAllowlist = []
    })

    const implPlan = `# Implementation Plan

## Task T1: In-scope work
**Dependencies:** none
**Files:** src/allowed.ts
**Expected tests:** tests/allowed.test.ts
**Complexity:** medium
`

    await writeImplPlanArtifact("impl-allowlist-recovery-feat", implPlan)

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("Approved")
    expect(result).toContain("IMPLEMENTATION")

    const state = ctx.engine!.store.get("s1")
    expect(state?.fileAllowlist).toContain(resolve(tmpDir, "src/allowed.ts"))
    expect(state?.fileAllowlist).toContain(resolve(tmpDir, "tests/allowed.test.ts"))
  })

  it("approves IMPL_PLAN when task files and tests are markdown-wrapped but in scope", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "backticked-impl-plan-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPL_PLAN"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.fileAllowlist = [resolve(tmpDir, "src/allowed.ts"), resolve(tmpDir, "tests/allowed.test.ts")]
    })

    const implPlan = `# Implementation Plan

## Task T1: In-scope work
**Dependencies:** none
**Files:** \0src/allowed.ts\0
**Expected tests:** \0tests/allowed.test.ts\0
**Complexity:** medium
`.replaceAll("\u00060", "`")

    await writeImplPlanArtifact("backticked-impl-plan-feat", implPlan)

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("Approved")
    expect(result).toContain("IMPLEMENTATION")
  })

  it("rejects TESTS approval when reviewed artifact files fall outside the approved allowlist", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "tests-allowlist-check-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "TESTS"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.fileAllowlist = [resolve(tmpDir, "tests/allowed.test.ts")]
      d.reviewArtifactFiles = ["tests/out-of-scope.test.ts"]
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("TESTS approval failed allowlist validation")
    expect(result).toContain(resolve(tmpDir, "tests/out-of-scope.test.ts"))
  })

  it("derives missing INCREMENTAL allowlist from approved plan for TESTS approval", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "tests-allowlist-recovery-feat" })
    const planPath = join(tmpDir, ".openartisan", "tests-allowlist-recovery-feat", "plan.md")
    await Bun.write(planPath, "# Planning\n\n## Narrow allowlist\n- tests/in-scope.test.ts\n")
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "TESTS"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.featureName = "tests-allowlist-recovery-feat"
      d.artifactDiskPaths.plan = planPath
      d.fileAllowlist = []
      d.reviewArtifactFiles = ["tests/in-scope.test.ts"]
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).not.toContain("approval failed allowlist validation")
    const state = ctx.engine!.store.get("s1")
    expect(state?.fileAllowlist).toContain(resolve(tmpDir, "tests/in-scope.test.ts"))
  })

  it("ignores saved artifact disk paths when validating TESTS approval allowlist scope", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "tests-artifact-path-feat" })
    const artifactPath = resolve(tmpDir, ".openartisan/tests-artifact-path-feat/tests.md")
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "TESTS"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.fileAllowlist = [resolve(tmpDir, "tests/in-scope.test.ts")]
      d.artifactDiskPaths.tests = artifactPath
      d.reviewArtifactFiles = [artifactPath]
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).not.toContain("approval failed allowlist validation")
  })

  it("approves IMPL_PLAN from previously written disk artifact when content is omitted", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "disk-dag-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPL_PLAN"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.featureName = "disk-dag-feat"
    })

    const implPlan = `# Implementation Plan

## Tasks

### T1. Disk-backed task
- **Dependencies:** none
- **Files:** src/disk-backed.ts
- **Expected tests:** none
`
    const artifactPath = join(tmpDir, ".openartisan", "disk-dag-feat", "impl-plan.md")
    await Bun.write(artifactPath, implPlan)
    await ctx.engine!.store.update("s1", (d) => {
      d.artifactDiskPaths.impl_plan = artifactPath
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("Approved")
    expect(result).toContain("IMPLEMENTATION")

    const state = ctx.engine!.store.get("s1")
    expect(state?.implDag).not.toBeNull()
    expect(state?.currentTaskId).toBe("T1")
  })

  it("derives INCREMENTAL allowlist from approved planning artifact when approved_files is omitted", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "derived-allowlist-feat" })
    const planPath = join(tmpDir, ".openartisan", "derived-allowlist-feat", "plan.md")
    await Bun.write(planPath, "# Planning\n\n## Narrow allowlist\n- src/a.ts\n- tests/a.test.ts\n")
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.featureName = "derived-allowlist-feat"
      d.artifactDiskPaths.plan = planPath
    })

    await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    const state = ctx.engine!.store.get("s1")
    expect(state?.fileAllowlist).toContain(resolve(tmpDir, "src/a.ts"))
    expect(state?.fileAllowlist).toContain(resolve(tmpDir, "tests/a.test.ts"))
  })

  it("rejects INCREMENTAL planning approval without an allowlist source", async () => {
    await exec("select_mode", { mode: "INCREMENTAL", feature_name: "missing-allowlist-feat" })
    const planPath = join(tmpDir, ".openartisan", "missing-allowlist-feat", "plan.md")
    await Bun.write(planPath, "# Planning\n\nNo allowlist here.\n")
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.featureName = "missing-allowlist-feat"
      d.artifactDiskPaths.plan = planPath
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("INCREMENTAL planning approval requires an explicit file allowlist source")
  })

  it("revise routes directly to REVISE in default agent-only bridge mode", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "rev-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
    })

    const result = await exec("submit_feedback", {
      feedback_type: "revise",
      feedback_text: "Please change X",
    })
    expect(result).toContain("REVISE")
  })

  it("blocks submit_feedback before user message at USER_GATE", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "gate-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = false
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "LGTM",
    })
    expect(result).toContain("Waiting for user response")
  })
})

// ---------------------------------------------------------------------------
// check_prior_workflow
// ---------------------------------------------------------------------------

describe("tool.execute — check_prior_workflow", () => {
  it("returns 'no prior workflow' for new feature", async () => {
    const result = await exec("check_prior_workflow", { feature_name: "brand-new" })
    expect(result).toContain("No prior workflow")
    expect(result).toContain("brand-new")
  })

  it("finds prior workflow state", async () => {
    // Create a session with a feature name
    await handleSessionCreated({ sessionId: "s2" }, ctx)
    await ctx.engine!.store.update("s2", (d) => {
      d.featureName = "existing-feat"
      d.phase = "PLANNING"
      d.mode = "GREENFIELD"
    })

    const result = await exec("check_prior_workflow", { feature_name: "existing-feat" })
    expect(result).toContain("Prior workflow found")
    expect(result).toContain("PLANNING")
  })

  it("finds persisted prior workflow state after a fresh bridge init", async () => {
    await handleSessionCreated({ sessionId: "writer" }, ctx)
    await ctx.engine!.store.update("writer", (d) => {
      d.featureName = "persisted-feat"
      d.mode = "INCREMENTAL"
      d.phase = "DISCOVERY"
      d.phaseState = "SCAN"
    })

    const freshCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" } }, freshCtx)
    await handleSessionCreated({ sessionId: "reader" }, freshCtx)

    const result = await handleToolExecute({
      name: "check_prior_workflow",
      args: { feature_name: "persisted-feat" },
      context: { sessionId: "reader", directory: tmpDir },
    }, freshCtx) as string

    expect(result).toContain("Prior workflow found")
    expect(result).toContain("DISCOVERY")
  })
})

describe("tool.execute — mark_task_complete", () => {
  it("completes a task and enters explicit TASK_REVIEW", async () => {
    // Get to IMPLEMENTATION with a DAG
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "mtc-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
        { id: "T2", description: "Core", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T1"
    })

    const result = await exec("mark_task_complete", {
      task_id: "T1",
      implementation_summary: "Set up the project",
      tests_passing: true,
    })
    expect(result).toContain("T1")
    expect(result).toContain("Per-task review required")
    expect(result).toContain("submit_task_review")
    expect(result).not.toContain("**Next task ready:**")

    const state = ctx.engine!.store.get("s1")
    expect(state?.implDag?.find((t) => t.id === "T1")?.status).toBe("complete")
    expect(state?.phaseState).toBe("TASK_REVIEW")
    expect(state?.taskCompletionInProgress).toBe("T1")
    expect(state?.currentTaskId).toBe("T1")
  })

  it("submit_task_review advances on pass", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "str-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Core", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
    })

    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({ passed: true, issues: [], reasoning: "All checks pass" }),
    })
    expect(result).toContain("review passed")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("SCHEDULING")
    expect(state?.taskCompletionInProgress).toBeNull()
    expect(state?.taskReviewCount).toBe(0)
    expect(state?.currentTaskId).toBe("T2")
  })

  it("submit_task_review moves to HUMAN_GATE when only unresolved human gates remain", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "awaiting-human-after-review" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        {
          id: "T1",
          description: "Completed task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "complete",
        },
        {
          id: "T2",
          description: "Needs human input",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "human-gated",
          category: "human-gate",
          humanGate: {
            whatIsNeeded: "Approve external action",
            why: "Needed",
            verificationSteps: "Verify",
            resolved: false,
          },
        },
        {
          id: "T3",
          description: "Blocked downstream work",
          dependencies: ["T2"],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "pending",
        },
      ] as any
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
      d.userGateMessageReceived = true
    })

    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({ passed: true, issues: [], reasoning: "All checks pass" }),
    })

    expect(result).toContain("review passed")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("HUMAN_GATE")
    expect(state?.currentTaskId).toBeNull()
    expect(state?.userGateMessageReceived).toBe(false)
  })

  it("submit_task_review reverts task on fail", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "fail-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
    })

    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({ passed: false, issues: ["Tests fail"], reasoning: "test_main fails" }),
    })
    expect(result).toContain("FAILED")
    expect(result).toContain("Tests fail")

    const state = ctx.engine!.store.get("s1")
    expect(state?.taskCompletionInProgress).toBeNull()
    expect(state?.implDag?.find((t) => t.id === "T1")?.status).toBe("pending")
    expect(state?.currentTaskId).toBe("T1")
    expect(state?.taskReviewCount).toBe(1)
  })

  it("blocks re-entry when review is pending", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "reentry-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
    })

    const result = await exec("mark_task_complete", {
      task_id: "T1",
      implementation_summary: "test",
      tests_passing: true,
    })
    expect(result).toContain("already awaiting review")
  })

  it("rejects when not in IMPLEMENTATION", async () => {
    const result = await exec("mark_task_complete", {
      task_id: "T1",
      implementation_summary: "test",
      tests_passing: true,
    })
    expect(result).toContain("Error")
    expect(result).toContain("IMPLEMENTATION")
  })
})

// ---------------------------------------------------------------------------
// query tools
// ---------------------------------------------------------------------------

describe("tool.execute — query tools", () => {
  it("query_parent_workflow returns error for non-sub-workflow", async () => {
    const result = await exec("query_parent_workflow")
    expect(result).toContain("Error")
    expect(result).toContain("not a sub-workflow")
  })

  it("query_child_workflow returns error with no children", async () => {
    const result = await exec("query_child_workflow", { task_id: "T1" })
    expect(result).toContain("Error")
    expect(result).toContain("No child workflow")
  })
})

// ---------------------------------------------------------------------------
// agent-only self-review mode
// ---------------------------------------------------------------------------

describe("tool.execute — agent-only mode", () => {
  let agentCtx: BridgeContext
  let agentExec: (name: string, args?: Record<string, unknown>) => Promise<string>

  beforeEach(async () => {
    agentCtx = makeBridgeContext()
    agentCtx.capabilities = { selfReview: "agent-only", orchestrator: false, discoveryFleet: false }
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" }, capabilities: { selfReview: "agent-only", orchestrator: false, discoveryFleet: false } }, agentCtx)
    await handleSessionCreated({ sessionId: "ao-session" }, agentCtx)
    agentExec = (name, args = {}) =>
      handleToolExecute(
        { name, args, context: { sessionId: "ao-session", directory: tmpDir } },
        agentCtx,
      ) as Promise<string>
  })

  async function writeCurrentPlanArtifact(sessionId = "ao-session", bridgeContext = agentCtx, content = "# Plan\n") {
    const state = bridgeContext.engine!.store.get(sessionId)
    const feature = state?.featureName ?? `feature-${Date.now()}`
    const planPath = join(tmpDir, ".openartisan", feature, "plan.md")
    await mkdir(join(tmpDir, ".openartisan", feature), { recursive: true })
    await Bun.write(planPath, content)
    return planPath
  }

  async function requestCurrentPlanReview(sessionId = "ao-session", bridgeContext = agentCtx, run = agentExec, content = "# Plan\n") {
    const planPath = await writeCurrentPlanArtifact(sessionId, bridgeContext, content)
    await run("request_review", { summary: "Plan", artifact_description: "Plan", artifact_files: [planPath] })
    return planPath
  }

  it("mark_satisfied passes with all blocking criteria met", async () => {
    // Advance to PLANNING/REVIEW
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-test-${Date.now()}` })
    await requestCurrentPlanReview()

    // PLANNING has many expected blocking criteria. Provide enough to satisfy the count check.
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `Criterion ${i + 1}`, met: true, evidence: "verified", severity: "blocking",
    }))
    const result = await agentExec("mark_satisfied", { criteria_met: criteria })
    // Should advance to USER_GATE (not error about SubagentDispatcher)
    expect(result).not.toContain("SubagentDispatcher")
    expect(result.toLowerCase()).toContain("user gate")
  })

  it("mark_satisfied fails and routes to REVISE with unmet criteria", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-fail-${Date.now()}` })
    await requestCurrentPlanReview()

    // Provide enough criteria but with one unmet blocking
    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `Criterion ${i + 1}`,
      met: i !== 0, // first criterion is unmet
      evidence: i === 0 ? "Missing scope" : "verified",
      severity: "blocking",
    }))
    const result = await agentExec("mark_satisfied", { criteria_met: criteria })
    // Should route to REVISE (self_review_fail → REVISE)
    expect(result).not.toContain("SubagentDispatcher")
    expect(result).toContain("blocking")
    // Verify state is REVISE
    const state = agentCtx.engine!.store.get("ao-session")
    expect(state?.phaseState).toBe("REVISE")
  })

  it("mark_analyze_complete works in agent-only mode", async () => {
    await agentExec("select_mode", { mode: "REFACTOR", feature_name: `ao-disc-${Date.now()}` })
    // Advance past SCAN to ANALYZE
    await agentExec("mark_scan_complete", { scan_summary: "Found stuff" })

    const result = await agentExec("mark_analyze_complete", { analysis_summary: "Architecture is solid" })
    expect(result).not.toContain("SubagentDispatcher")
    expect(result).toContain("CONVENTIONS")
    // Check discoveryReport was stored
    const state = agentCtx.engine!.store.get("ao-session")
    expect(state?.discoveryReport).toBe("Architecture is solid")
  })

  it("submit_feedback(revise) routes directly to REVISE in agent-only mode", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-rev-${Date.now()}` })
    await requestCurrentPlanReview()
    // mark_satisfied → pass → USER_GATE (provide enough criteria)
    const passingCriteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "ok", severity: "blocking",
    }))
    await agentExec("mark_satisfied", { criteria_met: passingCriteria })
    // Simulate user message for USER_GATE
    await agentCtx.engine!.store.update("ao-session", (d) => {
      d.userGateMessageReceived = true
      d.reviewArtifactHash = "stale-review-hash"
      d.latestReviewResults = [{ criterion: "Old", met: false, evidence: "stale" }]
    })

    const result = await agentExec("submit_feedback", { feedback_type: "revise", feedback_text: "Add more detail" })
    expect(result).not.toContain("SubagentDispatcher")
    expect(result).toContain("REVISE")
    const state = agentCtx.engine!.store.get("ao-session")
    expect(state?.phaseState).toBe("REVISE")
    expect(state?.reviewArtifactHash).toBeNull()
    expect(state?.latestReviewResults).toBeNull()
  })

  it("propose_backtrack lands in REDRAFT in agent-only mode", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-bt-${Date.now()}` })
    // Advance to PLANNING/REVIEW → USER_GATE → approve → INTERFACES/DRAFT
    await requestCurrentPlanReview()
    const passingCriteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "ok", severity: "blocking",
    }))
    await agentExec("mark_satisfied", { criteria_met: passingCriteria })
    await agentCtx.engine!.store.update("ao-session", (d) => { d.userGateMessageReceived = true })
    await agentExec("submit_feedback", { feedback_type: "approve", feedback_text: "approved" })
    // Now in INTERFACES/DRAFT — backtrack to PLANNING/REDRAFT
    const state1 = agentCtx.engine!.store.get("ao-session")
    expect(state1?.phase).toBe("INTERFACES")

    const result = await agentExec("propose_backtrack", {
      target_phase: "PLANNING",
      reason: "The plan is missing critical requirements that were discovered during interface design",
    })
    expect(result).not.toContain("SubagentDispatcher")
    expect(result).toContain("PLANNING")
    const state2 = agentCtx.engine!.store.get("ao-session")
    expect(state2?.phase).toBe("PLANNING")
    expect(state2?.phaseState).toBe("REDRAFT")
    expect(state2?.backtrackContext?.sourcePhase).toBe("INTERFACES")
    expect(state2?.backtrackContext?.targetPhase).toBe("PLANNING")
  })

  it("mark_satisfied returns subagent error in isolated mode", async () => {
    const isolatedCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" }, capabilities: { selfReview: "isolated", orchestrator: true, discoveryFleet: true } }, isolatedCtx)
    await handleSessionCreated({ sessionId: "iso-session", agent: "artisan" }, isolatedCtx)
    await handleToolExecute({
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: `iso-test-${Date.now()}` },
      context: { sessionId: "iso-session", directory: tmpDir },
    }, isolatedCtx)
    const isoPlanPath = await writeCurrentPlanArtifact("iso-session", isolatedCtx)
    await handleToolExecute({
      name: "request_review",
      args: { summary: "Plan", artifact_description: "Plan", artifact_files: [isoPlanPath] },
      context: { sessionId: "iso-session", directory: tmpDir },
    }, isolatedCtx)
    const result = await handleToolExecute({
      name: "mark_satisfied",
      args: {
      criteria_met: [{ criterion: "OK", met: true, evidence: "good", severity: "blocking" }],
      },
      context: { sessionId: "iso-session", directory: tmpDir },
    }, isolatedCtx) as string
    expect(result).toContain("SubagentDispatcher")
  })

  it("mark_satisfied rejects empty criteria without state transition", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-empty-${Date.now()}` })
    await requestCurrentPlanReview()
    // Confirm we're at REVIEW
    const stateBefore = agentCtx.engine!.store.get("ao-session")
    expect(stateBefore?.phaseState).toBe("REVIEW")

    // Call mark_satisfied with empty criteria
    const result = await agentExec("mark_satisfied", { criteria_met: [] })
    expect(result).toContain("Error")
    expect(result).toContain("empty")

    // State must remain at REVIEW — not transition to REVISE
    const stateAfter = agentCtx.engine!.store.get("ao-session")
    expect(stateAfter?.phaseState).toBe("REVIEW")
  })

  it("blocks mark_satisfied when the reviewed artifact changed on disk", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-hash-${Date.now()}` })
    await requestCurrentPlanReview("ao-session", agentCtx, agentExec, "# Initial plan")

    const stateBefore = agentCtx.engine!.store.get("ao-session")
    const planPath = stateBefore?.artifactDiskPaths.plan
    expect(planPath).toBeTruthy()
    if (!planPath) return

    await Bun.write(planPath, "# Modified plan after review")

    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `Criterion ${i + 1}`,
      met: true,
      evidence: "verified",
      severity: "blocking",
    }))

    const result = await agentExec("mark_satisfied", { criteria_met: criteria })
    expect(result).toContain("artifact changed after it was submitted for review")

    const stateAfter = agentCtx.engine!.store.get("ao-session")
    expect(stateAfter?.phaseState).toBe("REVIEW")
  })

  it("allows request_review at REVIEW to refresh text artifact hash and review files", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `review-refresh-${Date.now()}` })
    const planPath = await writeCurrentPlanArtifact("s1", ctx, "# Old plan artifact")
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "PLANNING"
      d.phaseState = "REVIEW"
      d.featureName = d.featureName ?? `review-refresh-${Date.now()}`
      d.artifactDiskPaths.plan = planPath
      d.reviewArtifactHash = "stale-hash"
      d.latestReviewResults = [{ criterion: "Old", met: false, evidence: "stale" }]
    })
    await Bun.write(planPath, "# Updated plan artifact")

    const result = await exec("request_review", {
      artifact_files: [planPath],
      summary: "Updated plan",
      artifact_description: "Plan artifact",
    })

    expect(result).toContain("re-submitted")
    expect(result).toContain("Registered 1 review file")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("REVIEW")
    expect(state?.reviewArtifactHash).not.toBe("stale-hash")
    expect(state?.reviewArtifactFiles).toContain(planPath)
    expect(state?.latestReviewResults).toBeNull()
  })

  it("allows request_review from DISCOVERY/CONVENTIONS", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `conv-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "DISCOVERY"
      d.phaseState = "CONVENTIONS"
    })
    const feature = ctx.engine!.store.get("s1")?.featureName ?? "conv"
    const conventionsPath = join(tmpDir, ".openartisan", feature, "conventions.md")
    await mkdir(join(tmpDir, ".openartisan", feature), { recursive: true })
    await Bun.write(conventionsPath, "# Conventions\n")

    const result = await exec("request_review", {
      summary: "Conventions",
      artifact_description: "Conventions doc",
      artifact_files: [conventionsPath],
    })

    expect(result).toContain("Transitioning to DISCOVERY/REVIEW")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("REVIEW")
  })

  it("materializes markdown artifact content for DISCOVERY/CONVENTIONS", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `conv-materialize-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "DISCOVERY"
      d.phaseState = "CONVENTIONS"
    })
    const feature = ctx.engine!.store.get("s1")?.featureName ?? "conv-materialize"
    const conventionsPath = join(tmpDir, ".openartisan", feature, "conventions.md")

    const result = await exec("request_review", {
      summary: "Conventions",
      artifact_description: "Conventions doc",
      artifact_files: [],
      artifact_markdown: "# Conventions\n\n- Use Bun.\n",
    })

    expect(result).toContain("Transitioning to DISCOVERY/REVIEW")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("REVIEW")
    expect(state?.reviewArtifactFiles).toEqual([conventionsPath])
    expect(await Bun.file(conventionsPath).text()).toContain("Use Bun")
  })

  it("rejects request_review artifact_content for PLANNING", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `planning-content-${Date.now()}` })

    const result = await exec("request_review", {
      summary: "Plan",
      artifact_description: "Inline plan",
      artifact_content: "# Plan\n",
    })

    expect(result).toContain("Error")
    expect(result).toContain("artifact_files")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("DRAFT")
  })

  it("rejects PLANNING artifact files outside the canonical plan path", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `planning-wrong-path-${Date.now()}` })
    const feature = ctx.engine!.store.get("s1")?.featureName ?? "planning-wrong-path"
    const wrongPath = join(tmpDir, ".openartisan", feature, "notes.md")
    await mkdir(join(tmpDir, ".openartisan", feature), { recursive: true })
    await Bun.write(wrongPath, "# Notes\n")

    const result = await exec("request_review", {
      summary: "Plan",
      artifact_description: "Wrong markdown path",
      artifact_files: [wrongPath],
    })

    expect(result).toContain("Error")
    expect(result).toContain(`.openartisan/${feature}/plan.md`)
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("DRAFT")
  })

  it("allows IMPL_PLAN request_review from the canonical markdown artifact", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `impl-plan-artifact-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPL_PLAN"
      d.phaseState = "DRAFT"
    })
    const feature = ctx.engine!.store.get("s1")?.featureName ?? "impl-plan-artifact"
    const artifactPath = join(tmpDir, ".openartisan", feature, "impl-plan.md")
    await mkdir(join(tmpDir, ".openartisan", feature), { recursive: true })
    await Bun.write(artifactPath, "# Implementation Plan\n\n## Task T1: Do work\n**Files:** src/index.ts\n**Depends on:** none\n")

    const result = await exec("request_review", {
      summary: "Implementation DAG",
      artifact_description: "Implementation plan artifact",
      artifact_files: [artifactPath],
    })

    expect(result).toContain("Transitioning to IMPL_PLAN/REVIEW")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("REVIEW")
    expect(ctx.engine!.store.get("s1")?.reviewArtifactFiles).toContain(artifactPath)
  })

  it("rejects request_review artifact_content for INTERFACES", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `interfaces-content-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
    })

    const result = await exec("request_review", {
      summary: "Interfaces",
      artifact_description: "Markdown interface design doc",
      artifact_content: "# Interfaces\n",
    })

    expect(result).toContain("Error")
    expect(result).toContain("artifact_files")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("DRAFT")
  })

  it("rejects .openartisan artifact files for INTERFACES", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `interfaces-openartisan-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
    })

    const result = await exec("request_review", {
      summary: "Interfaces",
      artifact_description: "Saved markdown artifact",
      artifact_files: [".openartisan/foo/interfaces.md"],
    })

    expect(result).toContain("Error")
    expect(result).toContain(".openartisan")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("DRAFT")
  })

  it("rejects non-test artifact files for TESTS", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `tests-invalid-file-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "TESTS"
      d.phaseState = "DRAFT"
    })

    await mkdir(join(tmpDir, "src"), { recursive: true })
    await Bun.write(join(tmpDir, "src", "types.ts"), "export interface X {}\n")
    const result = await exec("request_review", {
      summary: "Tests",
      artifact_description: "Wrong file",
      artifact_files: ["src/types.ts"],
    })

    expect(result).toContain("Error")
    expect(result).toContain("runnable test/spec files")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("DRAFT")
  })

  it("rejects markdown summaries for IMPLEMENTATION request_review", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `implementation-markdown-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
    })
    await mkdir(join(tmpDir, "docs"), { recursive: true })
    await Bun.write(join(tmpDir, "docs", "implementation.md"), "# Implementation summary\n")

    const result = await exec("request_review", {
      summary: "Implementation",
      artifact_description: "Markdown summary",
      artifact_files: ["docs/implementation.md"],
    })

    expect(result).toContain("Error")
    expect(result).toContain("not markdown summaries")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("DRAFT")
  })

  it("builds phase-level isolated review context from reviewed files", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `phase-review-${Date.now()}` })
    const planPath = await writeCurrentPlanArtifact("s1", ctx)
    await exec("request_review", {
      summary: "Plan",
      artifact_description: "Plan artifact",
      artifact_files: [planPath],
    })

    const prompt = await handlePhaseGetReviewContext({ sessionId: "s1" }, ctx)
    expect(prompt).toContain("reviewing the **PLANNING** artifact")
    expect(prompt).toContain("## Acceptance Criteria")
    expect(prompt).toContain("Artifact to Review")
  })

  it("submit_phase_review advances using isolated reviewer criteria", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `phase-submit-${Date.now()}` })
    const planPath = await writeCurrentPlanArtifact("s1", ctx)
    await exec("request_review", {
      summary: "Plan",
      artifact_description: "Plan artifact",
      artifact_files: [planPath],
    })

    const criteria = Array.from({ length: 16 }, (_, i) => ({
      criterion: `Criterion ${i + 1}`,
      met: true,
      evidence: "verified by isolated reviewer",
      severity: "blocking",
    }))
    const result = await exec("submit_phase_review", {
      review_output: JSON.stringify({ satisfied: true, criteria_results: criteria }),
    })

    expect(result).toContain("Isolated phase review submitted")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("USER_GATE")
  })

  it("submit_phase_review routes malformed reviewer output to REVISE", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `phase-bad-${Date.now()}` })
    const planPath = await writeCurrentPlanArtifact("s1", ctx)
    await exec("request_review", {
      summary: "Plan",
      artifact_description: "Plan artifact",
      artifact_files: [planPath],
    })

    const result = await exec("submit_phase_review", {
      review_output: "not json",
    })

    expect(result).toContain("Isolated phase review submitted")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("REVISE")
    expect(state?.latestReviewResults?.[0]?.criterion).toContain("Isolated reviewer failed")
    expect(state?.latestReviewResults?.[0]?.evidence).toContain("Reviewer output was not valid phase-review JSON")
    expect(state?.latestReviewResults?.[0]?.evidence).toContain("not json")
  })

  it("submit_phase_review preserves isolated reviewer subprocess failure text", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `phase-auth-fail-${Date.now()}` })
    const planPath = await writeCurrentPlanArtifact("s1", ctx)
    await exec("request_review", {
      summary: "Plan",
      artifact_description: "Plan artifact",
      artifact_files: [planPath],
    })

    await exec("submit_phase_review", {
      review_output: "ISOLATED_PHASE_REVIEW_FAILED: reviewer command exited with code 1 | stdout: Not logged in | stderr: Please run /login",
    })

    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("REVISE")
    expect(state?.latestReviewResults?.[0]?.evidence).toContain("Not logged in")
    expect(state?.latestReviewResults?.[0]?.evidence).toContain("Please run /login")
  })

  it("submit_phase_review normalizes raw reviewer process results in bridge", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `phase-raw-fail-${Date.now()}` })
    const planPath = await writeCurrentPlanArtifact("s1", ctx)
    await exec("request_review", {
      summary: "Plan",
      artifact_description: "Plan artifact",
      artifact_files: [planPath],
    })

    await exec("submit_phase_review", {
      review_stdout: "I think this artifact looks good.",
      review_stderr: "",
      review_exit_code: 0,
    })

    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("REVISE")
    expect(state?.latestReviewResults?.[0]?.evidence).toContain("Reviewer output was not valid phase-review JSON")
    expect(state?.latestReviewResults?.[0]?.evidence).toContain("I think this artifact looks good")
  })
})

describe("tool.execute — submit_auto_approve", () => {
  it("routes non-JSON auto-approve output to REVISE as a rejection", async () => {
    const agentCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" } }, agentCtx)
    await handleSessionCreated({ sessionId: "robot-session", agent: "robot-artisan" }, agentCtx)
    await agentCtx.engine!.store.update("robot-session", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
      d.reviewArtifactHash = "stale-review-hash"
      d.latestReviewResults = [{ criterion: "Old", met: false, evidence: "stale" }]
    })

    const result = await handleToolExecute({
      name: "submit_auto_approve",
      args: { review_output: "not-json" },
      context: { sessionId: "robot-session", directory: tmpDir },
    }, agentCtx) as string

    expect(result).toContain("Auto-approve rejected")
    const state = agentCtx.engine!.store.get("robot-session")
    expect(state?.phaseState).toBe("REVISE")
    expect(state?.reviewArtifactHash).toBeNull()
    expect(state?.latestReviewResults).toBeNull()
  })
})

describe("tool.execute — resolve_human_gate", () => {
  it("auto-advances to HUMAN_GATE when all remaining work is human-gated", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        {
          id: "T1",
          description: "Provision infrastructure",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "pending",
          category: "human-gate",
        },
      ]
    })

    const result = await exec("resolve_human_gate", {
      task_id: "T1",
      what_is_needed: "Provision the bucket",
      why: "Uploads need it",
      verification_steps: "Run aws s3 ls",
    })

    expect(result).toContain("HUMAN_GATE")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("HUMAN_GATE")
  })

  it("returns to structural scheduling when work remains after a human gate", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        {
          id: "T1",
          description: "Needs human input",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "pending",
          category: "human-gate",
        },
        {
          id: "T2",
          description: "Independent task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "pending",
          category: "standalone",
        },
      ]
    })

    const result = await exec("resolve_human_gate", {
      task_id: "T1",
      what_is_needed: "Human approval",
      why: "Needed",
      verification_steps: "Verify",
    })

    expect(result).toContain("Human gate set for task \"T1\"")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("SCHEDULING")
    expect(state?.currentTaskId).toBe("T2")
  })
})

describe("tool.execute — submit_feedback human gate handling", () => {
  it("does not treat HUMAN_GATE as a user approval surface", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "HUMAN_GATE"
      d.userGateMessageReceived = true
      d.implDag = [{
        id: "T1",
        description: "Provision infra",
        dependencies: [],
        expectedTests: [],
        expectedFiles: [],
        estimatedComplexity: "small",
        status: "human-gated",
        humanGate: {
          whatIsNeeded: "Provision infra",
          why: "Needed",
          verificationSteps: "Verify",
          resolved: false,
        },
      }]
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
    })

    expect(result).toContain("Cannot approve")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("HUMAN_GATE")
  })

  it("resolves HUMAN_GATE tasks and resumes scheduling when downstream work is unblocked", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "HUMAN_GATE"
      d.userGateMessageReceived = true
      d.implDag = [
        {
          id: "T1",
          description: "Provision infra",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "human-gated",
          humanGate: {
            whatIsNeeded: "Provision infra",
            why: "Needed",
            verificationSteps: "Verify",
            resolved: false,
          },
        },
        {
          id: "T2",
          description: "Resume work",
          dependencies: ["T1"],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "pending",
        },
      ]
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
      resolved_human_gates: ["T1"],
    })

    expect(result).toContain("Resolved 1 human gate(s): T1")
    expect(result).toContain("Returning to IMPLEMENTATION/SCHEDULING")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("SCHEDULING")
    expect(state?.currentTaskId).toBe("T2")
    expect(state?.implDag?.find((t) => t.id === "T1")?.status).toBe("complete")
    expect(state?.implDag?.find((t) => t.id === "T1")?.humanGate?.resolved).toBe(true)
  })

  it("resolves final HUMAN_GATE tasks without approving implementation directly", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "HUMAN_GATE"
      d.userGateMessageReceived = true
      d.implDag = [
        {
          id: "T1",
          description: "Provision infra",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "human-gated",
          category: "human-gate",
          humanGate: {
            whatIsNeeded: "Provision infra",
            why: "Needed",
            verificationSteps: "Verify",
            resolved: false,
          },
        },
      ]
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
      resolved_human_gates: ["T1"],
    })

    expect(result).toContain("Resolved 1 human gate(s): T1")
    expect(result).toContain("request final implementation review")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("SCHEDULING")
    expect(state?.currentTaskId).toBeNull()
    expect(state?.implDag?.[0]?.status).toBe("complete")
    expect(state?.implDag?.[0]?.humanGate?.resolved).toBe(true)
  })

  it("completes IMPLEMENTATION cleanly when the final human gate is resolved", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.taskReviewCount = 2
      d.latestReviewResults = [{ criterion: "Final implementation review", met: true, evidence: "24 of 24 blocking criteria met" }]
      d.reviewArtifactFiles = ["docs/full-execution-plan.md"]
      d.implDag = [
        {
          id: "T1",
          description: "Final doc task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: ["docs/full-execution-plan.md"],
          estimatedComplexity: "small",
          status: "human-gated",
          category: "human-gate",
          humanGate: {
            whatIsNeeded: "Maintainer decision",
            why: "Needed",
            verificationSteps: "Verify",
            resolved: false,
          },
        },
      ]
    })

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
      resolved_human_gates: ["T1"],
    })

    expect(result).toContain("Approved")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("DONE")
    expect(state?.phaseState).toBe("DRAFT")
    expect(state?.taskReviewCount).toBe(0)
    expect(state?.currentTaskId).toBeNull()
    expect(state?.latestReviewResults?.[0]?.criterion).toBe("Final implementation review")
    expect(state?.reviewArtifactFiles).toEqual(["docs/full-execution-plan.md"])
  })
})

// ---------------------------------------------------------------------------
// select_mode — feature alias and resume
// ---------------------------------------------------------------------------

describe("tool.execute — select_mode feature alias", () => {
  it("accepts --feature as alias for --feature_name", async () => {
    const result = await exec("select_mode", { mode: "GREENFIELD", feature: "alias-feat" })
    expect(result).toContain("GREENFIELD")
    expect(result).toContain("PLANNING")

    const state = ctx.engine!.store.get("s1")
    expect(state?.featureName).toBe("alias-feat")
  })
})

describe("tool.execute — select_mode resume", () => {
  it("resumes prior workflow state from a different session", async () => {
    // Create a session with a feature that has progressed past MODE_SELECT
    await handleSessionCreated({ sessionId: "old-session" }, ctx)
    await ctx.engine!.store.update("old-session", (d) => {
      d.featureName = "resume-feat"
      d.mode = "GREENFIELD"
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
    })

    // Now from session s1, call select_mode with the same feature name
    const result = await exec("select_mode", { mode: "GREENFIELD", feature_name: "resume-feat" })
    expect(result).toContain("Resumed")
    expect(result).toContain("INTERFACES")

    // The state should now be accessible under s1 with the old phase
    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("INTERFACES")
    expect(state?.phaseState).toBe("DRAFT")
    expect(state?.featureName).toBe("resume-feat")
  })

  it("resumes a persisted prior workflow even when the old session is not loaded in memory", async () => {
    await handleSessionCreated({ sessionId: "writer" }, ctx)
    await ctx.engine!.store.update("writer", (d) => {
      d.featureName = "persisted-resume-feat"
      d.mode = "INCREMENTAL"
      d.phase = "DISCOVERY"
      d.phaseState = "ANALYZE"
    })

    const freshCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" } }, freshCtx)
    await handleSessionCreated({ sessionId: "reader" }, freshCtx)

    const result = await handleToolExecute({
      name: "select_mode",
      args: { mode: "INCREMENTAL", feature_name: "persisted-resume-feat" },
      context: { sessionId: "reader", directory: tmpDir },
    }, freshCtx) as string

    expect(result).toContain("Resumed prior workflow")
    expect(result).toContain("DISCOVERY/ANALYZE")

    const state = freshCtx.engine!.store.get("reader")
    expect(state?.phase).toBe("DISCOVERY")
    expect(state?.phaseState).toBe("ANALYZE")
    expect(state?.featureName).toBe("persisted-resume-feat")
    expect(state?.sessionId).toBe("reader")
  })

  it("does not resume if prior state is at MODE_SELECT", async () => {
    // Create a session with feature at MODE_SELECT (fresh)
    await handleSessionCreated({ sessionId: "stale-session" }, ctx)
    await ctx.engine!.store.update("stale-session", (d) => {
      d.featureName = "stale-feat"
    })

    // Should NOT resume — should start fresh
    const result = await exec("select_mode", { mode: "GREENFIELD", feature_name: "stale-feat" })
    expect(result).toContain("PLANNING")
    expect(result).not.toContain("Resumed")
  })

  it("does not resume when session matches (same sessionId)", async () => {
    // Set up s1 with feature directly
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "same-sess" })
    // Advance to INTERFACES manually
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "INTERFACES"
      d.phaseState = "DRAFT"
    })

    // Create a new session s2 and call select_mode on same feature
    await handleSessionCreated({ sessionId: "s2" }, ctx)
    const result = await handleToolExecute({
      name: "select_mode",
      args: { mode: "GREENFIELD", feature_name: "same-sess" },
      context: { sessionId: "s2", directory: tmpDir },
    }, ctx) as string
    expect(result).toContain("Resumed")
    expect(result).toContain("INTERFACES")

    // s2 should now have the migrated state
    const state = ctx.engine!.store.get("s2")
    expect(state?.phase).toBe("INTERFACES")
  })
})

// ---------------------------------------------------------------------------
// Quality score enforcement in submit_task_review
// ---------------------------------------------------------------------------

describe("tool.execute — submit_task_review quality scoring", () => {
  it("reverts task when passed=true but code_quality below threshold", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "qs-low-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
    })

    // passed=true but code_quality=7 (below 8 threshold) — should be overridden to fail
    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({
        passed: true,
        issues: [],
        scores: { code_quality: 7, error_handling: 10 },
        reasoning: "Code quality is borderline",
      }),
    })
    expect(result).toContain("FAILED")

    const state = ctx.engine!.store.get("s1")
    expect(state?.taskCompletionInProgress).toBeNull()
    expect(state?.implDag?.find((t) => t.id === "T1")?.status).toBe("pending")
    expect(state?.currentTaskId).toBe("T1")
    expect(state?.taskReviewCount).toBe(1)
  })

  it("passes task when scores are exactly at threshold", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "qs-pass-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
    })

    // Both scores exactly at 8 — should pass
    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({
        passed: true,
        issues: [],
        scores: { code_quality: 8, error_handling: 8 },
        reasoning: "All checks pass, quality at threshold",
      }),
    })
    expect(result).toContain("review passed")

    const state = ctx.engine!.store.get("s1")
    expect(state?.taskCompletionInProgress).toBeNull()
    expect(state?.taskReviewCount).toBe(0)
  })

  it("graceful degradation with {0,0} scores reverts task (not infinite loop)", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "gd-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
      d.taskReviewCount = 0
    })

    // Simulate graceful degradation: passed=true but scores={0,0}
    // parseTaskReviewResult should override to passed=false, reverting the task
    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({
        passed: true,
        issues: ["Review dispatch failed: subprocess timed out"],
        scores: { code_quality: 0, error_handling: 0 },
        reasoning: "Graceful degradation",
      }),
    })
    expect(result).toContain("FAILED")

    const state = ctx.engine!.store.get("s1")
    // Task reverted — NOT auto-accepted
    expect(state?.implDag?.find((t) => t.id === "T1")?.status).toBe("pending")
    expect(state?.currentTaskId).toBe("T1")
    // Gate cleared — agent can retry
    expect(state?.taskCompletionInProgress).toBeNull()
    // Count incremented — will eventually hit force-accept cap
    expect(state?.taskReviewCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// task.getReviewContext
// ---------------------------------------------------------------------------

describe("task.getReviewContext", () => {
  let agentCtx: BridgeContext

  beforeEach(async () => {
    agentCtx = makeBridgeContext()
    agentCtx.capabilities = { selfReview: "agent-only", orchestrator: false, discoveryFleet: false }
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" }, capabilities: { selfReview: "agent-only", orchestrator: false, discoveryFleet: false } }, agentCtx)
    await handleSessionCreated({ sessionId: "rc-session" }, agentCtx)
  })

  it("returns review prompt when task review is pending", async () => {
    await agentCtx.engine!.store.update("rc-session", (d) => {
      d.mode = "GREENFIELD"
      d.featureName = "rc-feat"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup project", dependencies: [], expectedTests: ["tests/setup.test.ts"], expectedFiles: ["src/setup.ts"], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Core logic", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
    })

    const result = await handleTaskGetReviewContext({ sessionId: "rc-session" }, agentCtx)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
    expect(result as string).toContain("T1")
    expect(result as string).toContain("Setup project")
    // Should include adjacent task info (T2 is downstream of T1)
    expect(result as string).toContain("T2")
  })

  it("returns null when no task review is pending", async () => {
    await agentCtx.engine!.store.update("rc-session", (d) => {
      d.mode = "GREENFIELD"
      d.featureName = "rc-feat2"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = null
    })

    const result = await handleTaskGetReviewContext({ sessionId: "rc-session" }, agentCtx)
    expect(result).toBeNull()
  })
})

describe("task.getAutoApproveContext", () => {
  it("returns auto-approve prompt for robot-artisan at USER_GATE", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
      d.activeAgent = "robot-artisan"
      d.featureName = "auto-approve-feat"
      d.reviewArtifactFiles = [join(tmpDir, "plan.md")]
      d.latestReviewResults = [{ criterion: "All user requirements explicitly addressed", met: true, evidence: "ok" } as any]
    })
    const result = await handleAutoApproveContext({ sessionId: "s1" }, ctx)
    expect(typeof result).toBe("string")
    expect(result as string).toContain("auto-approve")
    expect(result as string).toContain("USER_GATE")
  })

  it("returns null outside robot-artisan USER_GATE", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "REDRAFT"
      d.activeAgent = "artisan"
      d.featureName = "no-auto-approve-feat"
    })
    const result = await handleAutoApproveContext({ sessionId: "s1" }, ctx)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Re-entry clearance cycle and force-accept
// ---------------------------------------------------------------------------

describe("tool.execute — task review edge cases", () => {
  it("allows mark_task_complete after review pass clears the gate", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "cycle-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "First", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
        { id: "T2", description: "Second", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = "T1"
    })

    // Complete T1
    const r1 = await exec("mark_task_complete", { task_id: "T1", implementation_summary: "Built T1", tests_passing: true })
    expect(r1).toContain("Per-task review required")

    // Submit passing review
    const r2 = await exec("submit_task_review", {
      review_output: JSON.stringify({ passed: true, issues: [], scores: { code_quality: 9, error_handling: 9 }, reasoning: "Good" }),
    })
    expect(r2).toContain("review passed")

    // Gate should be cleared — T2 should now be completable
    const state = ctx.engine!.store.get("s1")
    expect(state?.taskCompletionInProgress).toBeNull()
    expect(state?.currentTaskId).toBe("T2")

    // Complete T2 — should NOT hit re-entry guard
    await ctx.engine!.store.update("s1", (d) => {
      d.implDag![1]!.status = "pending"
    })
    const r3 = await exec("mark_task_complete", { task_id: "T2", implementation_summary: "Built T2", tests_passing: true })
    expect(r3).toContain("Per-task review required")
    expect(r3).not.toContain("already awaiting review")
  })

  it("force-accepts after MAX_TASK_REVIEW_ITERATIONS", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "cap-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Stubborn task", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = "T1"
      d.taskCompletionInProgress = "T1"
      d.taskReviewCount = 10 // At the cap
    })

    // Submit failing review when at cap — should force-accept
    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({ passed: false, issues: ["Still broken"], reasoning: "Won't pass" }),
    })
    expect(result).toContain("force-accepted")

    const state = ctx.engine!.store.get("s1")
    expect(state?.taskCompletionInProgress).toBeNull()
    expect(state?.taskReviewCount).toBe(0)
    expect(state?.currentTaskId).toBeNull()
  })

  it("passes implementation_summary to review prompt", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "summary-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = "T1"
    })

    const result = await exec("mark_task_complete", {
      task_id: "T1",
      implementation_summary: "Built the auth module with JWT tokens",
      tests_passing: true,
    })
    // The review prompt should include the actual summary, not "(see task files)"
    expect(result).toContain("Built the auth module with JWT tokens")
    expect(result).not.toContain("(see task files)")
  })

  it("allows reset_task during implementation scheduling", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "scheduling-reset" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "SCHEDULING"
      d.implDag = [
        { id: "T1", description: "Resettable", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Later", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = null
      d.taskCompletionInProgress = null
    })

    const result = await exec("reset_task", { task_ids: ["T1"], reason: "Drift repair reset from scheduling." })

    expect(result).toContain("Reset 1 task")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("SCHEDULING")
    expect(state?.currentTaskId).toBe("T1")
    expect(state?.implDag?.find((task) => task.id === "T1")?.status).toBe("pending")
  })

  it("rejects reset_task when completed downstream dependencies are not reset together", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "reset-downstream-guard" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "SCHEDULING"
      d.implDag = [
        { id: "T1", description: "Upstream", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Downstream", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = null
      d.taskCompletionInProgress = null
    })

    const result = await exec("reset_task", { task_ids: ["T1"], reason: "Attempt unsafe partial reset." })

    expect(result).toContain("depends on \"T1\"")
    const state = ctx.engine!.store.get("s1")
    expect(state?.implDag?.map((task) => task.status)).toEqual(["complete", "complete"])
    expect(state?.currentTaskId).toBeNull()
  })

  it("allows reset_task when completed downstream dependencies are reset together", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "reset-downstream-closure" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "SCHEDULING"
      d.implDag = [
        { id: "T1", description: "Upstream", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Downstream", dependencies: ["T1"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
        { id: "T3", description: "Later pending", dependencies: ["T2"], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = null
      d.taskCompletionInProgress = null
    })

    const result = await exec("reset_task", { task_ids: ["T2", "T1"], reason: "Reset full completed closure." })

    expect(result).toContain("Reset 2 task")
    const state = ctx.engine!.store.get("s1")
    expect(state?.currentTaskId).toBe("T1")
    expect(state?.implDag?.map((task) => task.status)).toEqual(["pending", "pending", "pending"])
  })

  it("records service file claims when reset_task selects the current task", async () => {
    const dbCtx = makeBridgeContext()
    const recordedLeases: any[] = []
    const recordedClaims: any[] = []
    dbCtx.openArtisanServices = {
      agentLeases: {
        recordLease: async (lease: any) => { recordedLeases.push(lease); return { ok: true, value: lease } },
        listLeases: async () => ({ ok: true, value: recordedLeases }),
        recordFileClaim: async (claim: any) => { recordedClaims.push(claim); return { ok: true, value: claim } },
        listFileClaims: async (agentLeaseId: string) => ({ ok: true, value: recordedClaims.filter((claim) => claim.agentLeaseId === agentLeaseId) }),
      },
    } as any
    await handleInit({ projectDir: tmpDir, persistence: { kind: "filesystem" } }, dbCtx)
    dbCtx.openArtisanServices = {
      agentLeases: {
        recordLease: async (lease: any) => { recordedLeases.push(lease); return { ok: true, value: lease } },
        listLeases: async () => ({ ok: true, value: recordedLeases }),
        recordFileClaim: async (claim: any) => { recordedClaims.push(claim); return { ok: true, value: claim } },
        listFileClaims: async (agentLeaseId: string) => ({ ok: true, value: recordedClaims.filter((claim) => claim.agentLeaseId === agentLeaseId) }),
      },
    } as any
    await handleSessionCreated({ sessionId: "db-reset" }, dbCtx)
    await dbCtx.engine!.store.update("db-reset", (d) => {
      d.mode = "GREENFIELD"
      d.featureName = "db-reset-claims"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Resettable", dependencies: [], expectedTests: [], expectedFiles: ["src/reset.ts"], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = null
    })

    const result = await handleToolExecute({
      name: "reset_task",
      args: { task_id: "T1" },
      context: { sessionId: "db-reset", directory: tmpDir },
    }, dbCtx) as string

    expect(result).toContain("Reset 1 task")
    const workflowId = workflowDbId(dbCtx.engine!.store.get("db-reset")!)
    const leases = await dbCtx.openArtisanServices!.agentLeases.listLeases(workflowId)
    expect(leases.ok && leases.value.length).toBe(1)
    const persistedClaims = await dbCtx.openArtisanServices!.agentLeases.listFileClaims(leases.ok ? leases.value[0]!.id : "")
    expect(persistedClaims.ok && persistedClaims.value.map((claim: any) => claim.path)).toEqual(["src/reset.ts"])
  })

  it("reports, plans, and applies safe task drift repair through reset_task", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "drift-reset" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "SCHEDULING"
      d.implDag = [
        { id: "T1", description: "Resettable", dependencies: [], expectedTests: [], expectedFiles: ["src/a.ts"], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Pending downstream", dependencies: ["T1"], expectedTests: [], expectedFiles: ["src/b.ts"], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = null
    })

    const reportRaw = await exec("report_drift", { task_ids: ["T1"], include_worktree: false, include_db: false })
    const report = JSON.parse(reportRaw)
    expect(report.ok).toBe(true)
    expect(report.value.findings[0].proposedActions[0].kind).toBe("reset_tasks")

    const planRaw = await exec("plan_drift_repair", { drift_report_id: report.value.id, strategy: "safe-auto" })
    const plan = JSON.parse(planRaw)
    expect(plan.ok).toBe(true)
    expect(plan.value.toolCalls[0].toolCall.toolName).toBe("reset_task")

    const appliedRaw = await exec("apply_drift_repair", { repair_plan_id: plan.value.id, apply_safe_actions: true })
    const applied = JSON.parse(appliedRaw)
    expect(applied.ok).toBe(true)
    expect(applied.value.results[0].toolName).toBe("reset_task")
    const state = ctx.engine!.store.get("s1")
    expect(state?.currentTaskId).toBe("T1")
    expect(state?.implDag?.[0]?.status).toBe("pending")
  })
})
