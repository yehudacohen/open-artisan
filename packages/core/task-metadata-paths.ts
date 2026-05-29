import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"

const COMMAND_PREFIXES = [
  /^bun(?:\s|$)/,
  /^bunx(?:\s|$)/,
  /^npm(?:\s|$)/,
  /^npx(?:\s|$)/,
  /^pnpm(?:\s|$)/,
  /^yarn(?:\s|$)/,
  /^node(?:\s|$)/,
  /^deno(?:\s|$)/,
  /^uv\s+run(?:\s|$)/,
  /^poetry\s+run(?:\s|$)/,
  /^python3?(?:\s+-m\s+pytest|\s+.*\bpytest\b|\s|$)/,
  /^pytest(?:\s|$)/,
  /^vitest(?:\s|$)/,
  /^jest(?:\s|$)/,
  /^mocha(?:\s|$)/,
  /^go\s+test(?:\s|$)/,
  /^cargo\s+(?:test|check|build|clippy)(?:\s|$)/,
  /^make(?:\s|$)/,
  /^just(?:\s|$)/,
  /^mvn(?:\s|$)/,
  /^gradle(?:\s|$)/,
  /^\.\/gradlew(?:\s|$)/,
]

const FILE_ARGUMENT_RE = /["']([^"']+\.[A-Za-z0-9][A-Za-z0-9._-]*)["']|([^\s"'`]+\.[A-Za-z0-9][A-Za-z0-9._-]*)/g

function cleanTaskMetadataEntry(entry: string): string {
  return entry.trim().replace(/^[`"']|[`"']$/g, "")
}

function commandCandidate(entry: string, cwd?: string): string {
  const cleaned = cleanTaskMetadataEntry(entry)
  if (!cwd || !cleaned.startsWith("/")) return cleaned
  const projectRoot = resolve(cwd)
  const rel = relative(projectRoot, cleaned)
  if (rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/")) return rel
  return cleaned
}

export function isLikelyCommandMetadataEntry(entry: string, cwd?: string): boolean {
  const candidate = commandCandidate(entry, cwd).trim()
  if (!candidate) return false
  return COMMAND_PREFIXES.some((prefix) => prefix.test(candidate))
}

export function extractExistingFileArgumentsFromCommand(entry: string, cwd: string): string[] {
  if (!isLikelyCommandMetadataEntry(entry, cwd)) return []
  const candidate = commandCandidate(entry, cwd)
  const files = new Set<string>()
  for (const match of candidate.matchAll(FILE_ARGUMENT_RE)) {
    const raw = match[1] ?? match[2]
    if (!raw || raw.startsWith("-")) continue
    const resolved = raw.startsWith("/") ? resolve(raw) : resolve(cwd, raw)
    if (existsSync(resolved)) files.add(resolved)
  }
  return Array.from(files)
}
