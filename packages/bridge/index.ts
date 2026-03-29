/**
 * packages/bridge/index.ts — Public API re-exports for the bridge server.
 */
export { createBridgeEngine, createBridgeServer, type BridgeEngine, type MethodHandler, type BridgeContext } from "./server"
export * from "./protocol"
export {
  handleInit,
  handlePing,
  handleShutdown,
  handleSessionCreated,
  handleSessionDeleted,
} from "./methods/lifecycle"
export { handleStateGet } from "./methods/state"
export { handleGuardCheck, handleGuardPolicy } from "./methods/guard"
export { handlePromptBuild, handlePromptCompaction } from "./methods/prompt"
export { handleMessageProcess } from "./methods/message"
export { handleIdleCheck } from "./methods/idle"
export { handleToolExecute } from "./methods/tool-execute"
export { checkPidFile, writePidFile, removePidFile, PID_FILENAME } from "./pid-file"
export { createBridgeLogger, adaptPinoToLogger } from "./structured-log"
