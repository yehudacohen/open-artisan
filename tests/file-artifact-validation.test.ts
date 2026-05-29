import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { collectImplementationReviewArtifactFiles, validateFileBasedReviewArtifacts } from "#core/tools/file-artifact-validation"
import type { WorkflowState } from "#core/workflow-state-types"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "artifact-validation-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("implementation review artifact validation", () => {
  it("ignores command-like completed task metadata while preserving existing file arguments", async () => {
    const sourcePath = join(tmpDir, "src", "feature.ts")
    const testPath = join(tmpDir, "test", "integration", "ory", "ory-identity-stack.test.ts")
    await mkdir(join(tmpDir, "src"), { recursive: true })
    await mkdir(join(tmpDir, "test", "integration", "ory"), { recursive: true })
    await Bun.write(sourcePath, "export const feature = true\n")
    await Bun.write(testPath, "import { expect, it } from 'bun:test'\n")

    const state = {
      phase: "IMPLEMENTATION",
      reviewArtifactFiles: [sourcePath],
      implDag: [
        {
          id: "T1",
          description: "Build feature",
          dependencies: [],
          expectedFiles: [
            "src/feature.ts",
            `${tmpDir}/bun test \"test/integration/ory/ory-identity-stack.test.ts\" --timeout 10000`,
          ],
          expectedTests: ["bun test \"test/integration/ory/ory-identity-stack.test.ts\" --timeout 10000"],
          estimatedComplexity: "small",
          status: "complete",
        },
      ],
    } as unknown as WorkflowState

    const artifactFiles = collectImplementationReviewArtifactFiles(state, tmpDir)

    expect(artifactFiles).toContain(sourcePath)
    expect(artifactFiles).toContain(testPath)
    expect(artifactFiles.some((file) => file.includes("bun test"))).toBe(false)
  })

  it("returns command-specific guidance when artifact_files contains a command", () => {
    const commandAsPath = resolve(tmpDir, "bun test test/integration/ory/ory-identity-stack.test.ts --timeout 10000")

    const error = validateFileBasedReviewArtifacts({
      phase: "IMPLEMENTATION",
      artifactFiles: [commandAsPath],
      cwd: tmpDir,
    })

    expect(error).toContain("received a command")
    expect(error).toContain("Verification commands")
  })
})
