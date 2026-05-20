import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { TOOL_HANDLERS } from "#bridge/methods/tool-execute"
import { TOOLS as MCP_TOOLS } from "#claude-code/bin/artisan-mcp-tools"
import { buildHermesToolContractsArtifact, hermesToolContractCount } from "../tools/hermes-tool-contract-artifact"
import { RequestReviewToolSchema, toJsonSchema } from "#core/schemas"
import { WORKFLOW_TOOL_NAMES } from "#core/workflow-tool-names"
import {
  assertValidToolContracts,
  BRIDGE_TOOL_CONTRACTS,
  deriveToolContractProjection,
  HERMES_AUTHOR_TOOL_CONTRACTS,
  HERMES_AUTHOR_PROJECTION_CONFIG,
  MCP_TOOL_CONTRACTS,
  OPENCODE_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
  validateToolContracts,
  WORKFLOW_TOOL_CONTRACTS,
  type DriftBacktrackAutoSkipPolicy,
} from "#core/tool-contracts"

describe("tool contract registry", () => {
  it("has unique canonical and MCP names", () => {
    const names = TOOL_CONTRACTS.map((contract) => contract.name)
    expect(new Set(names).size).toBe(names.length)

    const mcpNames = MCP_TOOL_CONTRACTS.map((contract) => contract.mcpName)
    expect(mcpNames.every((name): name is string => typeof name === "string" && name.length > 0)).toBe(true)
    expect(new Set(mcpNames).size).toBe(mcpNames.length)
  })

  it("validates the canonical registry and derives the Hermes author projection", () => {
    const validation = validateToolContracts(TOOL_CONTRACTS)
    expect(validation.success).toBe(true)

    const projection = deriveToolContractProjection(TOOL_CONTRACTS, HERMES_AUTHOR_PROJECTION_CONFIG)
    expect(projection.success).toBe(true)
    expect(projection.success ? projection.contracts.map((contract) => contract.name) : []).toEqual(
      HERMES_AUTHOR_TOOL_CONTRACTS.map((contract) => contract.name),
    )
  })

  it("rejects invalid contract registry metadata", () => {
    const { mcpName: _mcpName, ...badAuthorBase } = TOOL_CONTRACTS[0]!
    const invalid = validateToolContracts([
      ...TOOL_CONTRACTS,
      { ...TOOL_CONTRACTS[0]!, name: TOOL_CONTRACTS[0]!.name },
      { ...badAuthorBase, name: "bad_author", exposeTo: ["bridge"] as const, hermesSurfaceRole: "author" },
    ])

    expect(invalid.success).toBe(false)
    expect(invalid.success ? [] : invalid.errors.map((error) => error.code)).toContain("duplicate-canonical-name")
    expect(invalid.success ? [] : invalid.errors.map((error) => error.code)).toContain("author-surface-requires-mcp-exposure")
  })

  it("fails closed when adapter startup sees invalid contract metadata", () => {
    const { mcpName: _mcpName, ...badAuthorBase } = TOOL_CONTRACTS[0]!

    expect(() => assertValidToolContracts([
      ...TOOL_CONTRACTS,
      { ...badAuthorBase, name: "bad_author", exposeTo: ["bridge"] as const, hermesSurfaceRole: "author" },
    ])).toThrow(/Invalid Open Artisan tool contract registry/)
  })

  it("drives the workflow guard tool allowlist", () => {
    expect([...WORKFLOW_TOOL_NAMES].sort()).toEqual(WORKFLOW_TOOL_CONTRACTS.map((contract) => contract.name).sort())
  })

  it("matches bridge tool.execute handlers", () => {
    expect(Object.keys(TOOL_HANDLERS).sort()).toEqual(BRIDGE_TOOL_CONTRACTS.map((contract) => contract.name).sort())
  })

  it("matches Claude MCP tool definitions", () => {
    expect(MCP_TOOLS.map((tool) => tool.bridgeName).sort()).toEqual(MCP_TOOL_CONTRACTS.map((contract) => contract.name).sort())
    expect(MCP_TOOLS.map((tool) => tool.name).sort()).toEqual(MCP_TOOL_CONTRACTS.map((contract) => contract.mcpName ?? `oa_${contract.name}`).sort())
    for (const contract of MCP_TOOL_CONTRACTS) {
      const tool = MCP_TOOLS.find((candidate) => candidate.bridgeName === contract.name)
      expect(tool?.description).toBe(contract.description)
      expect(tool?.inputSchema).toEqual(toJsonSchema(contract.schema))
    }
  })

  it("keeps request_review file-based and rejects legacy artifact_content", () => {
    const schema = toJsonSchema(RequestReviewToolSchema) as { properties: Record<string, unknown>; required: string[] }
    expect(schema.properties.artifact_content).toBeUndefined()
    expect(schema.properties.artifact_files).toEqual({ type: "array", items: { type: "string" }, minItems: 1 })
    expect(schema.properties.artifact_markdown).toBeUndefined()
    expect(schema.required).toContain("artifact_files")
  })

  it("builds the Hermes tool contract artifact from the author projection", () => {
    const hermesContracts = JSON.parse(buildHermesToolContractsArtifact())
    expect(hermesContracts).toEqual(HERMES_AUTHOR_TOOL_CONTRACTS.map((contract) => ({
      hermes_name: contract.mcpName ?? `oa_${contract.name}`,
      bridge_name: contract.name,
      description: contract.description,
      schema: toJsonSchema(contract.schema),
    })))
    expect(hermesToolContractCount()).toBe(HERMES_AUTHOR_TOOL_CONTRACTS.length)
  })

  it("keeps the generated Hermes tool contract artifact aligned with the author projection", () => {
    const generatedPath = join(process.cwd(), "packages", "adapter-hermes", "hermes_adapter", "tool_contracts.json")
    const generatedContracts = JSON.parse(readFileSync(generatedPath, "utf-8"))

    expect(generatedContracts).toEqual(JSON.parse(buildHermesToolContractsArtifact()))
  })

  it("keeps reviewer and control tools out of the Hermes author projection", () => {
    const hermesBridgeNames = HERMES_AUTHOR_TOOL_CONTRACTS.map((contract) => contract.name).sort()
    expect(hermesBridgeNames).not.toContain("mark_satisfied")
    expect(hermesBridgeNames).not.toContain("submit_task_review")
    expect(hermesBridgeNames).not.toContain("submit_phase_review")
    expect(hermesBridgeNames).not.toContain("submit_auto_approve")
    expect(hermesBridgeNames).not.toContain("submit_task_review_result")
    expect(hermesBridgeNames).not.toContain("submit_phase_review_result")
    expect(hermesBridgeNames).not.toContain("submit_change_proposal_review_result")
    expect(hermesBridgeNames).not.toContain("submit_task_drift_review_result")
    expect(hermesBridgeNames).not.toContain("submit_orchestrator_assess_result")
    expect(hermesBridgeNames).not.toContain("submit_orchestrator_diverge_result")
    expect(hermesBridgeNames).not.toContain("submit_auto_approve_result")
    expect(hermesBridgeNames).not.toContain("submit_rebuttal_review_result")
    expect(hermesBridgeNames).not.toContain("submit_intent_comparison_result")
    expect(hermesBridgeNames).toContain("request_review")
    expect(hermesBridgeNames).toContain("submit_feedback")
  })

  it("projects roadmap tools as author-facing bridge, MCP, OpenCode, and Hermes tools without workflow guarding", () => {
    const roadmapToolNames = [
      "roadmap_read",
      "roadmap_query",
      "roadmap_derive_execution_slice",
      "roadmap_upsert_item",
      "roadmap_update_item_status",
      "roadmap_delete_item",
      "roadmap_upsert_edge",
      "roadmap_delete_edge",
      "roadmap_replace",
      "roadmap_delete",
    ]

    for (const name of roadmapToolNames) {
      const contract = TOOL_CONTRACTS.find((candidate) => candidate.name === name)
      expect(contract).toBeDefined()
      expect(contract?.workflowGuard).toBe(false)
      expect(contract?.hermesSurfaceRole).toBe("author")
      expect(contract?.exposeTo).toEqual(["bridge", "mcp", "opencode"])
      expect(contract?.mcpName).toBe(`oa_${name}`)
    }

    expect(BRIDGE_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual(expect.arrayContaining(roadmapToolNames))
    expect(MCP_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual(expect.arrayContaining(roadmapToolNames))
    expect(OPENCODE_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual(expect.arrayContaining(roadmapToolNames))
    expect(HERMES_AUTHOR_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual(expect.arrayContaining(roadmapToolNames))
  })

  it("models drift backtrack auto-skip policy as explicit operational contract data", () => {
    const policy: DriftBacktrackAutoSkipPolicy = {
      signals: ["artifact-drift", "allowlist-drift", "completed-task-drift", "drift-report", "drift-repair"],
      blockedReason: "blocking drift report requires explicit artifact updates",
    }

    expect(policy.signals).toEqual(["artifact-drift", "allowlist-drift", "completed-task-drift", "drift-report", "drift-repair"])
    expect(policy.blockedReason).toBe("blocking drift report requires explicit artifact updates")
  })

  it("keeps OpenCode-local result capture tools out of bridge dispatch", () => {
    const bridgeNames = BRIDGE_TOOL_CONTRACTS.map((contract) => contract.name)
    expect(bridgeNames).not.toContain("submit_task_review_result")
    expect(bridgeNames).not.toContain("submit_phase_review_result")
    expect(bridgeNames).not.toContain("submit_change_proposal_review_result")
    expect(bridgeNames).not.toContain("submit_task_drift_review_result")
    expect(bridgeNames).not.toContain("submit_orchestrator_assess_result")
    expect(bridgeNames).not.toContain("submit_orchestrator_diverge_result")
    expect(bridgeNames).not.toContain("submit_auto_approve_result")
    expect(bridgeNames).not.toContain("submit_rebuttal_review_result")
    expect(bridgeNames).not.toContain("submit_intent_comparison_result")
    expect(bridgeNames).toContain("submit_task_review")
    expect(bridgeNames).toContain("submit_phase_review")
    expect(bridgeNames).toContain("submit_auto_approve")
  })
})
