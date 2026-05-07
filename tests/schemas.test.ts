import { describe, expect, it } from "bun:test"

import {
  AnalyzeTaskBoundaryChangeSchema,
  RequestReviewToolSchema,
  RoadmapDeriveExecutionSliceToolSchema,
  RoadmapQueryToolSchema,
  SubmitPhaseReviewToolSchema,
  toJsonSchema,
} from "#core/schemas"

describe("shared tool schemas", () => {
  it("allows request_review markdown materialization with an empty artifact file list", () => {
    const parsed = RequestReviewToolSchema.safeParse({
      summary: "Conventions",
      artifact_description: "Conventions doc",
      artifact_files: [],
      artifact_markdown: "# Conventions\n",
    })

    expect(parsed.success).toBe(true)
  })

  it("still rejects request_review calls that provide no review source", () => {
    const parsed = RequestReviewToolSchema.safeParse({
      summary: "Plan",
      artifact_description: "Plan doc",
      artifact_files: [],
    })

    expect(parsed.success).toBe(false)
  })

  it("keeps artifact_files required in generated request_review JSON schema", () => {
    const schema = toJsonSchema(RequestReviewToolSchema) as {
      required?: string[]
      properties?: { artifact_files?: { minItems?: number } }
    }

    expect(schema.required).toContain("artifact_files")
    expect(schema.properties?.artifact_files?.minItems).toBeUndefined()
  })

  it("requires absolute paths for task boundary file changes", () => {
    expect(AnalyzeTaskBoundaryChangeSchema.safeParse({
      task_id: "T1",
      reason: "File belongs to this task",
      add_files: ["/tmp/example.ts"],
    }).success).toBe(true)

    expect(AnalyzeTaskBoundaryChangeSchema.safeParse({
      task_id: "T1",
      reason: "File belongs to this task",
      add_files: ["relative/example.ts"],
    }).success).toBe(false)
  })

  it("accepts isolated phase review process-output fields", () => {
    const parsed = SubmitPhaseReviewToolSchema.safeParse({
      review_token: "review-token",
      review_stdout: '{"criteriaResults":[]}',
      review_stderr: "",
      review_exit_code: 0,
      review_error: null,
    })

    expect(parsed.success).toBe(true)
  })

  it("validates roadmap query filters", () => {
    expect(RoadmapQueryToolSchema.safeParse({
      query: {
        itemIds: ["item-1"],
        kinds: ["feature"],
        statuses: ["todo"],
        featureName: "runtime-cleanup",
        minPriority: 2,
      },
    }).success).toBe(true)

    expect(RoadmapQueryToolSchema.safeParse({
      query: { kinds: ["unknown"] },
    }).success).toBe(false)
  })

  it("centralizes roadmap execution-slice compatibility aliases", () => {
    expect(RoadmapDeriveExecutionSliceToolSchema.safeParse({
      roadmap_item_ids: ["item-1"],
      feature_name: "runtime-cleanup",
    }).success).toBe(true)

    expect(RoadmapDeriveExecutionSliceToolSchema.safeParse({
      roadmapItemIds: ["item-1"],
      featureName: "runtime-cleanup",
    }).success).toBe(true)
  })
})
