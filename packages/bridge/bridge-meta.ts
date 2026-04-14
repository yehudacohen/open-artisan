/**
 * bridge-meta.ts - Shared local bridge metadata and lease snapshot persistence.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { BridgeLeaseSnapshot, BridgeMetadata } from "./shared-bridge-types"

export const BRIDGE_METADATA_FILENAME = ".bridge-meta.json"
export const BRIDGE_LEASES_FILENAME = ".bridge-clients.json"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isBridgeMetadata(value: unknown): value is BridgeMetadata {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    typeof value.bridgeInstanceId === "string" &&
    typeof value.projectDir === "string" &&
    typeof value.stateDir === "string" &&
    typeof value.transport === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.protocolVersion === "string" &&
    typeof value.lastHeartbeatAt === "string"
  )
}

function isBridgeLeaseSnapshot(value: unknown): value is BridgeLeaseSnapshot {
  if (!isRecord(value)) return false
  return typeof value.bridgeInstanceId === "string" && Array.isArray(value.clients)
}

async function readJsonFile(path: string): Promise<unknown> {
  const content = await readFile(path, "utf-8")
  return JSON.parse(content) as unknown
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf-8")
}

export function getBridgeMetadataPath(stateDir: string): string {
  return join(stateDir, BRIDGE_METADATA_FILENAME)
}

export function getBridgeLeasesPath(stateDir: string): string {
  return join(stateDir, BRIDGE_LEASES_FILENAME)
}

export async function loadBridgeMetadata(stateDir: string): Promise<BridgeMetadata | null> {
  const path = getBridgeMetadataPath(stateDir)
  if (!existsSync(path)) return null
  try {
    const parsed = await readJsonFile(path)
    return isBridgeMetadata(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function upsertBridgeMetadata(stateDir: string, metadata: BridgeMetadata): Promise<BridgeMetadata> {
  const path = getBridgeMetadataPath(stateDir)
  await mkdir(stateDir, { recursive: true })
  await writeFile(path, JSON.stringify(metadata, null, 2) + "\n", "utf-8")
  return metadata
}

export async function removeBridgeMetadata(stateDir: string): Promise<boolean> {
  const path = getBridgeMetadataPath(stateDir)
  try {
    await rm(path)
    return true
  } catch {
    return false
  }
}

export async function loadBridgeLeaseSnapshot(stateDir: string): Promise<BridgeLeaseSnapshot | null> {
  const path = getBridgeLeasesPath(stateDir)
  if (!existsSync(path)) return null
  try {
    const parsed = await readJsonFile(path)
    return isBridgeLeaseSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function upsertBridgeLeaseSnapshot(stateDir: string, snapshot: BridgeLeaseSnapshot): Promise<BridgeLeaseSnapshot> {
  const path = getBridgeLeasesPath(stateDir)
  await mkdir(stateDir, { recursive: true })
  await writeFile(path, JSON.stringify(snapshot, null, 2) + "\n", "utf-8")
  return snapshot
}

export async function removeBridgeLeaseSnapshot(stateDir: string): Promise<boolean> {
  const path = getBridgeLeasesPath(stateDir)
  try {
    await rm(path)
    return true
  } catch {
    return false
  }
}
