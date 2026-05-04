import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const STATE_DIR_NAME = ".openartisan"
const METADATA_FILE = ".bridge-meta.json"
const LEASES_FILE = ".bridge-clients.json"
const SOCKET_FILE = ".bridge.sock"
const PID_FILE = ".bridge-pid"

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function readPid(metadata: Record<string, unknown>, pidPath: string): number | null {
  if (typeof metadata.pid === "number") return metadata.pid
  try {
    const parsed = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function runtimeArtifactPaths(stateDir: string): string[] {
  return [
    join(stateDir, METADATA_FILE),
    join(stateDir, LEASES_FILE),
    join(stateDir, SOCKET_FILE),
    join(stateDir, PID_FILE),
  ]
}

export function recoverStaleBridgeRuntime(projectDir: string) {
  const stateDir = join(projectDir, STATE_DIR_NAME)
  const metadataPath = join(stateDir, METADATA_FILE)
  const leasesPath = join(stateDir, LEASES_FILE)
  const socketPath = join(stateDir, SOCKET_FILE)
  const pidPath = join(stateDir, PID_FILE)

  const metadata = existsSync(metadataPath) ? readJson(metadataPath) : null
  if (existsSync(metadataPath) && !metadata) {
    return clearPaths("attach_failed", "Bridge metadata is malformed.", runtimeArtifactPaths(stateDir), null)
  }

  if (!metadata) {
    return {
      kind: "no_recovery_needed",
      reason: "No bridge metadata exists; no stale runtime files were cleared.",
      clearedPaths: [],
      discovery: { kind: "no_bridge" },
      pluginReloaded: false,
    }
  }

  const pid = readPid(metadata, pidPath)
  if (pid !== null && !isRunningPid(pid)) {
    return clearPaths(
      "stale_bridge_state",
      "Bridge metadata exists but the recorded bridge process is not running.",
      runtimeArtifactPaths(stateDir),
      pid,
    )
  }

  const metadataSocketPath = typeof metadata.socketPath === "string" && metadata.socketPath
    ? metadata.socketPath
    : socketPath
  if (!existsSync(metadataSocketPath)) {
    return clearPaths(
      "stale_bridge_state",
      "Bridge process is running but the shared bridge socket is missing.",
      [metadataPath, leasesPath, pidPath],
      pid,
    )
  }

  return {
    kind: "no_recovery_needed",
    reason: "Bridge metadata points at a live compatible bridge; no stale runtime files were cleared.",
    clearedPaths: [],
    discovery: { kind: "live_compatible_bridge", previousPid: pid },
    pluginReloaded: false,
  }
}

function clearPaths(discoveryKind: string, reason: string, paths: string[], previousPid: number | null) {
  const clearedPaths: string[] = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      rmSync(path, { force: true })
      clearedPaths.push(path)
    } catch {
      // Recovery is best-effort; leave uncleared paths out of clearedPaths.
    }
  }

  return {
    kind: "stale_bridge_recovered",
    reason: "Cleared stale or malformed bridge runtime files. The next oa_* tool call will attach to or start a fresh bridge. This does not hot-reload the already-running Hermes plugin process.",
    clearedPaths,
    discovery: {
      kind: discoveryKind,
      reason,
      ...(previousPid !== null ? { previousPid } : {}),
      stalePaths: paths,
    },
    pluginReloaded: false,
  }
}
