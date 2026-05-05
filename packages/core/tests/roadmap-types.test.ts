import { describe, expect, it } from "bun:test"

import {
  validateRoadmapDocument,
  type DerivedExecutionSlice,
  type RoadmapDocument,
  type RoadmapResult,
  type WorkflowRoadmapLink,
} from "#core/roadmap-types"

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
})
