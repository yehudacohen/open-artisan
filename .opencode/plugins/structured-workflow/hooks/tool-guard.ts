/**
 * tool-guard.ts — Returns per-phase tool policies that gate what the agent
 * may write/edit at each point in the workflow.
 *
 * Key rules:
 * - DISCOVERY: no writes, no edits (read-only)
 * - PLANNING / IMPL_PLAN: no writes, no edits (plan is text in memory)
 * - INTERFACES: only interface/type/schema files may be written; .env always blocked.
 *   Language-agnostic: accepts .ts, .d.ts, .py, .go, .rs, .java, .rb, .ex, .proto,
 *   .graphql, .gql, .json (schema files), .yaml/.yml (OpenAPI), .thrift, .avsc, .capnp.
 * - TESTS: only test files may be written; .env always blocked.
 *   Language-agnostic: filename contains "test" or "spec" as a word part, or sits in
 *   a directory named "test", "tests", "__tests__", or "spec".
 * - IMPLEMENTATION (GREENFIELD/REFACTOR): unrestricted writes (except .env)
 * - IMPLEMENTATION (INCREMENTAL): only files in the allowlist; .env always blocked
 * - MODE_SELECT / DONE: no writes, no edits
 */
import type { Phase, PhaseState, WorkflowMode, PhaseToolPolicy } from "../types"

// Predicates ---------------------------------------------------------------

function isEnvFile(path: string): boolean {
  // Blocks any .env file or .env.* file
  const base = path.split("/").at(-1) ?? ""
  return base === ".env" || base.startsWith(".env.")
}

/**
 * Returns true for files that are plausibly interface/type/schema definitions.
 * Language-agnostic: covers TypeScript, Python (type stubs, protocols), Go interfaces,
 * Rust traits, Java interfaces, Protobuf, GraphQL, JSON Schema, OpenAPI, etc.
 */
function isInterfaceFile(path: string): boolean {
  const lower = path.toLowerCase()
  // TypeScript / JavaScript declaration files
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") ||
      lower.endsWith(".d.ts") || lower.endsWith(".d.tsx")) return true
  // Python, Ruby, Go, Rust, Java, Kotlin, Swift, Elixir, Scala, C/C++
  if (lower.endsWith(".py") || lower.endsWith(".pyi") ||
      lower.endsWith(".go") || lower.endsWith(".rs") ||
      lower.endsWith(".java") || lower.endsWith(".kt") ||
      lower.endsWith(".swift") || lower.endsWith(".ex") || lower.endsWith(".exs") ||
      lower.endsWith(".scala") || lower.endsWith(".clj") ||
      lower.endsWith(".rb") || lower.endsWith(".h") || lower.endsWith(".hpp")) return true
  // Schema/IDL formats
  if (lower.endsWith(".proto") || lower.endsWith(".thrift") ||
      lower.endsWith(".avsc") || lower.endsWith(".capnp")) return true
  // GraphQL
  if (lower.endsWith(".graphql") || lower.endsWith(".gql")) return true
  // JSON / YAML (commonly used for JSON Schema or OpenAPI specs)
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) return true
  return false
}

/**
 * Returns true for files that are plausibly test files.
 * Language-agnostic: checks filename patterns and directory names.
 */
function isTestFile(path: string): boolean {
  const lower = path.toLowerCase()
  const parts = lower.split("/")
  const filename = parts.at(-1) ?? ""
  const dirs = parts.slice(0, -1)

  // Filename patterns: contains "test" or "spec" as a boundary word
  // e.g.: foo.test.ts, foo_test.go, test_foo.py, foo.spec.ts, foo_spec.rb
  if (/(?:^|[._-])(?:test|spec)(?:[._-]|$)/.test(filename)) return true
  // Also match files like "FooTest.java", "FooSpec.scala"
  if (/(?:test|spec)(?:\.[a-z]+)?$/.test(filename)) return true

  // Directory patterns: test lives in test/, tests/, __tests__/, spec/, specs/
  const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"])
  if (dirs.some((d) => TEST_DIRS.has(d))) return true

  return false
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns the PhaseToolPolicy for a given phase/state combination.
 *
 * @param phase           Current workflow phase
 * @param phaseState      Sub-state within the phase (included for forward-compat)
 * @param mode            Workflow mode (null = not yet selected)
 * @param fileAllowlist   Absolute paths allowed to write in INCREMENTAL mode
 */
export function getPhaseToolPolicy(
  phase: Phase,
  phaseState: PhaseState,
  mode: WorkflowMode | null,
  fileAllowlist: string[],
): PhaseToolPolicy {
  switch (phase) {
    // -----------------------------------------------------------------------
    case "MODE_SELECT":
    case "DONE":
      return {
        blocked: ["write", "edit"],
        allowedDescription: "Only workflow control tools are allowed.",
      }

    // -----------------------------------------------------------------------
    case "DISCOVERY":
      return {
        // Discovery is strictly read-only — no writes, edits, or shell execution
        blocked: ["write", "edit", "bash"],
        allowedDescription: "Read-only — discovery phase scans and analyzes the codebase. No writes, edits, or bash execution.",
      }

    // -----------------------------------------------------------------------
    case "PLANNING":
    case "IMPL_PLAN":
      return {
        // Plans are pure text; no code writes or shell execution permitted
        blocked: ["write", "edit", "bash"],
        allowedDescription: "Planning phase: no file writes and no shell execution. Produce a plan as text output.",
      }

    // -----------------------------------------------------------------------
    case "INTERFACES":
      return {
        blocked: [],
        writePathPredicate: (filePath: string) => {
          if (isEnvFile(filePath)) return false
          return isInterfaceFile(filePath)
        },
        allowedDescription:
          "Only interface/type/schema files may be written (.ts, .d.ts, .py, .go, .rs, .java, .proto, .graphql, .json, .yaml, etc.). .env writes are always blocked.",
      }

    // -----------------------------------------------------------------------
    case "TESTS":
      return {
        blocked: [],
        writePathPredicate: (filePath: string) => {
          if (isEnvFile(filePath)) return false
          return isTestFile(filePath)
        },
        allowedDescription:
          "Only test files may be written (files containing 'test' or 'spec' in name, or in test/tests/__tests__/spec directories). .env writes are always blocked.",
      }

    // -----------------------------------------------------------------------
    case "IMPLEMENTATION": {
      if (mode === "INCREMENTAL") {
        // INCREMENTAL with a non-empty allowlist: restrict to listed files only.
        // INCREMENTAL with an empty allowlist: block all writes (do-no-harm guarantee —
        // agent must call select_mode and receive an allowlist before writing anything).
        if (fileAllowlist.length === 0) {
          return {
            blocked: ["write", "edit"],
            allowedDescription: "INCREMENTAL mode: no file allowlist provided — all writes blocked until an allowlist is set.",
          }
        }
        const allowSet = new Set(fileAllowlist)
        return {
          blocked: [],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            return allowSet.has(filePath)
          },
          allowedDescription: `INCREMENTAL mode: only allowlisted files may be written (${fileAllowlist.length} files). .env always blocked.`,
        }
      }

      // GREENFIELD or REFACTOR — unrestricted except for .env files.
      return {
        blocked: [],
        writePathPredicate: (filePath: string) => !isEnvFile(filePath),
        allowedDescription: "Implementation phase (GREENFIELD/REFACTOR): any file may be written except .env files.",
      }
    }
  }
}
