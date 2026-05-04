import { describe, expect, it } from "bun:test"

import { assessParallelTaskIsolation, getPhaseToolPolicy, normalizeParallelWritablePath } from "#core/hooks/tool-guard"
import type { TaskNode } from "#core/dag"

function makeTask(id: string, isolation?: TaskNode["isolation"]): Pick<TaskNode, "id" | "isolation"> {
  return isolation ? { id, isolation } : { id }
}

describe("parallel tool-guard isolation", () => {
  it("treats normalized non-overlapping writable paths as parallel-safe", () => {
    const result = assessParallelTaskIsolation([
      makeTask("T1", { mode: "isolated-worktree", ownershipKey: "one", writablePaths: ["./src/one.ts"], safeForParallelDispatch: true }),
      makeTask("T2", { mode: "isolated-worktree", ownershipKey: "two", writablePaths: ["src/two.ts"], safeForParallelDispatch: true }),
    ])
    expect(result.allowed).toBeTrue()
    expect(result.normalizedWritablePaths).toEqual(["src/one.ts", "src/two.ts"])
  })

  it("normalizes path equivalence before overlap checks", () => {
    const result = assessParallelTaskIsolation([
      makeTask("T1", { mode: "isolated-worktree", ownershipKey: "one", writablePaths: ["./src/shared.ts"], safeForParallelDispatch: true }),
      makeTask("T2", { mode: "isolated-worktree", ownershipKey: "two", writablePaths: ["src/shared.ts"], safeForParallelDispatch: true }),
    ])
    expect(result.allowed).toBeFalse()
    expect(result.reason).toBe("overlapping-writes")
  })

  it("rejects sequential-only tasks for batch dispatch", () => {
    const result = assessParallelTaskIsolation([
      makeTask("T1", { mode: "sequential-only", ownershipKey: "one", writablePaths: ["src/one.ts"], safeForParallelDispatch: false }),
      makeTask("T2", { mode: "isolated-worktree", ownershipKey: "two", writablePaths: ["src/two.ts"], safeForParallelDispatch: true }),
    ])
    expect(result.allowed).toBeFalse()
    expect(result.reason).toBe("runtime-unsupported")
  })

  it("rejects missing ownership keys", () => {
    const result = assessParallelTaskIsolation([
      makeTask("T1", { mode: "isolated-worktree", ownershipKey: "", writablePaths: ["src/one.ts"], safeForParallelDispatch: true }),
      makeTask("T2", { mode: "isolated-worktree", ownershipKey: "two", writablePaths: ["src/two.ts"], safeForParallelDispatch: true }),
    ])
    expect(result.allowed).toBeFalse()
    expect(result.reason).toBe("ownership-unknown")
  })

  it("rejects malformed writable paths", () => {
    expect(normalizeParallelWritablePath("../secret.txt")).toBeNull()
    const result = assessParallelTaskIsolation([
      makeTask("T1", { mode: "isolated-worktree", ownershipKey: "one", writablePaths: ["../secret.txt"], safeForParallelDispatch: true }),
      makeTask("T2", { mode: "isolated-worktree", ownershipKey: "two", writablePaths: ["src/two.ts"], safeForParallelDispatch: true }),
    ])
    expect(result.allowed).toBeFalse()
    expect(result.reason).toBe("ownership-unknown")
  })

  it("does not weaken env blocking under concurrent semantics", () => {
    const policy = getPhaseToolPolicy(
      "IMPLEMENTATION",
      "DRAFT",
      "INCREMENTAL",
      ["/project/src/a.ts", "/project/tests/a.test.ts"],
      ["/project/src/a.ts", "/project/tests/a.test.ts"],
    )
    expect(policy.writePathPredicate!("/project/.env")).toBeFalse()
    expect(policy.writePathPredicate!("/project/src/a.ts")).toBeTrue()
  })
})
