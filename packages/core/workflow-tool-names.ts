import { WORKFLOW_TOOL_NAME_LIST } from "./tool-contracts"

/**
 * Names of all custom workflow control tools.
 * The tool guard must never block these regardless of phase — they are the
 * mechanism by which the agent signals state transitions.
 */
export const WORKFLOW_TOOL_NAMES = new Set(WORKFLOW_TOOL_NAME_LIST)
