import { describe, expect, it } from "bun:test"

import { classifyWorktreeChanges, parseGitPorcelain } from "#core/worktree-observation"

const CREATED_AT = "2026-05-01T00:00:00.000Z"

describe("worktree observation classification", () => {
  it("parses git porcelain status into normalized changes", () => {
    expect(parseGitPorcelain(" M src/a.ts\n?? dist/out.js\nR  src/old.ts -> src/new.ts\n")).toEqual([
      { path: "src/a.ts", status: "modified", raw: " M src/a.ts" },
      { path: "dist/out.js", status: "untracked", raw: "?? dist/out.js" },
      { path: "src/new.ts", status: "renamed", raw: "R  src/old.ts -> src/new.ts" },
    ])
  })

  it("separates task-owned, artifact, generated, ambient, and claimed changes", () => {
    const observations = classifyWorktreeChanges({
      workflowId: "workflow-1",
      createdAt: CREATED_AT,
      currentAgentLeaseId: "agent-1",
      taskOwnedFiles: ["src/task.ts"],
      artifactFiles: [".openartisan/feature/plan.md"],
      fileClaims: [
        { path: "src/other-agent.ts", agentLeaseId: "agent-2" },
        { path: "src/claimed-by-current.ts", agentLeaseId: "agent-1" },
      ],
      changes: [
        { path: "src/task.ts", status: "modified" },
        { path: ".openartisan/feature/plan.md", status: "modified" },
        { path: "dist/out.js", status: "untracked" },
        { path: "src/other-agent.ts", status: "modified" },
        { path: "src/claimed-by-current.ts", status: "modified" },
        { path: "src/ambient.ts", status: "modified" },
      ],
    })

    expect(observations.map((observation) => [observation.path, observation.classification])).toEqual([
      ["src/task.ts", "task-owned"],
      [".openartisan/feature/plan.md", "artifact"],
      ["dist/out.js", "generated"],
      ["src/other-agent.ts", "parallel-claimed"],
      ["src/claimed-by-current.ts", "unowned-overlap"],
      ["src/ambient.ts", "ambient"],
    ])
  })

  it("treats Open Artisan logs as generated instead of task failures", () => {
    const [observation] = classifyWorktreeChanges({
      workflowId: "workflow-1",
      createdAt: CREATED_AT,
      changes: [{ path: ".openartisan/openartisan-errors.log", status: "modified" }],
    })

    expect(observation?.classification).toBe("generated")
  })
})
