import { describe, expect, it } from "bun:test"

import {
  AnalyzeTaskBoundaryChangeSchema,
  RequestReviewToolSchema,
  RoadmapDeleteEdgeToolSchema,
  RoadmapDeleteItemToolSchema,
  RoadmapDeriveExecutionSliceToolSchema,
  RoadmapReplaceToolSchema,
  RoadmapUpdateItemStatusToolSchema,
  RoadmapUpsertEdgeToolSchema,
  RoadmapUpsertItemToolSchema,
  RoadmapQueryToolSchema,
  SelectModeToolSchema,
  SubmitPhaseReviewToolSchema,
  toJsonSchema,
} from "#core/schemas"

describe("shared tool schemas", () => {
  it("rejects request_review markdown materialization with an empty artifact file list", () => {
    const parsed = RequestReviewToolSchema.safeParse({
      summary: "Conventions",
      artifact_description: "Conventions doc",
      artifact_files: [],
      artifact_markdown: "# Conventions\n",
    })

    expect(parsed.success).toBe(false)
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
    expect(schema.properties?.artifact_files?.minItems).toBe(1)
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

  it("requires roadmap item ids or an execution slice id when deriving roadmap execution slices", () => {
    expect(RoadmapDeriveExecutionSliceToolSchema.safeParse({}).success).toBe(false)
    expect(RoadmapDeriveExecutionSliceToolSchema.safeParse({ execution_slice_id: "slice-1" }).success).toBe(true)
    expect(RoadmapDeriveExecutionSliceToolSchema.safeParse({ executionSliceId: "slice-1" }).success).toBe(true)
  })

  it("accepts select_mode roadmap attachment aliases without changing the base mode contract", () => {
    expect(SelectModeToolSchema.safeParse({
      mode: "INCREMENTAL",
      feature_name: "roadmap-integration",
      roadmap_item_ids: ["item-1"],
      execution_slice_id: "slice-1",
    }).success).toBe(true)

    expect(SelectModeToolSchema.safeParse({
      mode: "INCREMENTAL",
      feature_name: "roadmap-integration",
      roadmapItemIds: ["item-1"],
      executionSliceId: "slice-1",
    }).success).toBe(true)
  })

  it("validates roadmap mutation tool schemas and rejects unsafe feature names", () => {
    const item = {
      id: "item-1",
      kind: "feature",
      title: "Roadmap tools",
      status: "todo",
      priority: 10,
      featureName: "roadmap-integration",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    }
    const edge = { from: "item-2", to: "item-1", kind: "depends-on" }

    expect(RoadmapUpsertItemToolSchema.safeParse({ item }).success).toBe(true)
    expect(RoadmapUpdateItemStatusToolSchema.safeParse({ item_id: "item-1", status: "in-progress" }).success).toBe(true)
    expect(RoadmapUpdateItemStatusToolSchema.safeParse({ itemId: "item-1", status: "blocked", updatedAt: item.updatedAt }).success).toBe(true)
    expect(RoadmapDeleteItemToolSchema.safeParse({ item_id: "item-1" }).success).toBe(true)
    expect(RoadmapDeleteItemToolSchema.safeParse({ itemId: "item-1" }).success).toBe(true)
    expect(RoadmapUpsertEdgeToolSchema.safeParse({ edge }).success).toBe(true)
    expect(RoadmapDeleteEdgeToolSchema.safeParse({ edge }).success).toBe(true)
    expect(RoadmapReplaceToolSchema.safeParse({ document: { schemaVersion: 1, items: [item], edges: [] } }).success).toBe(true)

    expect(RoadmapUpdateItemStatusToolSchema.safeParse({ status: "done" }).success).toBe(false)
    expect(RoadmapDeleteItemToolSchema.safeParse({}).success).toBe(false)
    expect(RoadmapUpsertItemToolSchema.safeParse({ item: { ...item, featureName: "../secrets" } }).success).toBe(false)
  })
})
