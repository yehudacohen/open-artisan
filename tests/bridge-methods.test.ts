/**
 * Tests for bridge guard, prompt, message, and idle methods.
 *
 * Uses in-process handler calls with a real store.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { handleInit, handleSessionCreated } from "#bridge/methods/lifecycle"
import { handleGuardCheck, handleGuardPolicy } from "#bridge/methods/guard"
import { handlePromptBuild, handlePromptCompaction } from "#bridge/methods/prompt"
import { handleStateGet, handleStateHealth } from "#bridge/methods/state"
import { handleMessageProcess } from "#bridge/methods/message"
import { handleIdleCheck } from "#bridge/methods/idle"
import type { BridgeContext } from "#bridge/server"
import type { GuardCheckResult, GuardPolicyResult, IdleCheckResult, MessageProcessResult } from "#bridge/protocol"
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
  tmpDir = await mkdtemp(join(tmpdir(), "bridge-methods-"))
  ctx = makeBridgeContext()
  await handleInit({ projectDir: tmpDir }, ctx)
  await handleSessionCreated({ sessionId: "s1" }, ctx)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// guard.check
// ---------------------------------------------------------------------------

describe("guard.check", () => {
  it("allows workflow tools in any phase", async () => {
    const result = await handleGuardCheck({
      toolName: "select_mode",
      args: {},
      sessionId: "s1",
    }, ctx) as GuardCheckResult
    // select_mode is not in the blocked list for MODE_SELECT
    // (it's a workflow tool, and the guard doesn't block workflow tools)
    expect(result.allowed).toBe(true)
    expect(result.policyVersion).toBeGreaterThanOrEqual(0)
  })

  it("blocks write tools in MODE_SELECT", async () => {
    const result = await handleGuardCheck({
      toolName: "write_file",
      args: { filePath: "/project/src/foo.ts" },
      sessionId: "s1",
    }, ctx) as GuardCheckResult
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("blocked")
  })

  it("includes policyVersion in response", async () => {
    const result = await handleGuardCheck({
      toolName: "read_file",
      args: {},
      sessionId: "s1",
    }, ctx) as GuardCheckResult
    expect(typeof result.policyVersion).toBe("number")
  })

  it("rejects missing sessionId", async () => {
    await expect(handleGuardCheck({
      toolName: "write_file",
      args: {},
    }, ctx)).rejects.toThrow("sessionId")
  })

  it("rejects unknown session", async () => {
    await expect(handleGuardCheck({
      toolName: "write_file",
      args: {},
      sessionId: "nonexistent",
    }, ctx)).rejects.toThrow("not found")
  })

  it("blocks workflow tools for ephemeral child sessions", async () => {
    await handleSessionCreated({ sessionId: "child", parentId: "s1" }, ctx)
    const result = await handleGuardCheck({
      toolName: "select_mode",
      args: {},
      sessionId: "child",
    }, ctx) as GuardCheckResult
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("subagent session")
  })

  it("allows workflow tools for sub-workflow children (own state)", async () => {
    // Create a sub-workflow child with its own state
    await handleSessionCreated({ sessionId: "sub-child", parentId: "s1" }, ctx)
    await ctx.engine!.store.create("sub-child")
    await ctx.engine!.store.update("sub-child", (d) => {
      d.featureName = "sub-feat"
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.parentWorkflow = { sessionId: "s1", featureName: "parent", taskId: "T1" }
    })
    const result = await handleGuardCheck({
      toolName: "request_review",
      args: {},
      sessionId: "sub-child",
    }, ctx) as GuardCheckResult
    // Sub-workflow should use its own state and policy, not be blocked
    expect(result.allowed).toBe(true)
  })

  it("allows write tools in IMPLEMENTATION/DRAFT with GREENFIELD mode", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.featureName = "impl-feat"
    })
    const result = await handleGuardCheck({
      toolName: "write_file",
      args: { filePath: "/project/src/foo.ts" },
      sessionId: "s1",
    }, ctx) as any
    expect(result.allowed).toBe(true)
  })

  it("allows expected test files for the current implementation task", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "INCREMENTAL"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.featureName = "impl-feat"
      d.fileAllowlist = [join(tmpDir, "src/foo.ts"), join(tmpDir, "tests/foo.test.ts")]
      d.currentTaskId = "T1"
      d.implDag = [{
        id: "T1",
        description: "Task",
        dependencies: [],
        expectedFiles: [join(tmpDir, "src/foo.ts")],
        expectedTests: [join(tmpDir, "tests/foo.test.ts")],
        estimatedComplexity: "small",
        status: "pending",
      }]
    })
    const result = await handleGuardCheck({
      toolName: "write_file",
      args: { filePath: join(tmpDir, "tests/foo.test.ts") },
      sessionId: "s1",
    }, ctx) as GuardCheckResult
    expect(result.allowed).toBe(true)
  })

  it("blocks bash write operators in INCREMENTAL mode", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "INCREMENTAL"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.featureName = "inc-feat"
      d.fileAllowlist = ["/project/src/foo.ts"]
    })
    const result = await handleGuardCheck({
      toolName: "bash",
      args: { command: "echo 'hello' > /tmp/out.txt" },
      sessionId: "s1",
    }, ctx) as any
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("INCREMENTAL")
  })
})

// ---------------------------------------------------------------------------
// guard.policy
// ---------------------------------------------------------------------------

describe("guard.policy", () => {
  it("returns policy for MODE_SELECT", async () => {
    const result = await handleGuardPolicy({
      phase: "MODE_SELECT",
      phaseState: "DRAFT",
      mode: null,
      allowlist: [],
    }, ctx) as GuardPolicyResult
    expect(result.blocked).toBeInstanceOf(Array)
    expect(result.blocked.length).toBeGreaterThan(0) // MODE_SELECT blocks most tools
    expect(typeof result.allowedDescription).toBe("string")
    expect(typeof result.policyVersion).toBe("number")
  })

  it("returns predicate flags", async () => {
    const result = await handleGuardPolicy({
      phase: "IMPLEMENTATION",
      phaseState: "DRAFT",
      mode: "INCREMENTAL",
      allowlist: ["/src/foo.ts"],
    }, ctx) as GuardPolicyResult
    // INCREMENTAL mode has write path and bash command predicates
    expect(typeof result.hasWritePathPredicate).toBe("boolean")
    expect(typeof result.hasBashCommandPredicate).toBe("boolean")
  })
})

describe("lifecycle.init capabilities", () => {
  it("defaults bridge mode to agent-only capabilities", async () => {
    const freshCtx = makeBridgeContext()
    await handleInit({ projectDir: tmpDir }, freshCtx)
    expect(freshCtx.capabilities).toEqual({
      selfReview: "agent-only",
      orchestrator: false,
      discoveryFleet: false,
    })
  })
})

// ---------------------------------------------------------------------------
// prompt.build
// ---------------------------------------------------------------------------

describe("prompt.build", () => {
  it("returns a prompt string for an active session", async () => {
    const result = await handlePromptBuild({ sessionId: "s1" }, ctx) as string
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    // MODE_SELECT prompt should mention mode selection
    expect(result.toLowerCase()).toContain("mode")
  })

  it("returns null for unknown session", async () => {
    const result = await handlePromptBuild({ sessionId: "nonexistent" }, ctx)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// prompt.compaction
// ---------------------------------------------------------------------------

describe("prompt.compaction", () => {
  it("returns compaction context for a session", async () => {
    const result = await handlePromptCompaction({ sessionId: "s1" }, ctx) as string
    expect(typeof result).toBe("string")
  })

  it("returns compaction context for ephemeral child sessions from the parent workflow", async () => {
    await handleSessionCreated({ sessionId: "child-compaction", parentId: "s1" }, ctx)
    const result = await handlePromptCompaction({ sessionId: "child-compaction" }, ctx)
    expect(typeof result).toBe("string")
    expect((result as string).toLowerCase()).toContain("subagent")
    expect(result).toContain("WORKFLOW")
  })

  it("includes structural REDRAFT state in compaction context", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "INCREMENTAL"
      d.phase = "PLANNING"
      d.phaseState = "REDRAFT"
      d.featureName = "redraft-feat"
      d.backtrackContext = {
        sourcePhase: "INTERFACES",
        targetPhase: "PLANNING",
        reason: "Interfaces uncovered a missing planner invariant.",
      }
    })
    const result = await handlePromptCompaction({ sessionId: "s1" }, ctx) as string
    expect(result).toContain("REDRAFT")
    expect(result).toContain("INTERFACES")
  })

  it("returns null for unknown session", async () => {
    const result = await handlePromptCompaction({ sessionId: "nonexistent" }, ctx)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// state.get / state.health
// ---------------------------------------------------------------------------

describe("state.get / state.health", () => {
  it("state.get includes runtime health for structural HUMAN_GATE state", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "INCREMENTAL"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "HUMAN_GATE"
      d.featureName = "human-gate-feat"
    })
    const result = await handleStateGet({ sessionId: "s1", includeRuntimeHealth: true }, ctx) as any
    expect(result.state.phaseState).toBe("HUMAN_GATE")
    expect(result.runtimeHealth.phase).toBe("IMPLEMENTATION")
    expect(result.runtimeHealth.phaseState).toBe("HUMAN_GATE")
    expect(result.runtimeHealth.awaitingUserGate).toBe(false)
  })

  it("state.health reports pending task review for TASK_REVIEW state", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "INCREMENTAL"
      d.phase = "IMPLEMENTATION"
      d.phaseState = "TASK_REVIEW"
      d.currentTaskId = "T9"
      d.taskCompletionInProgress = "T9"
      d.featureName = "task-review-feat"
    })
    const result = await handleStateHealth({ sessionId: "s1" }, ctx) as any
    expect(result.phase).toBe("IMPLEMENTATION")
    expect(result.phaseState).toBe("TASK_REVIEW")
    expect(result.pendingTaskReview).toBe(true)
    expect(result.noopReason).toContain("T9")
  })
})

// ---------------------------------------------------------------------------
// message.process
// ---------------------------------------------------------------------------

describe("message.process", () => {
  it("passes through messages when not at USER_GATE", async () => {
    // Session is at MODE_SELECT/DRAFT — not a gate
    const result = await handleMessageProcess({
      sessionId: "s1",
      parts: [{ type: "text", text: "hello" }],
    }, ctx) as MessageProcessResult
    expect(result.intercepted).toBe(false)
    expect(result.parts).toHaveLength(1)
  })

  it("intercepts messages at USER_GATE", async () => {
    // Move session to a USER_GATE state
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
    })
    const result = await handleMessageProcess({
      sessionId: "s1",
      parts: [{ type: "text", text: "looks good, approved" }],
    }, ctx) as MessageProcessResult
    expect(result.intercepted).toBe(true)
  })

  it("rejects unknown session", async () => {
    await expect(handleMessageProcess({
      sessionId: "nonexistent",
      parts: [{ type: "text", text: "hello" }],
    }, ctx)).rejects.toThrow("not found")
  })
})

// ---------------------------------------------------------------------------
// idle.check
// ---------------------------------------------------------------------------

describe("idle.check", () => {
  it("returns reprompt for session at active phase with low retry count", async () => {
    // Move to PLANNING/DRAFT — agent should be working, idle = reprompt
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.retryCount = 0
    })
    const result = await handleIdleCheck({ sessionId: "s1" }, ctx) as IdleCheckResult
    expect(result.action).toBe("reprompt")
    expect(typeof result.message).toBe("string")
    expect(result.retryCount).toBe(1)
  })

  // Decision note: treat REDRAFT, SKIP_CHECK, CASCADE_CHECK, SCHEDULING, TASK_REVIEW,
  // TASK_REVISE, and DELEGATED_WAIT as active non-gate states that should keep the
  // workflow moving autonomously through the bridge idle seam.
  // Alternative considered: ignore idle in these states. Rejected because it would leave
  // the workflow stalled during structural decision/revision/delegation work without a truthful gate.
  for (const [phase, phaseState] of [
    ["PLANNING", "REDRAFT"],
    ["INTERFACES", "SKIP_CHECK"],
    ["INTERFACES", "CASCADE_CHECK"],
    ["IMPLEMENTATION", "SCHEDULING"],
    ["IMPLEMENTATION", "TASK_REVIEW"],
    ["IMPLEMENTATION", "TASK_REVISE"],
    ["IMPLEMENTATION", "DELEGATED_WAIT"],
  ] as const) {
    it(`returns reprompt for ${phase}/${phaseState}`, async () => {
      await ctx.engine!.store.update("s1", (d) => {
        d.mode = "INCREMENTAL"
        d.phase = phase
        d.phaseState = phaseState
        d.retryCount = 0
      })
      const result = await handleIdleCheck({ sessionId: "s1" }, ctx) as IdleCheckResult
      expect(result.action).toBe("reprompt")
      expect(typeof result.message).toBe("string")
      expect(result.retryCount).toBe(1)
    })
  }

  it("returns escalate after max retries", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "DRAFT"
      d.retryCount = 10 // Well above MAX_IDLE_RETRIES
    })
    const result = await handleIdleCheck({ sessionId: "s1" }, ctx) as IdleCheckResult
    expect(result.action).toBe("escalate")
  })

  it("returns ignore at USER_GATE (waiting for user)", async () => {
    await ctx.engine!.store.update("s1", (d) => {
      d.mode = "GREENFIELD"
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
    })
    const result = await handleIdleCheck({ sessionId: "s1" }, ctx) as IdleCheckResult
    expect(result.action).toBe("ignore")
  })

  it("rejects unknown session", async () => {
    await expect(handleIdleCheck({
      sessionId: "nonexistent",
    }, ctx)).rejects.toThrow("not found")
  })
})
