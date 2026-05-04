import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")

function readSkill(name: string): string {
  return readFileSync(join(ROOT, ".opencode", "skills", name, "SKILL.md"), "utf-8")
}

function readClaudeSkill(name: string): string {
  return readFileSync(join(ROOT, ".claude", "skills", name, "SKILL.md"), "utf-8")
}

describe("OpenCode dogfood skills", () => {
  it("uses a meta skill with driver-specific subskills", () => {
    const content = readSkill("open-artisan-dogfood")

    expect(content).toContain("driver=opencode")
    expect(content).toContain("open-artisan-dogfood-opencode")
    expect(content).toContain("open-artisan-dogfood-hermes")
    expect(content).toContain("open-artisan-dogfood-claude")
  })

  it("does not assume every dogfood run has an RFP", () => {
    const content = readSkill("open-artisan-dogfood")

    expect(content).toContain("When the feature has a design document, RFP, issue, spec, ADR")
    expect(content).toContain("When no design document or RFP exists")
    expect(content).toContain("rather than assuming every dogfood run has a formal RFP")
  })

  it("requires substantive user-gate investigation", () => {
    const content = readSkill("open-artisan-dogfood")

    expect(content).toContain("At every Open Artisan `USER_GATE`")
    expect(content).toContain("Requirements fit")
    expect(content).toContain("Artifact quality")
    expect(content).toContain("Open Artisan improvement signal")
  })

  it("documents OpenCode-native driver setup", () => {
    const content = readSkill("open-artisan-dogfood-opencode")

    expect(content).toContain("Open Artisan OpenCode plugin")
    expect(content).toContain("artisan` agent")
    expect(content).toContain("robot-artisan` agent")
    expect(content).toContain("not just a normal Build session")
  })

  it("requires Hermes proof to come from Hermes, not supervisor recovery", () => {
    const meta = readSkill("open-artisan-dogfood")
    const hermes = readSkill("open-artisan-dogfood-hermes")

    expect(meta).toContain("Any state mutation performed directly by the supervisor is a recovery action")
    expect(meta).toContain("do not count it as autonomous driver proof")
    expect(hermes).toContain("Supervisor-side bridge calls, direct adapter scripts, direct `oa_*` calls")
    expect(hermes).toContain("They do not prove Hermes dogfooding")
    expect(hermes).toContain("return control to the Hermes driver before approving or claiming success")
  })

  it("requires Hermes bridge freshness and final review evidence checks", () => {
    const hermes = readSkill("open-artisan-dogfood-hermes")

    expect(hermes).toContain("`.bridge-meta.json` advertising a PID/socket while the PID is not running or `.bridge.sock` is absent")
    expect(hermes).toContain("status files that lost the latest review evidence after approval")
    expect(hermes).toContain("latest review results are present for the artifact being approved")
    expect(hermes).toContain("PID is running, socket exists when transport is `unix-socket`")
  })

  it("keeps Claude-side cross-plugin dogfood guidance aligned", () => {
    const content = readClaudeSkill("dogfood")

    expect(content).toContain("Any state mutation performed directly by the supervisor is a recovery action")
    expect(content).toContain("They do not prove Hermes dogfooding")
    expect(content).toContain("latest review results are present for the artifact being approved")
    expect(content).toContain("`.bridge-meta.json` advertising a PID/socket while the PID is not running or `.bridge.sock` is absent")
  })
})
