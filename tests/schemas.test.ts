import { describe, expect, it } from "bun:test"

import { RequestReviewToolSchema, toJsonSchema } from "#core/schemas"

describe("shared tool schemas", () => {
  it("allows request_review markdown materialization with an empty artifact file list", () => {
    const parsed = RequestReviewToolSchema.safeParse({
      summary: "Conventions",
      artifact_description: "Conventions doc",
      artifact_files: [],
      artifact_markdown: "# Conventions\n",
    })

    expect(parsed.success).toBe(true)
  })

  it("still rejects request_review calls that provide no review source", () => {
    const parsed = RequestReviewToolSchema.safeParse({
      summary: "Plan",
      artifact_description: "Plan doc",
      artifact_files: [],
    })

    expect(parsed.success).toBe(false)
  })

  it("keeps artifact_files required in generated request_review JSON schema", () => {
    const schema = toJsonSchema(RequestReviewToolSchema) as {
      required?: string[]
      properties?: { artifact_files?: { minItems?: number } }
    }

    expect(schema.required).toContain("artifact_files")
    expect(schema.properties?.artifact_files?.minItems).toBeUndefined()
  })
})
