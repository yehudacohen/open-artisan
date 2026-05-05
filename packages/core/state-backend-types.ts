/**
 * state-backend-types.ts — persistence backend contracts.
 */

/**
 * Structured persistence error contract for legacy thrown StateBackend failures.
 *
 * Decision note: existing runtime code currently throws at this seam instead of
 * returning a result union. The interface therefore documents the thrown error
 * shape explicitly without changing the established runtime contract in this phase.
 */
export interface StateBackendError {
  code: "STATE_BACKEND_IO_ERROR" | "STATE_BACKEND_LOCK_ERROR"
  message: string
  retryable: boolean
  cause?: unknown
}

/**
 * Low-level persistence backend for per-feature workflow state.
 *
 * Implementations handle storage I/O and cross-process locking.
 * The SessionStateStore layer above handles in-memory caching, schema
 * migration, validation, and in-process serialization.
 */
export interface StateBackend {
  /**
   * Release backend-owned resources. Optional because filesystem backends do not
   * keep persistent handles open.
   */
  dispose?(): Promise<void>

  /**
   * Read raw JSON for a feature. Returns null if not found.
   * @throws StateBackendError when storage I/O fails.
   */
  read(featureName: string): Promise<string | null>

  /**
   * Write raw JSON for a feature. Creates storage location if needed.
   * @throws StateBackendError when storage I/O fails.
   */
  write(featureName: string, data: string): Promise<void>

  /**
   * Remove stored state for a feature. No-op if not found.
   * @throws StateBackendError when storage I/O fails.
   */
  remove(featureName: string): Promise<void>

  /**
   * List all feature names that have persisted state.
   * @throws StateBackendError when storage I/O fails.
   */
  list(): Promise<string[]>

  /**
   * Acquire an exclusive lock for a feature.
   * Returns a release function that must be called when done.
   * Implementations may use lockfiles, database locks, etc.
   * @throws StateBackendError when locking fails.
   */
  lock(featureName: string): Promise<{ release(): Promise<void> }>
}
