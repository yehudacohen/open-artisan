/**
 * guard.ts — Bridge tool guard methods.
 *
 * guard.check:  Evaluate whether a specific tool call is allowed for a session.
 * guard.policy: Return the tool policy metadata for a phase/state combination.
 */
import { JSONRPCErrorException } from "json-rpc-2.0"
import { resolve } from "node:path"
import type { MethodHandler } from "../server"
import type { GuardCheckParams, GuardPolicyParams, GuardCheckResult, GuardPolicyResult } from "../protocol"
import { SESSION_NOT_FOUND, INVALID_PARAMS } from "../protocol"
import { extractWriteToolPaths, getPhaseToolPolicy, getTaskWriteFiles } from "../../core/hooks/tool-guard"
import { WORKFLOW_TOOL_NAMES } from "../../core/workflow-tool-names"
import type { Phase, PhaseState, WorkflowMode } from "../../core/workflow-primitives"

export const handleGuardCheck: MethodHandler = async (params, ctx) => {
  const p = params as Partial<GuardCheckParams>
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new JSONRPCErrorException("sessionId is required", INVALID_PARAMS)
  }
  if (!p.toolName || typeof p.toolName !== "string") {
    throw new JSONRPCErrorException("toolName is required", INVALID_PARAMS)
  }

  const { store, sessions } = ctx.engine!
  const toolName = p.toolName.toLowerCase()
  const policyToolName = toolName === "execute_command" || toolName === "shell" || toolName === "run_command"
    ? "bash"
    : toolName

  // Resolve effective state: for child sessions, use parent's state
  // (unless child has its own state — sub-workflow)
  const parentId = sessions.getParent(p.sessionId)
  let state = store.get(p.sessionId)

  if (parentId && !state) {
    // Ephemeral child — block workflow tools, use parent's state for policy
    if (WORKFLOW_TOOL_NAMES.has(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${p.toolName}" cannot be called from a subagent session. Only the parent session can call workflow control tools.`,
        policyVersion: ctx.policyVersion,
      } satisfies GuardCheckResult
    }
    state = store.get(parentId)
    if (!state) {
      throw new JSONRPCErrorException(`Parent session "${parentId}" not found`, SESSION_NOT_FOUND)
    }
  }

  if (!state) {
    throw new JSONRPCErrorException(`Session "${p.sessionId}" not found`, SESSION_NOT_FOUND)
  }

  if (WORKFLOW_TOOL_NAMES.has(toolName)) {
    return {
      allowed: true,
      policyVersion: ctx.policyVersion,
      phase: state.phase,
      phaseState: state.phaseState,
    } satisfies GuardCheckResult
  }

  // Resolve per-task expected files for the current task.
  // Resolve relative paths to absolute using the project directory.
  const rawTaskFiles = state.currentTaskId && state.implDag
    ? getTaskWriteFiles(state.implDag.find((t: { id: string; expectedFiles?: string[]; expectedTests?: string[] }) => t.id === state.currentTaskId))
    : undefined
  const taskExpectedFiles = rawTaskFiles && ctx.projectDir
    ? rawTaskFiles.map((f: string) => f.startsWith("/") ? f : resolve(ctx.projectDir!, f))
    : rawTaskFiles
  const policy = getPhaseToolPolicy(state.phase, state.phaseState, state.mode, state.fileAllowlist, taskExpectedFiles)

  // Check blocked list
  if (policy.blocked.some((blocked) => policyToolName.includes(blocked))) {
    return {
      allowed: false,
      reason: `Tool "${p.toolName}" is blocked in ${state.phase}/${state.phaseState}. ${policy.allowedDescription}`,
      policyVersion: ctx.policyVersion,
    } satisfies GuardCheckResult
  }

  // Check bash command predicate
  if (policy.bashCommandPredicate && policyToolName.includes("bash")) {
    const command = (p.args?.["command"] ?? p.args?.["cmd"] ?? p.args?.["script"] ?? "") as string
    if (command && !policy.bashCommandPredicate(command)) {
      return {
        allowed: false,
        reason: "Bash command blocked in INCREMENTAL mode — file-write operators not allowed.",
        policyVersion: ctx.policyVersion,
      } satisfies GuardCheckResult
    }
  }

  // Check write path predicate
  if (policy.writePathPredicate) {
    const writeTokens = ["write", "edit", "patch", "create", "overwrite"]
    if (writeTokens.some((t) => policyToolName.includes(t))) {
      const filePaths = extractWriteToolPaths(p.args)
      if (filePaths.length === 0) {
        return {
          allowed: false,
          reason: `Tool "${p.toolName}" is write-like but no target path could be extracted in ${state.phase}/${state.phaseState}. ${policy.allowedDescription}`,
          policyVersion: ctx.policyVersion,
        } satisfies GuardCheckResult
      }
      const baseDir = ctx.projectDir ?? process.cwd()
      for (const filePath of filePaths) {
        const checkedPath = filePath.startsWith("/") ? filePath : resolve(baseDir, filePath)
        if (policy.writePathPredicate(checkedPath)) continue
        return {
          allowed: false,
          reason: `Writing to "${filePath}" is blocked in ${state.phase}/${state.phaseState}. ${policy.allowedDescription}`,
          policyVersion: ctx.policyVersion,
        } satisfies GuardCheckResult
      }
    }
  }

  return {
    allowed: true,
    policyVersion: ctx.policyVersion,
    phase: state.phase,
    phaseState: state.phaseState,
  } satisfies GuardCheckResult
}

export const handleGuardPolicy: MethodHandler = async (params, ctx) => {
  const p = params as Partial<GuardPolicyParams>
  if (!p.phase || !p.phaseState) {
    throw new JSONRPCErrorException("phase and phaseState are required", INVALID_PARAMS)
  }

  const policy = getPhaseToolPolicy(
    p.phase as Phase,
    p.phaseState as PhaseState,
    p.mode as WorkflowMode | null,
    p.allowlist ?? [],
    p.taskExpectedFiles,
  )

  return {
    blocked: policy.blocked,
    allowedDescription: policy.allowedDescription,
    hasWritePathPredicate: !!policy.writePathPredicate,
    hasBashCommandPredicate: !!policy.bashCommandPredicate,
    policyVersion: ctx.policyVersion,
  } satisfies GuardPolicyResult
}
