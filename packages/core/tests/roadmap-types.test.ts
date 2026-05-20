import { describe, expect, it } from "bun:test"

import {
  validateRoadmapDocumentResult,
  validateRoadmapDocument,
  type DerivedExecutionSlice,
  type RoadmapContextAttachmentService,
  type RoadmapDiagnosticEvent,
  type RoadmapDocument,
  type RoadmapMutationInput,
  type RoadmapMutationResult,
  type RoadmapResult,
  type RoadmapSliceService,
  type TaskRoadmapTraceability,
  type WorkflowRoadmapContext,
  type WorkflowRoadmapLink,
} from "#core/roadmap-types"
import { createRoadmapContextAttachmentService, type WorkflowService } from "#core/open-artisan-services"

const NOW = "2026-04-16T00:00:00.000Z"

function makeDocument(overrides: Partial<RoadmapDocument> = {}): RoadmapDocument {
  return {
    schemaVersion: 1,
    items: [
      {
        id: "item-1",
        kind: "feature",
        title: "Persistent roadmap DAG",
        status: "todo",
        priority: 10,
        featureName: "persistent-roadmap-dag",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-2",
        kind: "bug",
        title: "Keep workflow resume semantics intact",
        status: "done",
        priority: 8,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-3",
        kind: "debt",
        title: "Track persistence namespace cleanup",
        status: "dropped",
        priority: 3,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    edges: [{ from: "item-1", to: "item-2", kind: "depends-on" }],
    ...overrides,
  }
}

describe("roadmap type contracts", () => {
  it("accepts a valid roadmap document including terminal statuses", () => {
    const document = makeDocument()

    expect(validateRoadmapDocument(document)).toBeNull()
  })

  it("accepts an empty edges array for independent roadmap items", () => {
    const document = makeDocument({ edges: [] })

    expect(validateRoadmapDocument(document)).toBeNull()
  })

  it("rejects duplicate roadmap item ids", () => {
    const base = makeDocument()
    const firstItem = base.items[0]
    if (!firstItem) throw new Error("expected seeded roadmap item")

    const duplicate = {
      ...firstItem,
      title: "Duplicate id",
    }

    const result = validateRoadmapDocument({
      ...base,
      items: [firstItem, duplicate],
      edges: [],
    })

    expect(result).toBe('Duplicate RoadmapItem.id "item-1"')
  })

  it("rejects edges whose endpoints are missing from the document", () => {
    const result = validateRoadmapDocument({
      ...makeDocument(),
      edges: [{ from: "item-1", to: "missing-item", kind: "depends-on" }],
    })

    expect(result).toBe('RoadmapDocument.edges[0].to references missing item "missing-item"')
  })

  it("rejects self dependencies", () => {
    const result = validateRoadmapDocument({
      ...makeDocument(),
      edges: [{ from: "item-1", to: "item-1", kind: "depends-on" }],
    })

    expect(result).toBe('RoadmapDocument.edges[0] must not self-reference "item-1"')
  })

  it("rejects directed cycles across multiple roadmap items", () => {
    const result = validateRoadmapDocument({
      ...makeDocument(),
      edges: [
        { from: "item-1", to: "item-2", kind: "depends-on" },
        { from: "item-2", to: "item-1", kind: "depends-on" },
      ],
    })

    expect(result).toBe('RoadmapDocument.edges must form a DAG; found cycle "item-1->item-2->item-1"')
  })

  it("rejects duplicate edges", () => {
    const edge = { from: "item-1", to: "item-2", kind: "depends-on" } as const
    const result = validateRoadmapDocument({
      ...makeDocument(),
      edges: [edge, edge],
    })

    expect(result).toBe('Duplicate RoadmapEdge "item-1->item-2:depends-on"')
  })

  it("supports structured roadmap result contracts and additive workflow linkage", () => {
    const document = makeDocument()
    const slice: DerivedExecutionSlice = {
      roadmapItemIds: document.items.map((item) => item.id),
      roadmapItems: document.items,
      edges: document.edges,
      featureName: "persistent-roadmap-dag",
    }
    const link: WorkflowRoadmapLink = {
      featureName: "persistent-roadmap-dag",
      roadmapItemIds: ["item-1", "item-2"],
    }
    const success: RoadmapResult<DerivedExecutionSlice> = { ok: true, value: slice }
    const failure: RoadmapResult<DerivedExecutionSlice> = {
      ok: false,
      error: {
        code: "invalid-slice",
        message: "unknown roadmap item",
        retryable: false,
        details: { itemId: "missing-item", schemaVersion: 1 },
      },
    }

    expect(success.ok).toBeTrue()
    if (success.ok) {
      expect(success.value.roadmapItemIds).toEqual(["item-1", "item-2", "item-3"])
      expect(success.value.featureName).toBe(link.featureName)
      expect(success.value.roadmapItems.map((item) => item.id)).toEqual(success.value.roadmapItemIds)
    }

    expect(failure.ok).toBeFalse()
    if (!failure.ok) {
      expect(failure.error.code).toBe("invalid-slice")
      expect(failure.error.details).toEqual({ itemId: "missing-item", schemaVersion: 1 })
    }

    expect(link.featureName).toBe("persistent-roadmap-dag")
    expect(link.roadmapItemIds).toEqual(["item-1", "item-2"])
  })

  it("returns structured roadmap document validation results for new tool paths", () => {
    const valid = validateRoadmapDocumentResult(makeDocument())
    expect(valid).toEqual({ ok: true, value: null })

    const invalid = validateRoadmapDocumentResult(makeDocument({
      edges: [{ from: "item-1", to: "missing-item", kind: "depends-on" }],
    }))
    expect(invalid.ok).toBeFalse()
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid-document")
      expect(invalid.error.retryable).toBeFalse()
      expect(invalid.error.details).toEqual({ schemaVersion: 1, operation: "replace-document" })
    }
  })

  it("models roadmap mutation inputs, diagnostics, workflow context, and task traceability without implying completion", () => {
    const document = makeDocument()
    const mutation: RoadmapMutationInput = { kind: "update-item-status", itemId: "item-1", status: "in-progress" }
    const result: RoadmapMutationResult = { kind: "update-item-status", item: { ...document.items[0]!, status: "in-progress" } }
    const context: WorkflowRoadmapContext = {
      roadmapItemIds: ["item-1", "item-2"],
      roadmapItems: document.items.slice(0, 2),
      edges: document.edges,
      featureName: "persistent-roadmap-dag",
      executionSliceId: "slice-1",
      attachedAt: NOW,
    }
    const taskTraceability: TaskRoadmapTraceability = { roadmapItemIds: ["item-1"] }
    const diagnostic: RoadmapDiagnosticEvent = {
      operation: "update-item-status",
      status: "ready",
      roadmapItemIds: ["item-1"],
    }

    expect(mutation.kind).toBe("update-item-status")
    expect(result.item?.status).toBe("in-progress")
    expect(context.roadmapItemIds).toEqual(["item-1", "item-2"])
    expect(taskTraceability.roadmapItemIds).toEqual(["item-1"])
    expect(diagnostic).toEqual({ operation: "update-item-status", status: "ready", roadmapItemIds: ["item-1"] })
  })

  it("models shared roadmap context attachment and workflow linking as typed service seams", async () => {
    const document = makeDocument()
    const context: WorkflowRoadmapContext = {
      roadmapItemIds: ["item-1", "item-2"],
      roadmapItems: document.items.slice(0, 2),
      edges: document.edges,
      featureName: "persistent-roadmap-dag",
      executionSliceId: "slice-1",
      attachedAt: NOW,
    }
    const service: RoadmapContextAttachmentService = {
      async deriveContext(input) {
        expect(input).toEqual({ roadmapItemIds: ["item-1", "item-2"], featureName: "persistent-roadmap-dag", executionSliceId: "slice-1" })
        return { ok: true, value: context }
      },
      async linkWorkflow(input) {
        expect(input.roadmapContext?.roadmapItemIds).toEqual(["item-1", "item-2"])
        return { ok: true, value: { featureName: input.featureName, roadmapItemIds: input.roadmapContext?.roadmapItemIds ?? [] } }
      },
    }

    const derived = await service.deriveContext({ roadmapItemIds: ["item-1", "item-2"], featureName: "persistent-roadmap-dag", executionSliceId: "slice-1" })
    expect(derived).toEqual({ ok: true, value: context })

    const linked = await service.linkWorkflow({ featureName: "persistent-roadmap-dag", roadmapContext: context })
    expect(linked).toEqual({ ok: true, value: { featureName: "persistent-roadmap-dag", roadmapItemIds: ["item-1", "item-2"] } })
  })

  it("derives and links roadmap context through the shared attachment service", async () => {
    const document = makeDocument()
    const roadmapSliceService: RoadmapSliceService = {
      async queryRoadmap() {
        return { ok: true, value: document.items }
      },
      async deriveExecutionSlice(input: { roadmapItemIds: string[]; featureName?: string; executionSliceId?: string }) {
        expect(input).toEqual({ roadmapItemIds: ["item-1", "item-2"], featureName: "persistent-roadmap-dag" })
        return {
          ok: true,
          value: {
            roadmapItemIds: input.roadmapItemIds,
            roadmapItems: document.items.slice(0, 2),
            edges: document.edges,
            ...(input.featureName !== undefined ? { featureName: input.featureName } : {}),
          },
        }
      },
    }
    const linkedItemIds: string[] = []
    const workflow = {
      async getWorkflowByFeature(featureName: string) {
        expect(featureName).toBe("persistent-roadmap-dag")
        return { ok: true, value: { workflow: { id: "workflow-1" } } }
      },
      async linkRoadmap(workflowId: string, roadmapItemId: string) {
        expect(workflowId).toBe("workflow-1")
        linkedItemIds.push(roadmapItemId)
        return { ok: true, value: { workflowId, roadmapItemId } }
      },
    } as Pick<WorkflowService, "getWorkflowByFeature" | "linkRoadmap"> as WorkflowService

    const service = createRoadmapContextAttachmentService({ roadmapSliceService, workflow })
    const context = await service.deriveContext({ roadmapItemIds: ["item-1", "item-2"], featureName: "persistent-roadmap-dag" })
    expect(context.ok).toBeTrue()
    if (!context.ok) throw new Error(context.error.message)
    expect(context.value?.attachedAt).toBeString()
    expect(context.value?.roadmapItemIds).toEqual(["item-1", "item-2"])

    const link = await service.linkWorkflow({ featureName: "persistent-roadmap-dag", roadmapContext: context.value })
    expect(link).toEqual({ ok: true, value: { featureName: "persistent-roadmap-dag", roadmapItemIds: ["item-1", "item-2"] } })
    expect(linkedItemIds).toEqual(["item-1", "item-2"])
  })
})
