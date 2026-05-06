import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { TOOL_HANDLERS } from "#bridge/methods/tool-execute"
import { TOOLS as MCP_TOOLS } from "#claude-code/bin/artisan-mcp-tools"
import { RequestReviewToolSchema, toJsonSchema } from "#core/schemas"
import { WORKFLOW_TOOL_NAMES } from "#core/workflow-tool-names"
import {
  BRIDGE_TOOL_CONTRACTS,
  MCP_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
  WORKFLOW_TOOL_CONTRACTS,
} from "#core/tool-contracts"

describe("tool contract registry", () => {
  it("has unique canonical and MCP names", () => {
    const names = TOOL_CONTRACTS.map((contract) => contract.name)
    expect(new Set(names).size).toBe(names.length)

    const mcpNames = MCP_TOOL_CONTRACTS.map((contract) => contract.mcpName)
    expect(mcpNames.every((name): name is string => typeof name === "string" && name.length > 0)).toBe(true)
    expect(new Set(mcpNames).size).toBe(mcpNames.length)
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
    expect(schema.properties.artifact_files).toEqual({ type: "array", items: { type: "string" } })
    expect(schema.properties.artifact_markdown).toEqual({ type: "string" })
    expect(schema.required).toContain("artifact_files")
  })

  it("matches generated Hermes tool contract artifact", () => {
    const artifactPath = join(process.cwd(), "packages/adapter-hermes/hermes_adapter/tool_contracts.json")
    const hermesContracts = JSON.parse(readFileSync(artifactPath, "utf-8"))
    expect(hermesContracts).toEqual(MCP_TOOL_CONTRACTS.map((contract) => ({
      hermes_name: contract.mcpName ?? `oa_${contract.name}`,
      bridge_name: contract.name,
      description: contract.description,
      schema: toJsonSchema(contract.schema),
    })))
  })
})
