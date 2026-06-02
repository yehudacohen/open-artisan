/**
 * proposeDirectApplication phase gate.
 *
 * Direct application is available in any phase, but during an ACTIVE workflow it
 * may only touch OUT-OF-BAND files (those the current phase's policy would not let
 * the agent author directly). In-scope/in-phase files are rejected so they go
 * through normal authoring + review. MODE_SELECT/DONE allow any (non-blocked) file.
 */
import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { proposeDirectApplication } from "#core/direct-application"
import type { WorkflowState } from "#core/workflow-state-types"

function stateAt(phase: string, phaseState: string): WorkflowState {
  return {
    phase, phaseState, mode: "GREENFIELD", fileAllowlist: [], approvedCleanupFiles: [],
  } as unknown as WorkflowState
}

function diff(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
}

async function propose(state: WorkflowState, path: string) {
  const cwd = await mkdtemp(join(tmpdir(), "direct-app-"))
  return proposeDirectApplication({
    state, cwd, summary: "tweak", whySafe: "one-line, narrow, reversible",
    affectedFiles: [path], patch: diff(path),
  })
}

const OUT_OF_BAND = "may only touch out-of-band files"

describe("proposeDirectApplication phase gate", () => {
  it("rejects an in-phase file during an active workflow (must go through review)", async () => {
    // INTERFACES treats *.ts/types as authorable → in-scope → must use the workflow.
    const result = await propose(stateAt("INTERFACES", "DRAFT"), "packages/x/src/types.ts")
    expect(result.approved).toBe(false)
    expect(result.reason).toContain(OUT_OF_BAND)
  })

  it("allows an out-of-band file during an active workflow (passes the phase gate)", async () => {
    // A design doc is not authorable in INTERFACES → out-of-band → gate lets it through
    // (it then fails at git apply in the empty temp dir, which is fine — not a gate reject).
    const result = await propose(stateAt("INTERFACES", "DRAFT"), "docs/design/platform-architecture.md")
    expect(result.reason).not.toContain(OUT_OF_BAND)
  })

  it("allows any (non-blocked) file at MODE_SELECT (preserved behavior)", async () => {
    const result = await propose(stateAt("MODE_SELECT", "DRAFT"), "docs/design/platform-architecture.md")
    expect(result.reason).not.toContain(OUT_OF_BAND)
  })

  it("still blocks .openartisan and .env regardless of phase", async () => {
    const artifact = await propose(stateAt("MODE_SELECT", "DRAFT"), ".openartisan/x/plan.md")
    expect(artifact.approved).toBe(false)
    expect(artifact.reason).toContain("not eligible")
    const env = await propose(stateAt("INTERFACES", "DRAFT"), ".env")
    expect(env.approved).toBe(false)
  })
})
