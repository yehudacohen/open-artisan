/**
 * run-test-shard.ts — deterministic test shard file selection.
 *
 * Bun's path-ignore behavior has proven unreliable for this repo's mixed root
 * and package test layout, so shards pass explicit file lists to `bun test`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const PGLITE_FILES = [
  "packages/bridge/tests/roadmap-tool-execute.test.ts",
  "packages/core/tests/pglite-connection-manager.test.ts",
  "tests/open-artisan-repository-pglite.test.ts",
  "tests/patch-suggestion-application.test.ts",
  "packages/core/tests/roadmap-state-backend-pglite.test.ts",
  "packages/core/tests/roadmap-repository-pglite.test.ts",
]

const PGLITE_IMPORT_PATTERNS = [
  /@electric-sql\/pglite/,
  /createPGlite\w*/,
  /PGlite\w*/,
  /open-artisan-repository-pglite/,
  /roadmap-repository-pglite/,
]

function listTests(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTests(path))
    } else if (entry.isFile() && path.endsWith(".test.ts")) {
      files.push(path)
    }
  }
  return files.sort()
}

function existing(files: string[]): string[] {
  return files.filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile())
}

function shardFiles(shard: string): string[] {
  const pgliteFiles = new Set(PGLITE_FILES)
  switch (shard) {
    case "root":
      return listTests("tests").filter((file) => !pgliteFiles.has(file))
    case "bridge":
      return listTests("packages/bridge/tests").filter((file) => !pgliteFiles.has(file))
    case "core":
      return listTests("packages/core/tests").filter((file) => !pgliteFiles.has(file))
    case "pglite":
      return existing(PGLITE_FILES)
    default:
      throw new Error(`Unknown test shard "${shard}". Expected root, bridge, core, or pglite.`)
  }
}

function assertPGliteShardIsComplete(): void {
  const known = new Set(PGLITE_FILES)
  const testRoots = ["tests", "packages/core/tests", "packages/bridge/tests"]
  const offenders = testRoots
    .flatMap(listTests)
    .filter((file) => !known.has(file))
    .filter((file) => {
      const source = readFileSync(file, "utf-8")
      return PGLITE_IMPORT_PATTERNS.some((pattern) => pattern.test(source))
    })

  if (offenders.length > 0) {
    throw new Error(
      `PGlite-using tests must be listed in PGLITE_FILES so they run in the pglite shard:\n${offenders.join("\n")}`,
    )
  }
}

const shard = process.argv[2]
if (!shard) throw new Error("Usage: bun run tools/run-test-shard.ts <root|bridge|core|pglite>")
const passthrough = process.argv.slice(3)
assertPGliteShardIsComplete()

const files = shardFiles(shard)
if (files.length === 0) throw new Error(`No test files selected for shard "${shard}"`)

const args = ["test", "--timeout", "90000"]
if (shard === "pglite") args.push("--max-concurrency", "2")
args.push(...passthrough)
args.push(...files)

console.log(`Running ${shard} shard (${files.length} files)`)
const proc = Bun.spawn(["bun", ...args], { stdout: "inherit", stderr: "inherit" })
process.exit(await proc.exited)
