/**
 * Tests for parseSelectModeArgs and buildSelectModeResponse.
 */
import { describe, expect, it } from "bun:test"
import { parseSelectModeArgs, buildSelectModeResponse, VALID_MODES } from "#core/tools/select-mode"

// ---------------------------------------------------------------------------
// parseSelectModeArgs
// ---------------------------------------------------------------------------

describe("parseSelectModeArgs — valid modes", () => {
  it("accepts GREENFIELD", () => {
    const result = parseSelectModeArgs({ mode: "GREENFIELD" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.mode).toBe("GREENFIELD")
  })

  it("accepts REFACTOR", () => {
    const result = parseSelectModeArgs({ mode: "REFACTOR" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.mode).toBe("REFACTOR")
  })

  it("accepts INCREMENTAL", () => {
    const result = parseSelectModeArgs({ mode: "INCREMENTAL" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.mode).toBe("INCREMENTAL")
  })
})

describe("parseSelectModeArgs — invalid inputs", () => {
  it("rejects an unknown mode string", () => {
    const result = parseSelectModeArgs({ mode: "EXPERIMENTAL" })
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("EXPERIMENTAL")
  })

  it("rejects null input", () => {
    const result = parseSelectModeArgs(null)
    expect("error" in result).toBe(true)
  })

  it("rejects a non-object input", () => {
    const result = parseSelectModeArgs("GREENFIELD")
    expect("error" in result).toBe(true)
  })

  it("rejects undefined mode field", () => {
    const result = parseSelectModeArgs({})
    expect("error" in result).toBe(true)
  })

  it("accepts lowercase mode via normalization", () => {
    const result = parseSelectModeArgs({ mode: "greenfield" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.mode).toBe("GREENFIELD")
  })

  it("accepts mixed-case mode via normalization", () => {
    const result = parseSelectModeArgs({ mode: "Incremental" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.mode).toBe("INCREMENTAL")
  })

  it("parses canonical and legacy feature name fields", () => {
    const canonical = parseSelectModeArgs({ mode: "GREENFIELD", feature_name: "runtime-cleanup" })
    expect("error" in canonical).toBe(false)
    if ("error" in canonical) return
    expect(canonical.featureName).toBe("runtime-cleanup")

    const legacy = parseSelectModeArgs({ mode: "GREENFIELD", feature: "runtime-cleanup" })
    expect("error" in legacy).toBe(false)
    if ("error" in legacy) return
    expect(legacy.featureName).toBe("runtime-cleanup")
  })

  it("rejects non-string mode value", () => {
    const result = parseSelectModeArgs({ mode: 42 })
    expect("error" in result).toBe(true)
  })

  it("rejects non-string feature names", () => {
    const result = parseSelectModeArgs({ mode: "GREENFIELD", feature_name: 42 })
    expect("error" in result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildSelectModeResponse
// ---------------------------------------------------------------------------

describe("buildSelectModeResponse — message content", () => {
  it("GREENFIELD message mentions PLANNING and skipping discovery", () => {
    const msg = buildSelectModeResponse("GREENFIELD")
    expect(msg).toContain("GREENFIELD")
    expect(msg).toContain("PLANNING")
    // Message should clarify discovery is skipped (not that it transitions to it)
    expect(msg.toLowerCase()).toContain("no discovery")
  })

  it("REFACTOR message mentions DISCOVERY", () => {
    const msg = buildSelectModeResponse("REFACTOR")
    expect(msg).toContain("REFACTOR")
    expect(msg).toContain("DISCOVERY")
  })

  it("INCREMENTAL message mentions DISCOVERY and allowlist", () => {
    const msg = buildSelectModeResponse("INCREMENTAL")
    expect(msg).toContain("INCREMENTAL")
    expect(msg).toContain("DISCOVERY")
    expect(msg.toLowerCase()).toContain("allowlist")
  })
})

describe("VALID_MODES", () => {
  it("contains exactly the three expected modes", () => {
    expect(VALID_MODES).toHaveLength(3)
    expect(VALID_MODES).toContain("GREENFIELD")
    expect(VALID_MODES).toContain("REFACTOR")
    expect(VALID_MODES).toContain("INCREMENTAL")
  })
})
