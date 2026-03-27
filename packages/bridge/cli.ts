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
import { handleStateGet } from "./methods/state"
import { handleGuardCheck, handleGuardPolicy } from "./methods/guard"
import { handlePromptBuild, handlePromptCompaction } from "./methods/prompt"
import { handleMessageProcess } from "./methods/message"
import { handleIdleCheck } from "./methods/idle"
import { handleToolExecute } from "./methods/tool-execute"

const server = createBridgeServer({
  "lifecycle.init": handleInit,
  "lifecycle.ping": handlePing,
  "lifecycle.shutdown": handleShutdown,
  "lifecycle.sessionCreated": handleSessionCreated,
  "lifecycle.sessionDeleted": handleSessionDeleted,
  "state.get": handleStateGet,
  "guard.check": handleGuardCheck,
  "guard.policy": handleGuardPolicy,
  "prompt.build": handlePromptBuild,
  "prompt.compaction": handlePromptCompaction,
  "message.process": handleMessageProcess,
  "idle.check": handleIdleCheck,
  "tool.execute": handleToolExecute,
})

server.start()
