import { describe, expect, it } from "bun:test"
import { join } from "node:path"

import { extractApprovedFileAllowlist } from "#core/tools/plan-allowlist"

describe("extractApprovedFileAllowlist", () => {
  it("extracts a full requested replacement allowlist section", () => {
    const cwd = "/repo"
    const plan = `# Plan

## File Allowlist (requested replacement approval source)

This redraft replaces the currently approved INCREMENTAL allowlist.

### Requested allowlist delta from the currently approved scope

**Add these newly required files:**
- \`packages/adapter-hermes/hermes_adapter/session_projects.py\`
- \`packages/adapter-hermes/hermes_adapter/prompt_hook.py\`

### Full requested replacement allowlist

This redraft requests approval to modify only:
- \`packages/core/tool-contracts.ts\`
- \`packages/adapter-hermes/hermes_adapter/session_projects.py\`
- \`packages/adapter-hermes/hermes_adapter/prompt_hook.py\`
- \`packages/adapter-hermes/tests/test_prompt_hook.py\`

### Allowlist rationale

- Not an allowlist entry.
`

    expect(extractApprovedFileAllowlist(plan, cwd)).toEqual([
      join(cwd, "packages/core/tool-contracts.ts"),
      join(cwd, "packages/adapter-hermes/hermes_adapter/session_projects.py"),
      join(cwd, "packages/adapter-hermes/hermes_adapter/prompt_hook.py"),
      join(cwd, "packages/adapter-hermes/tests/test_prompt_hook.py"),
    ])
  })

  it("extracts a numbered replacement allowlist with prose and category headings", () => {
    const cwd = "/repo"
    const plan = `# Plan

## 13. File allowlist (INCREMENTAL mode)

This section is the **requested replacement allowlist** for the current PLANNING revision.

**Required allowlist delta in this revision:**
- explicitly replace the stale runtime allowlist with one that also includes \`packages/core/schemas.ts\` and \`packages/bridge/methods/task-boundary-tool-handlers.ts\`
- explicitly exclude machine-generated cache/build artifacts (\`__pycache__/\`, \`*.egg-info/\`) from feature scope

**Review semantics for this revision:**
- this section is the authoritative proposed replacement allowlist for the revised plan under review

The implementation is expected to touch **only** these files after this revision is approved:

### Core workflow engine and transition helpers
- \`packages/core/types.ts\`
- \`packages/core/schemas.ts\`

### Bridge / shared-runtime parity path
- \`packages/bridge/methods/task-boundary-tool-handlers.ts\`
- \`packages/bridge/methods/tool-execute.ts\`

### Allowlist adequacy rationale

This rationale mentions \`packages/not-a-listed-file.ts\` but is not part of the list.

---
`

    const extracted = extractApprovedFileAllowlist(plan, cwd)

    expect(extracted).toEqual([
      join(cwd, "packages/core/types.ts"),
      join(cwd, "packages/core/schemas.ts"),
      join(cwd, "packages/bridge/methods/task-boundary-tool-handlers.ts"),
      join(cwd, "packages/bridge/methods/tool-execute.ts"),
    ])
  })
})
