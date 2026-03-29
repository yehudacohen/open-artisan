#!/usr/bin/env bun
/**
 * artisan-setup.ts — Set up open-artisan for a Claude Code project.
 *
 * Creates/merges configuration files:
 *   - .claude/settings.json (hooks)
 *   - .claude/skills/artisan/SKILL.md (/artisan command)
 *   - CLAUDE-WORKFLOW.md (workflow instructions)
 *   - .openartisan/ directory
 *
 * Usage:
 *   bun run packages/claude-code/bin/artisan-setup.ts [--project-dir <path>]
 */

import { join, resolve, relative } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { parseArgs } from "node:util"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = join(import.meta.dirname, "..", "templates")

function getProjectDir(): string {
  const { values } = parseArgs({
    options: { "project-dir": { type: "string" } },
    strict: false,
  })
  return resolve(values["project-dir"] ?? process.cwd())
}

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

/** Deep merge hooks into existing settings.json without overwriting other keys. */
function mergeSettings(projectDir: string, hookScriptPath: string): void {
  const settingsDir = join(projectDir, ".claude")
  const settingsPath = join(settingsDir, "settings.json")
  mkdirSync(settingsDir, { recursive: true })

  // Read template and resolve hook script path
  const template = readFileSync(join(TEMPLATES_DIR, "settings.json.tmpl"), "utf-8")
  const resolved = template.replace(/\{\{ARTISAN_HOOK_PATH\}\}/g, hookScriptPath)
  const newHooks = JSON.parse(resolved).hooks as Record<string, unknown[]>

  // Read existing settings (or start fresh)
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    } catch {
      console.warn("  Warning: existing .claude/settings.json is invalid JSON, creating new file")
    }
  }

  // Merge hooks — add our hooks without removing existing ones
  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>
  for (const [event, hooks] of Object.entries(newHooks)) {
    const existing = existingHooks[event] ?? []
    // Check if our hook is already registered (by checking command substring)
    const alreadyRegistered = existing.some((entry: any) =>
      JSON.stringify(entry).includes("artisan-hook"),
    )
    if (!alreadyRegistered) {
      existingHooks[event] = [...existing, ...hooks]
    }
  }
  settings.hooks = existingHooks

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8")
  console.log("  .claude/settings.json — hooks merged")
}

// ---------------------------------------------------------------------------
// Skill installation
// ---------------------------------------------------------------------------

function installSkill(projectDir: string): void {
  const skillDir = join(projectDir, ".claude", "skills", "artisan")
  const skillPath = join(skillDir, "SKILL.md")

  mkdirSync(skillDir, { recursive: true })
  copyFileSync(join(TEMPLATES_DIR, "SKILL.md"), skillPath)
  console.log("  .claude/skills/artisan/SKILL.md — installed")
}

// ---------------------------------------------------------------------------
// Workflow instructions
// ---------------------------------------------------------------------------

function installWorkflowInstructions(projectDir: string): void {
  const destPath = join(projectDir, "CLAUDE-WORKFLOW.md")
  copyFileSync(join(TEMPLATES_DIR, "CLAUDE-WORKFLOW.md"), destPath)
  console.log("  CLAUDE-WORKFLOW.md — installed")

  // Check if CLAUDE.md exists and add @include if needed
  const claudeMdPath = join(projectDir, "CLAUDE.md")
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8")
    if (!content.includes("CLAUDE-WORKFLOW.md")) {
      writeFileSync(claudeMdPath, content + "\n@include CLAUDE-WORKFLOW.md\n", "utf-8")
      console.log("  CLAUDE.md — added @include CLAUDE-WORKFLOW.md")
    } else {
      console.log("  CLAUDE.md — already includes CLAUDE-WORKFLOW.md")
    }
  } else {
    console.log("  Note: No CLAUDE.md found. Claude Code will read CLAUDE-WORKFLOW.md if referenced.")
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const projectDir = getProjectDir()
  console.log(`Setting up open-artisan for: ${projectDir}\n`)

  // Validate
  if (!existsSync(projectDir)) {
    console.error(`Error: directory does not exist: ${projectDir}`)
    process.exit(1)
  }

  // Create .openartisan/
  const stateDir = join(projectDir, ".openartisan")
  mkdirSync(stateDir, { recursive: true })
  console.log("  .openartisan/ — created")

  // Resolve the hook script path relative to the project
  // Try to find artisan-hook.ts relative to this script's location
  const hookScriptAbs = join(import.meta.dirname, "artisan-hook.ts")
  const hookScriptRel = relative(projectDir, hookScriptAbs)
  // Use the shorter of absolute or relative
  const hookScriptPath = hookScriptRel.length < hookScriptAbs.length ? hookScriptRel : hookScriptAbs

  // Merge hooks into .claude/settings.json
  mergeSettings(projectDir, hookScriptPath)

  // Install /artisan skill
  installSkill(projectDir)

  // Install workflow instructions
  installWorkflowInstructions(projectDir)

  // Create project-local artisan wrapper script
  const artisanCliPath = join(import.meta.dirname, "artisan.ts")
  const wrapperPath = join(projectDir, "artisan")
  const wrapperContent = `#!/usr/bin/env bash\nexec bun run "${artisanCliPath}" "$@"\n`
  writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 })
  console.log("  ./artisan — CLI wrapper created (chmod +x)")

  // Summary
  const serverPath = relative(projectDir, join(import.meta.dirname, "artisan-server.ts"))
  console.log(`
Setup complete!

To start using open-artisan:
  1. Start the server:
     bun run ${serverPath} --project-dir "${projectDir}" --daemon

  2. Enable the workflow:
     ./artisan enable

  3. Or use the /artisan skill in Claude Code:
     /artisan on

To verify:
  ./artisan ping
  ./artisan state
`)
}

main()
