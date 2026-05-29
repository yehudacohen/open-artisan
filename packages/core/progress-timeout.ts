export interface ProgressTimeoutPolicy {
  label: string
  idleTimeoutMs: number
  hardTimeoutMs: number
}

export interface ProgressTimeoutSignal {
  progress(message?: string): void
}

export interface ProgressTimeoutRunOptions<T> {
  policy: ProgressTimeoutPolicy
  run(signal: ProgressTimeoutSignal): Promise<T>
  onIdleTimeout?(lastProgressAt: number): Promise<void> | void
  onHardTimeout?(lastProgressAt: number): Promise<void> | void
}

function timeoutError(label: string, kind: "idle" | "hard", elapsedMs: number): Error {
  return new Error(`${label} ${kind} timeout after ${elapsedMs}ms`)
}

function isSyntheticHeartbeat(message?: string): boolean {
  if (!message) return false
  const normalized = message.trim().toLowerCase()
  return normalized === "reviewer prompt still running" || normalized === "still running" || normalized === "heartbeat"
}

/**
 * Runs work with an extendable idle timeout and a non-extendable hard cap.
 * Callers should report only meaningful progress; every progress call resets
 * the idle timer, but never extends beyond the hard timeout.
 */
export function runWithProgressTimeout<T>(options: ProgressTimeoutRunOptions<T>): Promise<T> {
  const startedAt = Date.now()
  let lastProgressAt = startedAt
  let settled = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let hardTimer: ReturnType<typeof setTimeout> | null = null

  return new Promise<T>((resolve, reject) => {
    function clearTimers(): void {
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
      idleTimer = null
      hardTimer = null
    }

    function fail(error: Error, cleanup?: (lastProgressAt: number) => Promise<void> | void): void {
      if (settled) return
      settled = true
      clearTimers()
      Promise.resolve(cleanup?.(lastProgressAt)).catch(() => {}).finally(() => reject(error))
    }

    function armIdleTimer(): void {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        fail(timeoutError(options.policy.label, "idle", Date.now() - lastProgressAt), options.onIdleTimeout)
      }, options.policy.idleTimeoutMs)
    }

    hardTimer = setTimeout(() => {
      fail(timeoutError(options.policy.label, "hard", Date.now() - startedAt), options.onHardTimeout)
    }, options.policy.hardTimeoutMs)
    armIdleTimer()

    const signal: ProgressTimeoutSignal = {
      progress(message?: string) {
        if (settled) return
        if (isSyntheticHeartbeat(message)) return
        lastProgressAt = Date.now()
        armIdleTimer()
      },
    }

    options.run(signal).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimers()
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimers()
        reject(error)
      },
    )
  })
}
