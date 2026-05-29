/**
 * Tests for processRequestReview.
 */
import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { collectImplementationReviewArtifactFiles, validateFileBasedReviewArtifacts } from "#core/tools/file-artifact-validation"
import { parseRequestReviewArtifactData, processRequestReview } from "#core/tools/request-review"

function requestReviewArgs(overrides: { summary: string; artifact_description: string }) {
  return { ...overrides, artifact_files: ["/tmp/artifact.md"] }
}

describe("processRequestReview — response message", () => {
  it("includes the summary in the response message", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "Implemented user auth service",
      artifact_description: "auth.ts — 3 functions exported",
    }))
    expect(result.responseMessage).toContain("Implemented user auth service")
  })

  it("includes the artifact description in the response message", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "Done",
      artifact_description: "types.ts — 5 interfaces",
    }))
    expect(result.responseMessage).toContain("types.ts — 5 interfaces")
  })

  it("response message mentions REVIEW state", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.responseMessage).toContain("REVIEW")
  })

  it("response message instructs to call mark_satisfied", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.responseMessage).toContain("mark_satisfied")
  })
})

describe("processRequestReview — phase instructions", () => {
  it("includes acceptance criteria instructions", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.phaseInstructions).toContain("acceptance criteria")
  })

  it("instructs to call mark_satisfied", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    expect(result.phaseInstructions).toContain("mark_satisfied")
  })

  it("both responseMessage and phaseInstructions are non-empty strings", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "anything",
      artifact_description: "any artifact",
    }))
    expect(typeof result.responseMessage).toBe("string")
    expect(result.responseMessage.length).toBeGreaterThan(0)
    expect(typeof result.phaseInstructions).toBe("string")
    expect(result.phaseInstructions.length).toBeGreaterThan(0)
  })

  it("handles empty summary and description gracefully", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "",
      artifact_description: "",
    }))
    expect(result.responseMessage.length).toBeGreaterThan(0)
    expect(result.phaseInstructions.length).toBeGreaterThan(0)
  })

  it("preserves special characters in summary", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "Built types<T> and Promise<Result>",
      artifact_description: "api.ts",
    }))
    expect(result.responseMessage).toContain("types<T>")
  })

  it("instructs to read actual files before evaluating", () => {
    const result = processRequestReview(requestReviewArgs({
      summary: "s",
      artifact_description: "a",
    }))
    // Ensures the review instructions emphasize file reading
    expect(result.phaseInstructions.toLowerCase()).toContain("read")
  })
})

describe("parseRequestReviewArtifactData", () => {
  it("parses structured artifact metadata from request_review", () => {
    const result = parseRequestReviewArtifactData({
      summary: "Plan ready",
      artifact_description: "Plan artifact",
      artifact_files: ["/tmp/plan.md"],
      artifact_data_json: JSON.stringify({ requiredSections: ["scenario"], allowlistSource: "tool" }),
    })

    expect(result.success).toBe(true)
    expect(result.success ? result.artifactData : null).toEqual({ requiredSections: ["scenario"], allowlistSource: "tool" })
  })

  it("rejects non-object structured artifact metadata", () => {
    const result = parseRequestReviewArtifactData({
      summary: "Plan ready",
      artifact_description: "Plan artifact",
      artifact_files: ["/tmp/plan.md"],
      artifact_data_json: "[]",
    })

    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error).toContain("JSON object")
  })
})

describe("validateFileBasedReviewArtifacts — mixed contract modules", () => {
  it("accepts an approved mixed contract module during INTERFACES", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oa-request-review-"))
    try {
      const contractsPath = join(dir, "contracts.ts")
      await writeFile(contractsPath, "export interface Contract { id: string }\nexport const ContractSchema = {}\n")

      const error = validateFileBasedReviewArtifacts({
        phase: "INTERFACES",
        artifactFiles: [contractsPath],
        mixedContractModules: [{
          filePath: contractsPath,
          publicContractSurface: ["Contract", "ContractSchema"],
          executableBehaviorInScope: ["schema construction"],
          approvedInPlan: true,
        }],
      } as any)

      expect(error).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects unapproved executable implementation files during INTERFACES", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oa-request-review-"))
    try {
      const implementationPath = join(dir, "runtime.ts")
      await writeFile(implementationPath, "export function run() { return true }\n")

      const error = validateFileBasedReviewArtifacts({
        phase: "INTERFACES",
        artifactFiles: [implementationPath],
      })

      expect(error).toContain("only accepts interface/type/schema files")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("collectImplementationReviewArtifactFiles", () => {
  it("excludes historical files superseded by completed intentional deletion metadata", () => {
    const files = collectImplementationReviewArtifactFiles({
      phase: "IMPLEMENTATION",
      reviewArtifactFiles: ["src/kept.ts", "src/deleted.ts"],
      implDag: [{
        id: "T1",
        description: "Historical task",
        dependencies: [],
        expectedFiles: ["src/deleted.ts", "src/kept.ts"],
        expectedTests: ["tests/kept.test.ts"],
        estimatedComplexity: "small",
        status: "complete",
      }, {
        id: "T9",
        description: "Deletion metadata repair",
        dependencies: ["T1"],
        expectedFiles: [],
        expectedTests: [],
        intentionalDeletionTargets: ["src/deleted.ts"],
        estimatedComplexity: "small",
        status: "complete",
      }],
    } as any, "/repo")

    expect(files).toEqual(["/repo/src/kept.ts", "/repo/tests/kept.test.ts"])
  })
})
