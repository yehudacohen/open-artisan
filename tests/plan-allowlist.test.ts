import { describe, expect, it } from "bun:test"

import { extractApprovedFileAllowlist } from "#core/tools/plan-allowlist"

describe("extractApprovedFileAllowlist", () => {
  it("extracts markdown-wrapped file paths and skips explanatory bullets", () => {
    const plan = `# Plan

## Narrow allowlist
- \`packages/core/types.ts\`
- \`packages/core/session-state.ts\`
- Existing DAG/state model files already used by workflow execution:
  - \`packages/core/dag.ts\`
  - \`packages/core/scheduler.ts\`
- Approved roadmap test files required by downstream TESTS and IMPL_PLAN artifacts:
  - \`packages/core/tests/roadmap-types.test.ts\`
  - \`packages/bridge/tests/roadmap-tool-execute.test.ts\`
`

    expect(extractApprovedFileAllowlist(plan, "/project")).toEqual([
      "/project/packages/core/types.ts",
      "/project/packages/core/session-state.ts",
      "/project/packages/core/dag.ts",
      "/project/packages/core/scheduler.ts",
      "/project/packages/core/tests/roadmap-types.test.ts",
      "/project/packages/bridge/tests/roadmap-tool-execute.test.ts",
    ])
  })
})
