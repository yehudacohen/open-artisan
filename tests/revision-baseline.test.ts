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
import { execSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"

import { captureRevisionBaseline, hasArtifactChanged } from "#core/revision-baseline"
import type { WorkflowState } from "#core/types"
import { SCHEMA_VERSION } from "#core/types"

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
    activeAgent: null,
    taskCompletionInProgress: null,
    taskReviewCount: 0,
    pendingFeedback: null,
    userMessages: [],
    cachedPriorState: null,
    priorWorkflowChecked: false,
    sessionModel: null,
    reviewArtifactHash: null,
    latestReviewResults: null,
    parentWorkflow: null,
    childWorkflows: [],
    concurrency: { maxParallelTasks: 1 },
    reviewArtifactFiles: [],
    ...overrides,
  }
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

let tmpDir: string

/** Initialize a git repo in the given directory with an initial commit. */
function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" })
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" })
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" })
  writeFileSync(join(dir, ".gitkeep"), "")
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe", shell: "/bin/sh" })
}

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

    const baseline = await captureRevisionBaseline("PLANNING", state, tmpDir)
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

    const baseline = await captureRevisionBaseline("DISCOVERY", state, tmpDir)
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

    const baseline = await captureRevisionBaseline("IMPL_PLAN", state, tmpDir)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("content-hash")
  })

  it("returns null when disk file does not exist", async () => {
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: { plan: "/nonexistent/path/plan.md" },
    })

    const baseline = await captureRevisionBaseline("PLANNING", state, tmpDir)
    expect(baseline).toBeNull()
  })

  it("returns null when no disk path is recorded", async () => {
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: {},
    })

    const baseline = await captureRevisionBaseline("PLANNING", state, tmpDir)
    expect(baseline).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// captureRevisionBaseline — file-based phases
// ---------------------------------------------------------------------------

describe("captureRevisionBaseline — file-based phases", () => {
  it("returns git-sha (worktree hash) for INTERFACES with no uncommitted changes", async () => {
    initGitRepo(tmpDir)
    const state = makeState({ phase: "INTERFACES" })
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
    if (baseline!.type === "git-sha") {
      // git diff on a clean repo returns empty string
      expect(baseline!.sha).toBe(contentHash(""))
    }
  })

  it("returns git-sha (worktree hash) for INTERFACES with uncommitted changes", async () => {
    initGitRepo(tmpDir)
    // Create a tracked file, commit it, then modify it (uncommitted change)
    const filePath = join(tmpDir, "types.ts")
    writeFileSync(filePath, "old")
    execSync("git add -A && git commit -m add-file", { cwd: tmpDir, stdio: "pipe", shell: "/bin/sh" })
    writeFileSync(filePath, "new")
    const state = makeState({ phase: "INTERFACES" })
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
    if (baseline!.type === "git-sha") {
      // Hash should match what git diff would produce
      const expectedDiff = execSync("git diff", { cwd: tmpDir, stdio: "pipe", encoding: "utf-8" })
      expect(baseline!.sha).toBe(contentHash(expectedDiff))
    }
  })

  it("returns git-sha for TESTS", async () => {
    initGitRepo(tmpDir)
    const state = makeState({ phase: "TESTS" })
    const baseline = await captureRevisionBaseline("TESTS", state, tmpDir)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
  })

  it("returns git-sha for IMPLEMENTATION", async () => {
    initGitRepo(tmpDir)
    const state = makeState({ phase: "IMPLEMENTATION" })
    const baseline = await captureRevisionBaseline("IMPLEMENTATION", state, tmpDir)
    expect(baseline).not.toBeNull()
    expect(baseline!.type).toBe("git-sha")
  })

  it("returns null when not a git repo", async () => {
    // tmpDir is NOT a git repo — git diff should fail gracefully
    const state = makeState({ phase: "INTERFACES" })
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir)
    expect(baseline).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// captureRevisionBaseline — edge cases
// ---------------------------------------------------------------------------

describe("captureRevisionBaseline — edge cases", () => {
  it("returns null for MODE_SELECT (no artifact)", async () => {
    const state = makeState({ phase: "MODE_SELECT" })
    const baseline = await captureRevisionBaseline("MODE_SELECT", state, tmpDir)
    expect(baseline).toBeNull()
  })

  it("returns null for DONE (no artifact)", async () => {
    const state = makeState({ phase: "DONE" })
    const baseline = await captureRevisionBaseline("DONE", state, tmpDir)
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

    const changed = await hasArtifactChanged(baseline, "PLANNING", content, state, tmpDir)
    expect(changed).toBe(false)
  })

  it("returns true when artifact_content differs from baseline hash", async () => {
    const originalContent = "# Plan\nBuild the thing."
    const revisedContent = "# Plan\nBuild the thing with tests."
    const baseline = { type: "content-hash" as const, hash: contentHash(originalContent) }
    const state = makeState({ phase: "PLANNING" })

    const changed = await hasArtifactChanged(baseline, "PLANNING", revisedContent, state, tmpDir)
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

    const changed = await hasArtifactChanged(baseline, "PLANNING", undefined, state, tmpDir)
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

    const changed = await hasArtifactChanged(baseline, "PLANNING", undefined, state, tmpDir)
    expect(changed).toBe(true)
  })

  it("returns true (allow through) when disk file is missing", async () => {
    const baseline = { type: "content-hash" as const, hash: "abc123" }
    const state = makeState({
      phase: "PLANNING",
      artifactDiskPaths: { plan: "/nonexistent/plan.md" },
    })

    const changed = await hasArtifactChanged(baseline, "PLANNING", undefined, state, tmpDir)
    expect(changed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasArtifactChanged — git-sha baseline
// ---------------------------------------------------------------------------

describe("hasArtifactChanged — git-sha (worktree hash)", () => {
  it("returns false when git diff output hash matches baseline (no new changes)", async () => {
    // Real git repo with no uncommitted changes — diff is empty at both capture and check
    initGitRepo(tmpDir)
    const state = makeState({ phase: "INTERFACES" })
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir)
    expect(baseline).not.toBeNull()
    // No changes made between capture and check
    const changed = await hasArtifactChanged(baseline!, "INTERFACES", undefined, state, tmpDir)
    expect(changed).toBe(false)
  })

  it("returns false when git diff output is identical to baseline (earlier cascade changes present but unchanged)", async () => {
    // Real git repo with uncommitted changes — same diff at capture and check
    initGitRepo(tmpDir)
    const filePath = join(tmpDir, "interfaces.ts")
    writeFileSync(filePath, "old")
    execSync("git add -A && git commit -m add", { cwd: tmpDir, stdio: "pipe", shell: "/bin/sh" })
    writeFileSync(filePath, "new")  // uncommitted change (earlier cascade)
    const state = makeState({ phase: "TESTS" })
    const baseline = await captureRevisionBaseline("TESTS", state, tmpDir)
    expect(baseline).not.toBeNull()
    // No NEW changes — same diff as at capture time
    const changed = await hasArtifactChanged(baseline!, "TESTS", undefined, state, tmpDir)
    expect(changed).toBe(false)
  })

  it("returns true when git diff output changes (new work done during REVISE)", async () => {
    // Capture baseline with clean repo, then make an unstaged change to a tracked file
    initGitRepo(tmpDir)
    const filePath = join(tmpDir, "types.ts")
    writeFileSync(filePath, "old content")
    execSync("git add -A && git commit -m track", { cwd: tmpDir, stdio: "pipe", shell: "/bin/sh" })
    const state = makeState({ phase: "INTERFACES" })
    const baseline = await captureRevisionBaseline("INTERFACES", state, tmpDir)
    expect(baseline).not.toBeNull()
    // Modify tracked file (unstaged change — shows in git diff)
    writeFileSync(filePath, "new content")
    const changed = await hasArtifactChanged(baseline!, "INTERFACES", undefined, state, tmpDir)
    expect(changed).toBe(true)
  })

  it("returns true when earlier cascade changes exist and new changes are added", async () => {
    // Start with existing uncommitted changes, capture baseline, then modify further
    initGitRepo(tmpDir)
    const file1 = join(tmpDir, "interfaces.ts")
    writeFileSync(file1, "old")
    execSync("git add -A && git commit -m add", { cwd: tmpDir, stdio: "pipe", shell: "/bin/sh" })
    writeFileSync(file1, "new")  // earlier cascade change (unstaged)
    const state = makeState({ phase: "TESTS" })
    const baseline = await captureRevisionBaseline("TESTS", state, tmpDir)
    expect(baseline).not.toBeNull()
    // Add MORE changes during REVISE (modify the same or different tracked file)
    writeFileSync(file1, "even newer")  // further unstaged change
    const changed = await hasArtifactChanged(baseline!, "TESTS", undefined, state, tmpDir)
    expect(changed).toBe(true)
  })

  it("returns true (allow through) when not a git repo", async () => {
    // tmpDir is not a git repo — graceful degradation
    const baseline = { type: "git-sha" as const, sha: contentHash("") }
    const state = makeState({ phase: "INTERFACES" })
    const changed = await hasArtifactChanged(baseline, "INTERFACES", undefined, state, tmpDir)
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

    const changed = await hasArtifactChanged(baseline, "PLANNING", "content", state, tmpDir)
    expect(changed).toBe(true)
  })
})
