import { describe, expect, it } from "bun:test"

import {
  buildScenarioSufficiencyPromptBlock,
  parseRealWorldAcceptanceScenario,
} from "#core/scenario-sufficiency"
import {
  ScenarioSufficiencyContextSchema,
  ScenarioSufficiencyLogEventPayloadSchema,
  ScenarioSufficiencyParseResultSchema,
  ScenarioSufficiencyPromptBlockResultSchema,
} from "#core/schemas"
import type { ScenarioSufficiencyContext } from "#core/workflow-state-types"

const PLAN_PATH = "/workspace/.openartisan/feature/plan.md"

function validScenarioMarkdown(overrides: Partial<Record<"scenario" | "capabilities" | "checks" | "nonGoals", string>> = {}): string {
  return `# Plan

## Real-World Acceptance Scenario

### Scenario
${overrides.scenario ?? "A maintainer resumes a compacted workflow and needs every reviewer to preserve the user's motivating use case."}

### Required Capabilities
${overrides.capabilities ?? "- Capture the scenario from planning\n- Carry it into author and reviewer prompts"}

### Acceptance Checks
${overrides.checks ?? "- Later artifacts are reviewed against the scenario\n- Scope drift is reported before implementation"}

### Explicit Non-Goals
${overrides.nonGoals ?? "- Do not infer scenarios from arbitrary chat"}

## Architecture
Details follow.
`
}

function validScenarioContext(overrides: Partial<ScenarioSufficiencyContext> = {}): ScenarioSufficiencyContext {
  return {
    scenario: "A maintainer resumes a compacted workflow and needs reviewers to preserve the motivating use case.",
    requiredCapabilities: ["Capture the planning scenario", "Carry it into downstream reviews"],
    acceptanceChecks: ["Reviewers evaluate artifacts against the scenario"],
    explicitNonGoals: ["Do not infer scenarios from arbitrary chat"],
    sourceArtifactPath: PLAN_PATH,
    capturedAtPhase: "PLANNING",
    ...overrides,
  }
}

describe("parseRealWorldAcceptanceScenario", () => {
  it("parseRealWorldAcceptanceScenario(markdown, sourceArtifactPath) parses the required planning section", () => {
    const result = parseRealWorldAcceptanceScenario(validScenarioMarkdown(), PLAN_PATH)

    expect(result.success).toBe(true)
    expect(ScenarioSufficiencyParseResultSchema.parse(result)).toEqual(result)
    if (!result.success) return
    expect(result.scenario.scenario).toContain("maintainer resumes")
    expect(result.scenario.requiredCapabilities).toEqual([
      "Capture the scenario from planning",
      "Carry it into author and reviewer prompts",
    ])
    expect(result.scenario.acceptanceChecks).toEqual([
      "Later artifacts are reviewed against the scenario",
      "Scope drift is reported before implementation",
    ])
    expect(result.scenario.explicitNonGoals).toEqual(["Do not infer scenarios from arbitrary chat"])
    expect(result.scenario.sourceArtifactPath).toBe(PLAN_PATH)
    expect(result.scenario.capturedAtPhase).toBe("PLANNING")
  })

  it("parseRealWorldAcceptanceScenario(markdown, sourceArtifactPath) accepts the explicit non-goals sentinel as an empty array", () => {
    const result = parseRealWorldAcceptanceScenario(
      validScenarioMarkdown({ nonGoals: "None beyond the plan scope boundaries." }),
      PLAN_PATH,
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.scenario.explicitNonGoals).toEqual([])
  })

  it("parseRealWorldAcceptanceScenario(markdown, sourceArtifactPath) returns SCENARIO_SECTION_MISSING without throwing", () => {
    const result = parseRealWorldAcceptanceScenario("# Plan\n\n## Scope\nNo scenario section.", PLAN_PATH)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.map((error) => error.code)).toContain("SCENARIO_SECTION_MISSING")
    expect(result.errors[0]!.sourceArtifactPath).toBe(PLAN_PATH)
  })

  it("parseRealWorldAcceptanceScenario(markdown, sourceArtifactPath) returns structured validation errors for missing required fields", () => {
    const result = parseRealWorldAcceptanceScenario(
      validScenarioMarkdown({ scenario: " ", capabilities: "No bullet here", checks: " ", nonGoals: " " }),
      PLAN_PATH,
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.map((error) => error.code).sort()).toEqual([
      "ACCEPTANCE_CHECKS_MISSING",
      "EXPLICIT_NON_GOALS_MISSING",
      "REQUIRED_CAPABILITIES_MISSING",
      "SCENARIO_PROSE_MISSING",
    ])
    for (const error of result.errors) {
      expect(error.message).toBeTruthy()
      expect(error.message).not.toContain("maintainer resumes")
    }
  })

  it("parseRealWorldAcceptanceScenario(markdown, sourceArtifactPath) rejects non-absolute source artifact paths", () => {
    const result = parseRealWorldAcceptanceScenario(validScenarioMarkdown(), "relative/plan.md")

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.map((error) => error.code)).toContain("SOURCE_ARTIFACT_PATH_INVALID")
  })
})

describe("buildScenarioSufficiencyPromptBlock", () => {
  it("buildScenarioSufficiencyPromptBlock(scenario) builds a concise scenario sufficiency block", () => {
    const result = buildScenarioSufficiencyPromptBlock(validScenarioContext(), {
      heading: "Real-World Acceptance Scenario",
      includeSourcePath: true,
    })

    expect(result.success).toBe(true)
    expect(ScenarioSufficiencyPromptBlockResultSchema.parse(result)).toEqual(result)
    if (!result.success) return
    expect(result.block).toContain("Real-World Acceptance Scenario")
    expect(result.block).toContain("A maintainer resumes")
    expect(result.block).toContain("Capture the planning scenario")
    expect(result.block).toContain("Reviewers evaluate artifacts against the scenario")
    expect(result.block).toContain("Do not infer scenarios from arbitrary chat")
    expect(result.block).toContain(PLAN_PATH)
  })

  it("buildScenarioSufficiencyPromptBlock(null) returns a successful null block", () => {
    const result = buildScenarioSufficiencyPromptBlock(null)

    expect(result).toEqual({ success: true, block: null })
  })

  it("buildScenarioSufficiencyPromptBlock(scenario) returns structured validation errors for invalid persisted scenario state", () => {
    const result = buildScenarioSufficiencyPromptBlock(validScenarioContext({ requiredCapabilities: [] }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.map((error) => error.code)).toContain("REQUIRED_CAPABILITIES_MISSING")
  })
})

describe("ScenarioSufficiency schemas", () => {
  it("ScenarioSufficiencyContextSchema enforces non-empty arrays and absolute source paths", () => {
    expect(ScenarioSufficiencyContextSchema.parse(validScenarioContext())).toEqual(validScenarioContext())
    expect(() => ScenarioSufficiencyContextSchema.parse(validScenarioContext({ sourceArtifactPath: "plan.md" }))).toThrow()
    expect(() => ScenarioSufficiencyContextSchema.parse(validScenarioContext({ acceptanceChecks: [] }))).toThrow()
  })

  it("ScenarioSufficiencyLogEventPayloadSchema forbids logging full user-authored scenario text", () => {
    expect(ScenarioSufficiencyLogEventPayloadSchema.parse({
      event: "scenario.validation_failed",
      sourceArtifactPath: PLAN_PATH,
      errorCodes: ["SCENARIO_PROSE_MISSING"],
      scenarioTextLogged: false,
    })).toEqual({
      event: "scenario.validation_failed",
      sourceArtifactPath: PLAN_PATH,
      errorCodes: ["SCENARIO_PROSE_MISSING"],
      scenarioTextLogged: false,
    })
    expect(() => ScenarioSufficiencyLogEventPayloadSchema.parse({
      event: "scenario.validation_failed",
      scenarioTextLogged: true,
      scenario: "raw user scenario text",
    })).toThrow()
  })
})
