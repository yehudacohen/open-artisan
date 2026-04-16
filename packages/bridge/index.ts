/**
 * packages/bridge/index.ts — Public API re-exports for the bridge server.
 */
export { createBridgeEngine, createBridgeServer, type BridgeEngine, type MethodHandler, type BridgeContext } from "./server"
export * from "./protocol"
export * from "./shared-bridge-types"
export * from "./bridge-meta"
export * from "./bridge-discovery"
export * from "./bridge-leases"
export * from "./bridge-clients"
export {
  handleInit,
  handlePing,
  handleShutdown,
  handleSessionCreated,
  handleSessionDeleted,
} from "./methods/lifecycle"
export { handleStateGet, handleStateHealth, resolveRuntimeHealth } from "./methods/state"
export { handleGuardCheck, handleGuardPolicy } from "./methods/guard"
export { handlePromptBuild, handlePromptCompaction } from "./methods/prompt"
export { handleMessageProcess } from "./methods/message"
export { handleIdleCheck } from "./methods/idle"
export { handleToolExecute } from "./methods/tool-execute"
export { checkPidFile, writePidFile, removePidFile, PID_FILENAME } from "./pid-file"
export { createBridgeLogger, adaptPinoToLogger } from "./structured-log"
