/**
 * guarded-file-tools.ts - OpenCode guarded file-edit tool definitions.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  applyParsedGuardedPatch,
  buildGuardedChangeSummary,
  buildUnifiedDiff,
  parseGuardedPatch,
  type UnifiedDiffSummary,
} from "../../../packages/core/guarded-patch"
import { getPhaseToolPolicy, getTaskWriteFiles } from "../../../packages/core/hooks/tool-guard"
import { resolveSessionId } from "../../../packages/core/utils"
import type { SessionStateStore, WorkflowState } from "../../../packages/core/workflow-state-types"

type ToolExecuteContext = ToolContext & { sessionId?: string; session_id?: string; session?: { id: string }; [key: string]: unknown }

function resolveGuardedTarget(filePath: string, cwd: string): { success: true; targetPath: string; displayPath: string } | { success: false; error: string } {
  const targetPath = filePath.startsWith("/") ? filePath : resolve(cwd, filePath)
  const rel = relative(cwd, targetPath)
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    return { success: false, error: `Writing to "${filePath}" is blocked because it is outside the project root "${cwd}".` }
  }
  return { success: true, targetPath, displayPath: rel || filePath }
}

function buildGuardedPolicy(state: WorkflowState, cwd: string) {
  const rawTaskFiles = state.currentTaskId && state.implDag
    ? getTaskWriteFiles(state.implDag.find((task) => task.id === state.currentTaskId))
    : undefined
  const taskFiles = rawTaskFiles?.map((file) => file.startsWith("/") ? file : resolve(cwd, file))
  return getPhaseToolPolicy(state.phase, state.phaseState, state.mode, state.fileAllowlist, taskFiles, cwd, state.approvedCleanupFiles)
}

function validateGuardedTarget(toolName: string, state: WorkflowState, cwd: string, filePath: string, options: { cleanupDelete?: boolean } = {}) {
  const resolved = resolveGuardedTarget(filePath, cwd)
  if (!resolved.success) return resolved
  const policy = buildGuardedPolicy(state, cwd)
  if (options.cleanupDelete && policy.cleanupPathPredicate?.(resolved.targetPath)) {
    return { success: true as const, targetPath: resolved.targetPath, displayPath: resolved.displayPath }
  }
  if (!policy.writePathPredicate) {
    return { success: false as const, error: `${toolName} is blocked in ${state.phase}/${state.phaseState}. ${policy.allowedDescription}` }
  }
  if (!policy.writePathPredicate(resolved.targetPath)) {
    return { success: false as const, error: `Writing to "${filePath}" is blocked in ${state.phase}/${state.phaseState}. ${policy.allowedDescription}` }
  }
  return { success: true as const, targetPath: resolved.targetPath, displayPath: resolved.displayPath }
}

export function createGuardedFileTools(tool: any, ctx: { store: SessionStateStore; projectRoot: string }) {
  return {
    guarded_edit: tool({
      description: "Safely edit one file using exact old/new text after Open Artisan validates the target path against the active phase policy. Use this instead of native apply_patch in guarded phases.",
      args: {
        file_path: tool.schema.string().describe("Project-relative or absolute file path to edit."),
        old_text: tool.schema.string().describe("Exact existing text to replace. Must occur exactly once."),
        new_text: tool.schema.string().describe("Replacement text."),
      },
      async execute(args: { file_path: string; old_text: string; new_text: string }, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        const state = ctx.store.get(sessionId)
        if (!state) return "Error: No workflow state for this session."
        const cwd = context.directory || ctx.projectRoot
        const target = validateGuardedTarget("guarded_edit", state, cwd, args.file_path)
        if (!target.success) return `Error: ${target.error}`
        if (args.old_text.length === 0) return "Error: old_text must not be empty."
        const current = existsSync(target.targetPath) ? await readFile(target.targetPath, "utf-8") : ""
        const first = current.indexOf(args.old_text)
        if (first === -1) return `Error: old_text was not found in ${args.file_path}.`
        if (current.indexOf(args.old_text, first + args.old_text.length) !== -1) return `Error: old_text occurs more than once in ${args.file_path}. Provide a larger unique span.`
        const next = `${current.slice(0, first)}${args.new_text}${current.slice(first + args.old_text.length)}`
        const diff = buildUnifiedDiff(current, next, target.displayPath)
        await mkdir(dirname(target.targetPath), { recursive: true })
        await writeFile(target.targetPath, next)
        return buildGuardedChangeSummary("Edited", target.displayPath, [diff])
      },
    }),

    guarded_write: tool({
      description: "Safely create one file after Open Artisan validates the target path against the active phase policy. Use this instead of native apply_patch when creating files in guarded phases.",
      args: {
        file_path: tool.schema.string().describe("Project-relative or absolute file path to create."),
        content: tool.schema.string().describe("Complete file content to write."),
        overwrite: tool.schema.boolean().optional().describe("Set true to replace an existing file. Defaults to false."),
      },
      async execute(args: { file_path: string; content: string; overwrite?: boolean }, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        const state = ctx.store.get(sessionId)
        if (!state) return "Error: No workflow state for this session."
        const cwd = context.directory || ctx.projectRoot
        const target = validateGuardedTarget("guarded_write", state, cwd, args.file_path)
        if (!target.success) return `Error: ${target.error}`
        const existed = existsSync(target.targetPath)
        if (existed && !args.overwrite) return `Error: ${args.file_path} already exists. Set overwrite=true to replace it.`
        const current = existed ? await readFile(target.targetPath, "utf-8") : null
        const diff = buildUnifiedDiff(current, args.content, target.displayPath)
        await mkdir(dirname(target.targetPath), { recursive: true })
        await writeFile(target.targetPath, args.content)
        return buildGuardedChangeSummary(existed ? "Wrote" : "Created", target.displayPath, [diff])
      },
    }),

    guarded_patch: tool({
      description: "Safely apply an OpenCode-style patch after Open Artisan validates every target path against the active phase policy. Use this instead of native apply_patch in guarded phases when OpenCode omits patch payloads from hooks.",
      args: {
        patch_text: tool.schema.string().describe("OpenCode-style patch text beginning with *** Begin Patch and ending with *** End Patch."),
      },
      async execute(args: { patch_text: string }, context: ToolExecuteContext) {
        const sessionId = resolveSessionId(context)
        if (!sessionId) return "Error: Could not determine session ID from tool context."
        const state = ctx.store.get(sessionId)
        if (!state) return "Error: No workflow state for this session."
        const parsed = parseGuardedPatch(args.patch_text)
        if (!parsed.success) return `Error: ${parsed.error}`
        const cwd = context.directory || ctx.projectRoot
        const resolvedTargets = new Map<string, { targetPath: string; displayPath: string }>()
        for (const operation of parsed.data.operations) {
          const target = validateGuardedTarget("guarded_patch", state, cwd, operation.path, { cleanupDelete: operation.type === "delete" })
          if (!target.success) return `Error: ${target.error}`
          resolvedTargets.set(operation.path, { targetPath: target.targetPath, displayPath: target.displayPath })
          if (operation.type === "update" && operation.moveTo) {
            const moveTarget = validateGuardedTarget("guarded_patch", state, cwd, operation.moveTo)
            if (!moveTarget.success) return `Error: ${moveTarget.error}`
            resolvedTargets.set(operation.moveTo, { targetPath: moveTarget.targetPath, displayPath: moveTarget.displayPath })
          }
        }
        const initialContents = new Map<string, string | null>()
        for (const [filePath, target] of resolvedTargets) {
          initialContents.set(filePath, existsSync(target.targetPath) ? await readFile(target.targetPath, "utf-8") : null)
        }
        const applied = applyParsedGuardedPatch(parsed.data, initialContents)
        if (!applied.success) return `Error: ${applied.error}`
        const diffs: UnifiedDiffSummary[] = []
        for (const change of applied.data) {
          const target = resolvedTargets.get(change.path)
          if (!target) return `Error: Patch produced an untracked change for ${change.path}.`
          diffs.push(buildUnifiedDiff(change.oldContent, change.newContent, target.displayPath))
        }
        for (const change of applied.data) {
          const target = resolvedTargets.get(change.path)
          if (!target) return `Error: Patch produced an untracked change for ${change.path}.`
          if (change.newContent === null) {
            if (existsSync(target.targetPath)) await unlink(target.targetPath)
          } else {
            await mkdir(dirname(target.targetPath), { recursive: true })
            await writeFile(target.targetPath, change.newContent)
          }
        }
        return buildGuardedChangeSummary("Applied patch to", `${applied.data.length} file(s)`, diffs)
      },
    }),
  }
}
