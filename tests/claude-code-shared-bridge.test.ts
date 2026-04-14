/**
 * claude-code-shared-bridge.test.ts — Interface-first tests for Claude Code's
 * shared-bridge usage contract.
 *
 * These tests depend only on approved shared-bridge interfaces and should fail
 * until the adapter wiring exists.
 */
import { beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"

import type {
  BridgeAttachParams,
  BridgeAttachRpcResult,
  BridgeDetachParams,
  BridgeDetachResult,
  BridgeDiscoverParams,
  BridgeDiscoverResult,
  BridgeShutdownEligibilityParams,
  BridgeShutdownEligibilityResult,
} from "#bridge/protocol"

interface ClaudeSharedBridgeContract {
  discover(params: BridgeDiscoverParams): Promise<BridgeDiscoverResult>
  attach(params: BridgeAttachParams): Promise<BridgeAttachRpcResult>
  detach(params: BridgeDetachParams): Promise<BridgeDetachResult>
  shutdownEligibility(
    params: BridgeShutdownEligibilityParams,
  ): Promise<BridgeShutdownEligibilityResult>
}

function makeClaudeSharedBridge(): ClaudeSharedBridgeContract {
  throw new Error("Claude shared-bridge contract not implemented")
}

let projectDir: string
let stateDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "claude-shared-contract-"))
  stateDir = join(projectDir, ".openartisan")
})

describe("Claude Code shared bridge contract", () => {
  it("discovers and reuses a compatible local bridge instead of starting a second one", async () => {
    const bridge = makeClaudeSharedBridge()

    const discovered = await bridge.discover({ projectDir, stateDir })
    expect(discovered.discovery.kind).toBe("live_compatible_bridge")

    const attached = await bridge.attach({
      projectDir,
      stateDir,
      clientId: "claude-a",
      clientKind: "claude-code",
      sessionId: "claude-session-a",
    })
    expect(attached.attach.kind).toBe("attached_existing")
  })

  it("starts and attaches when the socket bridge is unavailable", async () => {
    const bridge = makeClaudeSharedBridge()

    const attached = await bridge.attach({
      projectDir,
      stateDir,
      clientId: "claude-b",
      clientKind: "claude-code",
      sessionId: "claude-session-b",
    })

    expect(attached.attach.kind).toBe("started_new_and_attached")
  })

  it("treats stale socket state as recoverable instead of live ownership", async () => {
    const bridge = makeClaudeSharedBridge()

    const discovered = await bridge.discover({ projectDir, stateDir })

    expect(discovered.discovery.kind).toBe("stale_bridge_state")
  })

  it("fails cleanly when attach experiences transport timeout", async () => {
    const bridge = makeClaudeSharedBridge()

    const attached = await bridge.attach({
      projectDir,
      stateDir,
      clientId: "claude-timeout",
      clientKind: "claude-code",
      sessionId: "claude-timeout-session",
      capabilities: {
        supportsReconnect: true,
      },
    })

    expect(attached.attach.kind).toBe("failed_attach")
  })

  it("does not let one Claude client shutdown a bridge still used by another client", async () => {
    const bridge = makeClaudeSharedBridge()

    const detached = await bridge.detach({
      projectDir,
      stateDir,
      clientId: "claude-a",
      reason: "disconnect",
    })

    expect(detached.shutdownEligibility.allowed).toBe(false)
  })

  it("reports shutdown eligibility when the last Claude client exits", async () => {
    const bridge = makeClaudeSharedBridge()

    const eligibility = await bridge.shutdownEligibility({ projectDir, stateDir })

    expect(eligibility.eligibility.activeClientCount).toBe(0)
  })
})
