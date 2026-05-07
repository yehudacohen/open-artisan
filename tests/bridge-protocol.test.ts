/**
 * Tests for bridge protocol — application error codes and method types.
 *
 * JSON-RPC 2.0 protocol handling is tested by the json-rpc-2.0 library.
 * We only test our application-level types and error codes.
 */
import { describe, expect, it } from "bun:test"
import {
  NOT_INITIALIZED,
  SESSION_NOT_FOUND,
  INVALID_STATE,
  SUBAGENT_UNAVAILABLE,
} from "#bridge/protocol"
import { validateBridgeMethodParams } from "#bridge/protocol-validation"

describe("Bridge error codes", () => {
  it("defines application error codes in the -32000 range", () => {
    expect(NOT_INITIALIZED).toBe(-32000)
    expect(SESSION_NOT_FOUND).toBe(-32001)
    expect(INVALID_STATE).toBe(-32002)
    expect(SUBAGENT_UNAVAILABLE).toBe(-32003)
  })
})

describe("Bridge method param validation", () => {
  it("rejects invalid tool.execute envelopes", () => {
    expect(() => validateBridgeMethodParams("tool.execute", {
      name: "select_mode",
      args: {},
      context: {},
    })).toThrow("context.sessionId")
  })

  it("passes through unknown internal methods", () => {
    const params = { arbitrary: true }
    expect(validateBridgeMethodParams("internal.method", params)).toBe(params)
  })
})
