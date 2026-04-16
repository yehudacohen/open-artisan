/**
 * state-backend-fs.ts — Filesystem-based StateBackend implementation.
 *
 * Stores per-feature workflow state as JSON files:
 *   <baseDir>/<featureName>/workflow-state.json
 *
 * Cross-process locking via lockfiles:
 *   <baseDir>/<featureName>/.lock  (O_CREAT|O_EXCL, stale-PID detection)
 */
import { dirname, join } from "node:path"
import { existsSync, readdirSync, lstatSync } from "node:fs"
import { open, writeFile, readFile, mkdir, unlink } from "node:fs/promises"
import { validateRoadmapDocument, type RoadmapDocument, type RoadmapResult, type RoadmapStateBackend, type StateBackend } from "./types"
import { LOCK_TIMEOUT_MS, LOCK_POLL_MS } from "./constants"

const STATE_FILE = "workflow-state.json"
const LOCK_FILE = ".lock"
const ROADMAP_NAMESPACE_DIR = "roadmap"
const ROADMAP_STATE_FILE = "roadmap-state.json"
const ROADMAP_SCHEMA_VERSION = 1

export interface FileLockOptions {
  timeoutMs?: number
  pollMs?: number
}

export interface FileSystemRoadmapStateBackendOptions extends FileLockOptions {
  lockTimeoutMs?: number
  lockPollMs?: number
}

// ---------------------------------------------------------------------------
// File-level locking
// ---------------------------------------------------------------------------

/**
 * Check if a process is still running. Uses signal 0 which checks existence
 * without actually sending a signal.
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
 * Acquire a file-level lock for a feature directory.
 *
 * Creates `<baseDir>/<featureName>/.lock` atomically using O_CREAT|O_EXCL.
 * If the lock is held by a dead process, it's automatically cleaned up.
 *
 * @returns A release function that removes the lockfile.
 */
async function acquireFileLock(
  lockDir: string,
  lockName: string,
  options: FileLockOptions = {},
): Promise<{ release(): Promise<void> }> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  await mkdir(lockDir, { recursive: true })
  const lockPath = join(lockDir, LOCK_FILE)
  const startTime = Date.now()

  while (true) {
    try {
      // O_CREAT | O_EXCL — atomic: fails if file already exists
      const handle = await open(lockPath, "wx")
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf-8")
      await handle.close()
      // Lock acquired — return release function
      return {
        async release() {
          try { await unlink(lockPath) } catch { /* best-effort */ }
        },
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw err
      // Lock file exists — check if stale
      try {
        const content = JSON.parse(await readFile(lockPath, "utf-8")) as { pid?: number }
        if (typeof content.pid === "number" && !isProcessAlive(content.pid)) {
          // Owner is dead — remove stale lock and retry immediately
          try { await unlink(lockPath) } catch { /* race with another cleaner — OK */ }
          continue
        }
      } catch {
        // Can't read/parse lock — the owner may be mid-write (file exists
        // but content not yet flushed). Do NOT remove — fall through to
        // the timeout check and poll. If truly corrupt, we'll time out.
      }
      // Lock held by a live process — check timeout
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Failed to acquire file lock for ${lockName} after ${timeoutMs}ms`)
      }
      // Poll
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
}

function roadmapOk<T>(value: T): RoadmapResult<T> {
  return { ok: true, value }
}

function roadmapError(
  code: "not-found" | "invalid-document" | "invalid-slice" | "schema-mismatch" | "lock-timeout" | "storage-failure",
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): RoadmapResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
  }
}

function validatePersistableRoadmapDocument(document: RoadmapDocument): RoadmapResult<RoadmapDocument> {
  if (document.schemaVersion !== ROADMAP_SCHEMA_VERSION) {
    return roadmapError(
      "schema-mismatch",
      `Unsupported roadmap schema version ${document.schemaVersion}; expected ${ROADMAP_SCHEMA_VERSION}`,
      false,
      { schemaVersion: document.schemaVersion },
    )
  }

  const validationError = validateRoadmapDocument(document)
  if (validationError) {
    return roadmapError("invalid-document", validationError, false, { schemaVersion: document.schemaVersion })
  }

  return roadmapOk(document)
}

async function readRoadmapDocument(filePath: string): Promise<RoadmapResult<RoadmapDocument | null>> {
  if (!existsSync(filePath)) return roadmapOk(null)

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown
  } catch (error) {
    return roadmapError(
      "invalid-document",
      error instanceof Error ? error.message : "Failed to parse roadmap document",
      false,
    )
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return roadmapError("invalid-document", "Roadmap document must be a JSON object", false)
  }

  const document = parsed as RoadmapDocument
  const validation = validatePersistableRoadmapDocument(document)
  if (!validation.ok) return validation

  return roadmapOk(document)
}

// ---------------------------------------------------------------------------
// FileSystemStateBackend
// ---------------------------------------------------------------------------

/**
 * Create a filesystem-based StateBackend.
 *
 * @param baseDir - Root directory for per-feature state files (e.g., ".openartisan/").
 */
export function createFileSystemStateBackend(baseDir: string): StateBackend {
  return {
    async read(featureName: string): Promise<string | null> {
      const filePath = join(baseDir, featureName, STATE_FILE)
      if (!existsSync(filePath)) return null
      try {
        return await readFile(filePath, "utf-8")
      } catch {
        return null
      }
    },

    async write(featureName: string, data: string): Promise<void> {
      const dir = join(baseDir, featureName)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, STATE_FILE), data, "utf-8")
    },

    async remove(featureName: string): Promise<void> {
      const filePath = join(baseDir, featureName, STATE_FILE)
      try {
        await unlink(filePath)
      } catch {
        // Best-effort — file may already be gone
      }
    },

    async list(): Promise<string[]> {
      if (!existsSync(baseDir)) return []
      const features: string[] = []
      // Recursive scan — finds state files at any depth (supports nested sub-workflows
      // stored at <parent>/sub/<child>/workflow-state.json).
      // Uses lstatSync (not statSync) to avoid following symlinks (prevents cycles).
      // Max depth guard prevents runaway recursion from pathological directory trees.
      const MAX_SCAN_DEPTH = 10
      function scan(dir: string, prefix: string, depth: number): void {
        if (depth > MAX_SCAN_DEPTH) return
        let entries: string[]
        try { entries = readdirSync(dir) } catch { return }
        for (const entry of entries) {
          if (entry.startsWith(".")) continue // skip hidden dirs (.lock, .git, etc.)
          const fullPath = join(dir, entry)
          try { if (!lstatSync(fullPath).isDirectory()) continue } catch { continue }
          const featurePath = prefix ? `${prefix}/${entry}` : entry
          if (existsSync(join(fullPath, STATE_FILE))) {
            features.push(featurePath)
          }
          scan(fullPath, featurePath, depth + 1)
        }
      }
      scan(baseDir, "", 0)
      return features
    },

    async lock(featureName: string): Promise<{ release(): Promise<void> }> {
      return acquireFileLock(join(baseDir, featureName), `feature "${featureName}"`)
    },
  }
}

/**
 * Create a filesystem-backed RoadmapStateBackend.
 *
 * Stores roadmap state in a separate namespace:
 *   <baseDir>/roadmap/roadmap-state.json
 *
 * Locking is isolated from per-feature workflow locks:
 *   <baseDir>/roadmap/.lock
 */
export function createFileSystemRoadmapStateBackend(
  baseDir: string,
  options: FileSystemRoadmapStateBackendOptions = {},
): RoadmapStateBackend {
  const roadmapDir = join(baseDir, ROADMAP_NAMESPACE_DIR)
  const roadmapPath = join(roadmapDir, ROADMAP_STATE_FILE)

  async function writeRoadmapDocument(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>> {
    const validation = validatePersistableRoadmapDocument(document)
    if (!validation.ok) return validation

    try {
      await mkdir(dirname(roadmapPath), { recursive: true })
      await writeFile(roadmapPath, JSON.stringify(document, null, 2), "utf-8")
      return roadmapOk(document)
    } catch (error) {
      return roadmapError(
        "storage-failure",
        error instanceof Error ? error.message : "Failed to persist roadmap document",
        true,
      )
    }
  }

  return {
    async createRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>> {
      return writeRoadmapDocument(document)
    },

    async readRoadmap(): Promise<RoadmapResult<RoadmapDocument | null>> {
      try {
        return await readRoadmapDocument(roadmapPath)
      } catch (error) {
        return roadmapError(
          "storage-failure",
          error instanceof Error ? error.message : "Failed to read roadmap document",
          true,
        )
      }
    },

    async updateRoadmap(document: RoadmapDocument): Promise<RoadmapResult<RoadmapDocument>> {
      return writeRoadmapDocument(document)
    },

    async deleteRoadmap(): Promise<RoadmapResult<null>> {
      try {
        await unlink(roadmapPath)
      } catch (error) {
        const errno = error as NodeJS.ErrnoException
        if (errno.code !== "ENOENT") {
          return roadmapError(
            "storage-failure",
            error instanceof Error ? error.message : "Failed to delete roadmap document",
            true,
          )
        }
      }

      return roadmapOk(null)
    },

    async lockRoadmap(): Promise<RoadmapResult<{ release(): Promise<void> }>> {
      try {
        const lockOptions: FileLockOptions = {}
        const timeoutMs = options.lockTimeoutMs ?? options.timeoutMs
        const pollMs = options.lockPollMs ?? options.pollMs
        if (timeoutMs !== undefined) {
          lockOptions.timeoutMs = timeoutMs
        }
        if (pollMs !== undefined) {
          lockOptions.pollMs = pollMs
        }

        return roadmapOk(await acquireFileLock(roadmapDir, "roadmap namespace", lockOptions))
      } catch (error) {
        if (error instanceof Error && error.message.includes("Failed to acquire file lock")) {
          return roadmapError("lock-timeout", error.message, true)
        }
        return roadmapError(
          "storage-failure",
          error instanceof Error ? error.message : "Failed to acquire roadmap lock",
          true,
        )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Legacy migration utility
// ---------------------------------------------------------------------------

/**
 * Migrate a legacy single-file state store to per-feature files via a StateBackend.
 *
 * Reads the legacy `.opencode/workflow-state.json` (Record<sessionId, state>),
 * writes each session with a featureName to the backend, then deletes the legacy file.
 * Sessions without featureName are returned for in-memory-only loading.
 *
 * @returns Feature names that were migrated (for logging/debugging).
 */
export async function migrateLegacyStateFile(
  backend: StateBackend,
  legacyFilePath: string,
): Promise<{ migrated: string[]; memoryOnly: Array<{ id: string; raw: string }> }> {
  const migrated: string[] = []
  const memoryOnly: Array<{ id: string; raw: string }> = []

  if (!existsSync(legacyFilePath)) return { migrated, memoryOnly }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(legacyFilePath, "utf-8")) as Record<string, unknown>
  } catch {
    // Corrupt legacy file — skip migration
    return { migrated, memoryOnly }
  }

  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue
    const obj = value as Record<string, unknown>
    const featureName = obj["featureName"]
    if (typeof featureName === "string" && featureName) {
      // Check if backend already has state for this feature (per-feature file takes precedence)
      const existing = await backend.read(featureName)
      if (existing !== null) continue
      // Write to backend via the lock
      const { release } = await backend.lock(featureName)
      try {
        await backend.write(featureName, JSON.stringify(value, null, 2))
      } finally {
        await release()
      }
      migrated.push(featureName)
    } else {
      // No featureName — return for memory-only loading
      memoryOnly.push({ id, raw: JSON.stringify(value) })
    }
  }

  // Delete legacy file after successful migration
  try {
    await unlink(legacyFilePath)
  } catch {
    // Best-effort
  }

  return { migrated, memoryOnly }
}
