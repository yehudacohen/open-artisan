/**
 * shared-bridge-service.test.ts - T1 tests for shared local bridge metadata
 * and discovery behavior.
 */
import { beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { discoverBridge, removeBridgeState, SHARED_BRIDGE_PROTOCOL_VERSION } from "#bridge/bridge-discovery"
import {
  getBridgeLeasesPath,
  getBridgeMetadataPath,
  loadBridgeLeaseSnapshot,
  loadBridgeMetadata,
  upsertBridgeLeaseSnapshot,
  upsertBridgeMetadata,
} from "#bridge/bridge-meta"
import type { BridgeClientLease, BridgeLeaseSnapshot, BridgeMetadata } from "#bridge/shared-bridge-types"

let projectDir: string
let stateDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "shared-bridge-project-"))
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

function makeLease(clientId: string, clientKind: BridgeClientLease["clientKind"]): BridgeClientLease {
  return {
    clientId,
    clientKind,
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

describe("bridge metadata persistence", () => {
  it("writes and reads bridge metadata", async () => {
    const metadata = makeMetadata()
    await upsertBridgeMetadata(stateDir, metadata)

    expect(await loadBridgeMetadata(stateDir)).toEqual(metadata)
  })

  it("writes and reads bridge lease snapshots", async () => {
    const snapshot = makeLeaseSnapshot([makeLease("claude-1", "claude-code")])
    await upsertBridgeLeaseSnapshot(stateDir, snapshot)

    expect(await loadBridgeLeaseSnapshot(stateDir)).toEqual(snapshot)
  })
})

describe("discoverBridge", () => {
  it("returns no_bridge when no metadata or pid artifacts exist", async () => {
    const result = await discoverBridge({ projectDir, stateDir })
    expect(result.kind).toBe("no_bridge")
  })

  it("returns attach_failed when metadata is malformed", async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(getBridgeMetadataPath(stateDir), "{not-json", "utf-8")

    const result = await discoverBridge({ projectDir, stateDir })
    expect(result.kind).toBe("attach_failed")
  })

  it("returns stale_bridge_state when metadata exists but pid is stale", async () => {
    await upsertBridgeMetadata(stateDir, makeMetadata({ pid: 999999 }))
    await writeFile(join(stateDir, ".bridge-pid"), "999999\n", "utf-8")

    const result = await discoverBridge({ projectDir, stateDir })
    expect(result.kind).toBe("stale_bridge_state")
    if (result.kind === "stale_bridge_state") {
      expect(result.stalePaths.length).toBeGreaterThan(0)
    }
  })

  it("returns live_compatible_bridge with metadata and leases for a reusable bridge", async () => {
    const metadata = makeMetadata()
    const leases = makeLeaseSnapshot([makeLease("claude-1", "claude-code")])
    await upsertBridgeMetadata(stateDir, metadata)
    await upsertBridgeLeaseSnapshot(stateDir, leases)
    await writeFile(join(stateDir, ".bridge-pid"), `${process.pid}\n`, "utf-8")

    const result = await discoverBridge({ projectDir, stateDir })
    expect(result.kind).toBe("live_compatible_bridge")
    if (result.kind === "live_compatible_bridge") {
      expect(result.metadata).toEqual(metadata)
      expect(result.leases).toEqual(leases)
    }
  })

  it("returns live_incompatible_bridge when protocol versions do not match", async () => {
    await upsertBridgeMetadata(stateDir, makeMetadata({ protocolVersion: "999" }))
    await writeFile(join(stateDir, ".bridge-pid"), `${process.pid}\n`, "utf-8")

    const result = await discoverBridge({ projectDir, stateDir })
    expect(result.kind).toBe("live_incompatible_bridge")
  })
})

describe("removeBridgeState", () => {
  it("removes only the requested stale bridge artifacts", async () => {
    await upsertBridgeMetadata(stateDir, makeMetadata())
    await upsertBridgeLeaseSnapshot(stateDir, makeLeaseSnapshot([]))
    await writeFile(join(stateDir, ".bridge.sock"), "sock", "utf-8")

    const result = await removeBridgeState({
      projectDir,
      stateDir,
      targets: ["metadata", "socket"],
      reason: "stale",
    })

    expect(result.removedTargets).toEqual(["metadata", "socket"])
    expect(await loadBridgeMetadata(stateDir)).toBeNull()
    expect(await loadBridgeLeaseSnapshot(stateDir)).not.toBeNull()
  })
})

describe("shared bridge future tasks", () => {
  it.todo("T2 implements attach/detach and lease lifecycle", () => {})
  it.todo("T3 implements shutdown eligibility and service lifetime behavior", () => {})
  it.todo("T4 integrates Claude Code shared-bridge attach behavior", () => {})
  it.todo("T5 integrates Hermes shared-bridge attach behavior", () => {})
  it.todo("T6 verifies full bridge and adapter dogfooding flows", () => {})
})
