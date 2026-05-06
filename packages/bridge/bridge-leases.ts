/**
 * bridge-leases.ts - Shared local bridge client lease persistence.
 */
import {
  loadBridgeLeaseSnapshot,
  loadBridgeMetadata,
  upsertBridgeLeaseSnapshot,
} from "./bridge-meta"
import type {
  BridgeClientLease,
  BridgeLeaseSnapshot,
  RefreshBridgeClientLeaseParams,
  RemoveBridgeClientLeaseParams,
  RemoveBridgeClientLeaseResult,
  UpsertBridgeClientLeaseParams,
  UpsertBridgeClientLeaseResult,
} from "./shared-bridge-types"

function buildSnapshot(bridgeInstanceId: string, clients: BridgeClientLease[]): BridgeLeaseSnapshot {
  return { bridgeInstanceId, clients }
}

const leaseWriteQueues = new Map<string, Promise<void>>()

async function withLeaseWriteLock<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  const previous = leaseWriteQueues.get(stateDir) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => {}).then(() => current)
  leaseWriteQueues.set(stateDir, queued)
  await previous.catch(() => {})
  try {
    return await run()
  } finally {
    release()
    if (leaseWriteQueues.get(stateDir) === queued) leaseWriteQueues.delete(stateDir)
  }
}

export function createBridgeLeaseStore(bridgeInstanceId: string, initialClients: BridgeClientLease[] = []) {
  let snapshot = buildSnapshot(bridgeInstanceId, [...initialClients])

  return {
    upsert(lease: BridgeClientLease): BridgeClientLease {
      const idx = snapshot.clients.findIndex((client) => client.clientId === lease.clientId)
      if (idx >= 0) snapshot.clients[idx] = lease
      else snapshot.clients.push(lease)
      return lease
    },
    remove(clientId: string): boolean {
      const before = snapshot.clients.length
      snapshot.clients = snapshot.clients.filter((client) => client.clientId !== clientId)
      return snapshot.clients.length !== before
    },
    refresh(clientId: string, observedAt: string): BridgeClientLease | null {
      const lease = snapshot.clients.find((client) => client.clientId === clientId)
      if (!lease) return null
      lease.lastSeenAt = observedAt
      return lease
    },
    snapshot(): BridgeLeaseSnapshot {
      return buildSnapshot(snapshot.bridgeInstanceId, [...snapshot.clients])
    },
  }
}

export async function upsertBridgeClientLease(
  params: UpsertBridgeClientLeaseParams,
): Promise<UpsertBridgeClientLeaseResult> {
  return withLeaseWriteLock(params.stateDir, async () => {
  const existing = await loadBridgeLeaseSnapshot(params.stateDir)
  const metadata = existing ? null : await loadBridgeMetadata(params.stateDir)
  const store = createBridgeLeaseStore(
    existing?.bridgeInstanceId ?? metadata?.bridgeInstanceId ?? params.lease.clientId,
    existing?.clients ?? [],
  )
  const lease = store.upsert(params.lease)
  const snapshot = store.snapshot()
  await upsertBridgeLeaseSnapshot(params.stateDir, snapshot)
  return { lease, leases: snapshot }
  })
}

export async function refreshBridgeClientLease(
  params: RefreshBridgeClientLeaseParams,
): Promise<{ lease?: BridgeClientLease; leases: BridgeLeaseSnapshot }> {
  return withLeaseWriteLock(params.stateDir, async () => {
  const existing = await loadBridgeLeaseSnapshot(params.stateDir)
  const store = createBridgeLeaseStore(existing?.bridgeInstanceId ?? params.clientId, existing?.clients ?? [])
  const lease = store.refresh(params.clientId, params.observedAt) ?? undefined
  const snapshot = store.snapshot()
  await upsertBridgeLeaseSnapshot(params.stateDir, snapshot)
  return lease ? { lease, leases: snapshot } : { leases: snapshot }
  })
}

export async function removeBridgeClientLease(
  params: RemoveBridgeClientLeaseParams,
): Promise<RemoveBridgeClientLeaseResult> {
  return withLeaseWriteLock(params.stateDir, async () => {
  const existing = await loadBridgeLeaseSnapshot(params.stateDir)
  const store = createBridgeLeaseStore(existing?.bridgeInstanceId ?? params.clientId, existing?.clients ?? [])
  const removed = store.remove(params.clientId)
  const snapshot = store.snapshot()
  await upsertBridgeLeaseSnapshot(params.stateDir, snapshot)
  return { removed, leases: snapshot }
  })
}
