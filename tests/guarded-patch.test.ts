import { describe, expect, it } from "bun:test"

import { applyGuardedPatch, buildUnifiedDiff, parseGuardedPatch } from "#core/guarded-patch"

describe("guarded patch parser and applier", () => {
  it("parses target paths before applying file changes", () => {
    const parsed = parseGuardedPatch("*** Begin Patch\n*** Add File: src/contracts.d.ts\n+export interface Contract {}\n*** End Patch")

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.targetPaths).toEqual(["src/contracts.d.ts"])
  })

  it("applies add, update, and delete operations in memory", () => {
    const patch = "*** Begin Patch\n*** Add File: src/new.d.ts\n+export interface New {}\n*** Update File: src/existing.d.ts\n@@\n-export interface Existing {}\n+export interface Existing {\n+  readonly ok: true\n+}\n*** Delete File: src/old.d.ts\n*** End Patch"
    const initial = new Map<string, string | null>([
      ["src/new.d.ts", null],
      ["src/existing.d.ts", "export interface Existing {}"],
      ["src/old.d.ts", "export interface Old {}"],
    ])

    const applied = applyGuardedPatch(patch, initial)

    expect(applied.success).toBe(true)
    if (!applied.success) return
    expect(applied.data.changes).toEqual([
      { path: "src/new.d.ts", oldContent: null, newContent: "export interface New {}" },
      { path: "src/existing.d.ts", oldContent: "export interface Existing {}", newContent: "export interface Existing {\n  readonly ok: true\n}" },
      { path: "src/old.d.ts", oldContent: "export interface Old {}", newContent: null },
    ])
  })

  it("fails before producing changes when an update hunk does not match", () => {
    const applied = applyGuardedPatch(
      "*** Begin Patch\n*** Update File: src/existing.d.ts\n@@\n-missing\n+replacement\n*** End Patch",
      new Map([["src/existing.d.ts", "actual"]]),
    )

    expect(applied.success).toBe(false)
    if (applied.success) return
    expect(applied.error).toContain("did not match")
  })
})

describe("guarded unified diff", () => {
  it("reports additions and removals with unified diff headers", () => {
    const summary = buildUnifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n", "src/file.ts")

    expect(summary.additions).toBe(1)
    expect(summary.removals).toBe(1)
    expect(summary.diff).toContain("--- a/src/file.ts")
    expect(summary.diff).toContain("+++ b/src/file.ts")
    expect(summary.diff).toContain("-two")
    expect(summary.diff).toContain("+TWO")
  })
})
