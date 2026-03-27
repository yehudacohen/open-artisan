/**
 * pid-file.ts — PID file lifecycle management for the bridge server.
 *
 * Writes `.openartisan/.bridge-pid` on init, removes on shutdown.
 * Detects stale PID files from crashed bridge processes.
 */
import { join } from "node:path"
import { existsSync } from "node:fs"
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises"

const PID_FILENAME = ".bridge-pid"

/**
 * Check if a process is still running.
 * Uses signal 0 which checks existence without sending a signal.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Result of checking an existing PID file.
 */
export interface PidCheckResult {
  /** Whether a bridge process is already running. */
  running: boolean
  /** The PID from the file (if it existed). */
  pid?: number
  /** Whether a stale PID file was cleaned up. */
  staleCleaned?: boolean
}

/**
 * Check for an existing PID file. If it exists and the process is dead,
 * clean it up (stale detection).
 *
 * @param stateDir - Directory containing the PID file (e.g., ".openartisan/")
 * @returns Whether a bridge is already running, and cleanup info.
 */
export async function checkPidFile(stateDir: string): Promise<PidCheckResult> {
  const pidPath = join(stateDir, PID_FILENAME)
  if (!existsSync(pidPath)) {
    return { running: false }
  }

  try {
    const content = await readFile(pidPath, "utf-8")
    const pid = parseInt(content.trim(), 10)
    if (isNaN(pid)) {
      // Corrupt PID file — remove it
      try { await unlink(pidPath) } catch { /* ignore */ }
      return { running: false, staleCleaned: true }
    }

    if (isProcessAlive(pid)) {
      return { running: true, pid }
    }

    // Process is dead — stale PID file
    try { await unlink(pidPath) } catch { /* ignore */ }
    return { running: false, pid, staleCleaned: true }
  } catch {
    // Can't read PID file — remove it
    try { await unlink(pidPath) } catch { /* ignore */ }
    return { running: false, staleCleaned: true }
  }
}

/**
 * Write the current process PID to the PID file.
 *
 * @param stateDir - Directory to write the PID file in.
 */
export async function writePidFile(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, PID_FILENAME), String(process.pid), "utf-8")
}

/**
 * Remove the PID file. Called on graceful shutdown.
 * Best-effort — silently ignores errors.
 *
 * @param stateDir - Directory containing the PID file.
 */
export async function removePidFile(stateDir: string): Promise<void> {
  try {
    await unlink(join(stateDir, PID_FILENAME))
  } catch {
    // Best-effort — file may already be gone
  }
}
