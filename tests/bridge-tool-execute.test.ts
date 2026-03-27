/**
 * Tests for bridge tool.execute — dispatches tool calls through the bridge.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

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
    capabilities: { selfReview: "isolated" as const, orchestrator: true, discoveryFleet: true },
    pinoLogger: null,
    shuttingDown: false,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-tools-"))
  ctx = makeBridgeContext()
  await handleInit({ projectDir: tmpDir }, ctx)
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
    // Now at PLANNING — can't select mode again
    const result = await exec("select_mode", { mode: "GREENFIELD", feature_name: "other" })
    expect(result).toContain("Error")
    expect(result).toContain("MODE_SELECT")
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
  it("mark_analyze_complete returns bridge mode error", async () => {
    const result = await exec("mark_analyze_complete")
    expect(result).toContain("bridge mode")
    expect(result).toContain("SubagentDispatcher")
  })

  it("mark_satisfied returns bridge mode error", async () => {
    const result = await exec("mark_satisfied")
    expect(result).toContain("bridge mode")
  })

  it("propose_backtrack returns bridge mode error", async () => {
    const result = await exec("propose_backtrack")
    expect(result).toContain("bridge mode")
  })

  it("spawn_sub_workflow returns bridge mode error", async () => {
    const result = await exec("spawn_sub_workflow")
    expect(result).toContain("bridge mode")
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

    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).not.toBe("USER_GATE")
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
- **Complexity:** small
- **Tests:** tests/setup.test.ts

### T2: Implement core logic
- **Dependencies:** T1
- **Complexity:** medium
- **Tests:** tests/core.test.ts
`

    const result = await exec("submit_feedback", {
      feedback_type: "approve",
      feedback_text: "approved",
      artifact_content: implPlan,
    })
    expect(result).toContain("Approved")
    expect(result).toContain("IMPLEMENTATION")

    const state = ctx.engine!.store.get("s1")
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.implDag).not.toBeNull()
    expect(state?.implDag?.length).toBeGreaterThanOrEqual(1)
    expect(state?.currentTaskId).not.toBeNull()
  })

  it("revise returns bridge mode error (needs orchestrator)", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "rev-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phaseState = "USER_GATE"
    })

    const result = await exec("submit_feedback", {
      feedback_type: "revise",
      feedback_text: "Please change X",
    })
    expect(result).toContain("bridge mode")
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
})

describe("tool.execute — mark_task_complete", () => {
  it("completes a task and returns next scheduler decision", async () => {
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
    expect(result).not.toContain("Error")

    const state = ctx.engine!.store.get("s1")
    expect(state?.implDag?.find((t) => t.id === "T1")?.status).toBe("complete")
    expect(state?.currentTaskId).toBe("T2")
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
    await handleInit({ projectDir: tmpDir, capabilities: { selfReview: "agent-only", orchestrator: false, discoveryFleet: false } }, agentCtx)
    await handleSessionCreated({ sessionId: "ao-session" }, agentCtx)
    agentExec = (name, args = {}) =>
      handleToolExecute(
        { name, args, context: { sessionId: "ao-session", directory: tmpDir } },
        agentCtx,
      ) as Promise<string>
  })

  it("mark_satisfied passes with all blocking criteria met", async () => {
    // Advance to PLANNING/REVIEW
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-test-${Date.now()}` })
    await agentExec("request_review", { summary: "Plan", artifact_description: "Plan doc", artifact_content: "# Plan" })

    // PLANNING has many expected blocking criteria. Provide enough to satisfy the count check.
    const criteria = Array.from({ length: 15 }, (_, i) => ({
      criterion: `Criterion ${i + 1}`, met: true, evidence: "verified", severity: "blocking",
    }))
    const result = await agentExec("mark_satisfied", { criteria_met: criteria })
    // Should advance to USER_GATE (not error about SubagentDispatcher)
    expect(result).not.toContain("SubagentDispatcher")
    expect(result.toLowerCase()).toContain("user gate")
  })

  it("mark_satisfied fails and routes to REVISE with unmet criteria", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-fail-${Date.now()}` })
    await agentExec("request_review", { summary: "Plan", artifact_description: "Plan", artifact_content: "# Plan" })

    // Provide enough criteria but with one unmet blocking
    const criteria = Array.from({ length: 15 }, (_, i) => ({
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
    await agentExec("request_review", { summary: "Plan", artifact_description: "Plan", artifact_content: "# Plan" })
    // mark_satisfied → pass → USER_GATE (provide enough criteria)
    const passingCriteria = Array.from({ length: 15 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "ok", severity: "blocking",
    }))
    await agentExec("mark_satisfied", { criteria_met: passingCriteria })
    // Simulate user message for USER_GATE
    await agentCtx.engine!.store.update("ao-session", (d) => { d.userGateMessageReceived = true })

    const result = await agentExec("submit_feedback", { feedback_type: "revise", feedback_text: "Add more detail" })
    expect(result).not.toContain("SubagentDispatcher")
    expect(result).toContain("REVISE")
    const state = agentCtx.engine!.store.get("ao-session")
    expect(state?.phaseState).toBe("REVISE")
  })

  it("propose_backtrack works in agent-only mode", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-bt-${Date.now()}` })
    // Advance to PLANNING/REVIEW → USER_GATE → approve → INTERFACES/DRAFT
    await agentExec("request_review", { summary: "Plan", artifact_description: "Plan", artifact_content: "# Plan" })
    const passingCriteria = Array.from({ length: 15 }, (_, i) => ({
      criterion: `C${i + 1}`, met: true, evidence: "ok", severity: "blocking",
    }))
    await agentExec("mark_satisfied", { criteria_met: passingCriteria })
    await agentCtx.engine!.store.update("ao-session", (d) => { d.userGateMessageReceived = true })
    await agentExec("submit_feedback", { feedback_type: "approve", feedback_text: "approved" })
    // Now in INTERFACES/DRAFT — backtrack to PLANNING
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
    expect(state2?.phaseState).toBe("DRAFT")
  })

  it("mark_satisfied returns subagent error in isolated mode", async () => {
    // Use the default ctx (isolated mode)
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `iso-test-${Date.now()}` })
    await exec("request_review", { summary: "Plan", artifact_description: "Plan", artifact_content: "# Plan" })
    const result = await exec("mark_satisfied", {
      criteria_met: [{ criterion: "OK", met: true, evidence: "good", severity: "blocking" }],
    })
    expect(result).toContain("SubagentDispatcher")
  })
})
