/**
 * Integration tests for index.ts — the main plugin entry point.
 *
 * These tests exercise the full wiring: tool calls go through the state store
 * and state machine, hooks dispatch correctly, and edge cases are handled.
 *
 * Strategy: mock the OpenCode client, instantiate the real plugin, then call
 * the returned tools and hooks to verify end-to-end behavior.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// The plugin factory — note: it imports @opencode-ai/plugin at the top level
// which is a runtime-provided package. We rely on the tsconfig path mapping
// set up for tests. The `tool` and `Plugin` imports inside index.ts are
// resolved via the test shim at #opencode-ai/plugin.
import { OpenArtisanPlugin, WORKFLOW_TOOL_NAMES } from "#plugin/index"
import { resolveSessionId } from "#core/utils"
import { parseReviewResult } from "#core/self-review"
import { OPENCODE_TOOL_CONTRACTS, WORKFLOW_TOOL_CONTRACTS } from "#core/tool-contracts"
import { toJsonSchema } from "#core/schemas"
import { TOOL_HANDLERS } from "#bridge/methods/tool-execute"
import { MAX_IDLE_RETRIES } from "#core/constants"
import type { TaskNode } from "#core/dag"

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
            { criterion: "User journey completeness", met: true, evidence: "mock", severity: "blocking" },
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
          data: { info: response, parts: [{ type: "text", text: JSON.stringify(response) }] },
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
let previousStateBackend: string | undefined
let previousTrace: string | undefined
let previousIdlePrompts: string | undefined

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "sw-integration-"))
  client = makeMockClient()
  previousStateBackend = process.env["OPENARTISAN_STATE_BACKEND"]
  previousTrace = process.env["OPENARTISAN_TRACE"]
  previousIdlePrompts = process.env["OPENARTISAN_IDLE_PROMPTS"]
  process.env["OPENARTISAN_STATE_BACKEND"] = "filesystem"
  delete process.env["OPENARTISAN_IDLE_PROMPTS"]

  // Use the per-test temp project as the plugin directory so feature-name
  // collision checks exercise real persistence without leaking across tests.
  plugin = await OpenArtisanPlugin({ client, directory: tempDir } as any)
})

afterEach(() => {
  if (previousStateBackend === undefined) {
    delete process.env["OPENARTISAN_STATE_BACKEND"]
  } else {
    process.env["OPENARTISAN_STATE_BACKEND"] = previousStateBackend
  }
  if (previousTrace === undefined) {
    delete process.env["OPENARTISAN_TRACE"]
  } else {
    process.env["OPENARTISAN_TRACE"] = previousTrace
  }
  if (previousIdlePrompts === undefined) {
    delete process.env["OPENARTISAN_IDLE_PROMPTS"]
  } else {
    process.env["OPENARTISAN_IDLE_PROMPTS"] = previousIdlePrompts
  }
  rmSync(tempDir, { recursive: true, force: true })
})

function eventuallyRejects(message: string, ms = 100): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}

function planningPassCriteria() {
  return [
    { criterion: "All user requirements explicitly addressed", met: true, evidence: "Section 1 covers all", severity: "blocking" },
    { criterion: "Scope boundaries explicit", met: true, evidence: "Section 2 lists scope", severity: "blocking" },
    { criterion: "Architecture described", met: true, evidence: "Section 3 has arch diagram", severity: "blocking" },
    { criterion: "Error and failure cases specified", met: true, evidence: "Section 4 covers errors", severity: "blocking" },
    { criterion: "No TBD items", met: true, evidence: "All decisions resolved", severity: "blocking" },
    { criterion: "Data model described", met: true, evidence: "Section 5 has ERD", severity: "blocking" },
    { criterion: "Integration points identified", met: true, evidence: "Section 6 lists APIs", severity: "blocking" },
    { criterion: "Deployment & infrastructure addressed", met: true, evidence: "Section 8 covers deployment pipeline and infra", severity: "blocking" },
    { criterion: "User journey completeness", met: true, evidence: "Setup, onboarding, all modes covered", severity: "blocking" },
    { criterion: "[Q] Design excellence", met: true, evidence: "Well-reasoned approach", severity: "blocking", score: "9" },
    { criterion: "[Q] Architectural cohesion", met: true, evidence: "All components fit together", severity: "blocking", score: "9" },
    { criterion: "[Q] Vision alignment", met: true, evidence: "Plan traces to user intent", severity: "blocking", score: "9" },
    { criterion: "[Q] Completeness", met: true, evidence: "Every requirement addressed", severity: "blocking", score: "9" },
    { criterion: "[Q] Readiness for execution", met: true, evidence: "Engineer can begin immediately", severity: "blocking", score: "10" },
    { criterion: "[Q] Security standards", met: true, evidence: "Auth and validation covered", severity: "blocking", score: "9" },
    { criterion: "[Q] Operational excellence", met: true, evidence: "Monitoring and logging covered", severity: "blocking", score: "9" },
  ]
}

function schemaPropertyNames(schema: unknown): string[] {
  const jsonSchema = toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]) as { properties?: Record<string, unknown> }
  return Object.keys(jsonSchema.properties ?? {}).sort()
}

const VALID_REAL_WORLD_ACCEPTANCE_SCENARIO = `## Real-World Acceptance Scenario

### Scenario
A maintainer needs the workflow to preserve the user's motivating use case across reviews and compaction.

### Required Capabilities
- Capture the scenario from the planning artifact
- Carry the scenario into downstream review prompts

### Acceptance Checks
- Later artifacts are evaluated against the captured scenario
- Scope drift is surfaced before implementation

### Explicit Non-Goals
- Do not infer scenarios from arbitrary chat
`

const ROADMAP_NOW = "2026-04-16T00:00:00.000Z"

function roadmapDocument() {
  return {
    schemaVersion: 1,
    items: [
      {
        id: "item-1",
        kind: "feature",
        title: "Roadmap-backed workflow",
        status: "todo",
        priority: 10,
        featureName: "roadmap-backed-workflow",
        createdAt: ROADMAP_NOW,
        updatedAt: ROADMAP_NOW,
      },
      {
        id: "item-2",
        kind: "bug",
        title: "Preserve workflow gates",
        status: "blocked",
        priority: 8,
        createdAt: ROADMAP_NOW,
        updatedAt: ROADMAP_NOW,
      },
    ],
    edges: [{ from: "item-1", to: "item-2", kind: "depends-on" }],
  }
}

async function writeRoadmapState() {
  const roadmapDir = join(tempDir, ".openartisan", "roadmap")
  mkdirSync(roadmapDir, { recursive: true })
  await Bun.write(join(roadmapDir, "roadmap-state.json"), JSON.stringify(roadmapDocument(), null, 2))
}

function withRealWorldAcceptanceScenario(content: string): string {
  return content.includes("## Real-World Acceptance Scenario")
    ? content
    : `${content.trim()}\n\n${VALID_REAL_WORLD_ACCEPTANCE_SCENARIO}`
}

function planArtifactPath(featureName: string) {
  return join(tempDir, ".openartisan", featureName, "plan.md")
}

function implPlanArtifactPath(featureName: string) {
  return join(tempDir, ".openartisan", featureName, "impl-plan.md")
}

async function writePlanArtifact(featureName: string, content = "# Plan\n\nPlan text") {
  const planPath = planArtifactPath(featureName)
  mkdirSync(join(tempDir, ".openartisan", featureName), { recursive: true })
  await Bun.write(planPath, withRealWorldAcceptanceScenario(content))
  return planPath
}

async function writeImplPlanArtifact(featureName: string, content: string) {
  const implPlanPath = implPlanArtifactPath(featureName)
  mkdirSync(join(tempDir, ".openartisan", featureName), { recursive: true })
  await Bun.write(implPlanPath, content)
  return implPlanPath
}

async function requestPlanningReview(ctx: { directory: string; sessionId: string; agent?: string }, featureName: string, content = "# Plan\n\nPlan text") {
  const planPath = await writePlanArtifact(featureName, content)
  return plugin.tool.request_review.execute(
    { summary: "Plan", artifact_description: "Plan", artifact_files: [planPath] },
    ctx,
  )
}

async function advanceGreenfieldToInterfaces(sid: string, featureName: string) {
  const ctx = { directory: tempDir, sessionId: sid }
  await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
  await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
  await requestPlanningReview(ctx, featureName)
  await plugin.tool.mark_satisfied.execute({ criteria_met: planningPassCriteria() }, ctx)
  await plugin["chat.message"](
    { sessionID: sid },
    { message: { sessionID: sid }, parts: [{ type: "text", text: "approved" }] },
  )
  await plugin.tool.submit_feedback.execute({ feedback_text: "approved", feedback_type: "approve" }, ctx)
  return ctx
}

// Decision note: exercise the public OpenCode plugin seam directly for structural
// phase-state changes instead of asserting only core helper behavior. Alternative
// considered: rely on state-machine tests alone. Rejected because the approved plan
// explicitly requires cross-adapter/runtime parity, so at least one plugin-level
// test should fail until the OpenCode wiring lands.

describe("OpenCode integration — structural workflow parity", () => {
  it("approving PLANNING with implementation-only files should auto-skip structural ceremony", async () => {
    const sid = `int-test-${Date.now()}-planning-auto-skip`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: `auto-skip-${Date.now()}` }, ctx)
    // Simulate already-approved discovery so planning can be exercised directly.
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
      d.mode = "INCREMENTAL"
      d.userGateMessageReceived = true
    })
    await plugin.tool.submit_feedback.execute({
      feedback_text: "approved",
      feedback_type: "approve",
      approved_files: ["packages/adapter-hermes/hermes_adapter/continuation_controller.py"],
    }, ctx)
    const state = plugin._testStore.get(sid)
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("DRAFT")
  })

  it("approving PLANNING with interface-classified files should enter INTERFACES/DRAFT", async () => {
    const sid = `int-test-${Date.now()}-planning-interfaces-draft`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: `interfaces-draft-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "PLANNING"
      d.phaseState = "USER_GATE"
      d.mode = "INCREMENTAL"
      d.userGateMessageReceived = true
    })

    await plugin.tool.submit_feedback.execute({
      feedback_text: "approved",
      feedback_type: "approve",
      approved_files: ["packages/adapter-hermes/hermes_adapter/continuation_controller_types.py"],
    }, ctx)
    const state = plugin._testStore.get(sid)
    expect(state?.phase).toBe("INTERFACES")
    expect(state?.phaseState).toBe("DRAFT")
  })

  it("exposes scheduling_complete to resolve INTERFACES/SKIP_CHECK into drafting", async () => {
    const sid = `int-test-${Date.now()}-scheduling-complete`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: `structural-complete-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "INTERFACES"
      d.phaseState = "SKIP_CHECK"
      d.mode = "INCREMENTAL"
    })

    const result = await plugin.tool.scheduling_complete.execute({}, ctx)
    const state = plugin._testStore.get(sid)
    expect(result).toContain("Structural transition complete")
    expect(state?.phase).toBe("INTERFACES")
    expect(state?.phaseState).toBe("DRAFT")
  })

  it("exposes phase_skipped to resolve INTERFACES/SKIP_CHECK into the next skip check", async () => {
    const sid = `int-test-${Date.now()}-phase-skipped`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: `structural-skip-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "INTERFACES"
      d.phaseState = "SKIP_CHECK"
      d.mode = "INCREMENTAL"
    })

    const result = await plugin.tool.phase_skipped.execute({}, ctx)
    const state = plugin._testStore.get(sid)
    expect(result).toContain("Structural transition complete")
    expect(state?.phase).toBe("TESTS")
    expect(state?.phaseState).toBe("SKIP_CHECK")
  })

  it("resolves IMPLEMENTATION/HUMAN_GATE tasks without direct approval", async () => {
    const sid = `int-test-${Date.now()}-human-gate-resolve`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "HUMAN_GATE"
      d.mode = "INCREMENTAL"
      d.featureName = `human-gate-${Date.now()}`
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

    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "resolved", feedback_type: "approve", resolved_human_gates: ["T1"] },
      ctx,
    )

    expect(result).toContain("Resolved 1 human gate(s): T1")
    const state = plugin._testStore.get(sid)
    expect(state?.phase).toBe("IMPLEMENTATION")
    expect(state?.phaseState).toBe("DRAFT")
    expect(state?.currentTaskId).toBe("T2")
    expect(state?.implDag?.find((task: TaskNode) => task.id === "T2")?.status).toBe("in-flight")
  })

  it("rolls back delegated state when child sub-workflow prompt fails", async () => {
    const sid = `int-test-${Date.now()}-spawn-prompt-fail`
    client.session.prompt = mock(async () => {
      throw new Error("prompt failed")
    }) as any
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "SCHEDULING"
      d.mode = "INCREMENTAL"
      d.featureName = `spawn-parent-${Date.now()}`
      d.implDag = [
        { id: "T1", description: "Delegate me", dependencies: [], expectedFiles: [], expectedTests: [], estimatedComplexity: "small", status: "pending" },
      ]
      d.currentTaskId = null
      d.childWorkflows = []
    })

    const result = await plugin.tool.spawn_sub_workflow.execute({ task_id: "T1", feature_name: "child-work" }, ctx)

    expect(result).toContain("Error: Child workflow state was created but initial prompt failed")
    const state = plugin._testStore.get(sid)
    expect(state?.implDag?.[0]?.status).toBe("pending")
    expect(state?.childWorkflows).toEqual([])
    expect(plugin._testStore.get("eph-1")).toBeNull()
  })
})

describe("OpenCode integration — task boundary revision workflow", () => {
  it("analyzes a boundary change and reports impacted tasks", async () => {
    const sid = `int-test-${Date.now()}-boundary-analyze`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: `boundary-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.mode = "INCREMENTAL"
      d.fileAllowlist = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/tests/a.test.ts", "/repo/tests/b.test.ts"]
      d.implDag = [
        { id: "T1", description: "Done task", dependencies: [], expectedFiles: ["/repo/src/a.ts"], expectedTests: ["/repo/tests/a.test.ts"], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Target task", dependencies: ["T1"], expectedFiles: ["/repo/src/b.ts"], expectedTests: ["/repo/tests/b.test.ts"], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T2"
    })

    const result = await plugin.tool.analyze_task_boundary_change.execute({
      task_id: "T2",
      add_files: ["/repo/src/a.ts"],
      remove_files: ["/repo/src/b.ts"],
      reason: "T2 must absorb the runtime seam already exercised by review.",
    }, ctx)

    expect(result).toContain("T2")
    expect(result).toContain("T1")
    expect(result).toContain("completed task")
  })

  it("reports allowlist violations through the public plugin seam", async () => {
    const sid = `int-test-${Date.now()}-boundary-allowlist`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: `boundary-allowlist-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.mode = "INCREMENTAL"
      d.fileAllowlist = ["/repo/src/b.ts", "/repo/tests/b.test.ts"]
      d.implDag = [
        { id: "T2", description: "Target task", dependencies: [], expectedFiles: ["/repo/src/b.ts"], expectedTests: ["/repo/tests/b.test.ts"], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T2"
    })

    const result = await plugin.tool.analyze_task_boundary_change.execute({
      task_id: "T2",
      add_files: ["/repo/src/outside.ts"],
      reason: "Need to test the planning escalation path.",
    }, ctx)

    expect(result).toContain("allowlist")
    expect(result).toContain("/repo/src/outside.ts")
  })

  it("records first-class allowlist expansion requests without reviewer extraction", async () => {
    const sid = `int-test-${Date.now()}-allowlist-expansion`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: `allowlist-expansion-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.fileAllowlist = [`${tempDir}/src/allowed.ts`]
    })

    const result = await plugin.tool.request_allowlist_expansion.execute({
      files: ["src/new-boundary.ts"],
      reason: "Implementation discovered a necessary source boundary that the approved plan omitted.",
      source_artifact: "impl_plan",
    }, ctx)

    expect(result).toContain("allowlist expansion requested")
    const state = plugin._testStore.get(sid)
    expect(state.pendingAllowlistExpansions).toHaveLength(1)
    expect(state.pendingAllowlistExpansions[0].files).toEqual([`${tempDir}/src/new-boundary.ts`])
    expect(state.pendingAllowlistExpansions[0].sourceArtifact).toBe("impl_plan")
    expect(state.phaseState).toBe("USER_GATE")
  })

  it("applies approved allowlist expansion and returns to active work", async () => {
    const sid = `int-test-${Date.now()}-allowlist-expansion-apply`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: `allowlist-expansion-apply-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.fileAllowlist = [`${tempDir}/src/allowed.ts`]
    })

    await plugin.tool.request_allowlist_expansion.execute({
      files: ["src/contracts.d.ts"],
      reason: "Implementation must delete and replace a generated contract file that the approved plan omitted.",
      source_artifact: "impl_plan",
    }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.userGateMessageReceived = true
    })

    const result = await plugin.tool.submit_feedback.execute({
      feedback_type: "approve",
      feedback_text: "approved",
    }, ctx)

    expect(result).toContain("Applied approved allowlist expansion")
    const state = plugin._testStore.get(sid)
    expect(state.fileAllowlist).toContain(`${tempDir}/src/contracts.d.ts`)
    expect(state.pendingAllowlistExpansions).toEqual([])
    expect(state.phase).toBe("IMPLEMENTATION")
    expect(state.phaseState).toBe("DRAFT")
  })

  it("applies pending INTERFACES allowlist expansion during approval", async () => {
    const sid = `int-test-${Date.now()}-interfaces-allowlist-expansion-apply`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: `interfaces-allowlist-expansion-apply-${Date.now()}` }, ctx)
    const allowed = `${tempDir}/packages/core/src/auth-interfaces.ts`
    const runtime = `${tempDir}/packages/runtime/src/internal/contracts-implementation.ts`
    const createApp = `${tempDir}/packages/create-app/src/auth-tenancy-billing-interfaces.ts`
    await Bun.write(allowed, "export interface CoreAuth {}\n")
    await Bun.write(runtime, "export interface RuntimeAuth {}\n")
    await Bun.write(createApp, "export interface CreateAppAuth {}\n")
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "INTERFACES"
      d.phaseState = "USER_GATE"
      d.userGateMessageReceived = true
      d.fileAllowlist = [allowed]
      d.reviewArtifactFiles = [allowed, runtime, createApp]
      d.pendingAllowlistExpansions = [{
        files: [runtime, createApp],
        reason: "Reviewed interface files are required by the approved incremental plan.",
        sourceArtifact: "interfaces",
        requestedAtPhase: "INTERFACES",
        requestedAt: 1,
      }]
    })

    const result = await plugin.tool.submit_feedback.execute({
      feedback_type: "approve",
      feedback_text: "approve[WORKFLOW GATE — IMMEDIATE ACTION REQUIRED] The user has approved the INTERFACES artifact. Call `submit_feedback` NOW with feedback_type=\"approve\" and feedback_text set to the user's message. This must be your first and only tool call. Do NOT do anything else first.",
    }, ctx)

    expect(result).not.toContain("approval failed allowlist validation")
    expect(result).toContain("Approval recorded")
    const state = plugin._testStore.get(sid)
    expect(state.fileAllowlist).toContain(runtime)
    expect(state.fileAllowlist).toContain(createApp)
    expect(state.pendingAllowlistExpansions).toEqual([])
    expect(state.approvedArtifactFiles.interfaces).toEqual(expect.arrayContaining([allowed, runtime, createApp]))
  })

  it("rejects boundary changes that would reset completed task ownership", async () => {
    const sid = `int-test-${Date.now()}-boundary-apply`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: `boundary-apply-${Date.now()}` }, ctx)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "DRAFT"
      d.mode = "INCREMENTAL"
      d.fileAllowlist = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/tests/a.test.ts", "/repo/tests/b.test.ts"]
      d.implDag = [
        { id: "T1", description: "Done task", dependencies: [], expectedFiles: ["/repo/src/a.ts"], expectedTests: ["/repo/tests/a.test.ts"], estimatedComplexity: "small", status: "complete" },
        { id: "T2", description: "Target task", dependencies: ["T1"], expectedFiles: ["/repo/src/b.ts"], expectedTests: ["/repo/tests/b.test.ts"], estimatedComplexity: "medium", status: "pending" },
      ]
      d.currentTaskId = "T2"
    })

    const result = await plugin.tool.apply_task_boundary_change.execute({
      task_id: "T2",
      add_files: ["/repo/src/a.ts"],
      remove_files: ["/repo/src/b.ts"],
      expected_impacted_tasks: ["T1", "T2"],
      expected_reset_tasks: ["T1"],
      reason: "T2 must absorb the runtime seam already exercised by review.",
    }, ctx)

    expect(result).toContain("Completed task(s) cannot be reset")
    const state = plugin._testStore.get(sid)
    const t1 = state?.implDag?.find((t: any) => t.id === "T1")
    const t2 = state?.implDag?.find((t: any) => t.id === "T2")
    expect(t1?.expectedFiles).toContain("/repo/src/a.ts")
    expect(t1?.status).toBe("complete")
    expect(t2?.expectedFiles).toEqual(["/repo/src/b.ts"])
  })
})

describe("OpenCode integration — drift repair parity", () => {
  it("applies safe drift repair through the shared tool-execute dispatcher", async () => {
    const sid = `int-test-${Date.now()}-drift-repair-dispatch`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "IMPLEMENTATION"
      d.phaseState = "SCHEDULING"
      d.mode = "INCREMENTAL"
      d.featureName = `drift-repair-${Date.now()}`
      d.implDag = [
        { id: "T1", description: "Completed task", dependencies: [], expectedFiles: ["src/a.ts"], expectedTests: [], estimatedComplexity: "small", status: "complete" },
      ]
      d.currentTaskId = null
    })

    const reportRaw = await plugin.tool.report_drift.execute({ task_ids: ["T1"], include_worktree: false, include_db: false }, ctx)
    const report = JSON.parse(reportRaw)
    const planRaw = await plugin.tool.plan_drift_repair.execute({ drift_report_id: report.value.id, strategy: "safe-auto" }, ctx)
    const plan = JSON.parse(planRaw)
    expect(plan.value.actions[0].kind).toBe("request_user_decision")
    expect(plan.value.toolCalls[0].toolCall.toolName).toBe("submit_feedback")

    const appliedRaw = await plugin.tool.apply_drift_repair.execute({ repair_plan_id: plan.value.id, apply_safe_actions: true }, ctx)
    const applied = JSON.parse(appliedRaw)
    expect(applied.value.results[0].skipped).toContain("requires-approval")
    expect(plugin._testStore.get(sid)?.implDag?.[0]?.status).toBe("complete")
  })
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
    expect(Object.keys(tools).sort()).toEqual(OPENCODE_TOOL_CONTRACTS.map((contract) => contract.name).sort())
  })

  it("exposes roadmap author tools through the OpenCode plugin surface", () => {
    const roadmapToolNames = [
      "roadmap_read",
      "roadmap_query",
      "roadmap_derive_execution_slice",
      "roadmap_upsert_item",
      "roadmap_update_item_status",
      "roadmap_delete_item",
      "roadmap_upsert_edge",
      "roadmap_delete_edge",
      "roadmap_replace",
      "roadmap_delete",
    ]

    for (const toolName of roadmapToolNames) {
      expect(plugin.tool[toolName]).toBeDefined()
      expect(plugin.tool[toolName].execute).toBeFunction()
      expect(TOOL_HANDLERS[toolName as keyof typeof TOOL_HANDLERS]).toBeFunction()
    }
  })

  it("exposes product-management tools through the OpenCode plugin surface", () => {
    const productManagementToolNames = [
      "product_management_assess_request",
      "product_management_list_work",
      "product_management_queue_item",
    ]

    for (const toolName of productManagementToolNames) {
      expect(plugin.tool[toolName]).toBeDefined()
      expect(plugin.tool[toolName].execute).toBeFunction()
      expect(TOOL_HANDLERS[toolName as keyof typeof TOOL_HANDLERS]).toBeFunction()
    }
  })

  it("executes OpenCode product-management tools with the same typed JSON envelope as bridge", async () => {
    await writeRoadmapState()
    const sid = `int-test-${Date.now()}-opencode-product-management-tools`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const before = JSON.parse(JSON.stringify(plugin._testStore.get(sid)))

    const assess = JSON.parse(await plugin.tool["product_management_assess_request"].execute({
      request: "we should file a bug for this edge case and keep reviewing",
      feature_name: "autonomous-product-management",
      include_workflow_candidates: true,
    }, { directory: tempDir, sessionId: sid }))
    const list = JSON.parse(await plugin.tool["product_management_list_work"].execute({
      lifecycles: ["active", "frozen", "abandoned"],
      max_candidates: 10,
    }, { directory: tempDir, sessionId: sid }))
    const queue = JSON.parse(await plugin.tool["product_management_queue_item"].execute({
      title: "Capture OpenCode product-management chat",
      description: "Queue through the OpenCode tool surface while preserving workflow state.",
      kind: "bug",
      source: { sessionId: sid, artifactKey: "plan" },
      discovered_while: {
        request: "file this bug for later",
        currentPhase: before.phase,
        currentPhaseState: before.phaseState,
      },
    }, { directory: tempDir, sessionId: sid }))

    expect(assess).toMatchObject({ ok: true, value: { decision: "queue-roadmap-item", suggestedToolCalls: expect.any(Array), diagnostics: expect.any(Array) } })
    expect(list).toMatchObject({ ok: true, value: { candidates: expect.any(Array), diagnostics: expect.any(Array) } })
    expect(queue).toMatchObject({ ok: true, value: { queuedNode: expect.any(Object), currentWorkflowUnchanged: true, diagnostics: expect.any(Array) } })
    expect(plugin._testStore.get(sid)?.phase).toBe(before.phase)
    expect(plugin._testStore.get(sid)?.phaseState).toBe(before.phaseState)
  })

  it("executes OpenCode roadmap read tools with typed results without corrupting workflow state", async () => {
    await writeRoadmapState()
    const sid = `int-test-${Date.now()}-opencode-roadmap-read`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const before = JSON.parse(JSON.stringify(plugin._testStore.get(sid)))

    const response = await plugin.tool.roadmap_read.execute({}, { directory: tempDir, sessionId: sid })

    expect(JSON.parse(response)).toEqual({ ok: true, value: roadmapDocument() })
    const after = plugin._testStore.get(sid)
    expect(after.phase).toBe(before.phase)
    expect(after.phaseState).toBe(before.phaseState)
    expect(after.implDag).toEqual(before.implDag)
  })

  it("executes OpenCode roadmap query, derive, and mutation tools with typed roadmap results", async () => {
    await writeRoadmapState()
    const sid = `int-test-${Date.now()}-opencode-roadmap-tools`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const item = { ...roadmapDocument().items[0], status: "in-progress", updatedAt: ROADMAP_NOW }

    const query = await plugin.tool.roadmap_query.execute(
      { query: { featureName: "roadmap-backed-workflow", minPriority: 9 } },
      { directory: tempDir, sessionId: sid },
    )
    expect(JSON.parse(query)).toEqual({ ok: true, value: [roadmapDocument().items[0]] })

    const derive = await plugin.tool.roadmap_derive_execution_slice.execute(
      { roadmap_item_ids: ["item-1", "item-2"], feature_name: "roadmap-backed-workflow" },
      { directory: tempDir, sessionId: sid },
    )
    expect(JSON.parse(derive)).toEqual({
      ok: true,
      value: {
        roadmapItemIds: ["item-1", "item-2"],
        roadmapItems: roadmapDocument().items,
        edges: roadmapDocument().edges,
        featureName: "roadmap-backed-workflow",
      },
    })

    const status = await plugin.tool.roadmap_update_item_status.execute(
      { item_id: "item-1", status: "in-progress", updated_at: ROADMAP_NOW },
      { directory: tempDir, sessionId: sid },
    )
    expect(JSON.parse(status)).toEqual({ ok: true, value: { kind: "update-item-status", item, document: expect.any(Object) } })
  })

  it("keeps OpenCode tool arg names aligned with core contracts", () => {
    for (const contract of OPENCODE_TOOL_CONTRACTS) {
      expect(Object.keys(plugin.tool[contract.name].args ?? {}).sort()).toEqual(schemaPropertyNames(contract.schema))
    }
  })

  it("keeps task-boundary OpenCode args aligned with core schemas", () => {
    expect(Object.keys(plugin.tool.analyze_task_boundary_change.args).sort()).toEqual([
      "add_expected_tests",
      "add_files",
      "reason",
      "remove_expected_tests",
      "remove_files",
      "task_id",
    ])
    expect(Object.keys(plugin.tool.apply_task_boundary_change.args).sort()).toEqual([
      "add_expected_tests",
      "add_files",
      "expected_impacted_tasks",
      "expected_reset_tasks",
      "reason",
      "remove_expected_tests",
      "remove_files",
      "task_id",
    ])
  })

  it("exposes file-based request_review args without legacy artifact_content", () => {
    const args = plugin.tool.request_review.args
    expect(Object.keys(args).sort()).toEqual(["artifact_data_json", "artifact_description", "artifact_files", "summary"])
    expect(args.artifact_content).toBeUndefined()
    expect(args.artifact_markdown).toBeUndefined()
  })

  it("WORKFLOW_TOOL_NAMES contains every callable workflow tool", () => {
    expect([...WORKFLOW_TOOL_NAMES].sort()).toEqual(WORKFLOW_TOOL_CONTRACTS.map((contract) => contract.name).sort())
  })

  it("reviewer result capture tools reject calls without an active isolated reviewer", async () => {
    const captureToolArgs: Record<string, Record<string, unknown>> = {
      submit_task_review_result: { passed: true, issues: [], reasoning: "ok", code_quality_score: "9", error_handling_score: "9" },
      submit_phase_review_result: { satisfied: true, criteria_results: [{ criterion: "ok", met: true, evidence: "evidence", severity: "blocking", score: "9" }] },
      submit_change_proposal_review_result: { approved: true, route: "current-task-fix", confidence: "high", reason: "ok" },
      submit_task_drift_review_result: { drift_detected: false, updated_descriptions: [], reasoning: "ok" },
      submit_orchestrator_assess_result: { affected_artifacts: ["plan"], root_cause_artifact: "plan", reasoning: "ok" },
      submit_orchestrator_diverge_result: { classification: "tactical", trigger_criterion: "scope_expansion", reasoning: "ok" },
      submit_auto_approve_result: { approve: true, confidence: "0.9", reasoning: "ok", feedback: "approved" },
      submit_rebuttal_review_result: { criteria_results: [{ criterion: "ok", met: true, evidence: "evidence", severity: "blocking", score: "9", rebuttal_accepted: true }] },
      submit_intent_comparison_result: { classification: "FULL", explanation: "same intent" },
    }

    for (const [toolName, args] of Object.entries(captureToolArgs)) {
      const result = await plugin.tool[toolName].execute(args, { sessionId: `capture-${toolName}` })
      expect(result).toContain("can only be called by an active isolated reviewer session")
    }
  })

  it("patch suggestion tools report unavailable DB services", async () => {
    const patchSuggestionCalls: Array<[string, Record<string, unknown>]> = [
      ["route_patch_suggestions", {}],
      ["resolve_patch_suggestion", { patch_suggestion_id: "patch-1", resolution: "deferred", message: "later" }],
      ["apply_patch_suggestion", { patch_suggestion_id: "patch-1" }],
    ]

    for (const [toolName, args] of patchSuggestionCalls) {
      const result = await plugin.tool[toolName].execute(args, { sessionId: `patch-${toolName}`, directory: tempDir })
      expect(result).toContain("DB-backed patch suggestion services are not enabled")
    }
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle via event hook
// ---------------------------------------------------------------------------

describe("Event hook — session lifecycle", () => {
  it("writes trace init diagnostics at plugin startup when tracing is enabled", async () => {
    process.env["OPENARTISAN_TRACE"] = "1"
    plugin = await OpenArtisanPlugin({ client, directory: tempDir } as any)

    const tracePath = join(tempDir, ".openartisan", "openartisan-trace.jsonl")
    expect(existsSync(tracePath)).toBe(true)
    const events = readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(events.some((entry) =>
      entry.event === "trace.init" &&
      entry.traceEnabled === true &&
      entry.stateDir === join(tempDir, ".openartisan") &&
      typeof entry.backend === "string"
    )).toBe(true)
  })

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

  it("ignores idle events for stale non-active sessions", async () => {
    const staleSessionId = `int-test-${Date.now()}-stale`
    const activeSessionId = `int-test-${Date.now()}-active`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: staleSessionId } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: `stale-feature-${Date.now()}` },
      { directory: tempDir, sessionId: staleSessionId },
    )

    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: activeSessionId, agent: "artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `active-feature-${Date.now()}` },
      { directory: tempDir, sessionId: activeSessionId },
    )

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: staleSessionId } },
    })

    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("injects idle prompts for active workflow sessions by default", async () => {
    const workflowSessionId = `int-test-${Date.now()}-workflow-idle`
    const inactiveSessionId = `int-test-${Date.now()}-inactive`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: workflowSessionId } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `workflow-idle-${Date.now()}` },
      { directory: tempDir, sessionId: workflowSessionId },
    )

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: inactiveSessionId, agent: "Build" } } },
    })
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: workflowSessionId } },
    })

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    const promptArg = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]?.[0]
    expect(promptArg?.path?.id).toBe(workflowSessionId)
    expect(promptArg?.body?.parts?.[0]?.text).toContain("Continue drafting the PLANNING artifact")
    expect(plugin._testStore.get(workflowSessionId)?.retryCount).toBe(1)
  })

  it("does not inject idle prompts when the idle event came from user escape", async () => {
    const workflowSessionId = `int-test-${Date.now()}-workflow-escape-idle`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: workflowSessionId } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `workflow-escape-idle-${Date.now()}` },
      { directory: tempDir, sessionId: workflowSessionId },
    )

    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: workflowSessionId, reason: "user-escape" } },
    })

    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(plugin._testStore.get(workflowSessionId)?.retryCount).toBe(0)
  })

  it("auto-disables Open Artisan instead of escalating a stuck build-artisan session", async () => {
    const sid = `int-test-${Date.now()}-build-artisan-stuck`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build-artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `build-artisan-stuck-${Date.now()}` },
      { directory: tempDir, sessionId: sid, agent: "build-artisan" },
    )
    await plugin._testStore.update(sid, (draft: any) => {
      draft.activeAgent = "build-artisan"
      draft.retryCount = MAX_IDLE_RETRIES
    })

    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(client.session.prompt).not.toHaveBeenCalled()
    const state = plugin._testStore.get(sid)
    expect(state?.activeAgent).toBe("build")
    expect(state?.retryCount).toBe(0)

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("disables idle prompts when OPENARTISAN_IDLE_PROMPTS is 0", async () => {
    process.env["OPENARTISAN_IDLE_PROMPTS"] = "0"
    const workflowSessionId = `int-test-${Date.now()}-workflow-idle-opt-in`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: workflowSessionId } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `workflow-idle-opt-in-${Date.now()}` },
      { directory: tempDir, sessionId: workflowSessionId },
    )
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: workflowSessionId } },
    })

    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("does not block idle or later chat hooks when durable state updates hang", async () => {
    process.env["OPENARTISAN_TRACE"] = "1"
    const sid = `int-test-${Date.now()}-idle-stuck-write`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `idle-stuck-write-${Date.now()}` },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    const originalUpdate = plugin._testStore.update.bind(plugin._testStore)
    plugin._testStore.update = () => new Promise(() => {})
    try {
      await Promise.race([
        plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } }),
        eventuallyRejects("idle hook did not return"),
      ])

      await Promise.race([
        plugin["chat.message"](
          { sessionID: sid },
          { message: { sessionID: sid, id: "msg-ping" }, parts: [{ type: "text", text: "ping" }] },
        ),
        eventuallyRejects("chat.message hook did not return"),
      ])
    } finally {
      plugin._testStore.update = originalUpdate
    }

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(plugin._testStore.get(sid)?.retryCount).toBe(1)
    const tracePath = join(tempDir, ".openartisan", "openartisan-trace.jsonl")
    const events = readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.some((entry) => entry.event === "hook.memoryMutation" && entry.hook === "event" && entry.label === "idle.retryCount")).toBe(true)
    expect(events.some((entry) => entry.event === "hook.write.timeout")).toBe(false)
    expect(events.some((entry) => entry.event === "hook.end" && entry.hook === "event" && entry.eventType === "session.idle")).toBe(true)
    expect(events.some((entry) => entry.event === "hook.end" && entry.hook === "chat.message")).toBe(true)
  })

  it("injects user-gate routing without durable state updates from the chat hook", async () => {
    process.env["OPENARTISAN_TRACE"] = "1"
    const sid = `int-test-${Date.now()}-gate-stuck-write`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin._testStore.update(sid, (draft: any) => {
      draft.mode = "GREENFIELD"
      draft.featureName = "gate-stuck-write"
      draft.phase = "PLANNING"
      draft.phaseState = "USER_GATE"
      draft.activeAgent = "artisan"
      draft.userGateMessageReceived = false
    })

    const originalUpdate = plugin._testStore.update.bind(plugin._testStore)
    plugin._testStore.update = () => new Promise(() => {})
    const output = {
      message: { sessionID: sid, id: "msg-gate-stuck-write" },
      parts: [{ type: "text", text: "approved" }],
    }
    try {
      await Promise.race([
        plugin["chat.message"]({ sessionID: sid, agent: "artisan" }, output),
        eventuallyRejects("chat.message hook did not return"),
      ])
    } finally {
      plugin._testStore.update = originalUpdate
    }

    expect(output.parts).toHaveLength(2)
    expect(output.parts[0]?.text).toContain("Call `submit_feedback` NOW")
    expect(plugin._testStore.get(sid).userGateMessageReceived).toBe(true)
    const tracePath = join(tempDir, ".openartisan", "openartisan-trace.jsonl")
    const events = readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.some((entry) => entry.event === "hook.memoryMutation" && entry.hook === "chat.message" && entry.label === "chat.userGateReceived")).toBe(true)
    expect(events.some((entry) => entry.event === "hook.write.timeout")).toBe(false)
    expect(events.some((entry) => entry.event === "hook.end" && entry.hook === "chat.message" && entry.didMutateOutput === true)).toBe(true)
  })

  it("writes hook and idle prompt diagnostics to the trace file", async () => {
    process.env["OPENARTISAN_TRACE"] = "1"
    const sid = `int-test-${Date.now()}-trace`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `trace-${Date.now()}` },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "artisan" }, { system: [] })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

    const tracePath = join(tempDir, ".openartisan", "openartisan-trace.jsonl")
    expect(existsSync(tracePath)).toBe(true)
    const events = readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(events.some((entry) => entry.event === "hook.start" && entry.hook === "event")).toBe(true)
    expect(events.some((entry) => entry.event === "hook.end" && entry.hook === "experimental.chat.system.transform" && entry.injected === true)).toBe(true)
    expect(events.some((entry) => entry.event === "idle.decision" && entry.action === "reprompt")).toBe(true)
    expect(events.some((entry) => entry.event === "idle.prompt.skipped" && entry.reason === "idle-reprompt")).toBe(false)
    expect(events.some((entry) => entry.event === "promptExistingSession.start")).toBe(true)
  })

  it("records swallowed idle reprompt failures in trace", async () => {
    process.env["OPENARTISAN_IDLE_PROMPTS"] = "1"
    process.env["OPENARTISAN_TRACE"] = "1"
    const sid = `int-test-${Date.now()}-trace-idle-failure`

    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: `trace-idle-failure-${Date.now()}` },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )
    ;(client.session.prompt as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("synthetic prompt failure")
    })

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

    const tracePath = join(tempDir, ".openartisan", "openartisan-trace.jsonl")
    const events = readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(events.some((entry) =>
      entry.event === "promptExistingSession.end" &&
      entry.success === false &&
      entry.error === "synthetic prompt failure"
    )).toBe(true)
    expect(events.some((entry) =>
      entry.event === "idle.reprompt.failed" &&
      entry.error === "synthetic prompt failure"
    )).toBe(true)
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

  it("select_mode with roadmap item ids stores roadmapContext and enters the normal workflow", async () => {
    await writeRoadmapState()
    const sid = `int-test-${Date.now()}-roadmap-select-mode`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })

    const result = await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "roadmap-backed-workflow", roadmap_item_ids: ["item-1", "item-2"] },
      { directory: tempDir, sessionId: sid },
    )

    expect(result).toContain("INCREMENTAL")
    expect(result).toContain("DISCOVERY")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("DISCOVERY")
    expect(state.roadmapContext).toMatchObject({
      roadmapItemIds: ["item-1", "item-2"],
      featureName: "roadmap-backed-workflow",
      edges: [{ from: "item-1", to: "item-2", kind: "depends-on" }],
    })
  })

  it("select_mode with unknown roadmap ids fails before mode adoption", async () => {
    await writeRoadmapState()
    const sid = `int-test-${Date.now()}-roadmap-select-mode-missing`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })

    const result = await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "roadmap-backed-workflow", roadmap_item_ids: ["missing-item"] },
      { directory: tempDir, sessionId: sid },
    )

    expect(result).toContain("Error")
    expect(result).toContain("missing-item")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("MODE_SELECT")
    expect(state.mode).toBeNull()
    expect(state.roadmapContext ?? null).toBeNull()
  })

  it("resumes an incomplete prior workflow instead of restarting discovery", async () => {
    const oldSid = `int-test-${Date.now()}-resume-old`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: oldSid } } } })
    const oldCtx = { directory: tempDir, sessionId: oldSid }
    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "resume-incomplete" },
      oldCtx,
    )
    await plugin.tool.mark_scan_complete.execute({ scan_summary: "scanned" }, oldCtx)

    const newSid = `int-test-${Date.now()}-resume-new`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: newSid } } } })
    const newCtx = { directory: tempDir, sessionId: newSid }

    const check = await plugin.tool.check_prior_workflow.execute(
      { feature_name: "resume-incomplete" },
      newCtx,
    )
    expect(check).toContain("Prior workflow found")

    const result = await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "resume-incomplete" },
      newCtx,
    )

    expect(result).toContain("Resuming prior workflow")
    expect(result).toContain("DISCOVERY/ANALYZE")
    expect(plugin._testStore.get(newSid).phase).toBe("DISCOVERY")
    expect(plugin._testStore.get(newSid).phaseState).toBe("ANALYZE")
  })

  it("adopts persisted prior workflow state when resuming with the same session id", async () => {
    const sid = `int-test-${Date.now()}-resume-same`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "resume-same-session" },
      ctx,
    )
    await plugin.tool.mark_scan_complete.execute({ scan_summary: "scanned" }, ctx)

    plugin = await OpenArtisanPlugin({ client, directory: tempDir } as any)
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })

    const check = await plugin.tool.check_prior_workflow.execute(
      { feature_name: "resume-same-session" },
      ctx,
    )
    expect(check).toContain("Prior workflow found")

    const result = await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "resume-same-session" },
      ctx,
    )

    expect(result).toContain("Workflow already active")
    expect(plugin._testStore.get(sid).phase).toBe("DISCOVERY")
    expect(plugin._testStore.get(sid).phaseState).toBe("ANALYZE")
  })

  it("check_prior_workflow lazily creates session state after plugin restart", async () => {
    const sid = `int-test-${Date.now()}-check-prior-lazy`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    const ctx = { directory: tempDir, sessionId: sid }
    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "check-prior-lazy-resume" },
      ctx,
    )
    await plugin.tool.mark_scan_complete.execute({ scan_summary: "scanned" }, ctx)

    plugin = await OpenArtisanPlugin({ client, directory: tempDir } as any)

    const check = await plugin.tool.check_prior_workflow.execute(
      { feature_name: "check-prior-lazy-resume", user_intent: "continue testing resume after restart" },
      ctx,
    )

    expect(check).toContain("Prior workflow found")
    expect(check).not.toContain("Session")
    expect(plugin._testStore.get(sid).priorWorkflowChecked).toBe(true)
  })

  it("switches to a different feature in the same session by parking the current workflow", async () => {
    const sid = `int-test-${Date.now()}-switch`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "feature-one" },
      { directory: tempDir, sessionId: sid },
    )

    const result = await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "feature-two" },
      { directory: tempDir, sessionId: sid },
    )

    expect(result).toContain("DISCOVERY")
    const current = plugin._testStore.get(sid)
    expect(current.featureName).toBe("feature-two")
    expect(current.phase).toBe("DISCOVERY")

    const parked = plugin._testStore.findByFeatureName("feature-one")
    expect(parked?.featureName).toBe("feature-one")
    expect(parked?.phase).toBe("PLANNING")
    expect(parked?.sessionId).not.toBe(sid)
  })

  it("calling select_mode twice returns error", async () => {
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "test-feature" },
      { directory: tempDir, sessionId },
    )
    const result2 = await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "test-feature" },
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

  it("records session policy source in tool guard trace entries", async () => {
    process.env["OPENARTISAN_TRACE"] = "1"
    const sid = `int-test-${Date.now()}-guard-policy-source`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: `guard-policy-source-${Date.now()}` },
      { directory: tempDir, sessionId: sid },
    )

    await expect(
      plugin["tool.execute.before"]({ sessionID: sid, tool: "file_write", args: { filePath: "/tmp/test" } }),
    ).rejects.toThrow("blocked")

    const tracePath = join(tempDir, ".openartisan", "openartisan-trace.jsonl")
    const events = readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.some((entry) =>
      entry.event === "hook.end" &&
      entry.hook === "tool.execute.before" &&
      entry.tool === "file_write" &&
      entry.policySource === "session" &&
      typeof entry.error === "string",
    )).toBe(true)
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

  it("blocks write-like patch tools with no extractable target path in INTERFACES", async () => {
    const sid = `int-test-${Date.now()}-guard-unknown-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-unknown-patch-${Date.now()}`)

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: { patch: "*** Begin Patch\n*** End Patch" },
      }),
    ).rejects.toThrow("no target path")
  })

  it("explains native apply_patch is unguardable when OpenCode omits patch text", async () => {
    const sid = `int-test-${Date.now()}-guard-native-patch-no-payload`
    await advanceGreenfieldToInterfaces(sid, `guard-native-patch-no-payload-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => { d.phaseState = "REVISE" })

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        callID: "call_real_native_shape",
      } as any),
    ).rejects.toThrow("guarded_write")
  })

  it("allows guarded_edit in INTERFACES/REVISE for interface files", async () => {
    const sid = `int-test-${Date.now()}-guarded-edit-interface`
    const ctx = await advanceGreenfieldToInterfaces(sid, `guarded-edit-interface-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => { d.phaseState = "REVISE" })
    const targetPath = join(tempDir, "packages", "cli", "src", "contracts.d.ts")
    mkdirSync(join(tempDir, "packages", "cli", "src"), { recursive: true })
    await Bun.write(targetPath, "export interface C {}")

    const result = await plugin.tool.guarded_edit.execute({
      file_path: targetPath,
      old_text: "export interface C {}",
      new_text: "export interface C {\n  readonly ok: true\n}",
    }, ctx)

    expect(result).toContain("Edited")
    expect(result).toContain("Additions: 3")
    expect(result).toContain("Removals: 1")
    expect(result).toContain("```diff")
    expect(result).toContain("-export interface C {}")
    expect(result).toContain("+export interface C {")
    expect(readFileSync(targetPath, "utf-8")).toContain("readonly ok: true")
  })

  it("blocks guarded_edit in INTERFACES/REVISE for implementation files", async () => {
    const sid = `int-test-${Date.now()}-guarded-edit-implementation`
    const ctx = await advanceGreenfieldToInterfaces(sid, `guarded-edit-implementation-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => { d.phaseState = "REVISE" })
    const targetPath = join(tempDir, "src", "runtime", "app.ts")

    const result = await plugin.tool.guarded_edit.execute({
      file_path: targetPath,
      old_text: "old",
      new_text: "new",
    }, ctx)

    expect(result).toContain("blocked")
    expect(existsSync(targetPath)).toBe(false)
  })

  it("allows guarded_write in TESTS/DRAFT to create new test files", async () => {
    const sid = `int-test-${Date.now()}-guarded-write-test`
    const ctx = await advanceGreenfieldToInterfaces(sid, `guarded-write-test-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "TESTS"
      d.phaseState = "DRAFT"
    })
    const targetPath = join(tempDir, "packages", "cli", "src", "contracts.test.ts")

    const result = await plugin.tool.guarded_write.execute({
      file_path: targetPath,
      content: "import { describe, it } from 'bun:test'\n\ndescribe('contracts', () => {\n  it('loads', () => {})\n})\n",
    }, ctx)

    expect(result).toContain("Created")
    expect(result).toContain("Additions:")
    expect(result).toContain("--- /dev/null")
    expect(result).toContain("+++ b/packages/cli/src/contracts.test.ts")
    expect(readFileSync(targetPath, "utf-8")).toContain("describe('contracts'")
  })

  it("allows guarded_patch in TESTS/DRAFT to create a new test file with diff output", async () => {
    const sid = `int-test-${Date.now()}-guarded-patch-test`
    const ctx = await advanceGreenfieldToInterfaces(sid, `guarded-patch-test-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "TESTS"
      d.phaseState = "DRAFT"
    })
    const targetPath = join(tempDir, "packages", "cli", "src", "guarded-patch.test.ts")

    const result = await plugin.tool.guarded_patch.execute({
      patch_text: `*** Begin Patch\n*** Add File: ${targetPath}\n+import { describe, it } from 'bun:test'\n+\n+describe('guarded patch', () => {\n+  it('loads', () => {})\n+})\n*** End Patch`,
    }, ctx)

    expect(result).toContain("Applied patch to 1 file(s).")
    expect(result).toContain("Additions:")
    expect(result).toContain("+++ b/packages/cli/src/guarded-patch.test.ts")
    expect(readFileSync(targetPath, "utf-8")).toContain("describe('guarded patch'")
  })

  it("blocks guarded_patch before writing any file when a target violates phase policy", async () => {
    const sid = `int-test-${Date.now()}-guarded-patch-blocked`
    const ctx = await advanceGreenfieldToInterfaces(sid, `guarded-patch-blocked-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "TESTS"
      d.phaseState = "DRAFT"
    })
    const allowedPath = join(tempDir, "packages", "cli", "src", "guarded-patch.test.ts")
    const blockedPath = join(tempDir, "packages", "cli", "src", "guarded-patch.ts")

    const result = await plugin.tool.guarded_patch.execute({
      patch_text: `*** Begin Patch\n*** Add File: ${allowedPath}\n+test('ok', () => {})\n*** Add File: ${blockedPath}\n+export const blocked = true\n*** End Patch`,
    }, ctx)

    expect(result).toContain("blocked")
    expect(existsSync(allowedPath)).toBe(false)
    expect(existsSync(blockedPath)).toBe(false)
  })

  it("blocks guarded_write in TESTS/DRAFT for non-test files", async () => {
    const sid = `int-test-${Date.now()}-guarded-write-non-test`
    const ctx = await advanceGreenfieldToInterfaces(sid, `guarded-write-non-test-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => {
      d.phase = "TESTS"
      d.phaseState = "DRAFT"
    })
    const targetPath = join(tempDir, "packages", "cli", "src", "contracts.ts")

    const result = await plugin.tool.guarded_write.execute({
      file_path: targetPath,
      content: "export const notATest = true\n",
    }, ctx)

    expect(result).toContain("blocked")
    expect(existsSync(targetPath)).toBe(false)
  })

  it("allows apply_patch when all patch targets satisfy the phase file predicate", async () => {
    const sid = `int-test-${Date.now()}-guard-valid-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-valid-patch-${Date.now()}`)

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: {
          patchText: "*** Begin Patch\n*** Update File: src/core/aspects/types.ts\n@@\n-old\n+new\n*** End Patch",
        },
      }),
    ).resolves.toBeUndefined()
  })

  it("allows apply_patch in INTERFACES/REVISE with args.patchText", async () => {
    const sid = `int-test-${Date.now()}-guard-revise-args-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-revise-args-patch-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => { d.phaseState = "REVISE" })

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: {
          patchText: "*** Begin Patch\n*** Update File: packages/cli/src/contracts.d.ts\n@@\n-old\n+new\n*** End Patch",
        },
      }),
    ).resolves.toBeUndefined()
  })

  it("allows apply_patch when OpenCode provides patch text outside args", async () => {
    const sid = `int-test-${Date.now()}-guard-top-level-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-top-level-patch-${Date.now()}`)

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        patchText: `*** Begin Patch\n*** Add File: ${join(tempDir, "src/contracts.d.ts")}\n+export interface Contract {}\n*** End Patch`,
      } as any),
    ).resolves.toBeUndefined()
  })

  it("allows apply_patch in INTERFACES/REVISE with top-level patch text", async () => {
    const sid = `int-test-${Date.now()}-guard-revise-top-level-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-revise-top-level-patch-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => { d.phaseState = "REVISE" })

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: {},
        patchText: "*** Begin Patch\n*** Update File: packages/cli/src/contracts.d.ts\n@@\n-old\n+new\n*** End Patch",
      } as any),
    ).resolves.toBeUndefined()
  })

  it("allows apply_patch in INTERFACES/REVISE with JSON-stringified args", async () => {
    const sid = `int-test-${Date.now()}-guard-revise-string-args-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-revise-string-args-patch-${Date.now()}`)
    await plugin._testStore.update(sid, (d: any) => { d.phaseState = "REVISE" })

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: JSON.stringify({
          patchText: "*** Begin Patch\n*** Update File: packages/cli/src/contracts.d.ts\n@@\n-old\n+new\n*** End Patch",
        }),
      } as any),
    ).resolves.toBeUndefined()
  })

  it("allows apply_patch when OpenCode provides empty args and top-level patch text", async () => {
    const sid = `int-test-${Date.now()}-guard-empty-args-top-level-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-empty-args-top-level-patch-${Date.now()}`)

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: {},
        patchText: "*** Begin Patch\n*** Add File: src/contracts.d.ts\n+export interface Contract {}\n*** End Patch",
      } as any),
    ).resolves.toBeUndefined()
  })

  it("allows apply_patch when OpenCode provides patch text on hook output args", async () => {
    const sid = `int-test-${Date.now()}-guard-output-args-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-output-args-patch-${Date.now()}`)

    await expect(
      plugin["tool.execute.before"](
        {
          sessionID: sid,
          tool: "apply_patch",
          callID: "call_output_args_patch",
        } as any,
        {
          args: {
            patchText: "*** Begin Patch\n*** Add File: src/contracts.d.ts\n+export interface Contract {}\n*** End Patch",
          },
        } as any,
      ),
    ).resolves.toBeUndefined()
  })

  it("allows multi-file apply_patch when every target satisfies INTERFACES policy", async () => {
    const sid = `int-test-${Date.now()}-guard-multi-valid-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-multi-valid-patch-${Date.now()}`)

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: {
          patchText: "*** Begin Patch\n*** Add File: src/a.d.ts\n+export interface A {}\n*** Add File: src/b.d.ts\n+export interface B {}\n*** End Patch",
        },
      }),
    ).resolves.toBeUndefined()
  })

  it("blocks apply_patch when any patch target violates the phase file predicate", async () => {
    const sid = `int-test-${Date.now()}-guard-invalid-patch`
    await advanceGreenfieldToInterfaces(sid, `guard-invalid-patch-${Date.now()}`)

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: {
          patchText: "*** Begin Patch\n*** Update File: src/core/aspects/types.ts\n@@\n-old\n+new\n*** Update File: src/runtime/app.ts\n@@\n-old\n+new\n*** End Patch",
        },
      }),
    ).rejects.toThrow("src/runtime/app.ts")
  })

  it("suppresses idle reprompt after nonrecoverable apply_patch target extraction failure", async () => {
    const sid = `int-test-${Date.now()}-guard-idle-blocker`
    await advanceGreenfieldToInterfaces(sid, `guard-idle-blocker-${Date.now()}`)
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    await expect(
      plugin["tool.execute.before"]({
        sessionID: sid,
        tool: "apply_patch",
        args: { patch: "*** Begin Patch\n*** End Patch" },
      }),
    ).rejects.toThrow("no target path")

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("rejects artifact_content for OpenCode INTERFACES request_review", async () => {
    const sid = `int-test-${Date.now()}-interfaces-content`
    const ctx = await advanceGreenfieldToInterfaces(sid, `interfaces-content-${Date.now()}`)

    const result = await plugin.tool.request_review.execute(
      {
        summary: "Interfaces",
        artifact_description: "Markdown interface design doc",
        artifact_content: "# Interfaces\n",
      },
      ctx,
    )

    expect(result).toContain("Error")
    expect(result).toContain("artifact_files")
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
    // Workflow block should be appended (last element) to preserve
    // OpenCode's own system block positions for applyCaching.
    expect(output.system.length).toBeGreaterThanOrEqual(2)
    expect(output.system[0]).toBe("existing system prompt")
    const last = output.system[output.system.length - 1]
    expect(last).toContain("STRUCTURED WORKFLOW")
    expect(last).toContain("PLANNING")
  })

  it("injects roadmap context into PLANNING prompts without changing workflow gates", async () => {
    const sid = `int-test-${Date.now()}-roadmap-context-prompt`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "roadmap-backed-workflow" },
      { directory: tempDir, sessionId: sid },
    )
    await plugin._testStore.update(sid, (draft: any) => {
      draft.phase = "PLANNING"
      draft.phaseState = "DRAFT"
      draft.roadmapContext = {
        roadmapItemIds: ["item-1", "item-2"],
        roadmapItems: roadmapDocument().items,
        edges: roadmapDocument().edges,
        featureName: "roadmap-backed-workflow",
        executionSliceId: "slice-1",
        attachedAt: ROADMAP_NOW,
      }
    })

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid }, output)

    const injected = output.system[output.system.length - 1]
    expect(injected).toContain("Roadmap")
    expect(injected).toContain("item-1")
    expect(injected).toContain("Roadmap-backed workflow")
    expect(injected).toContain("blocked")
    expect(plugin._testStore.get(sid).phase).toBe("PLANNING")
    expect(plugin._testStore.get(sid).phaseState).toBe("DRAFT")
  })

  it("does not inject roadmap context into DISCOVERY prompts", async () => {
    await writeRoadmapState()
    const sid = `int-test-${Date.now()}-roadmap-context-discovery`
    await plugin.event({ event: { type: "session.created", properties: { info: { id: sid } } } })
    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "roadmap-backed-workflow", roadmap_item_ids: ["item-1"] },
      { directory: tempDir, sessionId: sid },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid }, output)

    const injected = output.system[output.system.length - 1]
    expect(plugin._testStore.get(sid).phase).toBe("DISCOVERY")
    expect(injected).not.toContain("Roadmap Context")
    expect(injected).not.toContain("item-1")
  })

  it("unknown session does not modify system array", async () => {
    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: "truly-unknown-session-system" }, output)
    expect(output.system.length).toBe(1)
    expect(output.system[0]).toBe("original")
  })

  it("stays dormant for non-artisan sessions detected at startup", async () => {
    const sid = `int-test-${Date.now()}-build-dormant`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "Build" } } },
    })

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "Build" }, output)

    expect(output.system).toEqual(["original"])
    const state = plugin._testStore.get(sid)
    expect(state.activeAgent).toBe("build")
  })

  it("activates immediately for artisan sessions detected at startup", async () => {
    const sid = `int-test-${Date.now()}-artisan-active`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "artisan" }, output)

    expect(output.system.length).toBeGreaterThanOrEqual(2)
    expect(output.system[output.system.length - 1]).toContain("STRUCTURED WORKFLOW")
    expect(output.system[output.system.length - 1]).toContain("MODE_SELECT")
  })

  it("activates for build sessions only when the user explicitly asks to use Open Artisan", async () => {
    const sid = `int-test-${Date.now()}-build-opt-in`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })

    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-opt-in" },
        parts: [{ type: "text", text: "Please use Open Artisan for this workflow." }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "build" }, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(output.system[output.system.length - 1]).toContain("STRUCTURED WORKFLOW")
    expect(plugin._testStore.get(sid).activeAgent).toBe("build-artisan")
  })

  it("does not opt in when the user explicitly says not to use Open Artisan", async () => {
    const sid = `int-test-${Date.now()}-build-negated-opt-in`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })

    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-negated-opt-in" },
        parts: [{ type: "text", text: "Don't use Open Artisan for this task." }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "build" }, output)

    expect(output.system).toEqual(["original"])
    expect(plugin._testStore.get(sid).activeAgent).toBe("build")
  })

  it("treats workflow tool calls from build sessions as explicit Open Artisan opt-in", async () => {
    const sid = `int-test-${Date.now()}-build-tool-opt-in`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "tool-opt-in" },
      { directory: tempDir, sessionId: sid, agent: "build" },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "build" }, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(output.system[output.system.length - 1]).toContain("STRUCTURED WORKFLOW")
    expect(plugin._testStore.get(sid).activeAgent).toBe("build-artisan")
  })

  it("ignores explicit disable-workflow text in true artisan sessions", async () => {
    const sid = `int-test-${Date.now()}-manual-dormant`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "manual-dormant" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )

    await plugin["chat.message"](
      { sessionID: sid },
      {
        message: { sessionID: sid, id: "msg-1" },
        parts: [{ type: "text", text: "we're in plan mode now, disable workflow" }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid }, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(output.system[output.system.length - 1]).toContain("STRUCTURED WORKFLOW")
    const state = plugin._testStore.get(sid)
    expect(state.activeAgent).toBe("artisan")
  })

  it("does not go dormant from incidental build-mode phrasing alone", async () => {
    const sid = `int-test-${Date.now()}-build-mode-mention`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "build-mode-mention" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )

    await plugin["chat.message"](
      { sessionID: sid },
      {
        message: { sessionID: sid, id: "msg-build-mode" },
        parts: [{ type: "text", text: "We are in build mode, continue the workflow changes." }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid }, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(output.system[output.system.length - 1]).toContain("STRUCTURED WORKFLOW")
    const state = plugin._testStore.get(sid)
    expect(state.activeAgent).toBe("artisan")
  })

  it("does not go dormant for explicit Open Artisan self-repair intent in artisan mode", async () => {
    const sid = `int-test-${Date.now()}-self-repair-dormant`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "self-repair-dormant" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )

    await plugin["chat.message"](
      { sessionID: sid },
      {
        message: { sessionID: sid, id: "msg-self-repair" },
        parts: [{ type: "text", text: "We need to fix Open Artisan itself before continuing." }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid }, output)

    expect(output.system.length).toBeGreaterThan(1)
    const state = plugin._testStore.get(sid)
    expect(state.activeAgent).toBe("artisan")
  })

  it("resets stalled retry state when the user responds", async () => {
    const sid = `int-test-${Date.now()}-retry-reset-on-user`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "retry-reset-on-user" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )
    await plugin._testStore.update(sid, (draft: any) => {
      draft.retryCount = 4
    })

    await plugin["chat.message"](
      { sessionID: sid, agent: "artisan" },
      {
        message: { sessionID: sid, id: "msg-retry-reset" },
        parts: [{ type: "text", text: "continue now" }],
      },
    )

    expect(plugin._testStore.get(sid).retryCount).toBe(0)
  })

  it("can switch back out of the workflow in build mode after an explicit opt-in", async () => {
    const sid = `int-test-${Date.now()}-build-opt-out`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })

    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-opt-in-2" },
        parts: [{ type: "text", text: "Use Open Artisan for this task." }],
      },
    )

    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-opt-out" },
        parts: [{ type: "text", text: "disable workflow now" }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "build" }, output)

    expect(output.system).toEqual(["original"])
    expect(plugin._testStore.get(sid).activeAgent).toBe("build")
  })

  it("can explicitly turn off Open Artisan from a build-driven workflow", async () => {
    const sid = `int-test-${Date.now()}-build-openartisan-off`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })

    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-opt-in-openartisan" },
        parts: [{ type: "text", text: "Use Open Artisan for this task." }],
      },
    )
    expect(plugin._testStore.get(sid).activeAgent).toBe("build-artisan")

    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-openartisan-off" },
        parts: [{ type: "text", text: "please turn off open-artisan. we're in build mode. we don't need openartisan for this" }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "build" }, output)

    expect(output.system).toEqual(["original"])
    expect(plugin._testStore.get(sid).activeAgent).toBe("build")
  })

  it("can turn on Open Artisan and record a user-gate approval in the same message", async () => {
    const sid = `int-test-${Date.now()}-turn-on-approve-gate`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })
    await plugin._testStore.update(sid, (draft: any) => {
      draft.mode = "INCREMENTAL"
      draft.featureName = "turn-on-approve-gate"
      draft.phase = "DISCOVERY"
      draft.phaseState = "USER_GATE"
      draft.activeAgent = "build"
      draft.userGateMessageReceived = false
    })

    const output = {
      message: { sessionID: sid, id: "msg-turn-on-approve-gate" },
      parts: [{ type: "text", text: "turn on open-artisan and approve the user gate" }],
    }
    await plugin["chat.message"]({ sessionID: sid, agent: "build" }, output)

    const state = plugin._testStore.get(sid)
    expect(state.activeAgent).toBe("build-artisan")
    expect(state.userGateMessageReceived).toBe(true)
    expect(output.parts[0]?.text).toContain("The user has approved")
  })

  it("rejects disable_open_artisan in artisan mode", async () => {
    const sid = `int-test-${Date.now()}-artisan-openartisan-off`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "artisan-openartisan-off" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )

    const result = await plugin.tool.disable_open_artisan.execute({}, { directory: tempDir, sessionId: sid, agent: "artisan" })

    expect(result).toContain("not available in artisan or robot-artisan modes")
    expect(plugin._testStore.get(sid).activeAgent).toBe("artisan")
  })

  it("rejects disable_open_artisan in robot-artisan mode", async () => {
    const sid = `int-test-${Date.now()}-artisan-off-idle`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "robot-artisan" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "artisan-off-idle" },
      { directory: tempDir, sessionId: sid, agent: "robot-artisan" },
    )

    const result = await plugin.tool.disable_open_artisan.execute({}, { directory: tempDir, sessionId: sid, agent: "robot-artisan" })

    expect(result).toContain("not available in artisan or robot-artisan modes")
    expect(plugin._testStore.get(sid).activeAgent).toBe("robot-artisan")
  })

  it("disable_open_artisan makes an opted-in build session dormant", async () => {
    const sid = `int-test-${Date.now()}-artisan-off-tool-guard`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })

    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-build-tool-opt-in" },
        parts: [{ type: "text", text: "Use Open Artisan for this task." }],
      },
    )
    expect(plugin._testStore.get(sid).activeAgent).toBe("build-artisan")

    const result = await plugin.tool.disable_open_artisan.execute({}, { directory: tempDir, sessionId: sid, agent: "build" })

    expect(result).toContain("Open Artisan disabled")
    expect(plugin._testStore.get(sid).activeAgent).toBe("build")
  })

  it("disable_open_artisan strips stale workflow gate text from later build messages", async () => {
    const sid = `int-test-${Date.now()}-artisan-off-stale-gate`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })
    await plugin["chat.message"](
      { sessionID: sid, agent: "build" },
      {
        message: { sessionID: sid, id: "msg-build-stale-gate-opt-in" },
        parts: [{ type: "text", text: "Use Open Artisan for this task." }],
      },
    )
    await plugin._testStore.update(sid, (draft: any) => {
      draft.phase = "DISCOVERY"
      draft.phaseState = "USER_GATE"
      draft.activeAgent = "build-artisan"
    })
    await plugin.tool.disable_open_artisan.execute({}, { directory: tempDir, sessionId: sid, agent: "build" })

    const output = {
      message: { sessionID: sid, id: "msg-build-stale-gate" },
      parts: [{
        type: "text",
        text: "can you review the current state?[WORKFLOW GATE — IMMEDIATE ACTION REQUIRED] The user has provided feedback on the DISCOVERY artifact. Call `submit_feedback` NOW.",
      }],
    }
    await plugin["chat.message"]({ sessionID: sid, agent: "build" }, output)

    expect(output.parts).toHaveLength(1)
    expect(output.parts[0]?.text).toBe("can you review the current state?")
    expect(plugin._testStore.get(sid).userGateMessageReceived).toBe(false)
  })

  it("disables compaction auto-continue at workflow user gates", async () => {
    const sid = `int-test-${Date.now()}-gate-autocontinue`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "gate-autocontinue" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )
    await plugin._testStore.update(sid, (draft: any) => {
      draft.phase = "DISCOVERY"
      draft.phaseState = "USER_GATE"
      draft.activeAgent = "artisan"
    })

    const output = { enabled: true }
    await plugin["experimental.compaction.autocontinue"]({ sessionID: sid }, output)

    expect(output.enabled).toBe(false)
  })

  it("leaves compaction auto-continue alone for dormant sessions", async () => {
    const sid = `int-test-${Date.now()}-dormant-autocontinue`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })
    await plugin._testStore.update(sid, (draft: any) => {
      draft.phase = "DISCOVERY"
      draft.phaseState = "USER_GATE"
      draft.activeAgent = "build"
    })

    const output = { enabled: true }
    await plugin["experimental.compaction.autocontinue"]({ sessionID: sid }, output)

    expect(output.enabled).toBe(true)
  })

  it("ignores disable-workflow text for true artisan sessions", async () => {
    const sid = `int-test-${Date.now()}-artisan-locked`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "artisan-locked" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )

    await plugin["chat.message"](
      { sessionID: sid, agent: "artisan" },
      {
        message: { sessionID: sid, id: "msg-locked" },
        parts: [{ type: "text", text: "disable workflow now" }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "artisan" }, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(plugin._testStore.get(sid).activeAgent).toBe("artisan")
  })

  it("ignores disable-workflow text for robot-artisan sessions", async () => {
    const sid = `int-test-${Date.now()}-robot-locked`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "robot-artisan" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "robot-locked" },
      { directory: tempDir, sessionId: sid, agent: "robot-artisan" },
    )

    await plugin["chat.message"](
      { sessionID: sid, agent: "robot-artisan" },
      {
        message: { sessionID: sid, id: "msg-robot-locked" },
        parts: [{ type: "text", text: "disable workflow now" }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "robot-artisan" }, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(plugin._testStore.get(sid).activeAgent).toBe("robot-artisan")
  })

  it("does not auto-downgrade a true artisan session from non-artisan agent metadata", async () => {
    const sid = `int-test-${Date.now()}-auto-build-dormant`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })

    await plugin.tool.select_mode.execute(
      { mode: "REFACTOR", feature_name: "auto-build-dormant" },
      { directory: tempDir, sessionId: sid, agent: "artisan" },
    )

    await plugin["chat.message"](
      { sessionID: sid, agent: "Build" },
      {
        message: { sessionID: sid, id: "msg-2" },
        parts: [{ type: "text", text: "continuing work" }],
      },
    )

    const output = { system: ["original"] }
    await plugin["experimental.chat.system.transform"]({ sessionID: sid, agent: "Build" }, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(output.system[output.system.length - 1]).toContain("STRUCTURED WORKFLOW")
    const state = plugin._testStore.get(sid)
    expect(state.activeAgent).toBe("artisan")
  })
})

describe("robot-artisan autonomy", () => {
  it("applies pending INTERFACES allowlist expansion during inline auto-approval", async () => {
    let promptCallCount = 0
    ;(client.session.prompt as ReturnType<typeof mock>).mockImplementation(async () => {
      promptCallCount += 1
      if (promptCallCount === 1) {
        return {
          data: { info: { satisfied: true, criteria_results: planningPassCriteria() }, parts: [{ type: "text", text: JSON.stringify({
            satisfied: true,
            criteria_results: planningPassCriteria(),
          }) }] },
        }
      }
      return {
        data: {
          parts: [{ type: "text", text: JSON.stringify({ approve: true, confidence: 0.95, reasoning: "Interface artifact and allowlist expansion are ready." }) }],
        },
      }
    })

    const sid = `int-test-${Date.now()}-robot-interfaces-allowlist-expansion`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "robot-artisan" } } },
    })
    const ctx = { directory: tempDir, sessionId: sid, agent: "robot-artisan" }
    await plugin.tool.select_mode.execute({ mode: "INCREMENTAL", feature_name: "robot-interfaces-allowlist-expansion" }, ctx)
    const allowed = `${tempDir}/packages/core/src/auth-interfaces.ts`
    const runtime = `${tempDir}/packages/runtime/src/internal/contracts-implementation.ts`
    await Bun.write(allowed, "export interface CoreAuth {}\n")
    await Bun.write(runtime, "export interface RuntimeAuth {}\n")
    await plugin._testStore.update(sid, (draft: any) => {
      draft.phase = "INTERFACES"
      draft.phaseState = "REVIEW"
      draft.mode = "INCREMENTAL"
      draft.activeAgent = "robot-artisan"
      draft.fileAllowlist = [allowed]
      draft.reviewArtifactFiles = [allowed, runtime]
      draft.pendingAllowlistExpansions = [{
        files: [runtime],
        reason: "Reviewed interface file is required by the approved incremental plan.",
        sourceArtifact: "interfaces",
        requestedAtPhase: "INTERFACES",
        requestedAt: 1,
      }]
    })

    const result = await plugin.tool.mark_satisfied.execute({ criteria_met: planningPassCriteria() }, ctx)

    expect(result).toContain("Auto-approved")
    const state = plugin._testStore.get(sid)
    expect(state.fileAllowlist).toContain(runtime)
    expect(state.pendingAllowlistExpansions).toEqual([])
  })

  it("moves directly to REVISE when the auto-approver rejects", async () => {
    let promptCallCount = 0
    ;(client.session.prompt as ReturnType<typeof mock>).mockImplementation(async () => {
      promptCallCount += 1
      if (promptCallCount === 1) {
        return {
          data: { info: { satisfied: true, criteria_results: planningPassCriteria() }, parts: [{ type: "text", text: JSON.stringify({
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
              { criterion: "User journey completeness", met: true, evidence: "mock", severity: "blocking" },
              { criterion: "[Q] Design excellence", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Architectural cohesion", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Vision alignment", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Completeness", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Readiness for execution", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Security standards", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Operational excellence", met: true, evidence: "mock", severity: "blocking", score: 9 },
            ],
          }) }] },
        }
      }

      return {
        data: {
          parts: [{
            type: "text",
            text: JSON.stringify({
              approve: false,
              confidence: 0.25,
              reasoning: "Deployment coverage is incomplete.",
              feedback: "Add the missing deployment and rollback details.",
            }),
          }],
        },
      }
    })

    const sid = `int-test-${Date.now()}-robot-auto-revise`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "robot-artisan" } } },
    })
    const ctx = { directory: tempDir, sessionId: sid, agent: "robot-artisan" }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "robot-auto-revise" },
      ctx,
    )
    await requestPlanningReview(ctx, "robot-auto-revise", "# Plan")
    promptCallCount = 0
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    const result = await plugin.tool.mark_satisfied.execute(
      {
        criteria_met: [
          { criterion: "All user requirements explicitly addressed", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Scope boundaries explicit", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Architecture described", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Error and failure cases specified", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "No TBD items", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Data model described", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Integration points identified", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Deployment & infrastructure addressed", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "User journey completeness", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "[Q] Design excellence", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Architectural cohesion", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Vision alignment", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Completeness", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Readiness for execution", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Security standards", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Operational excellence", met: true, evidence: "mock", severity: "blocking", score: "9" },
        ],
      },
      ctx,
    )

    expect(result).toContain("Auto-approve rejected")
    expect(result).toContain("Transitioned to **PLANNING/REVISE**")

    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("PLANNING")
    expect(state.phaseState).toBe("REVISE")
    expect(state.reviewArtifactHash).toBeNull()
    expect(state.latestReviewResults).toBeNull()
    expect(state.feedbackHistory[state.feedbackHistory.length - 1]?.feedback).toContain("Add the missing deployment")
  })

  it("moves directly to REVISE when auto-approval returns non-JSON output", async () => {
    let promptCallCount = 0
    ;(client.session.prompt as ReturnType<typeof mock>).mockImplementation(async () => {
      promptCallCount += 1
      if (promptCallCount === 1) {
        return {
          data: { info: { satisfied: true, criteria_results: planningPassCriteria() }, parts: [{ type: "text", text: JSON.stringify({
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
              { criterion: "User journey completeness", met: true, evidence: "mock", severity: "blocking" },
              { criterion: "[Q] Design excellence", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Architectural cohesion", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Vision alignment", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Completeness", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Readiness for execution", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Security standards", met: true, evidence: "mock", severity: "blocking", score: 9 },
              { criterion: "[Q] Operational excellence", met: true, evidence: "mock", severity: "blocking", score: 9 },
            ],
          }) }] },
        }
      }

      return {
        data: {
          parts: [{ type: "text", text: "not valid json" }],
        },
      }
    })

    const sid = `int-test-${Date.now()}-robot-auto-failure`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "robot-artisan" } } },
    })
    const ctx = { directory: tempDir, sessionId: sid, agent: "robot-artisan" }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "robot-auto-failure" },
      ctx,
    )
    await requestPlanningReview(ctx, "robot-auto-failure", "# Plan")
    promptCallCount = 0
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    const result = await plugin.tool.mark_satisfied.execute(
      {
        criteria_met: [
          { criterion: "All user requirements explicitly addressed", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Scope boundaries explicit", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Architecture described", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Error and failure cases specified", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "No TBD items", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Data model described", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Integration points identified", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "Deployment & infrastructure addressed", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "User journey completeness", met: true, evidence: "mock", severity: "blocking" },
          { criterion: "[Q] Design excellence", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Architectural cohesion", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Vision alignment", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Completeness", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Readiness for execution", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Security standards", met: true, evidence: "mock", severity: "blocking", score: "9" },
          { criterion: "[Q] Operational excellence", met: true, evidence: "mock", severity: "blocking", score: "9" },
        ],
      },
      ctx,
    )

    expect(result).toContain("Auto-approve rejected")
    expect(result).toContain("Transitioned to **PLANNING/REVISE**")

    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("PLANNING")
    expect(state.phaseState).toBe("REVISE")
    expect(state.reviewArtifactHash).toBeNull()
    expect(state.latestReviewResults).toBeNull()
    expect(state.feedbackHistory[state.feedbackHistory.length - 1]?.feedback).toContain("not valid json")
  })
})

// ---------------------------------------------------------------------------
// Multi-step workflow: MODE_SELECT → PLANNING/DRAFT → REVIEW → USER_GATE
// ---------------------------------------------------------------------------

describe("End-to-end: GREENFIELD happy path through PLANNING", () => {
  it("keeps REVIEW state when mark_satisfied omits required blocking criteria", async () => {
    const sid = `int-test-${Date.now()}-insufficient-review-criteria`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "insufficient-review-criteria" }, ctx)
    await requestPlanningReview(ctx, "insufficient-review-criteria")

    const result = await plugin.tool.mark_satisfied.execute({
      criteria_met: planningPassCriteria().slice(0, 2),
    }, ctx)
    await plugin.tool.mark_satisfied.execute({
      criteria_met: planningPassCriteria().slice(0, 2),
    }, ctx)

    expect(result).toContain("Error: Only 2 blocking criteria submitted")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("PLANNING")
    expect(state.phaseState).toBe("REVIEW")
    expect(state.toolFailureHistory[0]?.toolName).toBe("mark_satisfied")
    expect(state.toolFailureHistory[0]?.count).toBe(2)
    const summary = await plugin.tool.summarize_workflow_incident.execute({}, ctx)
    expect(summary).toContain("Repeated tool failures: 1")
    expect(summary).toContain("tooling/mark_satisfied x2")
  })

  it("keeps REVIEW state and records a tooling incident when isolated reviewer returns too few criteria", async () => {
    const sid = `int-test-${Date.now()}-reviewer-incomplete-criteria`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }
    const featureName = "reviewer-incomplete-criteria"

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    ;(client.session.prompt as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => ({
        data: { info: {
          satisfied: true,
          criteria_results: planningPassCriteria().slice(0, 2),
        } },
      }))
      .mockImplementationOnce(async () => ({
        data: { info: {
          satisfied: true,
          criteria_results: planningPassCriteria().slice(0, 2),
        } },
      }))

    const result = await plugin.tool.mark_satisfied.execute({ criteria_met: planningPassCriteria() }, ctx)

    expect(result).toContain("Error: Isolated reviewer failed")
    expect(result).toContain("Reviewer returned only 2 blocking criteria")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("PLANNING")
    expect(state.phaseState).toBe("REVIEW")
    expect(state.latestReviewResults?.[0]?.criterion).toBe("Isolated reviewer runtime failed")
    expect(state.toolFailureHistory[0]?.category).toBe("reviewer-infrastructure")
    expect(state.toolFailureHistory[0]?.toolName).toBe("mark_satisfied")
  })

  it("keeps REVIEW state and surfaces the error when isolated reviewer dispatch fails", async () => {
    const sid = `int-test-${Date.now()}-reviewer-error`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }
    const featureName = "reviewer-error-feature"

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    ;(client.session.prompt as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("reviewer runtime unavailable")
    })

    const result = await plugin.tool.mark_satisfied.execute({ criteria_met: planningPassCriteria() }, ctx)

    expect(result).toContain("Error: Isolated reviewer failed")
    expect(result).toContain("reviewer runtime unavailable")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("PLANNING")
    expect(state.phaseState).toBe("REVIEW")
    expect(state.latestReviewResults?.[0]?.criterion).toBe("Isolated reviewer runtime failed")
    expect(state.latestReviewResults?.[0]?.evidence).toContain("reviewer runtime unavailable")
  })

  it("blocks when isolated reviewer does not call the required submission tool", async () => {
    const sid = `int-test-${Date.now()}-reviewer-invalid-json-fallback`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }
    const featureName = "reviewer-invalid-json-fallback"

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    ;(client.session.prompt as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => ({ data: { parts: [{ type: "text", text: "**not json**" }] } }))
      .mockImplementationOnce(async () => ({ data: { parts: [{ type: "text", text: "**still not json**" }] } }))

    const result = await plugin.tool.mark_satisfied.execute({ criteria_met: planningPassCriteria() }, ctx)

    expect(result).toContain("Error: Isolated reviewer failed")
    expect(result).toContain("must call submit_phase_review_result")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("PLANNING")
    expect(state.phaseState).toBe("REVIEW")
    expect(state.latestReviewResults?.[0]?.criterion).toBe("Isolated reviewer runtime failed")
  })

  it("keeps REVIEW state when isolated reviewer times out", async () => {
    const sid = `int-test-${Date.now()}-reviewer-timeout-blocks`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }
    const featureName = "reviewer-timeout-blocks"

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    ;(client.session.prompt as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("timeout: self-review timed out after 300000ms")
    })

    const result = await plugin.tool.mark_satisfied.execute({ criteria_met: planningPassCriteria() }, ctx)

    expect(result).toContain("Error: Isolated reviewer failed")
    expect(result).toContain("timed out")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("PLANNING")
    expect(state.phaseState).toBe("REVIEW")
    expect(state.latestReviewResults?.[0]?.criterion).toBe("Isolated reviewer runtime failed")
  })

  it("select_mode → request_review → mark_satisfied → submit_feedback(approve)", async () => {
    const sid = `int-test-${Date.now()}-e2e`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // 1. Select GREENFIELD mode
    const featureName = "test-feature"
    const modeResult = await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    expect(modeResult).toContain("GREENFIELD")

    // 2. Now in PLANNING/DRAFT — call request_review
    const rrResult = await plugin.tool.request_review.execute(
      { summary: "The plan", artifact_description: "Plan for feature X", artifact_files: [await writePlanArtifact(featureName)] },
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
          { criterion: "User journey completeness", met: true, evidence: "Setup, onboarding, all modes covered", severity: "blocking" },
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

  it("approval advances with a skipped checkpoint warning in a non-git workspace", async () => {
    const sid = `int-test-${Date.now()}-non-git-checkpoint-approval`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }
    const featureName = "non-git-checkpoint-approval"

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    await plugin.tool.mark_satisfied.execute({ criteria_met: planningPassCriteria() }, ctx)
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "approved" }] },
    )

    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "approved", feedback_type: "approve" },
      ctx,
    )

    expect(result).not.toContain("Git checkpoint failed")
    expect(result.toLowerCase()).toContain("checkpoint")
    expect(result.toLowerCase()).toContain("skipped")
    const state = plugin._testStore.get(sid)
    expect(state.phase).toBe("INTERFACES")
  })
})

describe("bridge review protocol compatibility", () => {
  it("keeps submit_phase_review wired and criterion_id parseable for bridge reviewers", () => {
    expect(TOOL_HANDLERS.submit_phase_review).toBeFunction()

    const parsed = parseReviewResult(JSON.stringify({
      satisfied: true,
      criteria_results: [
        { criterion_id: "planning.scope-boundaries", criterion: "Scope boundaries display text", met: true, evidence: "ok", severity: "blocking" },
      ],
    }))

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.criteriaResults[0]?.criterionId).toBe("planning.scope-boundaries")
  })
})

// ---------------------------------------------------------------------------
// userGateMessageReceived — self-approval prevention (v8)
// ---------------------------------------------------------------------------

describe("userGateMessageReceived — blocks self-approval", () => {
  it("blocks submit_feedback(approve) when no user message text was provided", async () => {
    const sid = `int-test-${Date.now()}-selfapprove`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get to USER_GATE: GREENFIELD → PLANNING/DRAFT → request_review → mark_satisfied
    const featureName = "test-feature"
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    await plugin.tool.mark_satisfied.execute(
      { criteria_met: planningPassCriteria() },
      ctx,
    )

    // Attempt to approve WITHOUT sending a user message first
    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "", feedback_type: "approve" },
      ctx,
    )
    expect(result).toContain("Error: Waiting for user response")
    expect(result).toContain("you cannot self-approve")
  })

  it("allows explicit submit_feedback approval text even when chat.message did not mark the gate", async () => {
    const sid = `int-test-${Date.now()}-approve-text-no-hook`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "build" } } },
    })
    const ctx = { directory: tempDir, sessionId: sid, agent: "build" }

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "approve-text-no-hook" }, ctx)
    await requestPlanningReview(ctx, "approve-text-no-hook")
    await plugin.tool.mark_satisfied.execute(
      { criteria_met: planningPassCriteria() },
      ctx,
    )
    await plugin._testStore.update(sid, (draft: any) => {
      draft.userGateMessageReceived = false
    })

    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "approved", feedback_type: "approve" },
      ctx,
    )

    expect(result).not.toContain("Waiting for user response")
    expect(plugin._testStore.get(sid).phaseState).not.toBe("USER_GATE")
  })

  it("allows submit_feedback(approve) after user message is received", async () => {
    const sid = `int-test-${Date.now()}-userapprove`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get to USER_GATE
    const featureName = "test-feature"
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    await plugin.tool.mark_satisfied.execute(
      { criteria_met: planningPassCriteria() },
      ctx,
    )

    // Simulate a real user message via the chat.message hook
    await plugin["chat.message"](
      { sessionID: sid },
      { message: { sessionID: sid }, parts: [{ type: "text", text: "approved" }] },
    )

    // Now try to approve — should succeed (or fail for a different reason like phase)
    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "approved", feedback_type: "approve" },
      ctx,
    )
    // Should NOT contain the "no user message" error
    expect(result).not.toContain("no user message")
  })

  it("records the user gate response in memory before injecting submit_feedback routing", async () => {
    const sid = `int-test-${Date.now()}-gate-persist-before-inject`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin._testStore.update(sid, (draft: any) => {
      draft.mode = "GREENFIELD"
      draft.featureName = "gate-persist-before-inject"
      draft.phase = "DISCOVERY"
      draft.phaseState = "USER_GATE"
      draft.activeAgent = "artisan"
      draft.userGateMessageReceived = false
    })

    const output = {
      message: { sessionID: sid, id: "msg-gate-persist-before-inject" },
      parts: [{ type: "text", text: "approved" }],
    }
    await plugin["chat.message"]({ sessionID: sid, agent: "artisan" }, output)

    expect(plugin._testStore.get(sid).userGateMessageReceived).toBe(true)
    expect(output.parts[0]?.text).toContain("Call `submit_feedback` NOW")
  })

  it("does not call durable state update when injecting submit_feedback routing", async () => {
    const sid = `int-test-${Date.now()}-gate-persist-fails`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid, agent: "artisan" } } },
    })
    await plugin._testStore.update(sid, (draft: any) => {
      draft.mode = "GREENFIELD"
      draft.featureName = "gate-persist-fails"
      draft.phase = "DISCOVERY"
      draft.phaseState = "USER_GATE"
      draft.activeAgent = "artisan"
      draft.userGateMessageReceived = false
    })

    const originalUpdate = plugin._testStore.update.bind(plugin._testStore)
    let updateCalled = false
    plugin._testStore.update = async () => {
      updateCalled = true
      throw new Error("chat hook should not durably update gate state")
    }

    const output = {
      message: { sessionID: sid, id: "msg-gate-persist-fails" },
      parts: [{ type: "text", text: "approved" }],
    }
    try {
      await plugin["chat.message"]({ sessionID: sid, agent: "artisan" }, output)
    } finally {
      plugin._testStore.update = originalUpdate
    }

    expect(updateCalled).toBe(false)
    expect(plugin._testStore.get(sid).userGateMessageReceived).toBe(true)
    expect(output.parts[0]?.text).toContain("Call `submit_feedback` NOW")
  })

  it("submit_feedback(revise) is NOT blocked by userGateMessageReceived", async () => {
    const sid = `int-test-${Date.now()}-revise-ok`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    // Get to USER_GATE
    const featureName = "test-feature"
    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: featureName }, ctx)
    await requestPlanningReview(ctx, featureName)
    await plugin.tool.mark_satisfied.execute(
      { criteria_met: planningPassCriteria() },
      ctx,
    )

    await plugin._testStore.update(sid, (draft: any) => {
      draft.reviewArtifactHash = "stale-review-hash"
      draft.latestReviewResults = [{ criterion: "Old", met: false, evidence: "stale" }]
    })

    // Attempt to revise WITHOUT sending a user message first — should still work
    // (revise isn't blocked by the user gate flag, only approve is)
    const result = await plugin.tool.submit_feedback.execute(
      { feedback_text: "needs more detail on auth", feedback_type: "revise" },
      ctx,
    )
    // Should not contain the "no user message" error
    expect(result).not.toContain("no user message")

    const updated = plugin._testStore.get(sid)
    expect(updated.reviewArtifactHash).toBeNull()
    expect(updated.latestReviewResults).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// currentTaskId clearing on mark_task_complete
// ---------------------------------------------------------------------------

describe("mark_task_complete — phase gating and final-task cleanup", () => {
  it("returns a phase error when mark_task_complete is called before IMPLEMENTATION", async () => {
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

  it("clears taskCompletionInProgress before clearing currentTaskId for the final task", async () => {
    const sid = `int-test-${Date.now()}-final-task-complete`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute({ mode: "GREENFIELD", feature_name: "final-task-test" }, ctx)

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.implDag = [
        {
          id: "T1",
          description: "Final task",
          dependencies: [],
          expectedTests: [],
          expectedFiles: [],
          estimatedComplexity: "small",
          status: "in-flight",
        },
      ]
      draft.currentTaskId = "T1"
      draft.taskReviewCount = 9
      draft.taskCompletionInProgress = null
    })

    ;(client.session.prompt as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
      data: {
        info: { passed: true, issues: [], scores: { code_quality: 9, error_handling: 9 }, reasoning: "Task passes." },
        parts: [{
          type: "text",
          text: JSON.stringify({ passed: true, issues: [], scores: { code_quality: 9, error_handling: 9 }, reasoning: "Task passes." }),
        }],
      },
    }))

    const result = await plugin.tool.mark_task_complete.execute(
      { task_id: "T1", implementation_summary: "done", tests_passing: true },
      ctx,
    )

    expect(result).toContain("All DAG tasks complete")
    const updated = store.get(sid)
    expect(updated?.implDag?.[0]?.status).toBe("complete")
    expect(updated?.currentTaskId).toBeNull()
    expect(updated?.taskCompletionInProgress).toBeNull()
    expect(updated?.taskReviewCount).toBe(0)
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
      draft.feedbackHistory = [{ phase: "PLANNING", feedback: "old feedback", timestamp: Date.now() }]
      // escapePending cannot be true at DONE (validator requires ESCAPE_HATCH phaseState)
      // so we set it to false and verify it stays false after reset
      draft.escapePending = false
      draft.pendingFeedback = "stale feedback"
      draft.revisionBaseline = { type: "content-hash", hash: "abc123" }
      draft.userGateMessageReceived = false
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
  it("does not queue a same-session prompt while request_review is still executing", async () => {
    const sid = `int-test-${Date.now()}-review-reprompt`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "review-reprompt" },
      ctx,
    )
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()
    const planPath = await writePlanArtifact("review-reprompt", "Plan v1")

    const result = await plugin.tool.request_review.execute(
      { summary: "Plan", artifact_description: "Plan doc", artifact_files: [planPath] },
      ctx,
    )

    expect(result).not.toContain("Error")
    expect(client.session.prompt).not.toHaveBeenCalled()

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(plugin._testStore.get(sid)?.retryCount).toBe(1)
  })

  it("allows request_review at REVIEW state with artifact_files", async () => {
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
    const planPath = await writePlanArtifact("resubmit-test", "Old plan content")
    const rrResult = await plugin.tool.request_review.execute(
      { summary: "Initial plan", artifact_description: "Plan v1", artifact_files: [planPath] },
      ctx,
    )
    expect(rrResult).not.toContain("Error")

    // Now in REVIEW — re-submit with updated content
    await Bun.write(planPath, "New comprehensive 200-line plan")
    const resubmitResult = await plugin.tool.request_review.execute(
      { summary: "Updated plan", artifact_description: "Plan v2", artifact_files: [planPath] },
      ctx,
    )
    expect(resubmitResult).not.toContain("Error")
    expect(resubmitResult).toContain("re-submitted")
    expect(resubmitResult).toContain("in-place revision")

    // State should still be in REVIEW
    const store = plugin._testStore
    const state = store.get(sid)
    expect(state.phaseState).toBe("REVIEW")
    expect(state.iterationCount).toBe(0)
  })

  it("allows PLANNING request_review with artifact_files only", async () => {
    const sid = `int-test-${Date.now()}-review-artifact-files`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "review-artifact-files" },
      ctx,
    )

    const planPath = join(tempDir, ".openartisan", "review-artifact-files", "plan.md")
    mkdirSync(join(tempDir, ".openartisan", "review-artifact-files"), { recursive: true })
    await Bun.write(planPath, withRealWorldAcceptanceScenario("# Plan\n\nUse file references for review."))

    const result = await plugin.tool.request_review.execute(
      {
        summary: "Plan ready",
        artifact_description: "Plan doc",
        artifact_files: [planPath],
      },
      ctx,
    )

    expect(result).not.toContain("Error")
    const state = plugin._testStore.get(sid)
    expect(state.phaseState).toBe("REVIEW")
    expect(state.artifactDiskPaths.plan).toBe(planPath)
    expect(state.reviewArtifactHash).not.toBeNull()
  })

  it("PLANNING request_review persists realWorldAcceptanceScenario from the planning artifact", async () => {
    const sid = `int-test-${Date.now()}-planning-scenario-capture`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "planning-scenario-capture" },
      ctx,
    )

    const planPath = await writePlanArtifact("planning-scenario-capture", `# Plan

${VALID_REAL_WORLD_ACCEPTANCE_SCENARIO}`)
    const result = await plugin.tool.request_review.execute(
      {
        summary: "Plan ready",
        artifact_description: "Plan doc with real-world scenario",
        artifact_files: [planPath],
      },
      ctx,
    )

    expect(result).not.toContain("Error")
    const state = plugin._testStore.get(sid)
    expect(state.phaseState).toBe("REVIEW")
    expect(state.realWorldAcceptanceScenario).toMatchObject({
      scenario: "A maintainer needs the workflow to preserve the user's motivating use case across reviews and compaction.",
      requiredCapabilities: [
        "Capture the scenario from the planning artifact",
        "Carry the scenario into downstream review prompts",
      ],
      acceptanceChecks: [
        "Later artifacts are evaluated against the captured scenario",
        "Scope drift is surfaced before implementation",
      ],
      explicitNonGoals: ["Do not infer scenarios from arbitrary chat"],
      sourceArtifactPath: planPath,
      capturedAtPhase: "PLANNING",
    })
  })

  it("PLANNING request_review rejects a planning artifact without ## Real-World Acceptance Scenario", async () => {
    const sid = `int-test-${Date.now()}-planning-scenario-missing`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "planning-scenario-missing" },
      ctx,
    )

    const planPath = planArtifactPath("planning-scenario-missing")
    mkdirSync(join(tempDir, ".openartisan", "planning-scenario-missing"), { recursive: true })
    await Bun.write(planPath, "# Plan\n\nNo scenario section here.")

    const result = await plugin.tool.request_review.execute(
      {
        summary: "Plan ready",
        artifact_description: "Plan doc without scenario",
        artifact_files: [planPath],
      },
      ctx,
    )

    expect(result).toContain("Error")
    expect(result).toContain("## Real-World Acceptance Scenario")
    const state = plugin._testStore.get(sid)
    expect(state.phaseState).toBe("DRAFT")
    expect(state.realWorldAcceptanceScenario).toBeNull()
  })

  it("rejects request_review with artifact_markdown", async () => {
    const sid = `int-test-${Date.now()}-review-files-and-markdown`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "review-files-and-markdown" },
      ctx,
    )

    const planPath = join(tempDir, ".openartisan", "review-files-and-markdown", "plan.md")
    mkdirSync(join(tempDir, ".openartisan", "review-files-and-markdown"), { recursive: true })
    await Bun.write(planPath, withRealWorldAcceptanceScenario("# Plan\n\nOriginal on-disk plan."))

    const result = await plugin.tool.request_review.execute(
      {
        summary: "Plan ready",
        artifact_description: "Plan doc",
        artifact_files: [planPath],
        artifact_markdown: "# Placeholder\n",
      },
      ctx,
    )

    expect(result).toContain("Error")
    expect(result).toContain("artifact_markdown")
    expect(await Bun.file(planPath).text()).toContain("Original on-disk plan")
  })

  it("resolves relative artifact_files before persisting artifact disk paths", async () => {
    const sid = `int-test-${Date.now()}-review-relative-artifact-files`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "review-relative-artifact-files" },
      ctx,
    )

    const relativePlanPath = join(".openartisan", "review-relative-artifact-files", "plan.md")
    const absolutePlanPath = join(tempDir, relativePlanPath)
    mkdirSync(join(tempDir, ".openartisan", "review-relative-artifact-files"), { recursive: true })
    await Bun.write(absolutePlanPath, withRealWorldAcceptanceScenario("# Plan\n\nUse relative file references for review."))

    const result = await plugin.tool.request_review.execute(
      {
        summary: "Plan ready",
        artifact_description: "Plan doc",
        artifact_files: [relativePlanPath],
      },
      ctx,
    )

    expect(result).not.toContain("Error")
    const state = plugin._testStore.get(sid)
    expect(state.phaseState).toBe("REVIEW")
    expect(state.artifactDiskPaths.plan).toBe(absolutePlanPath)
    expect(state.reviewArtifactFiles).toContain(absolutePlanPath)
    expect(state.reviewArtifactHash).not.toBeNull()
  })

  it("classifies unchanged REVIEW resubmission and preserves iteration count", async () => {
    const sid = `int-test-${Date.now()}-resubmit-unchanged`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "resubmit-unchanged-test" },
      ctx,
    )
    const planPath = await writePlanArtifact("resubmit-unchanged-test", "Stable plan content")
    await plugin.tool.request_review.execute(
      { summary: "Initial plan", artifact_description: "Plan v1", artifact_files: [planPath] },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.iterationCount = 2
    })

    const resubmitResult = await plugin.tool.request_review.execute(
      { summary: "Same plan", artifact_description: "Plan v1", artifact_files: [planPath] },
      ctx,
    )

    expect(resubmitResult).toContain("unchanged resubmission")
    expect(resubmitResult).toContain("review iteration 2/")

    const state = store.get(sid)
    expect(state.phaseState).toBe("REVIEW")
    expect(state.iterationCount).toBe(2)
  })

  it("does not queue a same-session prompt during REVIEW resubmission", async () => {
    const sid = `int-test-${Date.now()}-review-resubmit-reprompt`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "review-resubmit-reprompt" },
      ctx,
    )
    const planPath = await writePlanArtifact("review-resubmit-reprompt", "Plan v1")
    await plugin.tool.request_review.execute(
      { summary: "Plan", artifact_description: "Plan doc", artifact_files: [planPath] },
      ctx,
    )
    ;(client.session.prompt as ReturnType<typeof mock>).mockClear()

    await Bun.write(planPath, withRealWorldAcceptanceScenario("Plan v2"))
    const result = await plugin.tool.request_review.execute(
      { summary: "Plan", artifact_description: "Plan doc", artifact_files: [planPath] },
      ctx,
    )

    expect(result).toContain("re-submitted")
    expect(client.session.prompt).not.toHaveBeenCalled()

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(plugin._testStore.get(sid)?.retryCount).toBe(1)
  })

  it("clears stale latestReviewResults on request_review resubmission", async () => {
    const sid = `int-test-${Date.now()}-clear-review-results`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "clear-review-results-test" },
      ctx,
    )
    const planPath = await writePlanArtifact("clear-review-results-test", "Plan v1")
    await plugin.tool.request_review.execute(
      { summary: "Initial plan", artifact_description: "Plan", artifact_files: [planPath] },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.latestReviewResults = [{ criterion: "Old", met: false, evidence: "stale" }]
    })

    await Bun.write(planPath, withRealWorldAcceptanceScenario("Plan v2"))
    await plugin.tool.request_review.execute(
      { summary: "Updated plan", artifact_description: "Plan", artifact_files: [planPath] },
      ctx,
    )

    const state = store.get(sid)
    expect(state.latestReviewResults).toBeNull()
  })

  it("checks current reviewArtifactFiles instead of stale phase artifact path", async () => {
    const sid = `int-test-${Date.now()}-review-files-hash`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "review-files-hash" },
      ctx,
    )

    const featureDir = join(tempDir, ".openartisan", "review-files-hash")
    mkdirSync(featureDir, { recursive: true })
    const staleMirrorPath = join(featureDir, "tests.md")
    const typeTestPath = join(tempDir, "test", "unit", "aspects-types.test.ts")
    const runtimeTestPath = join(tempDir, "test", "unit", "aspects.test.ts")
    mkdirSync(join(tempDir, "test", "unit"), { recursive: true })
    await Bun.write(staleMirrorPath, "stale legacy tests mirror")
    await Bun.write(typeTestPath, "import { describe, it } from 'bun:test'; describe('types', () => { it('works', () => {}); });")
    await Bun.write(runtimeTestPath, "import { describe, it } from 'bun:test'; describe('runtime', () => { it('works', () => {}); });")

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "TESTS"
      draft.phaseState = "REVIEW"
      draft.artifactDiskPaths.tests = staleMirrorPath
      draft.reviewArtifactHash = "stale-review-hash"
      draft.reviewArtifactFiles = [staleMirrorPath]
    })

    const resubmitResult = await plugin.tool.request_review.execute(
      {
        summary: "Tests ready",
        artifact_description: "Real test files",
        artifact_files: [typeTestPath, runtimeTestPath],
      },
      ctx,
    )
    expect(resubmitResult).not.toContain("Error")

    const result = await plugin.tool.mark_satisfied.execute(
      { criteria_met: planningPassCriteria() },
      ctx,
    )

    expect(result).not.toContain("Artifact has changed")
  })

  it("rejects request_review at REVIEW state without artifact_files", async () => {
    const sid = `int-test-${Date.now()}-resubmit-no-content`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "resubmit-no-content" },
      ctx,
    )
    const planPath = await writePlanArtifact("resubmit-no-content", "Content")
    await plugin.tool.request_review.execute(
      { summary: "Plan", artifact_description: "Plan", artifact_files: [planPath] },
      ctx,
    )

    // Re-submit without artifact_files — should error
    const result = await plugin.tool.request_review.execute(
      { summary: "Updated plan", artifact_description: "Plan v2" },
      ctx,
    )
    expect(result).toContain("Error")
    expect(result).toContain("artifact_files")
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
      { summary: "Plan", artifact_description: "Plan", artifact_files: [await writePlanArtifact("block-at-usergate")] },
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
      draft.userGateMessageReceived = false
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

  it("derives INCREMENTAL allowlist from planning artifact when approved_files is omitted", async () => {
    const sid = `int-test-${Date.now()}-allowlist-derived`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "allowlist-derived-test" },
      ctx,
    )

    const store = plugin._testStore
    const planPath = `${tempDir}/.openartisan/allowlist-derived-test/plan.md`
    await Bun.write(planPath, withRealWorldAcceptanceScenario("# Planning\n\n## Narrow allowlist\n- src/a.ts\n- tests/a.test.ts\n"))
    await store.update(sid, (draft: any) => {
      draft.phase = "PLANNING"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = false
      draft.artifactDiskPaths.plan = planPath
    })

    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
      },
      ctx,
    )

    expect(result).not.toContain("Error")
    const state = store.get(sid)
    expect(state.fileAllowlist).toContain(`${tempDir}/src/a.ts`)
    expect(state.fileAllowlist).toContain(`${tempDir}/tests/a.test.ts`)
  })

  it("rejects INCREMENTAL planning approval without an allowlist source", async () => {
    const sid = `int-test-${Date.now()}-allowlist-missing`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "allowlist-missing-test" },
      ctx,
    )

    const store = plugin._testStore
    const planPath = `${tempDir}/.openartisan/allowlist-missing-test/plan.md`
    await Bun.write(planPath, withRealWorldAcceptanceScenario("# Planning\n\nNo allowlist here.\n"))
    await store.update(sid, (draft: any) => {
      draft.phase = "PLANNING"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = false
      draft.artifactDiskPaths.plan = planPath
    })

    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
      },
      ctx,
    )

    expect(result).toContain("INCREMENTAL planning approval requires an explicit file allowlist source")
  })

  it("derives missing INCREMENTAL allowlist from the approved plan at IMPL_PLAN approval time", async () => {
    const sid = `int-test-${Date.now()}-impl-allowlist-recovery`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "impl-allowlist-recovery-test" },
      ctx,
    )

    const store = plugin._testStore
    const planPath = `${tempDir}/.openartisan/impl-allowlist-recovery-test/plan.md`
    await Bun.write(planPath, withRealWorldAcceptanceScenario("# Planning\n\n## Narrow allowlist\n- src/allowed.ts\n- tests/allowed.test.ts\n"))
    await store.update(sid, (draft: any) => {
      draft.phase = "IMPL_PLAN"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
      draft.artifactDiskPaths.plan = planPath
      draft.fileAllowlist = []
    })

    const implPlan = `# Implementation Plan

## Task T1: In-scope work
**Dependencies:** none
**Files:** src/allowed.ts
**Expected tests:** tests/allowed.test.ts
**Complexity:** medium
`
    const implPlanPath = await writeImplPlanArtifact("impl-allowlist-recovery-test", implPlan)
    await store.update(sid, (draft: any) => {
      draft.artifactDiskPaths.impl_plan = implPlanPath
    })

    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
      },
      ctx,
    )

    expect(result).not.toContain("IMPL_PLAN approval failed executable-contract validation")
    expect(result).toContain("workflow will advance")
    const state = store.get(sid)
    expect(state.fileAllowlist).toContain(`${tempDir}/src/allowed.ts`)
    expect(state.fileAllowlist).toContain(`${tempDir}/tests/allowed.test.ts`)
  })

  it("rejects invalid IMPL_PLAN approval before mutating approval state", async () => {
    const sid = `int-test-${Date.now()}-impl-prevalidation`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "impl-prevalidation-test" },
      ctx,
    )

    const store = plugin._testStore
    const implPlanPath = await writeImplPlanArtifact("impl-prevalidation-test", `# Implementation Plan

## Task T1: Out-of-scope work
**Dependencies:** none
**Files:** src/outside.ts
**Expected tests:** tests/outside.test.ts
**Complexity:** medium
`)
    await store.update(sid, (draft: any) => {
      draft.phase = "IMPL_PLAN"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
      draft.fileAllowlist = [`${tempDir}/src/allowed.ts`]
      draft.artifactDiskPaths.impl_plan = implPlanPath
      draft.approvalCount = 3
    })

    const result = await plugin.tool.submit_feedback.execute(
      { feedback_type: "approve", feedback_text: "approved" },
      ctx,
    )

    expect(result).toContain("IMPL_PLAN approval failed executable-contract validation")
    const state = store.get(sid)
    expect(state.phase).toBe("IMPL_PLAN")
    expect(state.phaseState).toBe("USER_GATE")
    expect(state.userGateMessageReceived).toBe(true)
    expect(state.approvalCount).toBe(3)
    expect(state.implDag).toBeNull()
  })

  it("dry-runs IMPL_PLAN approval validation without mutating workflow state", async () => {
    const sid = `int-test-${Date.now()}-impl-dry-run`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "impl-dry-run-test" },
      ctx,
    )

    const store = plugin._testStore
    const implPlanPath = await writeImplPlanArtifact("impl-dry-run-test", `# Implementation Plan

## Task T1: In-scope work
**Dependencies:** none
**Files:** src/allowed.ts
**Expected tests:** tests/allowed.test.ts
**Complexity:** medium
`)
    await store.update(sid, (draft: any) => {
      draft.phase = "IMPL_PLAN"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = false
      draft.fileAllowlist = [`${tempDir}/src/allowed.ts`, `${tempDir}/tests/allowed.test.ts`]
      draft.artifactDiskPaths.impl_plan = implPlanPath
      draft.approvalCount = 3
    })

    const result = await plugin.tool.submit_feedback.execute(
      { feedback_type: "approve", feedback_text: "approved", dry_run: true },
      ctx,
    )

    expect(result).toContain("Dry-run approval validation passed")
    const state = store.get(sid)
    expect(state.phase).toBe("IMPL_PLAN")
    expect(state.phaseState).toBe("USER_GATE")
    expect(state.userGateMessageReceived).toBe(false)
    expect(state.approvalCount).toBe(3)
    expect(state.implDag).toBeNull()
  })

  it("dry-runs human-gate approval without resolving gates", async () => {
    const sid = `int-test-${Date.now()}-human-gate-dry-run`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "human-gate-dry-run-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
      draft.implDag = [
        {
          id: "T1",
          description: "External setup",
          dependencies: [],
          expectedFiles: [],
          expectedTests: [],
          estimatedComplexity: "small",
          status: "human-gated",
          humanGate: { whatIsNeeded: "Configure credentials", why: "Needed", verificationSteps: "Check env", resolved: false },
        },
      ]
    })

    const result = await plugin.tool.submit_feedback.execute(
      { feedback_type: "approve", feedback_text: "approved", resolved_human_gates: ["T1"], dry_run: true },
      ctx,
    )

    expect(result).toContain("Dry-run human-gate validation passed")
    const state = store.get(sid)
    expect(state.phase).toBe("IMPLEMENTATION")
    expect(state.phaseState).toBe("USER_GATE")
    expect(state.implDag[0].status).toBe("human-gated")
    expect(state.implDag[0].humanGate.resolved).toBe(false)
  })

  it("approves IMPL_PLAN when task files and tests are markdown-wrapped but in scope", async () => {
    const sid = `int-test-${Date.now()}-impl-backticks`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "impl-backticks-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "IMPL_PLAN"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
      draft.fileAllowlist = [`${tempDir}/src/allowed.ts`, `${tempDir}/tests/allowed.test.ts`]
    })

    const implPlan = `# Implementation Plan

## Task T1: In-scope work
**Dependencies:** none
**Files:** \0src/allowed.ts\0
**Expected tests:** \0tests/allowed.test.ts\0
**Complexity:** medium
`.replaceAll("\u00060", "`")
    const implPlanPath = await writeImplPlanArtifact("impl-backticks-test", implPlan)
    await store.update(sid, (draft: any) => {
      draft.artifactDiskPaths.impl_plan = implPlanPath
    })

    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
      },
      ctx,
    )

    expect(result).not.toContain("outside the approved INCREMENTAL allowlist")
  })

  it("rejects TESTS approval when reviewed artifact files fall outside the approved allowlist", async () => {
    const sid = `int-test-${Date.now()}-tests-allowlist-check`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "tests-allowlist-check-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "TESTS"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
      draft.fileAllowlist = [`${tempDir}/tests/allowed.test.ts`]
      draft.reviewArtifactFiles = ["tests/out-of-scope.test.ts"]
    })

    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
      },
      ctx,
    )

    expect(result).toContain("TESTS approval failed allowlist validation")
    expect(result).toContain(`${tempDir}/tests/out-of-scope.test.ts`)
  })

  it("derives missing INCREMENTAL allowlist from approved plan for TESTS approval", async () => {
    const sid = `int-test-${Date.now()}-tests-allowlist-recovery`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "tests-allowlist-recovery-test" },
      ctx,
    )

    const store = plugin._testStore
    const planPath = `${tempDir}/.openartisan/tests-allowlist-recovery-test/plan.md`
    await Bun.write(planPath, withRealWorldAcceptanceScenario("# Planning\n\n## Narrow allowlist\n- tests/in-scope.test.ts\n"))
    await store.update(sid, (draft: any) => {
      draft.phase = "TESTS"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
      draft.artifactDiskPaths.plan = planPath
      draft.fileAllowlist = []
      draft.reviewArtifactFiles = ["tests/in-scope.test.ts"]
    })

    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
      },
      ctx,
    )

    expect(result).not.toContain("approval failed allowlist validation")
    const state = store.get(sid)
    expect(state.fileAllowlist).toContain(`${tempDir}/tests/in-scope.test.ts`)
  })

  it("ignores saved artifact disk paths when validating TESTS approval allowlist scope", async () => {
    const sid = `int-test-${Date.now()}-tests-artifact-path`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "INCREMENTAL", feature_name: "tests-artifact-path-test" },
      ctx,
    )

    const store = plugin._testStore
    const artifactPath = `${tempDir}/.openartisan/tests-artifact-path-test/tests.md`
    await store.update(sid, (draft: any) => {
      draft.phase = "TESTS"
      draft.phaseState = "USER_GATE"
      draft.userGateMessageReceived = true
      draft.fileAllowlist = [`${tempDir}/tests/in-scope.test.ts`]
      draft.artifactDiskPaths.tests = artifactPath
      draft.reviewArtifactFiles = [artifactPath]
    })

    const result = await plugin.tool.submit_feedback.execute(
      {
        feedback_type: "approve",
        feedback_text: "approved",
      },
      ctx,
    )

    expect(result).not.toContain("approval failed allowlist validation")
  })

  it("dispatches the next ready task when work remains after a human gate", async () => {
    const sid = `int-test-${Date.now()}-human-gate-dispatch`
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: sid } } },
    })
    const ctx = { directory: tempDir, sessionId: sid }

    await plugin.tool.select_mode.execute(
      { mode: "GREENFIELD", feature_name: "human-gate-dispatch-test" },
      ctx,
    )

    const store = plugin._testStore
    await store.update(sid, (draft: any) => {
      draft.phase = "IMPLEMENTATION"
      draft.phaseState = "DRAFT"
      draft.implDag = [
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

    const result = await plugin.tool.resolve_human_gate.execute(
      {
        task_id: "T1",
        what_is_needed: "Human approval",
        why: "Needed",
        verification_steps: "Verify",
      },
      ctx,
    )

    expect(result).toContain("Next task ready")
    expect(result).toContain("T2")
    const state = store.get(sid)
    expect(state.currentTaskId).toBe("T2")
    expect(state.phaseState).toBe("DRAFT")
    expect(state.implDag?.find((task: TaskNode) => task.id === "T2")?.status).toBe("in-flight")
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
