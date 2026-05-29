import { describe, expect, it } from "bun:test"

import {
  buildChangeProposalNextAction,
  buildChangeProposalReviewPrompt,
  dispatchChangeProposalReview,
  parseChangeProposalReviewResult,
} from "#core/change-proposal"
import type { SubagentDispatcher, SubagentPromptOptions } from "#core/subagent-dispatcher"
import { makeWorkflowState } from "./helpers/workflow-state"

const state = makeWorkflowState({
  mode: "INCREMENTAL",
  phase: "IMPLEMENTATION",
  phaseState: "REVISE",
  featureName: "scenario-sufficiency-gates",
  currentTaskId: "T5",
  fileAllowlist: ["packages/core/workflow-state-types.ts"],
  implDag: [{
    id: "T5",
    description: "Run final verification and fix approved fallout",
    dependencies: [],
    expectedTests: ["tests/scenario-sufficiency.test.ts"],
    expectedFiles: ["packages/core/workflow-state-types.ts"],
    estimatedComplexity: "small",
    status: "in-flight",
  }],
})

describe("change proposal review", () => {
  it("builds a reviewer prompt with allowlist and route context", () => {
    const prompt = buildChangeProposalReviewPrompt({
      state,
      cwd: "/repo",
      proposal: {
        summary: "Typecheck fixture fallout",
        why_needed: "A WorkflowState fixture lacks a newly required nullable field.",
        affected_files: ["tests/revision-baseline.test.ts"],
        failing_command: "bun run typecheck",
      },
    })

    expect(prompt).toContain("You are an isolated Open Artisan change-proposal reviewer")
    expect(prompt).toContain("Affected files outside allowlist: tests/revision-baseline.test.ts")
    expect(prompt).toContain("planning-allowlist-revision")
    expect(prompt).toContain("task-boundary-change")
    expect(prompt).toContain("reject-out-of-scope")
    expect(prompt).toContain("stale generated output")
    expect(prompt).toContain("Do not choose backtrack unless an approved artifact is actually wrong")
  })

  it("guides implementation allowlist revisions through request_allowlist_expansion instead of backtrack", () => {
    const nextAction = buildChangeProposalNextAction({
      state,
      proposal: {
        summary: "Stale build lock cleanup",
        why_needed: "A timed-out reviewer left build/tmp/build-packages.lock behind.",
        affected_files: ["build/tmp/build-packages.lock", "scripts/build-packages.ts"],
      },
      decision: {
        approved: true,
        route: "planning-allowlist-revision",
        confidence: "high",
        reason: "The cleanup is valid fallout but outside the current allowlist.",
        required_actions: [],
        allowed_files: ["build/tmp/build-packages.lock", "scripts/build-packages.ts"],
        rejected_files: [],
      },
    })

    expect(nextAction).toContain("request_allowlist_expansion")
    expect(nextAction).toContain("Do not call propose_backtrack")
  })

  it("guides TESTS allowlist revisions through request_allowlist_expansion instead of planning backtrack", () => {
    const nextAction = buildChangeProposalNextAction({
      state: makeWorkflowState({
        mode: "INCREMENTAL",
        phase: "TESTS",
        phaseState: "REVISE",
        fileAllowlist: ["/repo/tests/existing.test.ts"],
      }),
      proposal: {
        summary: "Reviewer required planned composition tests",
        why_needed: "TESTS review found the approved plan needs a platform composition test file.",
        affected_files: ["/repo/test/factories/ory/platform-composition.test.ts"],
      },
      decision: {
        approved: true,
        route: "planning-allowlist-revision",
        confidence: "high",
        reason: "The file is valid fallout but outside the current allowlist.",
        required_actions: [],
        allowed_files: ["/repo/test/factories/ory/platform-composition.test.ts"],
        rejected_files: [],
      },
    })

    expect(nextAction).toContain("request_allowlist_expansion")
    expect(nextAction).toContain("current review/approval path")
    expect(nextAction).toContain("Do not call propose_backtrack")
  })

  it("parses a valid reviewer routing decision", () => {
    const result = parseChangeProposalReviewResult([
      "```json",
      "{",
      "  \"approved\": true,",
      "  \"route\": \"planning-allowlist-revision\",",
      "  \"confidence\": \"high\",",
      "  \"reason\": \"The file is valid fallout but outside the incremental allowlist.\",",
      "  \"required_actions\": [\"Revise PLANNING allowlist first.\"],",
      "  \"allowed_files\": [],",
      "  \"rejected_files\": []",
      "}",
      "```",
    ].join("\n"))

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.decision.route).toBe("planning-allowlist-revision")
      expect(result.decision.approved).toBe(true)
    }
  })

  it("parses structured subagent response parts", () => {
    const result = parseChangeProposalReviewResult({
      data: {
        parts: [{
          type: "text",
          text: JSON.stringify({
            approved: true,
            route: "planning-allowlist-revision",
            confidence: "high",
            reason: "The file is valid fallout but outside the incremental allowlist.",
            required_actions: ["Approve the typed allowlist expansion."],
            allowed_files: ["/repo/src/new.ts"],
            rejected_files: [],
          }),
        }],
      },
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.decision.allowed_files).toEqual(["/repo/src/new.ts"])
  })

  it("parses nested message parts from raw prompt envelopes", () => {
    const result = parseChangeProposalReviewResult({
      data: {
        message: {
          parts: [{
            type: "text",
            text: JSON.stringify({
              approved: true,
              route: "task-boundary-change",
              confidence: "medium",
              reason: "The file belongs to a neighboring task boundary.",
              required_actions: ["Analyze and apply the task boundary change."],
              allowed_files: ["/repo/src/boundary.ts"],
              rejected_files: [],
            }),
          }],
        },
      },
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.decision.route).toBe("task-boundary-change")
  })

  it("fails metadata-only prompt envelopes with an extraction diagnostic", () => {
    const result = parseChangeProposalReviewResult({
      data: {
        info: { id: "msg-1", role: "assistant" },
      },
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("Cannot extract text from Change Proposal Review result")
  })

  it("rejects an unknown reviewer route", () => {
    const result = parseChangeProposalReviewResult(JSON.stringify({
      approved: true,
      route: "edit-anyway",
      confidence: "high",
      reason: "Nope",
      required_actions: [],
      allowed_files: [],
      rejected_files: [],
    }))

    expect(result.success).toBe(false)
  })

  it("dispatches an isolated reviewer with JSON schema output", async () => {
    let capturedPrompt = ""
    let capturedOptions: SubagentPromptOptions | undefined
    let destroyed = false
    const dispatcher: SubagentDispatcher = {
      async createSession(opts) {
        expect(opts.agent).toBe("workflow-reviewer")
        expect(opts.title).toBe("Change Proposal Review")
        return {
          id: "review-session",
          async prompt(text, options) {
            capturedPrompt = text
            capturedOptions = options
            return JSON.stringify({
              approved: true,
              route: "planning-allowlist-revision",
              confidence: "high",
              reason: "The fixture edit is valid fallout but needs allowlist approval.",
              required_actions: ["Revise PLANNING allowlist."],
              allowed_files: [],
              rejected_files: [],
            })
          },
          async destroy() {
            destroyed = true
          },
        }
      },
    }

    const result = await dispatchChangeProposalReview(dispatcher, {
      state,
      cwd: "/repo",
      proposal: {
        summary: "Typecheck fixture fallout",
        why_needed: "A WorkflowState fixture lacks a newly required nullable field.",
        affected_files: ["tests/revision-baseline.test.ts"],
      },
    })

    expect(result.success).toBe(true)
    expect(capturedPrompt).toContain("Typecheck fixture fallout")
    expect(capturedOptions?.submissionTool?.name).toBe("submit_change_proposal_review_result")
    expect(capturedOptions?.responseFormat?.type).toBe("json_schema")
    expect(destroyed).toBe(true)
  })
})
