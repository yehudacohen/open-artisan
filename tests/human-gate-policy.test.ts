import { describe, expect, it } from "bun:test"

import { activateHumanGateTasks, resolveAwaitingHumanState } from "#core/human-gate-policy"
import type { TaskNode } from "#core/dag"

function makeTask(overrides: Partial<TaskNode> & Pick<TaskNode, "id" | "description">): TaskNode {
  const { id, description, ...rest } = overrides
  return {
    id,
    description,
    dependencies: [],
    expectedTests: [],
    expectedFiles: [],
    estimatedComplexity: "small",
    status: "pending",
    ...rest,
  }
}

describe("human-gate-policy", () => {
  it("activates a human gate on the requested task", () => {
    const tasks = [makeTask({ id: "T1", description: "Provision infra", category: "human-gate" })]
    const updated = activateHumanGateTasks(tasks, "T1", {
      whatIsNeeded: "Create the bucket",
      why: "Uploads depend on it",
      verificationSteps: "Run aws s3 ls",
      resolved: false,
    })

    expect(updated[0]?.status).toBe("human-gated")
    expect(updated[0]?.humanGate?.whatIsNeeded).toBe("Create the bucket")
  })

  it("returns user-gate resolution for human sessions", () => {
    const tasks = activateHumanGateTasks(
      [makeTask({ id: "T1", description: "Provision infra", category: "human-gate" })],
      "T1",
      {
        whatIsNeeded: "Create the bucket",
        why: "Uploads depend on it",
        verificationSteps: "Run aws s3 ls",
        resolved: false,
      },
    )

    const resolution = resolveAwaitingHumanState(tasks, false)
    expect(resolution.action).toBe("user-gate")
    if (resolution.action !== "user-gate") return
    expect(resolution.humanGatedTasks[0]?.id).toBe("T1")
  })

  it("auto-aborts human-gated work for robot-artisan and keeps ready tasks", () => {
    const tasks = activateHumanGateTasks(
      [
        makeTask({ id: "T1", description: "Provision infra", category: "human-gate" }),
        makeTask({ id: "T2", description: "Use infra", dependencies: ["T1"] }),
      ],
      "T1",
      {
        whatIsNeeded: "Create the bucket",
        why: "Uploads depend on it",
        verificationSteps: "Run aws s3 ls",
        resolved: false,
      },
    )

    const resolution = resolveAwaitingHumanState(tasks, true)
    expect(resolution.action).toBe("robot-abort")
    if (resolution.action !== "robot-abort") return
    expect(resolution.abortedIds).toEqual(["T1", "T2"])
    expect(resolution.nextTask).toBeNull()
  })
})
