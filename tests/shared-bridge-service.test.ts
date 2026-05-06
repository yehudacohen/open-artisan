/**
 * shared-bridge-service.test.ts - T1 tests for shared local bridge metadata
 * and discovery behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import {
  attachOrStartBridgeClient,
  detachBridgeClient,
  evaluateBridgeShutdownEligibility,
} from "#bridge/bridge-clients"
import { discoverBridge, removeBridgeState, SHARED_BRIDGE_PROTOCOL_VERSION } from "#bridge/bridge-discovery"
import {
  getBridgeLeasesPath,
  getBridgeMetadataPath,
  loadBridgeLeaseSnapshot,
  loadBridgeMetadata,
  upsertBridgeLeaseSnapshot,
  upsertBridgeMetadata,
} from "#bridge/bridge-meta"
import { createBridgeLeaseStore, refreshBridgeClientLease, removeBridgeClientLease, upsertBridgeClientLease } from "#bridge/bridge-leases"
import type { BridgeClientLease, BridgeLeaseSnapshot, BridgeMetadata } from "#bridge/shared-bridge-types"

let projectDir: string
let stateDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "shared-bridge-project-"))
  stateDir = join(projectDir, ".openartisan")
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
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

describe("shared bridge attach and lease lifecycle", () => {
  it("creates an in-memory lease store that can upsert, refresh, and remove clients", () => {
    const store = createBridgeLeaseStore("bridge-1")
    store.upsert(makeLease("claude-1", "claude-code"))
    store.upsert(makeLease("hermes-1", "hermes"))
    expect(store.snapshot().clients).toHaveLength(2)
    expect(store.refresh("claude-1", "2026-04-14T12:02:00.000Z")?.lastSeenAt).toBe("2026-04-14T12:02:00.000Z")
    expect(store.remove("hermes-1")).toBe(true)
    expect(store.snapshot().clients).toHaveLength(1)
  })

  it("upserts and refreshes persisted bridge leases", async () => {
    const upserted = await upsertBridgeClientLease({
      projectDir,
      stateDir,
      lease: makeLease("claude-1", "claude-code"),
    })
    expect(upserted.leases.clients).toHaveLength(1)

    const refreshed = await refreshBridgeClientLease({
      projectDir,
      stateDir,
      clientId: "claude-1",
      observedAt: "2026-04-14T12:03:00.000Z",
    })
    expect(refreshed.lease?.lastSeenAt).toBe("2026-04-14T12:03:00.000Z")
  })

  it("attaches to an existing compatible bridge instead of starting a new one", async () => {
    const metadata = makeMetadata()
    await upsertBridgeMetadata(stateDir, metadata)
    await upsertBridgeLeaseSnapshot(stateDir, makeLeaseSnapshot([]))
    await writeFile(join(stateDir, ".bridge-pid"), `${process.pid}\n`, "utf-8")

    const result = await attachOrStartBridgeClient({
      projectDir,
      stateDir,
      clientId: "claude-1",
      clientKind: "claude-code",
      sessionId: "claude-session-1",
    })

    expect(result.kind).toBe("attached_existing")
    if (result.kind !== "attached_existing") throw new Error("Expected attached_existing")
    expect(result.leases.clients).toHaveLength(1)
  })

  it("starts a new bridge and attaches when no bridge exists", async () => {
    const result = await attachOrStartBridgeClient({
      projectDir,
      stateDir,
      clientId: "hermes-1",
      clientKind: "hermes",
      sessionId: "hermes-session-1",
    })

    expect(result.kind).toBe("started_new_and_attached")
    expect(await loadBridgeMetadata(stateDir)).not.toBeNull()
  })

  it("detaches one client without removing the others", async () => {
    await upsertBridgeLeaseSnapshot(stateDir, makeLeaseSnapshot([
      makeLease("claude-1", "claude-code"),
      makeLease("hermes-1", "hermes"),
    ]))

    const result = await detachBridgeClient({
      projectDir,
      stateDir,
      clientId: "claude-1",
      reason: "disconnect",
    })

    expect(result.detached).toBe(true)
    expect(result.leases.clients).toHaveLength(1)
    expect(result.shutdownEligibility.allowed).toBe(false)
    expect(result.shutdownEligibility.blockingClientIds).toEqual(["hermes-1"])
  })

  it("removes a client lease directly", async () => {
    await upsertBridgeLeaseSnapshot(stateDir, makeLeaseSnapshot([makeLease("claude-1", "claude-code")]))
    const result = await removeBridgeClientLease({
      projectDir,
      stateDir,
      clientId: "claude-1",
      reason: "shutdown",
    })
    expect(result.removed).toBe(true)
    expect(result.leases.clients).toHaveLength(0)
  })
})

describe("shared bridge shutdown eligibility", () => {
  it("does not allow shutdown while another client remains attached", () => {
    const eligibility = evaluateBridgeShutdownEligibility(
      makeLeaseSnapshot([
        makeLease("claude-1", "claude-code"),
        makeLease("hermes-1", "hermes"),
      ]),
      "claude-1",
    )

    expect(eligibility.allowed).toBe(false)
    expect(eligibility.blockingClientIds).toEqual(["hermes-1"])
  })

  it("allows shutdown when no active clients remain", () => {
    const eligibility = evaluateBridgeShutdownEligibility(makeLeaseSnapshot([]))
    expect(eligibility.allowed).toBe(true)
    expect(eligibility.activeClientCount).toBe(0)
  })
})

describe("shared bridge future tasks", () => {
  it.todo("T3 implements shutdown eligibility and service lifetime behavior", () => {})
  it.todo("T4 integrates Claude Code shared-bridge attach behavior", () => {})
  it.todo("T5 integrates Hermes shared-bridge attach behavior", () => {})
  it.todo("T6 verifies full bridge and adapter dogfooding flows", () => {})
})
