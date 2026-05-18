import { describe, expect, it } from "bun:test"

import {
  extractPlannedReviewedInterfaceArtifacts,
  validatePlannedReviewedInterfaceArtifacts,
} from "#core/tools/planning-interface-artifacts"

describe("planning interface artifact validation", () => {
  it("rejects non-interface files explicitly planned as reviewed INTERFACES artifacts", () => {
    const plan = `# Plan

The interface-contract portion of the allowlist includes the actual source-of-truth workflow contract files required by INTERFACES review: \
\`packages/core/workflow-primitives.ts\`, \`packages/core/workflow-state-types.ts\`, and \`packages/core/review-types.ts\`.
`

    const errors = validatePlannedReviewedInterfaceArtifacts(plan)

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("packages/core/workflow-primitives.ts")
    expect(errors[0]).toContain("supporting implementation dependency")
    expect(errors[0]).toContain("*-contracts.ts")
  })

  it("allows the same non-interface file when listed only as supporting context", () => {
    const plan = `# Plan

## Reviewed INTERFACES artifacts

- \`packages/core/workflow-state-types.ts\`
- \`packages/core/review-types.ts\`

## Supporting implementation dependencies

- \`packages/core/workflow-primitives.ts\`
`

    expect(extractPlannedReviewedInterfaceArtifacts(plan).map((item) => item.path)).toEqual([
      "packages/core/workflow-state-types.ts",
      "packages/core/review-types.ts",
    ])
    expect(validatePlannedReviewedInterfaceArtifacts(plan)).toEqual([])
  })

  it("extracts explicit reviewed interface artifact sections", () => {
    const plan = `# Plan

### Reviewed INTERFACES artifacts

- packages/core/tool-types.ts
- \`packages/core/structural-workflow-types.ts\`
`

    expect(extractPlannedReviewedInterfaceArtifacts(plan).map((item) => item.path)).toEqual([
      "packages/core/tool-types.ts",
      "packages/core/structural-workflow-types.ts",
    ])
  })
})
