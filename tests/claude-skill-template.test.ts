import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")

describe("Claude artisan skill template", () => {
  it("does not treat no argument as permission to enable workflow", () => {
    const content = readFileSync(join(ROOT, "packages/claude-code/templates/SKILL.md"), "utf-8")

    expect(content).toContain("No argument means status only")
    expect(content).toContain("Never enable workflow enforcement unless the user explicitly asks")
    expect(content).not.toContain("\"on\" or no argument when workflow is not active")
  })

  it("documents build-mode and Hermes dogfooding safety", () => {
    const content = readFileSync(join(ROOT, "packages/claude-code/templates/SKILL.md"), "utf-8")

    expect(content).toContain("build mode")
    expect(content).toContain("Hermes/Open Artisan")
    expect(content).toContain("do not enable Artisan in Claude Code")
  })
})
