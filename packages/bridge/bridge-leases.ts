/**
 * bridge-leases.ts - Shared local bridge client lease persistence.
 */
import {
  loadBridgeLeaseSnapshot,
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
  const existing = await loadBridgeLeaseSnapshot(params.stateDir)
  const store = createBridgeLeaseStore(
    existing?.bridgeInstanceId ?? params.lease.clientId,
    existing?.clients ?? [],
  )
  const lease = store.upsert(params.lease)
  const snapshot = store.snapshot()
  await upsertBridgeLeaseSnapshot(params.stateDir, snapshot)
  return { lease, leases: snapshot }
}

export async function refreshBridgeClientLease(
  params: RefreshBridgeClientLeaseParams,
): Promise<{ lease?: BridgeClientLease; leases: BridgeLeaseSnapshot }> {
  const existing = await loadBridgeLeaseSnapshot(params.stateDir)
  const store = createBridgeLeaseStore(existing?.bridgeInstanceId ?? params.clientId, existing?.clients ?? [])
  const lease = store.refresh(params.clientId, params.observedAt) ?? undefined
  const snapshot = store.snapshot()
  await upsertBridgeLeaseSnapshot(params.stateDir, snapshot)
  return lease ? { lease, leases: snapshot } : { leases: snapshot }
}

export async function removeBridgeClientLease(
  params: RemoveBridgeClientLeaseParams,
): Promise<RemoveBridgeClientLeaseResult> {
  const existing = await loadBridgeLeaseSnapshot(params.stateDir)
  const store = createBridgeLeaseStore(existing?.bridgeInstanceId ?? params.clientId, existing?.clients ?? [])
  const removed = store.remove(params.clientId)
  const snapshot = store.snapshot()
  await upsertBridgeLeaseSnapshot(params.stateDir, snapshot)
  return { removed, leases: snapshot }
}
