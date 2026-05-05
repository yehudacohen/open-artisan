import { describe, expect, it } from "bun:test"

import { TOOL_HANDLERS } from "#bridge/methods/tool-execute"
import { TOOLS as MCP_TOOLS } from "#claude-code/bin/artisan-mcp-tools"
import { WORKFLOW_TOOL_NAMES } from "#core/constants"
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
  })
})
