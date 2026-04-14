/**
 * claude-code-shared-bridge.test.ts — Interface-first tests for Claude Code's
 * shared-bridge usage contract.
 *
 * These tests depend only on approved shared-bridge interfaces and should fail
 * until the adapter wiring exists.
 */
import { beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"

import type {
  BridgeAttachParams,
  BridgeAttachRpcResult,
  BridgeDetachParams,
  BridgeDetachResult,
  BridgeDiscoverParams,
  BridgeDiscoverResult,
  BridgeShutdownEligibilityParams,
  BridgeShutdownEligibilityResult,
} from "#bridge/protocol"

interface ClaudeSharedBridgeContract {
  discover(params: BridgeDiscoverParams): Promise<BridgeDiscoverResult>
  attach(params: BridgeAttachParams): Promise<BridgeAttachRpcResult>
  detach(params: BridgeDetachParams): Promise<BridgeDetachResult>
  shutdownEligibility(
    params: BridgeShutdownEligibilityParams,
  ): Promise<BridgeShutdownEligibilityResult>
}

function makeClaudeSharedBridge(): ClaudeSharedBridgeContract {
  throw new Error("Claude shared-bridge contract not implemented")
}

let projectDir: string
let stateDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "claude-shared-contract-"))
  stateDir = join(projectDir, ".openartisan")
})

describe("Claude Code shared bridge contract", () => {
  it.todo("discovers and reuses a compatible local bridge instead of starting a second one", () => {})
  it.todo("starts and attaches when the socket bridge is unavailable", () => {})
  it.todo("treats stale socket state as recoverable instead of live ownership", () => {})
  it.todo("fails cleanly when attach experiences transport timeout", () => {})
  it.todo("does not let one Claude client shutdown a bridge still used by another client", () => {})
  it.todo("reports shutdown eligibility when the last Claude client exits", () => {})
})
