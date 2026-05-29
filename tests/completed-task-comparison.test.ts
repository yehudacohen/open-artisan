import { describe, expect, it } from "bun:test"

import { completedTaskRewriteDiagnostic, completedTaskRewriteReason } from "#core/completed-task-comparison"
import type { TaskNode } from "#core/dag"

function task(overrides: Partial<TaskNode>): TaskNode {
  return {
    id: "T1",
    description: "Completed task",
    dependencies: [],
    expectedFiles: [],
    expectedTests: [],
    estimatedComplexity: "small",
    status: "complete",
    ...overrides,
  }
}

describe("completedTaskRewriteReason", () => {
  it("ignores review/deletion prose around the completed implementation block", () => {
    const existing = task({
      description: "Documentation cleanup — Implementation: - Preserve existing docs cleanup. - Keep generated artifacts outside default discovery.",
    })
    const planned = task({
      description: [
        "Documentation cleanup — Intentional deletion targets:",
        "- build/tmp/generated.js",
        "Implementation:",
        "- Preserve existing docs cleanup.",
        "- Keep generated artifacts outside default discovery.",
        "Acceptance:",
        "- Final review understands the deletion metadata.",
      ].join(" "),
    })

    expect(completedTaskRewriteReason(existing, planned)).toBeNull()
  })

  it("reports expected file rewrites of completed task history", () => {
    const existing = task({ expectedFiles: ["/repo/src/a.ts"] })
    const planned = task({ expectedFiles: ["/repo/src/a.ts", "/repo/src/new.ts"] })

    expect(completedTaskRewriteReason(existing, planned)).toBe("expectedFiles")
  })

  it("does not treat reordered completed task file metadata as a rewrite", () => {
    const existing = task({ expectedFiles: ["/repo/src/a.ts", "/repo/src/b.ts"] })
    const planned = task({ expectedFiles: ["/repo/src/b.ts", "/repo/src/a.ts"] })

    expect(completedTaskRewriteDiagnostic(existing, planned)).toBeNull()
  })

  it("reports missing and extra expected file details for completed task rewrites", () => {
    const existing = task({ expectedFiles: ["/repo/src/kept.ts", "/repo/src/deleted-openfga.ts"] })
    const planned = task({ expectedFiles: ["/repo/src/kept.ts", "/repo/src/new.ts"] })

    const diagnostic = completedTaskRewriteDiagnostic(existing, planned)

    expect(diagnostic?.field).toBe("expectedFiles")
    expect(diagnostic?.detail).toContain("missing from revised plan: /repo/src/deleted-openfga.ts")
    expect(diagnostic?.detail).toContain("unexpected additions: /repo/src/new.ts")
    expect(diagnostic?.guidance).toContain("Do not remove deleted historical files")
  })
})
