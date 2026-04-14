/**
 * Tests for bridge tool.execute — dispatches tool calls through the bridge.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { handleInit, handleSessionCreated } from "#bridge/methods/lifecycle"
import { handleToolExecute, handleTaskGetReviewContext } from "#bridge/methods/tool-execute"
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
      d.userGateMessageReceived = true
    })

    const result = await exec("submit_feedback", {
      feedback_type: "revise",
      feedback_text: "Please change X",
    })
    expect(result).toContain("bridge mode")
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
})

describe("tool.execute — mark_task_complete", () => {
  it("completes a task and sets review pending", async () => {
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

    const state = ctx.engine!.store.get("s1")
    expect(state?.implDag?.find((t) => t.id === "T1")?.status).toBe("complete")
    expect(state?.taskCompletionInProgress).toBe("T1")
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
      d.currentTaskId = "T2"
      d.taskCompletionInProgress = "T1"
    })

    const result = await exec("submit_task_review", {
      review_output: JSON.stringify({ passed: true, issues: [], reasoning: "All checks pass" }),
    })
    expect(result).toContain("review passed")

    const state = ctx.engine!.store.get("s1")
    expect(state?.taskCompletionInProgress).toBeNull()
    expect(state?.taskReviewCount).toBe(0)
  })

  it("submit_task_review reverts task on fail", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: "fail-feat" })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.implDag = [
        { id: "T1", description: "Setup", dependencies: [], expectedTests: [], expectedFiles: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = null
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
    await agentExec("request_review", { summary: "Plan", artifact_description: "Plan", artifact_content: "# Plan" })

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
    await agentExec("request_review", { summary: "Plan", artifact_description: "Plan", artifact_content: "# Plan" })
    // mark_satisfied → pass → USER_GATE (provide enough criteria)
    const passingCriteria = Array.from({ length: 16 }, (_, i) => ({
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
    const passingCriteria = Array.from({ length: 16 }, (_, i) => ({
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

  it("mark_satisfied rejects empty criteria without state transition", async () => {
    await agentExec("select_mode", { mode: "GREENFIELD", feature_name: `ao-empty-${Date.now()}` })
    await agentExec("request_review", { summary: "Plan", artifact_description: "Plan", artifact_content: "# Plan" })
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

  it("allows request_review from DISCOVERY/CONVENTIONS", async () => {
    await exec("select_mode", { mode: "GREENFIELD", feature_name: `conv-${Date.now()}` })
    await ctx.engine!.store.update("s1", (d) => {
      d.phase = "DISCOVERY"
      d.phaseState = "CONVENTIONS"
    })

    const result = await exec("request_review", {
      summary: "Conventions",
      artifact_description: "Conventions doc",
      artifact_content: "# Conventions\n",
    })

    expect(result).toContain("Transitioning to DISCOVERY/REVIEW")
    expect(ctx.engine!.store.get("s1")?.phaseState).toBe("REVIEW")
  })
})

describe("tool.execute — submit_auto_approve", () => {
  it("routes invalid auto-approve output to REVISE", async () => {
    const agentCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir }, agentCtx)
    await handleSessionCreated({ sessionId: "robot-session", agent: "robot-artisan" }, agentCtx)
    await agentCtx.engine!.store.update("robot-session", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
    })

    const result = await handleToolExecute({
      name: "submit_auto_approve",
      args: { review_output: "not-json" },
      context: { sessionId: "robot-session", directory: tmpDir },
    }, agentCtx) as string

    expect(result).toContain("Auto-approve failed")
    const state = agentCtx.engine!.store.get("robot-session")
    expect(state?.phaseState).toBe("REVISE")
  })
})

describe("tool.execute — resolve_human_gate", () => {
  it("auto-advances to USER_GATE when all remaining work is human-gated", async () => {
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

    expect(result).toContain("USER_GATE")
    const state = ctx.engine!.store.get("s1")
    expect(state?.phaseState).toBe("USER_GATE")
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
      d.currentTaskId = null
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
      d.currentTaskId = null
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
      d.currentTaskId = null
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
    await handleInit({ projectDir: tmpDir, capabilities: { selfReview: "agent-only", orchestrator: false, discoveryFleet: false } }, agentCtx)
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
      d.currentTaskId = "T2"
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
      d.currentTaskId = null
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
})
