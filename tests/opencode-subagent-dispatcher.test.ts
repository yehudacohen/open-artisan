/**
 * Tests for opencode-subagent-dispatcher.ts — OpenCode adapter for SubagentDispatcher.
 *
 * Verifies:
 * - createSession extracts session ID from SDK envelope
 * - prompt() extracts text from SDK parts array
 * - destroy() calls session.delete (no parentId) or skips (with parentId)
 * - Model normalization (string → { modelID })
 * - Throws when client.session is not available
 */
import { describe, expect, it, mock } from "bun:test"
import { createOpenCodeSubagentDispatcher } from "#plugin/opencode-subagent-dispatcher"

function makeClient(overrides?: {
  createResponse?: unknown
  promptResponse?: unknown
  createThrows?: boolean
  promptThrows?: boolean
}) {
  return {
    session: {
      create: overrides?.createThrows
        ? mock(async () => { throw new Error("create failed") })
        : mock(async () => overrides?.createResponse ?? { data: { id: "sess-1" } }),
      prompt: overrides?.promptThrows
        ? mock(async () => { throw new Error("prompt failed") })
        : mock(async () => overrides?.promptResponse ?? {
            data: { parts: [{ type: "text", text: "response text" }] },
          }),
      delete: mock(async () => {}),
    },
  }
}

describe("createOpenCodeSubagentDispatcher", () => {
  it("extracts session ID from SDK create envelope", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    expect(session.id).toBe("sess-1")
  })

  it("prompt() extracts text from SDK parts array", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    const text = await session.prompt("hello")
    expect(text).toBe("response text")
  })

  it("prompt() passes text as parts array to SDK", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    await session.prompt("my prompt")
    const call = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const body = (call as any)?.[0]?.body
    expect(body.parts[0].text).toBe("my prompt")
  })

  it("destroy() calls session.delete when no parentId", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    await session.destroy()
    expect(client.session.delete).toHaveBeenCalledTimes(1)
  })

  it("destroy() skips session.delete when parentId is set", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer", parentId: "parent-1" })
    await session.destroy()
    expect(client.session.delete).not.toHaveBeenCalled()
  })

  it("normalizes string model to { modelID }", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    await dispatcher.createSession({ title: "test", agent: "workflow-reviewer", model: "gpt-4" })
    const call = (client.session.create as ReturnType<typeof mock>).mock.calls[0]
    expect((call as any)?.[0]?.body?.model).toEqual({ modelID: "gpt-4" })
  })

  it("passes object model as-is", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    await dispatcher.createSession({ title: "test", agent: "workflow-reviewer", model: { modelID: "claude-3", providerID: "anthropic" } })
    const call = (client.session.create as ReturnType<typeof mock>).mock.calls[0]
    expect((call as any)?.[0]?.body?.model).toEqual({ modelID: "claude-3", providerID: "anthropic" })
  })

  it("throws when client.session is not available", async () => {
    const dispatcher = createOpenCodeSubagentDispatcher({ session: undefined } as any)
    await expect(dispatcher.createSession({ title: "test", agent: "workflow-reviewer" }))
      .rejects.toThrow("client.session is not available")
  })

  it("throws when create fails", async () => {
    const client = makeClient({ createThrows: true })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    await expect(dispatcher.createSession({ title: "test", agent: "workflow-reviewer" }))
      .rejects.toThrow("create failed")
  })

  it("destroy() swallows errors silently", async () => {
    const client = makeClient()
    ;(client.session.delete as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("delete failed")
    })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    // Should not throw
    await session.destroy()
  })
})
