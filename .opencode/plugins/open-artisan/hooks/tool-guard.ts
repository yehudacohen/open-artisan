/**
 * tool-guard.ts — Returns per-phase tool policies that gate what the agent
 * may write/edit at each point in the workflow.
 *
 * Key rules:
 * - DISCOVERY:
 *   - SCAN/ANALYZE: strictly read-only (no writes, edits, or bash)
 *   - CONVENTIONS: writes to .openartisan/ only (conventions authoring), bash blocked
 *   - REVISE: writes to .openartisan/ only (conventions revision), bash allowed
 *   - REVIEW/USER_GATE: no writes or edits, bash allowed for verification
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

export function isEnvFile(path: string): boolean {
  // Blocks any .env file or .env.* file
  const base = path.split("/").at(-1) ?? ""
  return base === ".env" || base.startsWith(".env.")
}

/** Returns true if the file is under the .openartisan/ artifact directory. */
export function isOpenArtisanFile(path: string): boolean {
  return path.includes("/.openartisan/") || path.includes("\\.openartisan\\")
}

/**
 * Filename/path keywords that indicate a file is an interface/type/schema definition
 * rather than an implementation file. Used to restrict general source file extensions
 * (.ts, .py, .go, etc.) to interface-like files only.
 */
const INTERFACE_KEYWORDS = /(?:^|[/\\._-])(?:types?|interfaces?|models?|schemas?|api|protocols?|traits?|contracts?|dtos?|enums?|constants?|stubs?|abstract)[/\\._-]?/i

/**
 * Returns true for files that are plausibly interface/type/schema definitions.
 * Language-agnostic: covers TypeScript, Python (type stubs, protocols), Go interfaces,
 * Rust traits, Java interfaces, Protobuf, GraphQL, JSON Schema, OpenAPI, etc.
 *
 * For general source file extensions (.ts, .py, .go, .rs, .java, etc.), the file
 * must also contain an interface-like keyword in its path or filename (e.g., "types",
 * "interfaces", "models", "schema"). This prevents the INTERFACES phase from
 * allowing writes to arbitrary implementation files.
 *
 * Schema/IDL formats (.proto, .graphql, .json, .yaml, etc.) and TypeScript
 * declaration files (.d.ts) are always allowed since they are inherently definition files.
 */
export function isInterfaceFile(path: string): boolean {
  const lower = path.toLowerCase()

  // TypeScript declaration files — always interface definitions
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.tsx")) return true
  // Python type stubs — always interface definitions
  if (lower.endsWith(".pyi")) return true
  // C/C++ headers — always declarations
  if (lower.endsWith(".h") || lower.endsWith(".hpp")) return true

  // Schema/IDL formats — inherently definition files, always allowed
  if (lower.endsWith(".proto") || lower.endsWith(".thrift") ||
      lower.endsWith(".avsc") || lower.endsWith(".capnp")) return true
  if (lower.endsWith(".graphql") || lower.endsWith(".gql")) return true
  // JSON / YAML (commonly used for JSON Schema or OpenAPI specs)
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) return true

  // General source file extensions: only allowed if path contains interface-like keyword
  const SOURCE_EXTS = [
    ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".kt",
    ".swift", ".ex", ".exs", ".scala", ".clj", ".rb",
  ]
  if (SOURCE_EXTS.some((ext) => lower.endsWith(ext))) {
    return INTERFACE_KEYWORDS.test(lower)
  }

  return false
}

/**
 * Returns true for files that are plausibly test files.
 * Language-agnostic: checks filename patterns and directory names.
 */
export function isTestFile(path: string): boolean {
  const lower = path.toLowerCase()
  const parts = lower.split("/")
  const filename = parts.at(-1) ?? ""
  const dirs = parts.slice(0, -1)

  // Filename patterns: contains "test" or "spec" as a word boundary
  // e.g.: foo.test.ts, foo_test.go, test_foo.py, foo.spec.ts, foo_spec.rb
  if (/(?:^|[._-])(?:test|spec)(?:[._-]|$)/.test(filename)) return true
  // "FooTest.java", "FooSpec.scala" — capital letter prefix ensures word boundary
  // (avoids false-positives like "forest.py" which ends in "est" but is not a test file)
  if (/(?<=[A-Z])(?:Test|Spec)(?:\.[a-z]+)?$/.test(filename)) return true

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
    case "DISCOVERY": {
      // CONVENTIONS: agent is authoring the conventions document in .openartisan/.
      // Allow writes to .openartisan/ only, bash blocked (definition-only authoring).
      if (phaseState === "CONVENTIONS") {
        return {
          blocked: ["bash"],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            return isOpenArtisanFile(filePath)
          },
          allowedDescription:
            "Conventions authoring: writes allowed ONLY to .openartisan/ files. No writes to project source. bash blocked. .env writes are always blocked.",
        }
      }
      // REVISE: agent is revising the conventions document after user feedback.
      // Allow writes to .openartisan/ only, bash allowed for verification.
      if (phaseState === "REVISE") {
        return {
          blocked: [],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            return isOpenArtisanFile(filePath)
          },
          allowedDescription:
            "Revision phase: edits allowed ONLY to .openartisan/ convention files. No writes to project source. bash allowed for verification. .env writes are always blocked.",
        }
      }
      // REVIEW/USER_GATE: bash allowed for read-only verification, no file writes.
      if (phaseState === "REVIEW" || phaseState === "USER_GATE") {
        return {
          blocked: ["write", "edit"],
          allowedDescription: "Discovery review: no file writes or edits. bash allowed for read-only verification.",
        }
      }
      // SCAN/ANALYZE: strictly read-only — no writes, edits, or shell execution.
      return {
        blocked: ["write", "edit", "bash"],
        allowedDescription: "Read-only — discovery phase scans and analyzes the codebase. No writes, edits, or bash execution.",
      }
    }

    // -----------------------------------------------------------------------
    case "PLANNING":
    case "IMPL_PLAN": {
      // REVISE: the plan already exists on disk in .openartisan/. Allow surgical
      // edits to .openartisan/ files so the agent doesn't have to reproduce the
      // entire plan just to make targeted changes. Still block all other writes.
      if (phaseState === "REVISE") {
        return {
          blocked: [],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            return isOpenArtisanFile(filePath)
          },
          allowedDescription:
            "Revision phase: edits allowed ONLY to .openartisan/ plan files. No writes to project source. bash allowed for verification. .env writes are always blocked.",
        }
      }
      // REVIEW/USER_GATE: bash allowed for read-only verification (same as TESTS/INTERFACES)
      if (phaseState === "REVIEW" || phaseState === "USER_GATE") {
        return {
          blocked: ["write", "edit"],
          allowedDescription: "Planning phase: no file writes or edits. bash allowed for read-only verification.",
        }
      }
      // DRAFT/CONVENTIONS: fully locked — plans are produced as text output
      return {
        blocked: ["write", "edit", "bash"],
        allowedDescription: "Planning phase: no file writes and no shell execution. Produce a plan as text output.",
      }
    }

    // -----------------------------------------------------------------------
    case "INTERFACES": {
      // During DRAFT/REVISE/CONVENTIONS: bash is blocked (definition-only authoring).
      // During REVIEW/USER_GATE: bash is allowed so the agent (and isolated reviewer)
      // can run read-only commands (rg, wc, find, etc.) to verify acceptance criteria.
      const interfacesBashBlocked = phaseState === "REVIEW" || phaseState === "USER_GATE"
        ? []
        : ["bash"] as const
      return {
        blocked: [...interfacesBashBlocked],
        writePathPredicate: (filePath: string) => {
          if (isEnvFile(filePath)) return false
          return isInterfaceFile(filePath)
        },
        allowedDescription: phaseState === "REVIEW" || phaseState === "USER_GATE"
          ? "Only interface/type/schema files may be written. bash is allowed for read-only verification. .env writes are always blocked."
          : "Only interface/type/schema files may be written (.ts, .d.ts, .py, .go, .rs, .java, .proto, .graphql, .json, .yaml, etc.). bash is blocked. .env writes are always blocked.",
      }
    }

    // -----------------------------------------------------------------------
    case "TESTS": {
      // During DRAFT/REVISE/CONVENTIONS: bash is blocked (test-writing only, no running).
      // During REVIEW/USER_GATE: bash is allowed so the agent (and isolated reviewer)
      // can run read-only commands (rg, wc, find, etc.) to verify acceptance criteria.
      const testsBashBlocked = phaseState === "REVIEW" || phaseState === "USER_GATE"
        ? []
        : ["bash"] as const
      return {
        blocked: [...testsBashBlocked],
        writePathPredicate: (filePath: string) => {
          if (isEnvFile(filePath)) return false
          return isTestFile(filePath)
        },
        allowedDescription: phaseState === "REVIEW" || phaseState === "USER_GATE"
          ? "Only test files may be written. bash is allowed for read-only verification. .env writes are always blocked."
          : "Only test files may be written (files containing 'test' or 'spec' in name, or in test/tests/__tests__/spec directories). bash is blocked. .env writes are always blocked.",
      }
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
          bashCommandPredicate: (command: string) => {
            // Block bash commands that contain obvious file-write operators.
            // This is best-effort — cannot catch all obfuscation — but catches
            // the common case of `echo > file`, `cat > file`, `sed -i`, `tee`.
            const WRITE_OPS = /(?:>>|>[^&]|\btee\b|\bsed\s+-i\b|\bdd\b.*\bof=)/
            return !WRITE_OPS.test(command)
          },
          allowedDescription: `INCREMENTAL mode: only allowlisted files may be written (${fileAllowlist.length} files). .env always blocked. Bash write operators (>, >>, tee, sed -i) are blocked.`,
        }
      }

      // GREENFIELD or REFACTOR — unrestricted except for .env files.
      return {
        blocked: [],
        writePathPredicate: (filePath: string) => !isEnvFile(filePath),
        allowedDescription: "Implementation phase (GREENFIELD/REFACTOR): any file may be written except .env files.",
      }
    }

    default: {
      // Exhaustive check: if a new Phase is added to the union, TypeScript
      // will error here at compile time. At runtime, fall back to blocking
      // all writes as the safest default.
      const _exhaustive: never = phase
      return {
        blocked: ["write", "edit", "bash"],
        allowedDescription: `Unknown phase "${_exhaustive}" — all writes blocked as a safety fallback.`,
      }
    }
  }
}
