import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extractAgentName,
  isArtisanAgent,
  isWorkflowSessionActive,
  normalizeAgentName,
  persistActiveAgent,
} from "#core/agent-policy"
import { createSessionStateStore } from "#core/session-state"
import { createFileSystemStateBackend } from "#core/state-backend-fs"
import { makeWorkflowState } from "./helpers/workflow-state"

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const makeState = (overrides = {}) => makeWorkflowState({ sessionId: "s1", mode: null, phase: "MODE_SELECT", ...overrides })

describe("agent-policy", () => {
  it("normalizes agent names", () => {
    expect(normalizeAgentName(" Robot-Artisan ")).toBe("robot-artisan")
    expect(normalizeAgentName(42)).toBeNull()
  })

  it("detects artisan agents", () => {
    expect(isArtisanAgent("artisan")).toBe(true)
    expect(isArtisanAgent("robot-artisan")).toBe(true)
    expect(isArtisanAgent("build-artisan")).toBe(true)
    expect(isArtisanAgent("build")).toBe(false)
  })

  it("extracts nested agent metadata", () => {
    expect(extractAgentName({ info: { agent: "Build" } })).toBe("build")
    expect(extractAgentName({ properties: { session: { agentId: "artisan" } } })).toBe("artisan")
  })

  it("treats unknown MODE_SELECT sessions as dormant", () => {
    expect(isWorkflowSessionActive(makeState())).toBe(false)
  })

  it("treats non-artisan sessions as dormant", () => {
    expect(isWorkflowSessionActive(makeState({ activeAgent: "build" }))).toBe(false)
  })

  it("treats persisted workflow state as active even without agent metadata", () => {
    expect(isWorkflowSessionActive(makeState({ phase: "PLANNING" }))).toBe(true)
  })

  it("keeps an opted-in build-artisan workflow active even when the current agent override is build", () => {
    expect(isWorkflowSessionActive(makeState({ activeAgent: "build-artisan" }), "build")).toBe(true)
  })

  it("persists normalized agent names to session state", async () => {
    const dir = await makeTempDir("agent-policy-")
    const store = createSessionStateStore(createFileSystemStateBackend(dir))
    await store.create("s1")

    const persisted = await persistActiveAgent(store, "s1", " Build ")

    expect(persisted).toBe("build")
    expect(store.get("s1")?.activeAgent).toBe("build")
  })

  it("does not downgrade an artisan session to build from transient agent metadata", async () => {
    const dir = await makeTempDir("agent-policy-lock-")
    const store = createSessionStateStore(createFileSystemStateBackend(dir))
    await store.create("s1")
    await store.update("s1", (draft) => {
      draft.activeAgent = "artisan"
    })

    const persisted = await persistActiveAgent(store, "s1", "build")

    expect(persisted).toBe("artisan")
    expect(store.get("s1")?.activeAgent).toBe("artisan")
  })
})
