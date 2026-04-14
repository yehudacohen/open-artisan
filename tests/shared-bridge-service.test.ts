/**
 * shared-bridge-service.test.ts — Interface-first contract tests for shared
 * local bridge discovery, attach-or-start, lease tracking, cleanup, and
 * shutdown behavior.
 *
 * These tests intentionally target the approved interfaces only. They should
 * fail until concrete implementations are wired to the interface contract.
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
  BridgeLeaseRefreshParams,
  BridgeLeaseRefreshResult,
  BridgeLeaseRemoveParams,
  BridgeLeaseRemoveResult,
  BridgeLeaseUpsertParams,
  BridgeLeaseUpsertResult,
  BridgeMetadataGetParams,
  BridgeMetadataGetResult,
  BridgeMetadataUpsertParams,
  BridgeMetadataUpsertResult,
  BridgeShutdownEligibilityParams,
  BridgeShutdownEligibilityResult,
  BridgeStateRemoveParams,
  BridgeStateRemoveResultRpc,
} from "#bridge/protocol"
import type {
  BridgeClientLease,
  BridgeLeaseSnapshot,
  BridgeMetadata,
} from "#bridge/shared-bridge-types"

interface SharedBridgeRpcContract {
  discover(params: BridgeDiscoverParams): Promise<BridgeDiscoverResult>
  attach(params: BridgeAttachParams): Promise<BridgeAttachRpcResult>
  leaseRefresh(params: BridgeLeaseRefreshParams): Promise<BridgeLeaseRefreshResult>
  detach(params: BridgeDetachParams): Promise<BridgeDetachResult>
  metadataGet(params: BridgeMetadataGetParams): Promise<BridgeMetadataGetResult>
  shutdownEligibility(
    params: BridgeShutdownEligibilityParams,
  ): Promise<BridgeShutdownEligibilityResult>
  metadataUpsert(
    params: BridgeMetadataUpsertParams,
  ): Promise<BridgeMetadataUpsertResult>
  leaseUpsert(params: BridgeLeaseUpsertParams): Promise<BridgeLeaseUpsertResult>
  leaseRemove(params: BridgeLeaseRemoveParams): Promise<BridgeLeaseRemoveResult>
  stateRemove(params: BridgeStateRemoveParams): Promise<BridgeStateRemoveResultRpc>
}

function makeSharedBridgeRpc(): SharedBridgeRpcContract {
  throw new Error("shared bridge RPC contract not implemented")
}

let projectDir: string
let stateDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "shared-bridge-contract-"))
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
    pid: 123,
    startedAt: "2026-04-14T12:00:00.000Z",
    protocolVersion: "1",
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

// ---------------------------------------------------------------------------
// bridge.discover
// ---------------------------------------------------------------------------

describe("shared bridge RPC — discover", () => {
  it("classifies an empty state directory as no_bridge", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeDiscoverParams = { projectDir, stateDir }

    const result = await rpc.discover(params)

    expect(result.discovery.kind).toBe("no_bridge")
  })

  it("classifies stale pid/socket artifacts as stale_bridge_state", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.discover({ projectDir, stateDir })

    expect(result.discovery.kind).toBe("stale_bridge_state")
    if (result.discovery.kind === "stale_bridge_state") {
      expect(result.discovery.stalePaths.length).toBeGreaterThan(0)
    }
  })

  it("returns live_compatible_bridge with metadata and leases for a reusable bridge", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.discover({ projectDir, stateDir })

    expect(result.discovery.kind).toBe("live_compatible_bridge")
    if (result.discovery.kind === "live_compatible_bridge") {
      expect(result.discovery.metadata).toEqual(makeMetadata())
      expect(result.discovery.leases.clients).toEqual([
        makeLease("claude-1", "claude-code"),
      ])
    }
  })

  it("returns live_incompatible_bridge when protocol versions do not match", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.discover({ projectDir, stateDir })

    expect(result.discovery.kind).toBe("live_incompatible_bridge")
    if (result.discovery.kind === "live_incompatible_bridge") {
      expect(result.discovery.reason).toContain("protocol")
    }
  })

  it("surfaces malformed metadata as attach_failed instead of attaching unsafely", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.discover({ projectDir, stateDir })

    expect(result.discovery.kind).toBe("attach_failed")
  })
})

// ---------------------------------------------------------------------------
// bridge.attach
// ---------------------------------------------------------------------------

describe("shared bridge RPC — attach", () => {
  it("attaches to an existing compatible bridge", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeAttachParams = {
      projectDir,
      stateDir,
      clientId: "claude-1",
      clientKind: "claude-code",
      sessionId: "claude-session-1",
    }

    const result = await rpc.attach(params)

    expect(result.attach.kind).toBe("attached_existing")
  })

  it("starts a new bridge and attaches when no bridge exists", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.attach({
      projectDir,
      stateDir,
      clientId: "hermes-1",
      clientKind: "hermes",
      sessionId: "hermes-session-1",
    })

    expect(result.attach.kind).toBe("started_new_and_attached")
  })

  it("rejects an incompatible live bridge instead of taking it over", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.attach({
      projectDir,
      stateDir,
      clientId: "claude-2",
      clientKind: "claude-code",
      sessionId: "claude-session-2",
    })

    expect(result.attach.kind).toBe("rejected_incompatible_bridge")
  })

  it("returns failed_attach on transport/network failure", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.attach({
      projectDir,
      stateDir,
      clientId: "claude-timeout",
      clientKind: "claude-code",
      sessionId: "timeout-session",
      capabilities: {
        supportsReconnect: true,
      },
    })

    expect(result.attach.kind).toBe("failed_attach")
  })
})

// ---------------------------------------------------------------------------
// metadata CRUD
// ---------------------------------------------------------------------------

describe("shared bridge RPC — metadata CRUD", () => {
  it("upserts sanitized metadata without secrets", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeMetadataUpsertParams = {
      metadata: makeMetadata(),
    }

    const result = await rpc.metadataUpsert(params)

    expect(result.metadata).toEqual(makeMetadata())
    expect("token" in result.metadata).toBe(false)
    expect("secret" in result.metadata).toBe(false)
  })

  it("reads metadata and leases for operational inspection", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeMetadataGetParams = { projectDir, stateDir }

    const result = await rpc.metadataGet(params)

    expect(result.metadata).toEqual(makeMetadata())
    expect(result.leases).toEqual(makeLeaseSnapshot([makeLease("claude-1", "claude-code")]))
  })

  it("rejects malformed metadata input rather than persisting it", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeMetadataUpsertParams = {
      metadata: makeMetadata({ protocolVersion: "" }),
    }

    await expect(rpc.metadataUpsert(params)).rejects.toThrow("protocolVersion")
  })
})

// ---------------------------------------------------------------------------
// lease CRUD + refresh
// ---------------------------------------------------------------------------

describe("shared bridge RPC — lease lifecycle", () => {
  it("upserts a newly attached client lease", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeLeaseUpsertParams = {
      projectDir,
      stateDir,
      lease: makeLease("claude-1", "claude-code"),
    }

    const result = await rpc.leaseUpsert(params)

    expect(result.lease.clientId).toBe("claude-1")
  })

  it("refreshes an existing client lease heartbeat", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeLeaseRefreshParams = {
      projectDir,
      stateDir,
      clientId: "claude-1",
      observedAt: "2026-04-14T12:02:00.000Z",
    }

    const result = await rpc.leaseRefresh(params)

    expect(result.lease?.lastSeenAt).toBe("2026-04-14T12:02:00.000Z")
  })

  it("handles boundary lease counts when many clients are attached", async () => {
    const rpc = makeSharedBridgeRpc()
    const clients = Array.from({ length: 32 }, (_, index) =>
      makeLease(`client-${index}`, index % 2 === 0 ? "claude-code" : "hermes"),
    )

    const result = await rpc.leaseUpsert({
      projectDir,
      stateDir,
      lease: clients.at(-1)!,
    })

    expect(result.leases.clients.length).toBeGreaterThan(0)
  })

  it("removes only the target client lease", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeLeaseRemoveParams = {
      projectDir,
      stateDir,
      clientId: "claude-1",
      reason: "disconnect",
    }

    const result = await rpc.leaseRemove(params)

    expect(result.removed).toBe(true)
  })

  it("fails cleanly when lease refresh targets an unknown client", async () => {
    const rpc = makeSharedBridgeRpc()

    await expect(
      rpc.leaseRefresh({
        projectDir,
        stateDir,
        clientId: "missing-client",
        observedAt: "2026-04-14T12:03:00.000Z",
      }),
    ).rejects.toThrow("missing-client")
  })
})

// ---------------------------------------------------------------------------
// detach + shutdown eligibility
// ---------------------------------------------------------------------------

describe("shared bridge RPC — detach and shutdown", () => {
  it("detaches one client while leaving the bridge running for others", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeDetachParams = {
      projectDir,
      stateDir,
      clientId: "claude-1",
      reason: "disconnect",
    }

    const result = await rpc.detach(params)

    expect(result.detached).toBe(true)
    expect(result.shutdownEligibility.allowed).toBe(false)
  })

  it("allows shutdown when no clients remain", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeShutdownEligibilityParams = { projectDir, stateDir }

    const result = await rpc.shutdownEligibility(params)

    expect(result.eligibility.allowed).toBe(true)
    expect(result.eligibility.activeClientCount).toBe(0)
  })

  it("blocks shutdown when another client lease is still active", async () => {
    const rpc = makeSharedBridgeRpc()

    const result = await rpc.shutdownEligibility({ projectDir, stateDir })

    expect(result.eligibility.allowed).toBe(false)
    expect(result.eligibility.blockingClientIds.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// state removal
// ---------------------------------------------------------------------------

describe("shared bridge RPC — state removal", () => {
  it("removes only the requested stale artifacts", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeStateRemoveParams = {
      projectDir,
      stateDir,
      targets: ["metadata", "socket"],
      reason: "stale",
    }

    const result = await rpc.stateRemove(params)

    expect(result.removal.removedTargets).toEqual(["metadata", "socket"])
  })

  it("rejects destructive cleanup requests outside the allowed target set", async () => {
    const rpc = makeSharedBridgeRpc()
    const params: BridgeStateRemoveParams = {
      projectDir,
      stateDir,
      targets: ["metadata", "leases", "pid", "socket"],
      reason: "force",
    }

    await expect(rpc.stateRemove(params)).rejects.toThrow("destructive cleanup")
  })

  it("surfaces timeout/degradation when state removal cannot complete", async () => {
    const rpc = makeSharedBridgeRpc()

    await expect(
      rpc.stateRemove({
        projectDir,
        stateDir,
        targets: ["socket"],
        reason: "stale",
      }),
    ).rejects.toThrow("timeout")
  })
})
