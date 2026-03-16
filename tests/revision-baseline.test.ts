/**
 * Tests for revision-baseline.ts — artifact diff gate for REVISE state.
 *
 * Covers:
 * - captureRevisionBaseline: content-hash for in-memory phases, worktree-diff-hash for file-based
 * - hasArtifactChanged: same content → false, different content → true, worktree diff hash comparison
 * - Cascade isolation: earlier cascade changes don't cause false positives
 * - Graceful degradation: missing files, git errors, unknown phases
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"

import { captureRevisionBaseline, hasArtifactChanged } from "#plugin/revision-baseline"
import type { WorkflowState } from "#plugin/types"
import { SCHEMA_VERSION } from "#plugin/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "test-session",
    mode: "GREENFIELD",
    phase: "PLANNING",
    phaseState: "REVISE",
    iterationCount: 0,
    retryCount: 0,
    approvedArtifacts: {},
    conventions: null,
    fileAllowlist: [],
    lastCheckpointTag: null,
    approvalCount: 0,
    orchestratorSessionId: null,
    intentBaseline: null,
    modeDetectionNote: null,
    discoveryReport: null,
    currentTaskId: null,
    feedbackHistory: [],
    implDag: null,
    phaseApprovalCounts: {},
    escapePending: false,
    pendingRevisionSteps: null,
    userGateMessageReceived: false,
    artifactDiskPaths: {},
    featureName: null,
    revisionBaseline: null,
    ...overrides,
  }
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

/** No-op shell mock that returns empty output. */
const mockShellEmpty: any = Object.assign(
  (strings: TemplateStringsArray, ...args: unknown[]) => ({
    text: async () => "",
    exitCode: Promise.resolve(0),
  }),
  {},
)

/** Shell mock that returns a specific output (used for both git diff and git rev-parse). */
function mockShellWithOutput(output: string): any {
  return Object.assign(
    (strings: TemplateStringsArray, ...args: unknown[]) => ({
      text: async () => output,
      exitCode: Promise.resolve(0),
    }),
    {},
  )
}

// Aliases for readability (kept for backward compat with test naming)
const mockShellWithDiff = mockShellWithOutput

/** Shell mock that fails. */
const mockShellFail: any = Object.assign(
  (strings: TemplateStringsArray, ...args: unknown[]) => ({
    text: async () => "",
    exitCode: Promise.resolve(1),
  }),
  {},
)

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "revision-baseline-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// captureRevisionBaseline — in-memory phases
// ---------------------------------------------------------------------------

describe("captureRevisionBaseline — in-memory phases", () => {
  it("returns content-hash for PLANNING with disk file", async () => {
    const artifactPath = join(tmpDir, "plan.md")
    writeFileSync(artifactPath, "# Plan\nBuild the thing.")
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: { plan: artifactPath },
    })

    const baseline = await captureRevisionBaseline("PLANNING", state, tmpDir, mockShellEmpty)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("content-hash")
    if (baseline!.type === "content-hash") {
      expect(baseline!.hash).toBe(contentHash("# Plan\nBuild the thing."))
    }
  })

  it("returns content-hash for DISCOVERY with disk file", async () => {
    const artifactPath = join(tmpDir, "conventions.md")
    writeFileSync(artifactPath, "# Conventions\nUse TypeScript.")
    const state = makeState({
      phase: "DISCOVERY",
      artifactDiskPaths: { conventions: artifactPath },
    })

    const baseline = await captureRevisionBaseline("DISCOVERY", state, tmpDir, mockShellEmpty)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("content-hash")
  })

  it("returns content-hash for IMPL_PLAN with disk file", async () => {
    const artifactPath = join(tmpDir, "impl-plan.md")
    writeFileSync(artifactPath, "## Task T1: Do stuff")
    const state = makeState({
      phase: "IMPL_PLAN",
      artifactDiskPaths: { impl_plan: artifactPath },
    })

    const baseline = await captureRevisionBaseline("IMPL_PLAN", state, tmpDir, mockShellEmpty)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("content-hash")
  })

  it("returns null when disk file does not exist", async () => {
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: { plan: "/nonexistent/path/plan.md" },
    })

    const baseline = await captureRevisionBaseline("PLANNING", state, tmpDir, mockShellEmpty)
    expect(baseline).toBeNull()
  })

  it("returns null when no disk path is recorded", async () => {
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: {},
    })

    const baseline = await captureRevisionBaseline("PLANNING", state, tmpDir, mockShellEmpty)
    expect(baseline).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// captureRevisionBaseline — file-based phases
// ---------------------------------------------------------------------------

describe("captureRevisionBaseline — file-based phases", () => {
  it("returns git-sha (worktree hash) for INTERFACES with no uncommitted changes", async () => {
    const state = makeState({ phase: "INTERFACES" })
    // git diff returns empty output when no uncommitted changes
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir, mockShellWithOutput(""))
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
    if (baseline!.type === "git-sha") {
      // Should be a content hash of the empty diff output
      expect(baseline!.sha).toBe(contentHash(""))
    }
  })

  it("returns git-sha (worktree hash) for INTERFACES with uncommitted changes", async () => {
    const diffOutput = "diff --git a/src/types.ts b/src/types.ts\n--- a/src/types.ts\n+++ b/src/types.ts\n@@ -1 +1 @@\n-old\n+new\n"
    const state = makeState({ phase: "INTERFACES" })
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir, mockShellWithOutput(diffOutput))
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
    if (baseline!.type === "git-sha") {
      expect(baseline!.sha).toBe(contentHash(diffOutput))
    }
  })

  it("returns git-sha for TESTS", async () => {
    const state = makeState({ phase: "TESTS" })
    const baseline = await captureRevisionBaseline("TESTS", state, tmpDir, mockShellWithOutput(""))
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
  })

  it("returns git-sha for IMPLEMENTATION", async () => {
    const state = makeState({ phase: "IMPLEMENTATION" })
    const baseline = await captureRevisionBaseline("IMPLEMENTATION", state, tmpDir, mockShellWithOutput(""))
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
  })

  it("returns null when git fails", async () => {
    const state = makeState({ phase: "INTERFACES" })
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir, mockShellFail)
    expect(baseline).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// captureRevisionBaseline — edge cases
// ---------------------------------------------------------------------------

describe("captureRevisionBaseline — edge cases", () => {
  it("returns null for MODE_SELECT (no artifact)", async () => {
    const state = makeState({ phase: "MODE_SELECT" })
    const baseline = await captureRevisionBaseline("MODE_SELECT", state, tmpDir, mockShellEmpty)
    expect(baseline).toBeNull()
  })

  it("returns null for DONE (no artifact)", async () => {
    const state = makeState({ phase: "DONE" })
    const baseline = await captureRevisionBaseline("DONE", state, tmpDir, mockShellEmpty)
    expect(baseline).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// hasArtifactChanged — content-hash baseline
// ---------------------------------------------------------------------------

describe("hasArtifactChanged — content-hash", () => {
  it("returns false when artifact_content matches baseline hash", async () => {
    const content = "# Plan\nBuild the thing."
    const baseline = { type: "content-hash" as const, hash: contentHash(content) }
    const state = makeState({ phase: "PLANNING" })

    const changed = await hasArtifactChanged(baseline, "PLANNING", content, state, tmpDir, mockShellEmpty)
    expect(changed).toBe(false)
  })

  it("returns true when artifact_content differs from baseline hash", async () => {
    const originalContent = "# Plan\nBuild the thing."
    const revisedContent = "# Plan\nBuild the thing with tests."
    const baseline = { type: "content-hash" as const, hash: contentHash(originalContent) }
    const state = makeState({ phase: "PLANNING" })

    const changed = await hasArtifactChanged(baseline, "PLANNING", revisedContent, state, tmpDir, mockShellEmpty)
    expect(changed).toBe(true)
  })

  it("falls back to disk file when artifact_content is undefined", async () => {
    const originalContent = "# Plan\nBuild the thing."
    const artifactPath = join(tmpDir, "plan.md")
    writeFileSync(artifactPath, originalContent) // same content → no change
    const baseline = { type: "content-hash" as const, hash: contentHash(originalContent) }
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: { plan: artifactPath },
    })

    const changed = await hasArtifactChanged(baseline, "PLANNING", undefined, state, tmpDir, mockShellEmpty)
    expect(changed).toBe(false)
  })

  it("returns true when disk file content differs from baseline", async () => {
    const originalContent = "# Plan\nBuild the thing."
    const artifactPath = join(tmpDir, "plan.md")
    writeFileSync(artifactPath, "# Plan\nChanged content.") // different content
    const baseline = { type: "content-hash" as const, hash: contentHash(originalContent) }
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: { plan: artifactPath },
    })

    const changed = await hasArtifactChanged(baseline, "PLANNING", undefined, state, tmpDir, mockShellEmpty)
    expect(changed).toBe(true)
  })

  it("returns true (allow through) when disk file is missing", async () => {
    const baseline = { type: "content-hash" as const, hash: "abc123" }
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: { plan: "/nonexistent/plan.md" },
    })

    const changed = await hasArtifactChanged(baseline, "PLANNING", undefined, state, tmpDir, mockShellEmpty)
    expect(changed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasArtifactChanged — git-sha baseline
// ---------------------------------------------------------------------------

describe("hasArtifactChanged — git-sha (worktree hash)", () => {
  it("returns false when git diff output hash matches baseline (no new changes)", async () => {
    // Simulate: at REVISE entry, git diff output was empty. At check time, still empty.
    const baselineDiffOutput = ""
    const baseline = { type: "git-sha" as const, sha: contentHash(baselineDiffOutput) }
    const state = makeState({ phase: "INTERFACES" })

    // Mock shell returns same empty diff
    const changed = await hasArtifactChanged(baseline, "INTERFACES", undefined, state, tmpDir, mockShellWithDiff(""))
    expect(changed).toBe(false)
  })

  it("returns false when git diff output is identical to baseline (earlier cascade changes present but unchanged)", async () => {
    // Simulate: at REVISE entry, there were uncommitted changes from earlier cascade steps.
    // At check time, those same changes are still there, unchanged.
    const earlierCascadeDiff = "diff --git a/src/interfaces.ts b/src/interfaces.ts\n--- a/src/interfaces.ts\n+++ b/src/interfaces.ts\n@@ -1 +1 @@\n-old\n+new\n"
    const baseline = { type: "git-sha" as const, sha: contentHash(earlierCascadeDiff) }
    const state = makeState({ phase: "TESTS" })

    // Mock shell returns same diff output (no new work done during this REVISE step)
    const changed = await hasArtifactChanged(baseline, "TESTS", undefined, state, tmpDir, mockShellWithDiff(earlierCascadeDiff))
    expect(changed).toBe(false)
  })

  it("returns true when git diff output changes (new work done during REVISE)", async () => {
    // Simulate: at REVISE entry, git diff was empty. Agent made changes.
    const baselineDiffOutput = ""
    const baseline = { type: "git-sha" as const, sha: contentHash(baselineDiffOutput) }
    const state = makeState({ phase: "INTERFACES" })

    const newDiff = "diff --git a/src/types.ts b/src/types.ts\n--- a/src/types.ts\n+++ b/src/types.ts\n@@ -1 +1 @@\n-old\n+new\n"
    const changed = await hasArtifactChanged(baseline, "INTERFACES", undefined, state, tmpDir, mockShellWithDiff(newDiff))
    expect(changed).toBe(true)
  })

  it("returns true when earlier cascade changes exist and new changes are added", async () => {
    // Simulate: at REVISE entry, earlier cascade changes were present. Agent adds more.
    const earlierDiff = "diff --git a/src/interfaces.ts b/src/interfaces.ts\n-old\n+new\n"
    const baseline = { type: "git-sha" as const, sha: contentHash(earlierDiff) }
    const state = makeState({ phase: "TESTS" })

    const expandedDiff = earlierDiff + "diff --git a/tests/foo.test.ts b/tests/foo.test.ts\n-old_test\n+new_test\n"
    const changed = await hasArtifactChanged(baseline, "TESTS", undefined, state, tmpDir, mockShellWithDiff(expandedDiff))
    expect(changed).toBe(true)
  })

  it("returns true (allow through) when git fails", async () => {
    const baseline = { type: "git-sha" as const, sha: contentHash("") }
    const state = makeState({ phase: "INTERFACES" })

    const changed = await hasArtifactChanged(baseline, "INTERFACES", undefined, state, tmpDir, mockShellFail)
    expect(changed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasArtifactChanged — graceful degradation
// ---------------------------------------------------------------------------

describe("hasArtifactChanged — graceful degradation", () => {
  it("returns true for unknown baseline type (future-proofing)", async () => {
    // Force an unknown type to test the default branch
    const baseline = { type: "unknown", data: "whatever" } as any
    const state = makeState({ phase: "PLANNING" })

    const changed = await hasArtifactChanged(baseline, "PLANNING", "content", state, tmpDir, mockShellEmpty)
    expect(changed).toBe(true)
  })
})
