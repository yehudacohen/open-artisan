import { describe, expect, it } from "bun:test"

import { parseImplPlan } from "#core/impl-plan-parser"

/** Minimal two-task plan; T2's `**Files:**` line is the variable under test. */
const planWithT2Files = (filesLine: string) => `## Task T1: scaffold
**Dependencies:** none
**Expected tests:** none
**Files:** package.json

## Task T2: verify
**Dependencies:** T1
**Expected tests:** none
**Files:** ${filesLine}
`

describe("parseImplPlan — list tokenization (parenthetical asides + none)", () => {
  it("treats '**Files:** none (verification-only …)' as no files, not bogus path tokens", () => {
    // Regression: the prose after "none" used to split into tokens like "(verification-only",
    // which then failed IMPLEMENTATION request_review as a missing file on disk.
    const result = parseImplPlan(
      planWithT2Files("none (verification-only task — it runs the gated E2E; it writes no source)."),
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    const t2 = result.dag.tasks.find((t) => t.id === "T2")
    expect(t2).toBeDefined()
    expect(t2!.expectedFiles).toEqual([])
  })

  it("strips a parenthetical aside but keeps the real path", () => {
    const result = parseImplPlan(planWithT2Files("src/db/repo.ts (the repository entry point)"))
    expect(result.success).toBe(true)
    if (!result.success) return
    const t2 = result.dag.tasks.find((t) => t.id === "T2")!
    expect(t2.expectedFiles).toEqual(["src/db/repo.ts"])
  })

  it("still parses a normal comma/space-separated path list", () => {
    const result = parseImplPlan(planWithT2Files("src/a.ts, src/b.ts"))
    expect(result.success).toBe(true)
    if (!result.success) return
    const t2 = result.dag.tasks.find((t) => t.id === "T2")!
    expect(t2.expectedFiles).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("preserves a real path that merely starts with 'none' (e.g. none.ts)", () => {
    const result = parseImplPlan(planWithT2Files("src/none.ts"))
    expect(result.success).toBe(true)
    if (!result.success) return
    const t2 = result.dag.tasks.find((t) => t.id === "T2")!
    expect(t2.expectedFiles).toEqual(["src/none.ts"])
  })
})
