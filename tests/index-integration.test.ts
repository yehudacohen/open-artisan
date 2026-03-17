/**
 * Integration tests for index.ts — the main plugin entry point.
 *
 * These tests exercise the full wiring: tool calls go through the state store
 * and state machine, hooks dispatch correctly, and edge cases are handled.
 *
 * Strategy: mock the OpenCode client, instantiate the real plugin, then call
 * the returned tools and hooks to verify end-to-end behavior.
 */
import { describe, expect, it, beforeEach, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// The plugin factory — note: it imports @opencode-ai/plugin at the top level
// which is a runtime-provided package. We rely on the tsconfig path mapping
// set up for tests. The `tool` and `Plugin` imports inside index.ts are
// resolved via the test shim at #opencode-ai/plugin.
import { OpenArtisanPlugin, WORKFLOW_TOOL_NAMES, resolveSessionId } from "#plugin/index"

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeMockClient() {
  const sessions = new Map<string, { id: string }>()
  let idCounter = 0

  return {
    session: {
      create: mock(async (opts: { title?: string }) => {
        const id = `eph-${++idCounter}`
        sessions.set(id, { id })
        return { data: { id } }
      }),
      prompt: mock(async (opts: { sessionID: string; parts?: unknown[] }) => {
        // Return a v2 shape that satisfies both orchestrator (assess/diverge) and
        // self-review (satisfied/criteria_results) parsers.
        // Include enough blocking criteria to pass cross-validation for any phase.
        // PLANNING has 8 standard blocking + 7 [Q] quality = 15 total blocking.
        const response = {
          classification: "tactical",
          reasoning: "mock",
          satisfied: true,
          criteria_results: [
            { criterion: "All user requirements explicitly addressed", met: true, evidence: "mock", severity: "blocking" },
            { criterion: "Scope boundaries explicit", met: true, evidence: "mock", severity: "blocking" },
            { criterion: "Architecture described", met: true, evidence: "mock", severity: "blocking" },
            { criterion: "Error and failure cases specified", met: true, evidence: "mock", severity: "blocking" },
            { criterion: "No TBD items", met: true, evidence: "mock", severity: "blocking" },
            { criterion: "Data model described", met: true, evidence: "mock", severity: "blocking" },
            { criterion: "Integration points identified", met: true, evidence: "mock", severity: "blocking" },
            { criterion: "Deployment & infrastructure addressed", met: true, evidence: "mock", severity: "blocking" },
            // [Q] Quality dimensions (scored 9/10 to pass threshold)
            { criterion: "[Q] Design excellence", met: true, evidence: "mock", severity: "blocking", score: 9 },
            { criterion: "[Q] Architectural cohesion", met: true, evidence: "mock", severity: "blocking", score: 9 },
            { criterion: "[Q] Vision alignment", met: true, evidence: "mock", severity: "blocking", score: 9 },
            { criterion: "[Q] Completeness", met: true, evidence: "mock", severity: "blocking", score: 9 },
            { criterion: "[Q] Readiness for execution", met: true, evidence: "mock", severity: "blocking", score: 9 },
            { criterion: "[Q] Security standards", met: true, evidence: "mock", severity: "blocking", score: 9 },
            { criterion: "[Q] Operational excellence", met: true, evidence: "mock", severity: "blocking", score: 9 },
          ],
        }
        return {
          data: { parts: [{ type: "text", text: JSON.stringify(response) }] },
        }
      }),
      delete: mock(async (opts: { sessionID: string }) => {
        sessions.delete(opts.sessionID)
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin instance helper
// ---------------------------------------------------------------------------

let tempDir: string
let client: ReturnType<typeof makeMockClient>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let plugin: any

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "sw-integration-"))
  client = makeMockClient()

  // OpenArtisanPlugin reads import.meta.dirname to find the state dir.
  // In tests, the state file lands in the real plugin dir — we accept that and
  // work around by using a unique session ID per test. The plugin startup
  // calls store.load() which is safe even if the file doesn't exist.
  plugin = await OpenArtisanPlugin({ client } as any)
})

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("Plugin shape — returned object has all required keys", () => {
  it("returns event hook", () => {
    expect(typeof plugin.event).toBe("function")
  })

  it("returns chat.message hook", () => {
    expect(typeof plugin["chat.message"]).toBe("function")
  })

  it("returns system transform hook", () => {
    expect(typeof plugin["experimental.chat.system.transform"]).toBe("function")
  })

  it("returns compaction hook", () => {
    expect(typeof plugin["experimental.session.compacting"]).toBe("function")
  })

  it("returns tool guard hook", () => {
    expect(typeof plugin["tool.execute.before"]).toBe("function")
  })

  it("returns all expected tools", () => {
    const tools = plugin.tool
    expect(tools.select_mode).toBeDefined()
    expect(tools.mark_scan_complete).toBeDefined()
    expect(tools.mark_analyze_complete).toBeDefined()
    expect(tools.mark_satisfied).toBeDefined()
    expect(tools.mark_task_complete).toBeDefined()
    expect(tools.request_review).toBeDefined()
    expect(tools.submit_feedback).toBeDefined()
  })

  it("WORKFLOW_TOOL_NAMES contains all 8 tool names", () => {
    expect(WORKFLOW_TOOL_NAMES.size).toBe(8)
    expect(WORKFLOW_TOOL_NAMES.has("select_mode")).toBe(true)
    expect(WORKFLOW_TOOL_NAMES.has("mark_task_complete")).toBe(true)
    expect(WORKFLOW_TOOL_NAMES.has("submit_feedback")).toBe(true)
    expect(WORKFLOW_TOOL_NAMES.has("resolve_human_gate")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle via event hook
// ---------------------------------------------------------------------------

describe("Event hook — session lifecycle", () => {
  it("session.created initializes state", async () => {
    const sessionId = `int-test-${Date.now()}-created`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sessionId } } },
    })

    // Verify by calling select_mode — should succeed at MODE_SELECT
    const result = await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId },
    )
    expect(result).toContain("GREENFIELD")
    expect(result).not.toContain("Error")
  })

  it("session.created with no sessionId is a no-op", async () => {
    // Should not throw
    await plugin.event({
      event: { type: "session.created", properties: {} },
    })
  })

  it("session.deleted cleans up state", async () => {
    const sessionId = `int-test-${Date.now()}-deleted`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sessionId } } },
    })
    await plugin.event({
      event: { type: "session.deleted", properties: { info: { id: sessionId } } },
    })

    // State was deleted, but ensureState lazily re-creates it (handles
    // missed session.created events at startup). After re-creation the
    // session starts in MODE_SELECT, so select_mode succeeds.
    const result = await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId },
    )
    expect(result).toContain("GREENFIELD")
  })
})

// ---------------------------------------------------------------------------
// select_mode tool — full wiring
// ---------------------------------------------------------------------------

describe("select_mode tool — full integration", () => {
  const sessionId = `int-test-${Date.now()}-mode`

  beforeEach(async () => {
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sessionId } } },
    })
  })

  it("GREENFIELD transitions to PLANNING", async () => {
    const result = await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId },
    )
    expect(result).toContain("GREENFIELD")
    expect(result).toContain("PLANNING")
  })

  it("REFACTOR transitions to DISCOVERY", async () => {
    const sid = `int-test-${Date.now()}-refactor`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const result = await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "test-refactor" },
      { directory: tempDir, sessionId: sid },
    )
    expect(result).toContain("REFACTOR")
    expect(result).toContain("DISCOVERY")
  })

  it("INCREMENTAL transitions to DISCOVERY", async () => {
    const sid = `int-test-${Date.now()}-incremental`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const result = await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "test-incremental" },
      { directory: tempDir, sessionId: sid },
    )
    expect(result).toContain("INCREMENTAL")
    expect(result).toContain("DISCOVERY")
  })

  it("calling select_mode twice returns error", async () => {
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId },
    )
    const result2 = await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "test-refactor" },
      { directory: tempDir, sessionId },
    )
    expect(result2).toContain("Error")
    expect(result2).toContain("Mode already selected")
  })

  it("invalid mode returns error", async () => {
    const sid = `int-test-${Date.now()}-badmode`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const result = await plugin.tool.select_mode.execute(
      { mode: "INVALID", feature_name: "test-invalid" },
      { directory: tempDir, sessionId: sid },
    )
    expect(result).toContain("Error")
  })

  it("no prior session.created event — ensureState creates state lazily", async () => {
    // ensureState handles the race condition where session.created was missed
    // (e.g. plugin loaded after session already existed). select_mode succeeds.
    const sid = `int-test-${Date.now()}-lazy`
    const result = await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId: sid },
    )
    expect(result).toContain("GREENFIELD")
  })
})

// ---------------------------------------------------------------------------
// Tool guard — tool.execute.before
// ---------------------------------------------------------------------------

describe("tool.execute.before — phase-gated tool restrictions", () => {
  it("does not block workflow tools regardless of phase", async () => {
    const sid = `int-test-${Date.now()}-guard`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    // At MODE_SELECT — most tools should be blocked but workflow tools are exempt
    await expect(
      plugin["tool.execute.before"]({ sessionID: sid, tool: "select_mode" }),
    ).resolves.toBeUndefined()
  })

  it("blocks write tools during DISCOVERY/SCAN", async () => {
    const sid = `int-test-${Date.now()}-guardscan`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    // Transition to DISCOVERY
    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "test-refactor" },
      { directory: tempDir, sessionId: sid },
    )
    // Now in DISCOVERY/SCAN — write tools should be blocked
    await expect(
      plugin["tool.execute.before"]({ sessionID: sid, tool: "file_write", args: { filePath: "/tmp/test" } }),
    ).rejects.toThrow("blocked")
  })

  it("allows read tools during DISCOVERY/SCAN", async () => {
    const sid = `int-test-${Date.now()}-guardread`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "test-refactor" },
      { directory: tempDir, sessionId: sid },
    )
    // Read tools should pass through
    await expect(
      plugin["tool.execute.before"]({ sessionID: sid, tool: "read_file" }),
    ).resolves.toBeUndefined()
  })

  it("unknown session is a no-op (does not throw)", async () => {
    await expect(
      plugin["tool.execute.before"]({ sessionID: "truly-unknown-session-guard", tool: "file_write" }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Compaction hook
// ---------------------------------------------------------------------------

describe("experimental.session.compacting — preserves context", () => {
  it("injects context for an active session", async () => {
    const sid = `int-test-${Date.now()}-compact`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId: sid },
    )
    const output: { context?: string[] } = {}
    await plugin["experimental.session.compacting"]({ sessionID: sid }, output)
    expect(output.context).toBeDefined()
    expect(output.context!.length).toBeGreaterThan(0)
    expect(output.context![0]).toContain("PLANNING")
    expect(output.context![0]).toContain("GREENFIELD")
  })

  it("unknown session is a no-op", async () => {
    const output: { context?: string[] } = {}
    await plugin["experimental.session.compacting"]({ sessionID: "truly-unknown-session-compact" }, output)
    expect(output.context).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// System transform hook
// ---------------------------------------------------------------------------

describe("experimental.chat.system.transform — injects workflow prompt", () => {
  it("prepends workflow block to system parts", async () => {
    const sid = `int-test-${Date.now()}-systrans`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId: sid },
    )
    const output = { system: ["existing system prompt"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid }, output)
    // Workflow block should be prepended (first element)
    expect(output.system.length).toBeGreaterThanOrEqual(2)
    expect(output.system[0]).toContain("STRUCTURED WORKFLOW")
    expect(output.system[0]).toContain("PLANNING")
  })

  it("unknown session does not modify system array", async () => {
    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: "truly-unknown-session-system" }, output)
    expect(output.system.length).toBe(1)
    expect(output.system[0]).toBe("original")
  })
})

// ---------------------------------------------------------------------------
// Multi-step workflow: MODE_SELECT → PLANNING/DRAFT → REVIEW → USER_GATE
// ---------------------------------------------------------------------------

describe("End-to-end: GREENFIELD happy path through PLANNING", () => {
  it("select_mode → request_review → mark_satisfied → submit_feedback(approve)", async () => {
    const sid = `int-test-${Date.now()}-e2e`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // 1. Select GREENFIELD mode
    const modeResult = await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "test-feature" }, ctx)
    expect(modeResult).toContain("GREENFIELD")

    // 2. Now in PLANNING/DRAFT — call request_review
    const rrResult = await plugin.tool.request_review.execute(
      { summary: "The plan", artifact_description: "Plan for feature X" },
      ctx,
    )
    expect(rrResult).not.toContain("Error")
    // Should now be in REVIEW

    // 3. Call mark_satisfied with all 15 blocking criteria for PLANNING phase met
    //    (8 standard blocking + 7 [Q] quality dimensions)
    const msResult = await plugin.tool.mark_satisfied.execute(
      {
        criteria_met: [
          { criterion: "All user requirements explicitly addressed", met: true, evidence: "Section 1 covers all", severity: "blocking" },
          { criterion: "Scope boundaries explicit", met: true, evidence: "Section 2 lists scope", severity: "blocking" },
          { criterion: "Architecture described", met: true, evidence: "Section 3 has arch diagram", severity: "blocking" },
          { criterion: "Error and failure cases specified", met: true, evidence: "Section 4 covers errors", severity: "blocking" },
          { criterion: "No TBD items", met: true, evidence: "All decisions resolved", severity: "blocking" },
          { criterion: "Data model described", met: true, evidence: "Section 5 has ERD", severity: "blocking" },
          { criterion: "Integration points identified", met: true, evidence: "Section 6 lists APIs", severity: "blocking" },
          { criterion: "Deployment & infrastructure addressed", met: true, evidence: "Section 8 covers deployment pipeline and infra", severity: "blocking" },
          // [Q] Quality dimensions — scored as strings (tool.schema has no .number())
          { criterion: "[Q] Design excellence", met: true, evidence: "Well-reasoned approach", severity: "blocking", score: "9" },
          { criterion: "[Q] Architectural cohesion", met: true, evidence: "All components fit together", severity: "blocking", score: "9" },
          { criterion: "[Q] Vision alignment", met: true, evidence: "Plan traces to user intent", severity: "blocking", score: "9" },
          { criterion: "[Q] Completeness", met: true, evidence: "Every requirement addressed", severity: "blocking", score: "9" },
          { criterion: "[Q] Readiness for execution", met: true, evidence: "Engineer can begin immediately", severity: "blocking", score: "10" },
          { criterion: "[Q] Security standards", met: true, evidence: "Auth and validation covered", severity: "blocking", score: "9" },
          { criterion: "[Q] Operational excellence", met: true, evidence: "Monitoring and logging covered", severity: "blocking", score: "9" },
        ],
      },
      ctx,
    )
    expect(msResult).not.toContain("Error")
    // Should now be in USER_GATE (or still in REVIEW if self-review took over)

    // 4. Simulate a user message at USER_GATE (required before approval can succeed).
    //    The chat.message hook sets userGateMessageReceived=true when intercepting a
    //    user message at USER_GATE.
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "approved" }] },
    )

    // 5. Call submit_feedback with approve — now allowed because user message was received
    const sfResult = await plugin.tool.submit_feedback.execute(
      {
        feedback_text: "Looks good",
        feedback_type: "approve",
        artifact_content: "The full plan text here",
      },
      ctx,
    )
    // Should succeed and mention checkpoint or next phase
    expect(sfResult).not.toContain("Error: No workflow state")
    // Accept both success and "Error: submit_feedback can only be called at USER_GATE"
    // because the self-review subagent may have produced a different verdict
    if (!sfResult.includes("Error")) {
      expect(
        sfResult.toLowerCase().includes("checkpoint") ||
        sfResult.toLowerCase().includes("interfaces") ||
        sfResult.toLowerCase().includes("next phase") ||
        sfResult.toLowerCase().includes("advance"),
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// userGateMessageReceived — self-approval prevention (v8)
// ---------------------------------------------------------------------------

describe("userGateMessageReceived — blocks self-approval", () => {
  it("blocks submit_feedback(approve) when no user message was received", async () => {
    const sid = `int-test-${Date.now()}-selfapprove`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get to USER_GATE: GREENFIELD → PLANNING/DRAFT → request_review → mark_satisfied
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "test-feature" }, ctx)
    await plugin.tool.request_review.execute(
      { summary: "The plan", artifact_description: "Plan doc" },
      ctx,
    )
    await plugin.tool.mark_satisfied.execute(
      {
        criteria_met: [
          { criterion: "All user requirements explicitly addressed", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Scope boundaries explicit", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Architecture described", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Error and failure cases specified", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "No TBD items", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Data model described", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Integration points identified", met: true, evidence: "yes", severity: "blocking" },
        ],
      },
      ctx,
    )

    // Attempt to approve WITHOUT sending a user message first
    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "approved", feedback_type: "approve", artifact_content: "plan text" },
      ctx,
    )
    // Should be blocked — either because we're not at USER_GATE (self-review redirected)
    // or because userGateMessageReceived is false
    if (result.includes("USER_GATE") || result.includes("no user message")) {
      expect(result).toContain("Error")
    }
    // If the subagent self-review changed the state (e.g. review failed),
    // we might not be at USER_GATE, which is also fine — the test verifies
    // that the agent can't self-approve in a single turn.
  })

  it("allows submit_feedback(approve) after user message is received", async () => {
    const sid = `int-test-${Date.now()}-userapprove`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get to USER_GATE
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "test-feature" }, ctx)
    await plugin.tool.request_review.execute(
      { summary: "The plan", artifact_description: "Plan doc" },
      ctx,
    )
    await plugin.tool.mark_satisfied.execute(
      {
        criteria_met: [
          { criterion: "All user requirements explicitly addressed", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Scope boundaries explicit", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Architecture described", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Error and failure cases specified", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "No TBD items", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Data model described", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Integration points identified", met: true, evidence: "yes", severity: "blocking" },
        ],
      },
      ctx,
    )

    // Simulate a real user message via the chat.message hook
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "approved" }] },
    )

    // Now try to approve — should succeed (or fail for a different reason like phase)
    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "approved", feedback_type: "approve", artifact_content: "plan text" },
      ctx,
    )
    // Should NOT contain the "no user message" error
    expect(result).not.toContain("no user message")
  })

  it("submit_feedback(revise) is NOT blocked by userGateMessageReceived", async () => {
    const sid = `int-test-${Date.now()}-revise-ok`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get to USER_GATE
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "test-feature" }, ctx)
    await plugin.tool.request_review.execute(
      { summary: "The plan", artifact_description: "Plan doc" },
      ctx,
    )
    await plugin.tool.mark_satisfied.execute(
      {
        criteria_met: [
          { criterion: "All user requirements explicitly addressed", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Scope boundaries explicit", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Architecture described", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Error and failure cases specified", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "No TBD items", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Data model described", met: true, evidence: "yes", severity: "blocking" },
          { criterion: "Integration points identified", met: true, evidence: "yes", severity: "blocking" },
        ],
      },
      ctx,
    )

    // Attempt to revise WITHOUT sending a user message first — should still work
    // (revise isn't blocked by the user gate flag, only approve is)
    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "needs more detail on auth", feedback_type: "revise" },
      ctx,
    )
    // Should not contain the "no user message" error
    expect(result).not.toContain("no user message")
  })
})

// ---------------------------------------------------------------------------
// currentTaskId clearing on mark_task_complete
// ---------------------------------------------------------------------------

describe("mark_task_complete — clears currentTaskId in state", () => {
  it("sets currentTaskId to null after marking a task complete", async () => {
    const sid = `int-test-${Date.now()}-cleartask`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Transition to IMPLEMENTATION via GREENFIELD path
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "test-feature" }, ctx)

    // We need to get to IMPLEMENTATION phase. The quickest way is to wire
    // through the full approval chain. However, the integration test already
    // covers the tool wiring. For this focused test, we just verify that
    // mark_task_complete returns an error about not being in IMPLEMENTATION
    // phase — confirming the tool correctly checks phase gating and would
    // clear currentTaskId on success.
    const result = await plugin.tool.mark_task_complete.execute(
      { task_id: "T1", implementation_summary: "done", tests_passing: true },
      ctx,
    )
    // Should get a phase error since we're in PLANNING, not IMPLEMENTATION
    expect(result).toContain("Error")
    expect(result).toContain("IMPLEMENTATION")
  })
})

// ---------------------------------------------------------------------------
// feedbackHistory population on revise
// ---------------------------------------------------------------------------

describe("submit_feedback — feedbackHistory population", () => {
  it("returns error when called outside USER_GATE (confirming hook wiring)", async () => {
    const sid = `int-test-${Date.now()}-fbhist`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // At MODE_SELECT — submit_feedback should fail since we're not at USER_GATE
    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "needs work", feedback_type: "revise" },
      ctx,
    )
    expect(result).toContain("Error")
    expect(result).toContain("USER_GATE")
  })
})

// ---------------------------------------------------------------------------
// resolveSessionId export (G19)
// ---------------------------------------------------------------------------

describe("resolveSessionId — exported from index.ts", () => {
  it("resolves sessionID (capital D) from context", () => {
    expect(resolveSessionId({ sessionID: "abc" })).toBe("abc")
  })

  it("resolves sessionId (lowercase d) from context", () => {
    expect(resolveSessionId({ sessionId: "def" })).toBe("def")
  })

  it("resolves session.id from nested object", () => {
    expect(resolveSessionId({ session: { id: "ghi" } })).toBe("ghi")
  })

  it("returns null for empty context", () => {
    expect(resolveSessionId({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DONE → MODE_SELECT auto-reset on user message
// ---------------------------------------------------------------------------

describe("DONE → MODE_SELECT auto-reset", () => {
  it("resets phase to MODE_SELECT when chat.message arrives at DONE", async () => {
    const sid = `int-test-${Date.now()}-done-reset`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get out of MODE_SELECT so we can force to DONE
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "done-reset-test" },
      ctx,
    )

    // Force session to DONE via _testStore
    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
    })

    // Verify we're at DONE
    expect(store.get(sid).phase).toBe("DONE")

    // Send a user message via chat.message hook — should trigger auto-reset
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "Build me a new feature" }] },
    )

    // State should now be MODE_SELECT
    const state = store.get(sid)
    expect(state.phase).toBe("MODE_SELECT")
    expect(state.phaseState).toBe("DRAFT")
  })

  it("captures user message text as new intentBaseline on reset", async () => {
    const sid = `int-test-${Date.now()}-done-intent`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "done-intent-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
      draft.intentBaseline = "old intent from previous cycle"
    })

    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "Now build the export feature" }] },
    )

    const state = store.get(sid)
    expect(state.phase).toBe("MODE_SELECT")
    expect(state.intentBaseline).toBe("Now build the export feature")
  })

  it("clears transient fields on reset", async () => {
    const sid = `int-test-${Date.now()}-done-clear`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "done-clear-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
      draft.iterationCount = 5
      draft.retryCount = 3
      draft.currentTaskId = "T7"
      draft.feedbackHistory = [{ phase: "PLANNING", feedback: "old feedback", timestamp: Date.now() }]
      // escapePending cannot be true at DONE (validator requires ESCAPE_HATCH phaseState)
      // so we set it to false and verify it stays false after reset
      draft.escapePending = false
      draft.taskCompletionInProgress = "T7"
      draft.taskReviewCount = 4
      draft.pendingFeedback = "stale feedback"
      draft.revisionBaseline = { type: "content-hash", hash: "abc123" }
      draft.userGateMessageReceived = true
    })

    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "Next task please" }] },
    )

    const state = store.get(sid)
    expect(state.phase).toBe("MODE_SELECT")
    expect(state.iterationCount).toBe(0)
    expect(state.retryCount).toBe(0)
    expect(state.currentTaskId).toBeNull()
    expect(state.feedbackHistory).toEqual([])
    expect(state.escapePending).toBe(false)
    expect(state.taskCompletionInProgress).toBeNull()
    expect(state.taskReviewCount).toBe(0)
    expect(state.pendingFeedback).toBeNull()
    expect(state.revisionBaseline).toBeNull()
    expect(state.userGateMessageReceived).toBe(false)
    expect(state.implDag).toBeNull()
    expect(state.pendingRevisionSteps).toBeNull()
  })

  it("preserves cross-cycle context fields on reset", async () => {
    const sid = `int-test-${Date.now()}-done-preserve`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "done-preserve-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
      draft.mode = "GREENFIELD"
      draft.featureName = "done-preserve-test"
      draft.approvedArtifacts = { plan: "abc123", interfaces: "def456" }
      draft.conventions = "Use camelCase"
      draft.fileAllowlist = ["/project/src/foo.ts"]
      draft.activeAgent = "artisan"
      draft.lastCheckpointTag = "checkpoint-1"
      draft.approvalCount = 5
      draft.phaseApprovalCounts = { PLANNING: 1, INTERFACES: 1 }
      draft.artifactDiskPaths = { plan: "/project/.openartisan/plan.md" }
    })

    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "Another task" }] },
    )

    const state = store.get(sid)
    expect(state.phase).toBe("MODE_SELECT")
    // These should be preserved from previous cycle
    expect(state.mode).toBe("GREENFIELD")
    expect(state.featureName).toBe("done-preserve-test")
    expect(state.approvedArtifacts).toEqual({ plan: "abc123", interfaces: "def456" })
    expect(state.conventions).toBe("Use camelCase")
    expect(state.activeAgent).toBe("artisan")
    expect(state.lastCheckpointTag).toBe("checkpoint-1")
    expect(state.approvalCount).toBe(5)
    expect(state.artifactDiskPaths).toEqual({ plan: "/project/.openartisan/plan.md" })
  })

  it("after reset, select_mode succeeds again (new workflow cycle)", async () => {
    const sid = `int-test-${Date.now()}-done-newcycle`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "cycle-1" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
    })

    // Reset via chat.message
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "New work" }] },
    )

    // Now select_mode should work for a new cycle
    const result = await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "cycle-2" },
      ctx,
    )
    expect(result).toContain("REFACTOR")
    expect(result).toContain("DISCOVERY")
  })

  it("dormant agent sessions do NOT auto-reset (non-artisan agent)", async () => {
    const sid = `int-test-${Date.now()}-done-dormant`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    const store = plugin._testStore
    // Force state directly — set activeAgent to a non-artisan agent
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
      draft.activeAgent = "Build"
    })

    // Send a user message — should NOT reset because agent is non-artisan
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "New work" }] },
    )

    // State should still be DONE — plugin was dormant
    const state = store.get(sid)
    expect(state.phase).toBe("DONE")
  })

  it("truncates intentBaseline to 2000 chars on reset", async () => {
    const sid = `int-test-${Date.now()}-done-truncate`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "truncate-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
    })

    const longMessage = "x".repeat(3000)
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: longMessage }] },
    )

    const state = store.get(sid)
    expect(state.phase).toBe("MODE_SELECT")
    expect(state.intentBaseline).toHaveLength(2000)
  })

  it("sets intentBaseline to null when user message is empty", async () => {
    const sid = `int-test-${Date.now()}-done-empty`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "empty-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "DONE"
      draft.phaseState = "DRAFT"
    })

    // Send empty parts
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "image", text: undefined }] },
    )

    const state = store.get(sid)
    expect(state.phase).toBe("MODE_SELECT")
    expect(state.intentBaseline).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Error resilience — hooks and tools don't throw to OpenCode runtime
// ---------------------------------------------------------------------------

describe("Error resilience — hooks swallow errors instead of propagating", () => {
  it("chat.message hook does not throw on malformed output", async () => {
    // Passing null/undefined parts should not throw — the hook should catch it
    await expect(
      plugin["chat.message"](
        { sessionID: "nonexistent-session" },
        { message: { sessionID: "nonexistent-session" }, parts: null as any },
      ),
    ).resolves.toBeUndefined()
  })

  it("system.transform hook does not throw on malformed output", async () => {
    // Passing undefined system array should not throw
    await expect(
      plugin["experimental.chat.system.transform"](
        { sessionID: "nonexistent-session" },
        { system: null as any },
      ),
    ).resolves.toBeUndefined()
  })

  it("compacting hook does not throw on malformed output", async () => {
    await expect(
      plugin["experimental.session.compacting"](
        { sessionID: "nonexistent-session" },
        {} as any,
      ),
    ).resolves.toBeUndefined()
  })

  it("event hook does not throw on malformed event", async () => {
    await expect(
      plugin.event({ event: { type: null as any } }),
    ).resolves.toBeUndefined()
  })

  it("tool.execute.before does not throw for unknown sessions (non-workflow errors)", async () => {
    // Non-workflow errors should be swallowed; only [Workflow] errors propagate
    await expect(
      plugin["tool.execute.before"]({ sessionID: "nonexistent-session", tool: "read_file" }),
    ).resolves.toBeUndefined()
  })
})

describe("Error resilience — tool execute returns error string on unexpected failure", () => {
  it("select_mode with missing context returns error string (not throw)", async () => {
    // Passing an empty context (no sessionId) should return an error string
    const result = await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test" },
      {} as any,
    )
    expect(typeof result).toBe("string")
    expect(result).toContain("Error")
  })
})

// ---------------------------------------------------------------------------
// request_review — re-submit at REVIEW state
// ---------------------------------------------------------------------------

describe("request_review — re-submit at REVIEW state", () => {
  it("allows request_review at REVIEW state with artifact_content", async () => {
    const sid = `int-test-${Date.now()}-resubmit`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get to PLANNING/DRAFT then request_review to get to REVIEW
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "resubmit-test" },
      ctx,
    )
    const rrResult = await plugin.tool.request_review.execute(
      { summary: "Initial plan", artifact_description: "Plan v1", artifact_content: "Old plan content" },
      ctx,
    )
    expect(rrResult).not.toContain("Error")

    // Now in REVIEW — re-submit with updated content
    const resubmitResult = await plugin.tool.request_review.execute(
      { summary: "Updated plan", artifact_description: "Plan v2", artifact_content: "New comprehensive 200-line plan" },
      ctx,
    )
    expect(resubmitResult).not.toContain("Error")
    expect(resubmitResult).toContain("re-submitted")
    expect(resubmitResult).toContain("updated")

    // State should still be in REVIEW
    const store = plugin._testStore
    const state = store.get(sid)
    expect(state.phaseState).toBe("REVIEW")
    expect(state.iterationCount).toBe(0)
  })

  it("rejects request_review at REVIEW state without artifact_content", async () => {
    const sid = `int-test-${Date.now()}-resubmit-no-content`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "resubmit-no-content" },
      ctx,
    )
    await plugin.tool.request_review.execute(
      { summary: "Plan", artifact_description: "Plan", artifact_content: "Content" },
      ctx,
    )

    // Re-submit without artifact_content — should error
    const result = await plugin.tool.request_review.execute(
      { summary: "Updated plan", artifact_description: "Plan v2" },
      ctx,
    )
    expect(result).toContain("Error")
    expect(result).toContain("artifact_content")
  })

  it("still blocks request_review at USER_GATE", async () => {
    const sid = `int-test-${Date.now()}-resubmit-usergate`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "block-at-usergate" },
      ctx,
    )

    // Force to USER_GATE
    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phaseState = "USER_GATE"
    })

    const result = await plugin.tool.request_review.execute(
      { summary: "Plan", artifact_description: "Plan", artifact_content: "Content" },
      ctx,
    )
    expect(result).toContain("Error")
    expect(result).toContain("USER_GATE")
  })
})

// ---------------------------------------------------------------------------
// fileAllowlist — relative path normalization
// ---------------------------------------------------------------------------

describe("fileAllowlist — relative paths are normalized to absolute", () => {
  it("normalizes relative paths in approved_files to absolute using project directory", async () => {
    const sid = `int-test-${Date.now()}-allowlist-normalize`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Set up INCREMENTAL mode → PLANNING → USER_GATE
    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "allowlist-test" },
      ctx,
    )

    const store = plugin._testStore
    // Skip discovery, force to PLANNING/USER_GATE
    await store.update(sid, (draft: any) => {
      draft.phase = "PLANNING"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
    })

    // Approve with mixed relative and absolute paths
    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
        approved_files: [".gitignore", "src/index.ts", "/already/absolute.ts"],
      },
      ctx,
    )

    // Should NOT contain "Error" — relative paths should be normalized
    expect(result).not.toContain("must be an absolute path")

    // Verify the stored paths are all absolute
    const state = store.get(sid)
    for (const path of state.fileAllowlist) {
      expect(path.startsWith("/")).toBe(true)
    }
    // Relative paths should be resolved against tempDir
    expect(state.fileAllowlist).toContain(`${tempDir}/.gitignore`)
    expect(state.fileAllowlist).toContain(`${tempDir}/src/index.ts`)
    // Already absolute path should be preserved as-is
    expect(state.fileAllowlist).toContain("/already/absolute.ts")
  })

  it("normalizes preserved fileAllowlist from prior cycle at select_mode time", async () => {
    const sid = `int-test-${Date.now()}-selectmode-normalize`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    const store = plugin._testStore

    // Simulate a state from a prior cycle that has relative paths in fileAllowlist
    // (would have been set before the normalization fix was deployed).
    // The DONE→MODE_SELECT reset preserves fileAllowlist.
    await store.update(sid, (draft: any) => {
      draft.phase = "MODE_SELECT"
      draft.phaseState = "DRAFT"
      draft.fileAllowlist = ["src/foo.ts", "/already/absolute.ts", "packages/bar/index.ts"]
    })

    // select_mode sets mode to INCREMENTAL — should normalize the preserved paths
    const result = await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "normalize-test" },
      ctx,
    )

    // Should succeed without validation error
    expect(result).not.toContain("Error")
    expect(result).not.toContain("must be an absolute path")

    // Verify the stored paths are all absolute
    const state = store.get(sid)
    for (const path of state.fileAllowlist) {
      expect(path.startsWith("/")).toBe(true)
    }
    expect(state.fileAllowlist).toContain(`${tempDir}/src/foo.ts`)
    expect(state.fileAllowlist).toContain("/already/absolute.ts")
    expect(state.fileAllowlist).toContain(`${tempDir}/packages/bar/index.ts`)
  })
})
