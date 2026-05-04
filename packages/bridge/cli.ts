#!/usr/bin/env bun
/**
 * cli.ts — Bridge server entry point.
 *
 * Usage: bun run packages/bridge/cli.ts
 *
 * Reads JSON-RPC 2.0 requests from stdin, writes responses to stdout.
 * The adapter spawns this as a child process.
 */
import { createBridgeServer } from "./server"
import {
  handleInit,
  handlePing,
  handleShutdown,
  handleSessionCreated,
  handleSessionDeleted,
} from "./methods/lifecycle"
import { handleStateGet, handleStateHealth } from "./methods/state"
import { handleGuardCheck, handleGuardPolicy } from "./methods/guard"
import { handlePromptBuild, handlePromptCompaction } from "./methods/prompt"
import { handleMessageProcess } from "./methods/message"
import { handleIdleCheck } from "./methods/idle"
import { handleToolExecute, handleTaskGetReviewContext, handlePhaseGetReviewContext, handleAutoApproveContext } from "./methods/tool-execute"
import { recoverStaleBridgeRuntime } from "./recovery"

if (process.argv[2] === "recover") {
  const projectDir = process.argv[3] || process.cwd()
  process.stdout.write(`${JSON.stringify(recoverStaleBridgeRuntime(projectDir), null, 2)}\n`)
  process.exit(0)
}

const server = createBridgeServer({
  "lifecycle.init": handleInit,
  "lifecycle.ping": handlePing,
  "lifecycle.shutdown": handleShutdown,
  "lifecycle.sessionCreated": handleSessionCreated,
  "lifecycle.sessionDeleted": handleSessionDeleted,
  "state.get": handleStateGet,
  "state.health": handleStateHealth,
  "guard.check": handleGuardCheck,
  "guard.policy": handleGuardPolicy,
  "prompt.build": handlePromptBuild,
  "prompt.compaction": handlePromptCompaction,
  "message.process": handleMessageProcess,
  "idle.check": handleIdleCheck,
  "tool.execute": handleToolExecute,
  "task.getReviewContext": handleTaskGetReviewContext,
  "task.getPhaseReviewContext": handlePhaseGetReviewContext,
  "task.getAutoApproveContext": handleAutoApproveContext,
})

server.start()
