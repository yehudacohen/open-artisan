import type {
  ScenarioSufficiencyContext,
  ScenarioSufficiencyParseResult,
  ScenarioSufficiencyPromptBlockOptions,
  ScenarioSufficiencyPromptBlockResult,
  ScenarioSufficiencyValidationCode,
  ScenarioSufficiencyValidationError,
} from "./workflow-state-types"

const SCENARIO_SECTION_HEADING = "Real-World Acceptance Scenario"
const NON_GOALS_EMPTY_SENTINEL = "none beyond the plan scope boundaries."

type ScenarioSectionKey = "scenario" | "requiredCapabilities" | "acceptanceChecks" | "explicitNonGoals"

const SUBSECTION_HEADINGS: Record<string, ScenarioSectionKey> = {
  scenario: "scenario",
  "required capabilities": "requiredCapabilities",
  "acceptance checks": "acceptanceChecks",
  "explicit non-goals": "explicitNonGoals",
}

function createError(
  code: ScenarioSufficiencyValidationCode,
  sourceArtifactPath: string,
): ScenarioSufficiencyValidationError {
  return {
    code,
    message: buildValidationMessage(code),
    sourceArtifactPath,
  }
}

function buildValidationMessage(code: ScenarioSufficiencyValidationCode): string {
  switch (code) {
    case "SCENARIO_SECTION_MISSING":
      return `Planning artifact must include a ## ${SCENARIO_SECTION_HEADING} section.`
    case "SCENARIO_PROSE_MISSING":
      return "Scenario section must include non-empty prose under ### Scenario."
    case "REQUIRED_CAPABILITIES_MISSING":
      return "Scenario section must include at least one bullet under ### Required Capabilities."
    case "ACCEPTANCE_CHECKS_MISSING":
      return "Scenario section must include at least one bullet under ### Acceptance Checks."
    case "EXPLICIT_NON_GOALS_MISSING":
      return "Scenario section must include bullets under ### Explicit Non-Goals, or the approved empty non-goals sentinel."
    case "SOURCE_ARTIFACT_PATH_INVALID":
      return "Scenario source artifact path must be absolute."
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/")
}

function extractScenarioSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/)
  const startIndex = lines.findIndex((line) => line.trim() === `## ${SCENARIO_SECTION_HEADING}`)
  if (startIndex === -1) return null

  const sectionLines: string[] = []
  for (const line of lines.slice(startIndex + 1)) {
    if (/^##\s+/.test(line.trim())) break
    sectionLines.push(line)
  }
  return sectionLines.join("\n")
}

function extractSubsections(section: string): Partial<Record<ScenarioSectionKey, string>> {
  const subsections: Partial<Record<ScenarioSectionKey, string[]>> = {}
  let currentKey: ScenarioSectionKey | null = null

  for (const line of section.split(/\r?\n/)) {
    const headingMatch = line.trim().match(/^###\s+(.+)$/)
    if (headingMatch) {
      currentKey = SUBSECTION_HEADINGS[headingMatch[1]!.trim().toLowerCase()] ?? null
      if (currentKey) subsections[currentKey] = []
      continue
    }

    if (currentKey) subsections[currentKey]!.push(line)
  }

  return Object.fromEntries(
    Object.entries(subsections).map(([key, lines]) => [key, lines.join("\n")]),
  ) as Partial<Record<ScenarioSectionKey, string>>
}

function parseBullets(markdown: string | undefined): string[] {
  if (!markdown) return []

  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
}

function parseScenarioProse(markdown: string | undefined): string {
  if (!markdown) return ""
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

function parseExplicitNonGoals(markdown: string | undefined): { validSentinel: boolean; values: string[] } {
  const bullets = parseBullets(markdown)
  if (bullets.length > 0) return { validSentinel: false, values: bullets }

  const text = parseScenarioProse(markdown).toLowerCase()
  return { validSentinel: text === NON_GOALS_EMPTY_SENTINEL, values: [] }
}

function validateScenarioContext(
  scenario: ScenarioSufficiencyContext,
): ScenarioSufficiencyValidationError[] {
  const errors: ScenarioSufficiencyValidationError[] = []

  if (!scenario.scenario.trim()) errors.push(createError("SCENARIO_PROSE_MISSING", scenario.sourceArtifactPath))
  if (scenario.requiredCapabilities.filter((item) => item.trim()).length === 0) {
    errors.push(createError("REQUIRED_CAPABILITIES_MISSING", scenario.sourceArtifactPath))
  }
  if (scenario.acceptanceChecks.filter((item) => item.trim()).length === 0) {
    errors.push(createError("ACCEPTANCE_CHECKS_MISSING", scenario.sourceArtifactPath))
  }
  if (scenario.explicitNonGoals.some((item) => !item.trim())) {
    errors.push(createError("EXPLICIT_NON_GOALS_MISSING", scenario.sourceArtifactPath))
  }
  if (!isAbsolutePath(scenario.sourceArtifactPath)) {
    errors.push(createError("SOURCE_ARTIFACT_PATH_INVALID", scenario.sourceArtifactPath))
  }

  return errors
}

export function parseRealWorldAcceptanceScenario(
  markdown: string,
  sourceArtifactPath: string,
): ScenarioSufficiencyParseResult {
  const errors: ScenarioSufficiencyValidationError[] = []

  if (!isAbsolutePath(sourceArtifactPath)) {
    errors.push(createError("SOURCE_ARTIFACT_PATH_INVALID", sourceArtifactPath))
  }

  const section = extractScenarioSection(markdown)
  if (section === null) {
    errors.push(createError("SCENARIO_SECTION_MISSING", sourceArtifactPath))
    return { success: false, errors }
  }

  const subsections = extractSubsections(section)
  const scenario = parseScenarioProse(subsections.scenario)
  const requiredCapabilities = parseBullets(subsections.requiredCapabilities)
  const acceptanceChecks = parseBullets(subsections.acceptanceChecks)
  const explicitNonGoals = parseExplicitNonGoals(subsections.explicitNonGoals)

  if (!scenario) errors.push(createError("SCENARIO_PROSE_MISSING", sourceArtifactPath))
  if (requiredCapabilities.length === 0) errors.push(createError("REQUIRED_CAPABILITIES_MISSING", sourceArtifactPath))
  if (acceptanceChecks.length === 0) errors.push(createError("ACCEPTANCE_CHECKS_MISSING", sourceArtifactPath))
  if (!explicitNonGoals.validSentinel && explicitNonGoals.values.length === 0) {
    errors.push(createError("EXPLICIT_NON_GOALS_MISSING", sourceArtifactPath))
  }

  if (errors.length > 0) return { success: false, errors }

  return {
    success: true,
    scenario: {
      scenario,
      requiredCapabilities,
      acceptanceChecks,
      explicitNonGoals: explicitNonGoals.values,
      sourceArtifactPath,
      capturedAtPhase: "PLANNING",
    },
  }
}

export function buildScenarioSufficiencyPromptBlock(
  scenario: ScenarioSufficiencyContext | null,
  options: ScenarioSufficiencyPromptBlockOptions = {},
): ScenarioSufficiencyPromptBlockResult {
  if (scenario === null) return { success: true, block: null }

  const errors = validateScenarioContext(scenario)
  if (errors.length > 0) return { success: false, errors }

  const heading = options.heading ?? "Scenario Sufficiency"
  const lines = [
    `## ${heading}`,
    "",
    scenario.scenario,
    "",
    "Required capabilities:",
    ...scenario.requiredCapabilities.map((capability) => `- ${capability.trim()}`),
    "",
    "Acceptance checks:",
    ...scenario.acceptanceChecks.map((check) => `- ${check.trim()}`),
  ]

  if (scenario.explicitNonGoals.length > 0) {
    lines.push("", "Explicit non-goals:", ...scenario.explicitNonGoals.map((nonGoal) => `- ${nonGoal.trim()}`))
  }

  if (options.includeSourcePath) {
    lines.push("", `Source artifact: ${scenario.sourceArtifactPath}`)
  }

  return { success: true, block: lines.join("\n") }
}
