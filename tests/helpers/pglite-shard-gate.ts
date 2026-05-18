import { describe } from "bun:test"

export const RUN_PGLITE_TESTS_ENV = "OPENARTISAN_RUN_PGLITE_TESTS"

export function pgliteShardDescribe(name: string, fn: () => void): void {
  if (process.env[RUN_PGLITE_TESTS_ENV] === "1") {
    describe(name, fn)
    return
  }

  describe.skip(`${name} (requires bun run test:pglite)`, fn)
}
