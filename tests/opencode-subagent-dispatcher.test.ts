/**
 * Tests for opencode-subagent-dispatcher.ts — OpenCode adapter for SubagentDispatcher.
 *
 * Verifies:
 * - createSession extracts session ID from SDK envelope
 * - prompt() extracts text from SDK parts array
 * - destroy() calls session.delete (no parentId) or skips (with parentId)
 * - Model routing is sent with prompts, not session creation
 * - Throws when client.session is not available
 */
import { describe, expect, it, mock } from "bun:test"
import { createOpenCodeSubagentDispatcher } from "#plugin/opencode-subagent-dispatcher"

function makeClient(overrides?: {
  createResponse?: unknown
  createResponses?: unknown[]
  promptResponse?: unknown
  messageResponse?: unknown
  messagesResponse?: unknown
  createThrows?: boolean
  promptThrows?: boolean
}) {
  let createCall = 0
  return {
    session: {
      create: overrides?.createThrows
        ? mock(async () => { throw new Error("create failed") })
        : mock(async () => {
            if (overrides?.createResponses) {
              const response = overrides.createResponses[Math.min(createCall, overrides.createResponses.length - 1)]
              createCall++
              return response
            }
            return overrides?.createResponse ?? { data: { id: "sess-1" } }
          }),
      prompt: overrides?.promptThrows
        ? mock(async () => { throw new Error("prompt failed") })
        : mock(async () => overrides?.promptResponse ?? {
            data: { parts: [{ type: "text", text: "response text" }] },
          }),
      message: mock(async () => overrides?.messageResponse ?? {
        data: { parts: [{ type: "text", text: "fetched response text" }] },
      }),
      messages: mock(async () => overrides?.messagesResponse ?? {
        data: [{ info: { id: "msg-1", role: "assistant" }, parts: [{ type: "text", text: "history response text" }] }],
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

  it("extracts session ID from nested OpenCode create envelopes", async () => {
    const client = makeClient({ createResponse: { data: { session: { id: "sess-nested" } } } })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    expect(session.id).toBe("sess-nested")
  })

  it("prompt() extracts text from SDK parts array", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    const text = await session.prompt("hello")
    expect(text).toBe("response text")
  })

  it("prompt() fetches message parts when prompt returns assistant metadata only", async () => {
    const client = makeClient({
      promptResponse: { data: { info: { id: "msg-1", role: "assistant" } } },
      messageResponse: { data: { parts: [{ type: "text", text: "late response" }] } },
    })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    const text = await session.prompt("hello")
    expect(text).toBe("late response")
    expect(client.session.message).toHaveBeenCalledWith({ path: { id: "sess-1", messageID: "msg-1" } })
  })

  it("prompt() falls back to message history when direct message fetch has no parts", async () => {
    const client = makeClient({
      promptResponse: { data: { info: { id: "msg-1", role: "assistant" } } },
      messageResponse: { data: { info: { id: "msg-1", role: "assistant" } } },
      messagesResponse: { data: [{ info: { id: "msg-1", role: "assistant" }, parts: [{ type: "text", text: "history response" }] }] },
    })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    const text = await session.prompt("hello")
    expect(text).toBe("history response")
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: "sess-1" }, query: { limit: 20 } })
  })

  it("prompt() selects the assistant message from mixed message history", async () => {
    const client = makeClient({
      promptResponse: { data: { info: { id: "assistant-1", role: "assistant" } } },
      messageResponse: { data: { info: { id: "assistant-1", role: "assistant" } } },
      messagesResponse: {
        data: [
          { info: { id: "user-1", role: "user" }, parts: [{ type: "text", text: "original prompt" }] },
          { info: { id: "assistant-1", role: "assistant" }, parts: [{ type: "text", text: "assistant answer" }] },
        ],
      },
    })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    const text = await session.prompt("hello")
    expect(text).toBe("assistant answer")
  })

  it("prompt() skips target assistant metadata without text in message history", async () => {
    const client = makeClient({
      promptResponse: { data: { info: { id: "assistant-1", role: "assistant" } } },
      messageResponse: { info: { id: "assistant-1", role: "assistant" } },
      messagesResponse: {
        data: [
          { info: { id: "assistant-1", role: "assistant" } },
          { info: { id: "assistant-2", role: "assistant" }, parts: [{ type: "text", text: "hydrated answer" }] },
        ],
      },
    })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    const text = await session.prompt("hello")
    expect(text).toBe("hydrated answer")
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

  it("prompt() explicitly requests a reply", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    await session.prompt("my prompt")
    const call = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    const body = (call as any)?.[0]?.body
    expect(body.noReply).toBe(false)
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

  it("uses SDK-compatible session.create body only", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    await dispatcher.createSession({ title: "test", agent: "workflow-reviewer", parentId: "parent-1", model: { modelID: "claude-3", providerID: "anthropic" } })
    const call = (client.session.create as ReturnType<typeof mock>).mock.calls[0]
    expect((call as any)?.[0]?.body).toEqual({ title: "test", parentID: "parent-1" })
  })

  it("passes agent and full model config in session.prompt body", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer", model: { modelID: "claude-3", providerID: "anthropic" } })
    await session.prompt("hello")
    const call = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    expect((call as any)?.[0]?.body?.agent).toBe("workflow-reviewer")
    expect((call as any)?.[0]?.body?.model).toEqual({ modelID: "claude-3", providerID: "anthropic" })
  })

  it("passes structured response format in session.prompt body", async () => {
    const client = makeClient()
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer" })
    await session.prompt("hello", { responseFormat: { type: "json_schema", schema: { type: "object" } } })
    const call = (client.session.prompt as ReturnType<typeof mock>).mock.calls[0]
    expect((call as any)?.[0]?.body?.format).toEqual({ type: "json_schema", schema: { type: "object" } })
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

  it("retries with a minimal create body when OpenCode returns BadRequest", async () => {
    const client = makeClient({
      createResponses: [
        { error: { _tag: "BadRequest" }, request: {}, response: {} },
        { data: { id: "sess-retry" } },
      ],
    })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)
    const session = await dispatcher.createSession({ title: "test", agent: "workflow-reviewer", parentId: "parent-1", model: "gpt-4" })

    expect(session.id).toBe("sess-retry")
    expect(client.session.create).toHaveBeenCalledTimes(2)
    const retryBody = ((client.session.create as ReturnType<typeof mock>).mock.calls[1] as any)?.[0]?.body
    expect(retryBody).toEqual({ title: "test" })
  })

  it("throws an explicit create failure when all create attempts fail", async () => {
    const client = makeClient({ createResponse: { error: { _tag: "BadRequest" }, request: {}, response: {} } })
    const dispatcher = createOpenCodeSubagentDispatcher(client as any)

    await expect(dispatcher.createSession({ title: "test", agent: "workflow-reviewer" }))
      .rejects.toThrow("test: session.create failed")
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
