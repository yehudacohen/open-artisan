import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")

function readTemplate(): string {
  return readFileSync(join(ROOT, "packages/claude-code/templates/SKILL.md"), "utf-8")
}

function readInstalledSkill(): string {
  return readFileSync(join(ROOT, ".claude", "skills", "artisan", "SKILL.md"), "utf-8")
}

describe("Claude artisan skill template", () => {
  it("does not treat no argument as permission to enable workflow", () => {
    const content = readTemplate()

    expect(content).toContain("No argument means status only")
    expect(content).toContain("Never enable workflow enforcement unless the user explicitly asks")
    expect(content).not.toContain("\"on\" or no argument when workflow is not active")
  })

  it("documents build-mode and Hermes dogfooding safety", () => {
    const content = readTemplate()

    expect(content).toContain("build mode")
    expect(content).toContain("Hermes/Open Artisan")
    expect(content).toContain("do not enable Artisan in Claude Code")
  })

  it("keeps installed Claude artisan skill present and aligned with current enforcement", () => {
    const content = readInstalledSkill()

    expect(content).toContain("name: artisan")
    expect(content).toContain("allowed-tools: Bash(./artisan *)")
    expect(content).toContain("No argument means status only")
    expect(content).toContain("Claude `PreToolUse` hooks fail closed")
    expect(content).toContain("`INCREMENTAL` interface and test writes")
    expect(content).toContain("Bridge review submissions require valid isolated-review tokens")
  })

  it("documents current enforcement truths in the template", () => {
    const content = readTemplate()

    expect(content).toContain("Current enforcement truths")
    expect(content).toContain("Claude `PreToolUse` hooks fail closed")
    expect(content).toContain("Scope or allowlist expansion must be explicitly approved")
    expect(content).toContain("Persisted feature ownership is authoritative")
  })
})
