import { describe, expect, it } from "bun:test"
import { validatePriorState, extractSessionId, extractLLMText } from "#plugin/type-validation"

describe("validatePriorState", () => {
  it("returns null for non-object input", () => {
    expect(validatePriorState(null)).toBeNull()
    expect(validatePriorState("bad")).toBeNull()
  })

  it("sanitizes fields and filters non-string entries", () => {
    const result = validatePriorState({
      intentBaseline: 123,
      phase: 456,
      artifactDiskPaths: { plan: 123, tests: "/tmp/tests.md" },
      approvedArtifacts: { plan: "hash", bad: 42 },
    })

    expect(result).not.toBeNull()
    expect(result?.intentBaseline).toBeNull()
    expect(result?.phase).toBe("UNKNOWN")
    expect(result?.artifactDiskPaths).toEqual({ tests: "/tmp/tests.md" })
    expect(result?.approvedArtifacts).toEqual({ plan: "hash" })
  })
})

describe("extractSessionId", () => {
  it("extracts id from direct field", () => {
    expect(extractSessionId({ id: "abc" })).toBe("abc")
  })

  it("extracts id from data field", () => {
    expect(extractSessionId({ data: { id: "xyz" } })).toBe("xyz")
  })

  it("returns null when id is missing", () => {
    expect(extractSessionId({})).toBeNull()
  })
})

describe("extractLLMText", () => {
  it("extracts text from direct field", () => {
    expect(extractLLMText({ text: "hello" })).toBe("hello")
  })

  it("extracts text from data.text", () => {
    expect(extractLLMText({ data: { text: "world" } })).toBe("world")
  })

  it("extracts text from data.parts[0].text", () => {
    expect(extractLLMText({ data: { parts: [{ text: "part" }] } })).toBe("part")
  })

  it("returns null when text is missing", () => {
    expect(extractLLMText({ data: { parts: [] } })).toBeNull()
  })
})
