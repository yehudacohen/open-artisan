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
const INTERFACE_KEYWORDS = /(?:^|[/\\._-])(?:types?|interfaces?|models?|schemas?|openapi|api|protocols?|traits?|contracts?|dtos?|enums?|constants?|stubs?|abstract)[/\\._-]?/i

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
  // JSON / YAML: only when the path contains an interface-like keyword.
  // This prevents arbitrary config files (package.json, tsconfig.json, etc.)
  // from being writable during the INTERFACES phase.
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return INTERFACE_KEYWORDS.test(lower)
  }

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
 * @param taskExpectedFiles  Per-task file restriction for IMPLEMENTATION phase.
 *                           When set, the agent can only write to these files
 *                           (plus .openartisan/ for artifact writes). Enforces
 *                           one-task-at-a-time discipline from the approved DAG.
 */
export function getPhaseToolPolicy(
  phase: Phase,
  phaseState: PhaseState,
  mode: WorkflowMode | null,
  fileAllowlist: string[],
  taskExpectedFiles?: string[],
): PhaseToolPolicy {
  switch (phase) {
    // -----------------------------------------------------------------------
    case "MODE_SELECT":
      return {
        blocked: ["write", "edit"],
        allowedDescription: "No file writes or edits until a workflow mode is selected. Bash is allowed for read-only exploration. Call select_mode to begin.",
      }
    case "DONE":
      return {
        blocked: ["write", "edit"],
        allowedDescription: "Workflow complete — no file writes or edits. Bash is allowed for read-only tasks (git log, test runs, etc.). Send a new message to start a fresh workflow cycle.",
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
      // REVIEW: bash allowed, writes to .openartisan/ allowed so the agent can fix
      // artifact issues discovered during self-review before calling mark_satisfied.
      if (phaseState === "REVIEW") {
        return {
          blocked: [],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            return isOpenArtisanFile(filePath)
          },
          allowedDescription:
            "Discovery review: writes allowed ONLY to .openartisan/ files (to fix review issues). bash allowed for verification. .env writes are always blocked.",
        }
      }
      // USER_GATE / ESCAPE_HATCH: no file writes — waiting for user response.
      if (phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH") {
        return {
          blocked: ["write", "edit"],
          allowedDescription: "Discovery user gate: no file writes or edits. bash allowed for read-only verification.",
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
      // REVIEW: bash allowed, writes to .openartisan/ allowed so the agent can fix
      // artifact issues discovered during self-review before calling mark_satisfied.
      if (phaseState === "REVIEW") {
        return {
          blocked: [],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            return isOpenArtisanFile(filePath)
          },
          allowedDescription:
            "Planning review: writes allowed ONLY to .openartisan/ files (to fix review issues). bash allowed for verification. .env writes are always blocked.",
        }
      }
      // USER_GATE / ESCAPE_HATCH: no file writes — waiting for user response.
      if (phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH") {
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
      // During DRAFT/CONVENTIONS: bash is blocked (definition-only authoring).
      // During REVISE/REVIEW/USER_GATE: bash is allowed so the agent can run
      // read-only commands (rg, wc, find, etc.) to verify acceptance criteria
      // or understand what needs revising from feedback.
      const interfacesBashBlocked = phaseState === "REVISE" || phaseState === "REVIEW" || phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH"
        ? []
        : ["bash"] as const
      return {
        blocked: [...interfacesBashBlocked],
        writePathPredicate: (filePath: string) => {
          if (isEnvFile(filePath)) return false
          return isInterfaceFile(filePath)
        },
        allowedDescription: phaseState === "REVISE" || phaseState === "REVIEW" || phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH"
          ? "Only interface/type/schema files may be written. bash is allowed for read-only verification. .env writes are always blocked."
          : "Only interface/type/schema files may be written (.ts, .d.ts, .py, .go, .rs, .java, .proto, .graphql, .json, .yaml, etc.). bash is blocked. .env writes are always blocked.",
      }
    }

    // -----------------------------------------------------------------------
    case "TESTS": {
      // During DRAFT/CONVENTIONS: bash is blocked (test-writing only, no running).
      // During REVISE/REVIEW/USER_GATE: bash is allowed so the agent can run
      // read-only commands (rg, wc, find, test runner) to verify acceptance criteria
      // or understand what needs revising from feedback.
      const testsBashBlocked = phaseState === "REVISE" || phaseState === "REVIEW" || phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH"
        ? []
        : ["bash"] as const
      return {
        blocked: [...testsBashBlocked],
        writePathPredicate: (filePath: string) => {
          if (isEnvFile(filePath)) return false
          return isTestFile(filePath)
        },
        allowedDescription: phaseState === "REVISE" || phaseState === "REVIEW" || phaseState === "USER_GATE" || phaseState === "ESCAPE_HATCH"
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
        // In INCREMENTAL, per-task files intersect with the workflow allowlist.
        // The agent can only write files that are both in the task's expectedFiles
        // AND in the workflow allowlist. If no task files specified, use the full allowlist.
        const allowSet = new Set(fileAllowlist)
        const taskSet = taskExpectedFiles && taskExpectedFiles.length > 0
          ? new Set(taskExpectedFiles)
          : null
        return {
          blocked: [],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            if (isOpenArtisanFile(filePath)) return true // always allow artifact writes
            if (!allowSet.has(filePath)) return false
            if (taskSet && !taskSet.has(filePath)) return false
            return true
          },
          bashCommandPredicate: (command: string) => {
            // Block bash commands that contain obvious file-write operators.
            // This is best-effort — cannot catch all obfuscation — but catches
            // the common case of `echo > file`, `cat > file`, `sed -i`, `tee`.
            // Also blocks heredoc patterns (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`)
            // which can be used to write file contents via `cat <<EOF > file`.
            const WRITE_OPS = /(?:>>|>[^&]|\btee\b|\bsed\s+-i\b|\bdd\b.*\bof=|<<-?\s*['"]?\w+['"]?)/
            return !WRITE_OPS.test(command)
          },
          allowedDescription: taskSet
            ? `INCREMENTAL mode: only current task files may be written (${taskSet.size} files). .env always blocked.`
            : `INCREMENTAL mode: only allowlisted files may be written (${fileAllowlist.length} files). .env always blocked. Bash write operators (>, >>, tee, sed -i) are blocked.`,
        }
      }

      // GREENFIELD or REFACTOR — per-task file restriction when a task is active.
      // When taskExpectedFiles is set, the agent can only write to those files
      // (plus .openartisan/). This enforces one-task-at-a-time from the DAG.
      // When no task is active (e.g. between tasks, or pre-v22 DAGs without
      // expectedFiles), fall back to unrestricted writes.
      if (taskExpectedFiles && taskExpectedFiles.length > 0) {
        const taskSet = new Set(taskExpectedFiles)
        return {
          blocked: [],
          writePathPredicate: (filePath: string) => {
            if (isEnvFile(filePath)) return false
            if (isOpenArtisanFile(filePath)) return true // always allow artifact writes
            return taskSet.has(filePath)
          },
          allowedDescription: `Implementation phase: only current task files may be written (${taskSet.size} files). .openartisan/ always allowed. .env always blocked.`,
        }
      }

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
