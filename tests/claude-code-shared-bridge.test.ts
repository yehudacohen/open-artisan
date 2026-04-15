/**
 * Tests for Claude Code's shared-bridge usage contract.
 */
import { beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import {
  attachOrStartSocketBridge,
  detachSocketBridgeClient,
  discoverSharedBridge,
  getSocketShutdownEligibility,
} from "#claude-code/src/socket-transport"
import { upsertBridgeLeaseSnapshot, upsertBridgeMetadata } from "#bridge/bridge-meta"
import { SHARED_BRIDGE_PROTOCOL_VERSION } from "#bridge/bridge-discovery"
import type { BridgeClientLease, BridgeLeaseSnapshot, BridgeMetadata } from "#bridge/shared-bridge-types"

let projectDir: string
let stateDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "claude-shared-contract-"))
  stateDir = join(projectDir, ".openartisan")
})

function makeMetadata(overrides: Partial<BridgeMetadata> = {}): BridgeMetadata {
  return {
    version: 1,
    bridgeInstanceId: "bridge-1",
    projectDir,
    stateDir,
    transport: "unix-socket",
    socketPath: join(stateDir, ".bridge.sock"),
    pid: process.pid,
    startedAt: "2026-04-14T12:00:00.000Z",
    protocolVersion: SHARED_BRIDGE_PROTOCOL_VERSION,
    adapterCompatibility: {
      claudeCode: true,
      hermes: true,
    },
    lastHeartbeatAt: "2026-04-14T12:01:00.000Z",
    ...overrides,
  }
}

function makeLease(clientId: string): BridgeClientLease {
  return {
    clientId,
    clientKind: "claude-code",
    sessionId: `${clientId}-session`,
    attachedAt: "2026-04-14T12:00:00.000Z",
    lastSeenAt: "2026-04-14T12:01:00.000Z",
  }
}

function makeLeaseSnapshot(clients: BridgeClientLease[]): BridgeLeaseSnapshot {
  return {
    bridgeInstanceId: "bridge-1",
    clients,
  }
}

describe("Claude Code shared bridge contract", () => {
  it("discovers and reuses a compatible local bridge instead of starting a second one", async () => {
    await upsertBridgeMetadata(stateDir, makeMetadata())
    await upsertBridgeLeaseSnapshot(stateDir, makeLeaseSnapshot([]))
    await writeFile(join(stateDir, ".bridge-pid"), `${process.pid}\n`, "utf-8")

    const discovered = await discoverSharedBridge({ projectDir, stateDir })
    expect(discovered.discovery.kind).toBe("live_compatible_bridge")

    const attached = await attachOrStartSocketBridge({
      projectDir,
      stateDir,
      clientId: "claude-a",
      clientKind: "claude-code",
      sessionId: "claude-session-a",
    })
    expect(attached.attach.kind).toBe("attached_existing")
  })

  it("starts and attaches when the socket bridge is unavailable", async () => {
    const attached = await attachOrStartSocketBridge({
      projectDir,
      stateDir,
      clientId: "claude-b",
      clientKind: "claude-code",
      sessionId: "claude-session-b",
    })

    expect(attached.attach.kind).toBe("started_new_and_attached")
  })

  it("treats stale socket state as recoverable instead of live ownership", async () => {
    await mkdir(stateDir, { recursive: true })
    await upsertBridgeMetadata(stateDir, makeMetadata({ pid: 999999 }))
    await writeFile(join(stateDir, ".bridge-pid"), "999999\n", "utf-8")

    const discovered = await discoverSharedBridge({ projectDir, stateDir })

    expect(discovered.discovery.kind).toBe("stale_bridge_state")
  })

  it("fails cleanly when attach experiences malformed metadata", async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, ".bridge-meta.json"), "{bad-json", "utf-8")

    const attached = await attachOrStartSocketBridge({
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
    await upsertBridgeLeaseSnapshot(stateDir, makeLeaseSnapshot([
      makeLease("claude-a"),
      {
        ...makeLease("claude-b"),
        clientId: "claude-b",
      },
    ]))

    const detached = await detachSocketBridgeClient({
      projectDir,
      stateDir,
      clientId: "claude-a",
      reason: "disconnect",
    })

    expect(detached.shutdownEligibility.allowed).toBe(false)
    expect(detached.shutdownEligibility.blockingClientIds).toEqual(["claude-b"])
  })

  it("reports shutdown eligibility when the last Claude client exits", async () => {
    await upsertBridgeLeaseSnapshot(stateDir, makeLeaseSnapshot([]))

    const eligibility = await getSocketShutdownEligibility({ projectDir, stateDir })

    expect(eligibility.eligibility.activeClientCount).toBe(0)
    expect(eligibility.eligibility.allowed).toBe(true)
  })
})
