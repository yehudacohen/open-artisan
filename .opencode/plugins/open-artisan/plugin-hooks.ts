import { resolve } from "node:path"

import type { EngineContext } from "#core/engine-context"
import {
  IDLE_COOLDOWN_MS,
  MAX_IDLE_RETRIES,
  MAX_INTENT_BASELINE_CHARS,
  WORKFLOW_TOOL_NAMES,
} from "#core/constants"
import { buildCompactionContext } from "#core/hooks/compaction"
import { buildUserGateHint, processUserMessage } from "#core/hooks/chat-message"
import { handleIdle } from "#core/hooks/idle-handler"
import { buildSubagentContext, buildWorkflowSystemPrompt } from "#core/hooks/system-transform"
import { extractWriteToolPaths, getPhaseToolPolicy, getTaskWriteFiles } from "#core/hooks/tool-guard"
import { detectMode } from "#core/mode-detect"
import { extractAgentName, isArtisanAgent, isWorkflowSessionActive, normalizeAgentName, persistActiveAgent } from "#core/agent-policy"
import type { ModeDetectionResult } from "#core/mode-detection-types"

type SessionEvent = { type: string; properties?: Record<string, unknown> }

interface HookDeps {
  ctx: EngineContext
  projectRoot: string
  passthroughToolNames: Set<string>
  buildModeDetectionNote: (result: ModeDetectionResult) => string
  extractModelConfig: (model: unknown) => { modelID: string; providerID?: string } | null
  logTransition: (
    from: { phase: string; phaseState: string },
    to: { nextPhase: string; nextPhaseState: string } | { phase: string; phaseState: string },
    trigger: string,
    notify?: EngineContext["notify"],
  ) => void
}

function enforceWritePathPredicate(input: {
  tool: string
  phase: string
  phaseState: string
  allowedDescription: string
  args: Record<string, unknown> | undefined
  predicate: (filePath: string) => boolean
}): void {
  const filePaths = extractWriteToolPaths(input.args)
  if (filePaths.length === 0) {
    throw new Error(
      `[Workflow] Tool "${input.tool}" is write-like but no target path could be extracted in ${input.phase}/${input.phaseState}. ` +
      `Use a write/edit tool with an explicit file path. ${input.allowedDescription}`,
    )
  }
  for (const filePath of filePaths) {
    if (!input.predicate(filePath)) {
      throw new Error(
        `[Workflow] Writing to "${filePath}" is blocked in ${input.phase}/${input.phaseState}. ` +
        `${input.allowedDescription}`,
      )
    }
  }
}

function shouldForceWorkflowDormant(text: string): boolean {
  const normalized = text.toLowerCase()
  return [
    "out of artisan mode",
    "out of open artisan mode",
    "disable workflow",
    "disable the workflow",
    "disable open artisan",
    "disable open-artisan",
    "turn off open artisan",
    "turn off open-artisan",
    "turn off openartisan",
    "workflow off",
    "turn off workflow",
    "open artisan off",
    "open-artisan off",
    "openartisan off",
    "don't need openartisan",
    "do not need openartisan",
    "don't need open artisan",
    "do not need open artisan",
    "don't use openartisan",
    "do not use openartisan",
    "don't use open artisan",
    "do not use open artisan",
    "don't use open-artisan",
    "do not use open-artisan",
    "restarted the opencode session",
    "just restarted",
    "restarted",
  ].some((phrase) => normalized.includes(phrase))
}

function explicitlyNamesOpenArtisan(text: string): boolean {
  const normalized = text.toLowerCase()
  return normalized.includes("open artisan") || normalized.includes("open-artisan") || normalized.includes("openartisan")
}

function shouldActivateWorkflow(text: string): boolean {
  const normalized = text.toLowerCase()
  return [
    "use open artisan",
    "use openartisan",
    "use artisan",
    "turn on workflow",
    "enable workflow",
    "enable the workflow",
    "switch to open artisan",
    "switch to artisan",
  ].some((phrase) => normalized.includes(phrase))
}

function isArtisanLockedSession(state: { activeAgent?: string | null }, detectedAgent: string | null): boolean {
  const persistedAgent = normalizeAgentName(state.activeAgent)
  return isArtisanAgent(detectedAgent) || persistedAgent === "artisan" || persistedAgent === "robot-artisan"
}

export function createPluginHooks({
  ctx,
  projectRoot,
  passthroughToolNames,
  buildModeDetectionNote,
  extractModelConfig,
  logTransition,
}: HookDeps) {
  return {
    event: async ({ event }: { event: SessionEvent }) => {
      const { store, log, sessions, lastRepromptTimestamps, notify } = ctx
      try {
        if (event.type === "session.created") {
          const info = event.properties?.["info"] as { id?: string; parentID?: string; [key: string]: unknown } | undefined
          const sessionId = info?.id
          if (!sessionId) return

          if (info?.parentID) {
            sessions.registerChild(sessionId, info.parentID)
            return
          }

          sessions.registerPrimary(sessionId)
          sessions.setActive(sessionId)
          try {
            await store.create(sessionId)
          } catch {
            // already exists
          }

          const detectedAgent = extractAgentName(info)

          try {
            const cwd = (info as any)?.path?.cwd ?? (info as any)?.path ?? process.cwd()
            const detectionResult = await detectMode(typeof cwd === "string" ? cwd : process.cwd())
            await store.update(sessionId, (draft) => {
              if (detectedAgent) {
                draft.activeAgent = detectedAgent
              }
              draft.modeDetectionNote = buildModeDetectionNote(detectionResult)
            })
          } catch {
            // advisory only
          }
          return
        }

        if (event.type === "session.deleted") {
          const info = event.properties?.["info"] as { id?: string } | undefined
          const sessionId = info?.id
          if (!sessionId) return
          sessions.unregister(sessionId)
          try {
            await store.delete(sessionId)
          } catch (e) {
            log.warn("Failed to delete session state", { detail: e instanceof Error ? e.message : String(e), sessionId })
          }
          return
        }

        if (event.type === "session.idle") {
          const sessionId = (
            (event.properties?.["sessionID"] as string | undefined) ??
            (event.properties?.["sessionId"] as string | undefined) ??
            (event.properties?.["session_id"] as string | undefined)
          )
          if (!sessionId) return

          const state = store.get(sessionId)
          if (!state) return
          const activeSessionId = sessions.getActiveId()
          if (activeSessionId && activeSessionId !== sessionId) return
          if (!isWorkflowSessionActive(state)) return

          const now = Date.now()
          const lastReprompt = lastRepromptTimestamps.get(sessionId) ?? 0
          if (now - lastReprompt < IDLE_COOLDOWN_MS) return

          if (state.childWorkflows.length > 0 && state.phase === "IMPLEMENTATION") {
            const { applyDelegationTimeout, findTimedOutChildren } = await import("#core/tools/complete-sub-workflow")
            const timedOut = findTimedOutChildren(state)
            if (timedOut.length > 0) {
              try {
                await store.update(sessionId, (draft) => {
                  for (const to of timedOut) {
                    const aborted = applyDelegationTimeout(draft, to.taskId)
                    log.warn("Idle timeout: sub-workflow timed out", {
                      detail: `task=${to.taskId} feature=${to.featureName} elapsed=${Math.round(to.elapsedMs / 60000)}min aborted=[${aborted.join(",")}]`,
                    })
                  }
                })
                const timeoutMsg = timedOut.map(
                  (to) => `Sub-workflow "${to.featureName}" for task "${to.taskId}" timed out after ${Math.round(to.elapsedMs / 60000)} minutes. The task and its dependents have been aborted.`,
                ).join("\n")
                await ctx.promptExistingSession(sessionId,
                  `**Sub-workflow timeout detected:**\n${timeoutMsg}\n\n` +
                  `Implement the timed-out task(s) directly or spawn a smaller sub-workflow.`,
                )
              } catch (err) {
                log.warn("Failed to handle idle timeout", { detail: err instanceof Error ? err.message : String(err) })
              }
              return
            }
          }

          const decision = handleIdle(state)
          if (decision.action === "ignore") return

          if (decision.action === "escalate") {
            log.warn(`Idle escalation: agent stopped ${state.retryCount} times at ${state.phase}/${state.phaseState}`, { sessionId })
            try {
              notify.toast("Workflow Stalled", decision.message, "warning")
            } catch {
              // ignore
            }
            try {
              await store.update(sessionId, (draft) => { draft.retryCount = MAX_IDLE_RETRIES + 1 })
            } catch (e) {
              log.warn("Failed to reset retryCount on escalation", { detail: e instanceof Error ? e.message : String(e), sessionId })
            }
            try {
              await ctx.promptExistingSession(sessionId,
                `WORKFLOW STALLED: You have stopped ${state.retryCount} times during ${state.phase}/${state.phaseState} ` +
                `without completing the current step. Stop what you are doing and ask the user for guidance. ` +
                `Explain what you were trying to do and where you got stuck.`,
              )
            } catch {
              // ignore
            }
            return
          }

          log.warn(`Idle reprompt ${decision.retryCount}/${MAX_IDLE_RETRIES} at ${state.phase}/${state.phaseState}`, { sessionId })
          try {
            lastRepromptTimestamps.set(sessionId, Date.now())
            await ctx.promptExistingSession(sessionId, decision.message)
            await store.update(sessionId, (draft) => {
              draft.retryCount = decision.retryCount
            })
          } catch {
            // ignore
          }
        }
      } catch (e) {
        log.error("Unhandled error in event hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    },

    "chat.message": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string; messageID?: string; [key: string]: unknown },
      output: { message: { sessionID?: string; sessionId?: string; id?: string }; parts: Array<{ type: string; text?: string; id?: string; sessionID?: string; messageID?: string }> },
    ) => {
      const { store, log, notify, sessions } = ctx
      try {
        const sessionId = (
          (input.sessionID as string | undefined) ??
          (input.sessionId as string | undefined) ??
          (input.session_id as string | undefined) ??
          (output.message?.sessionID as string | undefined) ??
          (output.message?.sessionId as string | undefined)
        )
        if (!sessionId) return
        sessions.setActive(sessionId)

        const detectedAgent = extractAgentName(input) ?? extractAgentName(output.message)
        const state = store.get(sessionId)
        if (!state) return

        const textContent = output.parts
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text!)
          .join(" ")
          .trim()

        if (textContent && shouldActivateWorkflow(textContent) && !isArtisanLockedSession(state, detectedAgent)) {
          await store.update(sessionId, (draft) => {
            draft.activeAgent = "build-artisan"
            draft.retryCount = 0
            draft.userGateMessageReceived = false
          })
        }

        if (detectedAgent) {
          await persistActiveAgent(store, sessionId, detectedAgent)
        }

        const refreshedState = store.get(sessionId)
        if (!refreshedState) return

        if (textContent && refreshedState.retryCount > MAX_IDLE_RETRIES) {
          await store.update(sessionId, (draft) => {
            draft.retryCount = 0
          })
        }

        if (
          textContent &&
          shouldForceWorkflowDormant(textContent) &&
          (!isArtisanLockedSession(refreshedState, detectedAgent) || explicitlyNamesOpenArtisan(textContent))
        ) {
          await store.update(sessionId, (draft) => {
            draft.activeAgent = "build"
            draft.retryCount = 0
            draft.userGateMessageReceived = false
          })
          return
        }
        if (!isWorkflowSessionActive(refreshedState, detectedAgent)) return

        if (refreshedState.phase === "DONE") {
          await store.update(sessionId, (draft) => {
            draft.phase = "MODE_SELECT"
            draft.phaseState = "DRAFT"
            draft.iterationCount = 0
            draft.retryCount = 0
            draft.intentBaseline = textContent ? textContent.slice(0, MAX_INTENT_BASELINE_CHARS) : null
            draft.userGateMessageReceived = false
            draft.currentTaskId = null
            draft.implDag = null
            draft.feedbackHistory = []
            draft.pendingRevisionSteps = null
            draft.escapePending = false
            draft.taskCompletionInProgress = null
            draft.taskReviewCount = 0
            draft.pendingFeedback = null
            draft.revisionBaseline = null
            draft.reviewArtifactFiles = []
            draft.userMessages = textContent ? [textContent] : []
          })
          logTransition(
            { phase: "DONE", phaseState: "DRAFT" },
            { phase: "MODE_SELECT", phaseState: "DRAFT" },
            "new workflow cycle — user sent new work",
            notify,
          )
          return
        }

        const messageId = (input.messageID as string | undefined) ?? (output.message?.id as string | undefined) ?? ""

        if (textContent) {
          await store.update(sessionId, (draft) => {
            draft.userMessages.push(textContent)
            if (!draft.intentBaseline) {
              draft.intentBaseline = textContent.slice(0, MAX_INTENT_BASELINE_CHARS)
            }
          })
        }

        if (refreshedState.phaseState !== "USER_GATE") return

        const result = processUserMessage(refreshedState, output.parts)
        if (result.intercepted) {
          const injectedText = result.parts[0]?.text ?? ""
          if (injectedText) {
            output.parts.splice(0, 0, {
              type: "text",
              text: injectedText,
              id: `prt_oa_routing_${Date.now()}`,
              sessionID: sessionId,
              messageID: messageId,
            })
          }

          await store.update(sessionId, (draft) => {
            draft.userGateMessageReceived = true
          })
        }
      } catch (e) {
        log.error("Unhandled error in chat.message hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string; model?: unknown },
      output: { system: string[] },
    ) => {
      const { store, log, sessions } = ctx
      try {
        const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
        if (!sessionId) return
        sessions.setActive(sessionId)

        const parentSessionId = sessions.getParent(sessionId)
        if (parentSessionId) {
          const childState = store.get(sessionId)
          if (!childState) {
            const parentState = store.get(parentSessionId)
            if (parentState) {
              output.system.push(buildSubagentContext(parentState))
            }
            return
          }
        }

        const state = store.get(sessionId)
        if (!state) return

        const detectedAgent = extractAgentName(input)
        if (detectedAgent) {
          await persistActiveAgent(store, sessionId, detectedAgent)
        }

        const refreshedState = store.get(sessionId)
        if (!refreshedState) return

        const modelConfig = extractModelConfig(input.model)
        if (input.model) {
          log.debug("Session model detected", { detail: `input.model: ${JSON.stringify(input.model)}, extracted: ${JSON.stringify(modelConfig)}` })
        }
        if (modelConfig) {
          const current = refreshedState.sessionModel
          const changed = !current
            || typeof current === "string"
            || current.modelID !== modelConfig.modelID
            || (current.providerID ?? undefined) !== (modelConfig.providerID ?? undefined)
          if (changed) {
            await store.update(sessionId, (draft) => {
              draft.sessionModel = modelConfig
            })
          }
        } else if (input.model) {
          log.warn("Failed to extract model config", { detail: `input.model type: ${typeof input.model}, value: ${JSON.stringify(input.model).slice(0, 200)}` })
        }

        if (!isWorkflowSessionActive(refreshedState, detectedAgent)) return

        output.system.push(buildWorkflowSystemPrompt(refreshedState))
        if (refreshedState.phaseState === "USER_GATE") {
          output.system.push(buildUserGateHint(refreshedState.phase, refreshedState.phaseState))
        }
      } catch (e) {
        log.error("Unhandled error in system.transform hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    },

    "tool.execute.before": async (input: { sessionID?: string; sessionId?: string; session_id?: string; tool: string; args?: Record<string, unknown> }) => {
      const { store, log, sessions } = ctx
      try {
        const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
        if (!sessionId) return

        const parentId = sessions.getParent(sessionId)
        if (parentId) {
          const childState = store.get(sessionId)
          if (!childState) {
            if (passthroughToolNames.has(input.tool.toLowerCase())) return

            if (WORKFLOW_TOOL_NAMES.has(input.tool)) {
              throw new Error(
                `[Workflow] Tool "${input.tool}" cannot be called from a subagent session. ` +
                `Only the parent session can call workflow control tools (mark_task_complete, request_review, etc.). ` +
                `Complete your implementation work and report results back to the parent session.`,
              )
            }
            const parentState = store.get(parentId)
            if (!parentState) return
            const rawParentTaskFiles = parentState.currentTaskId && parentState.implDag
              ? getTaskWriteFiles(parentState.implDag.find((task) => task.id === parentState.currentTaskId))
              : undefined
            const parentTaskFiles = rawParentTaskFiles?.map((file) => file.startsWith("/") ? file : resolve(projectRoot, file))
            const policy = getPhaseToolPolicy(
              parentState.phase,
              parentState.phaseState,
              parentState.mode,
              parentState.fileAllowlist,
              parentTaskFiles,
            )
            const toolName = input.tool.toLowerCase()
            if (policy.blocked.some((blocked) => toolName.includes(blocked))) {
              throw new Error(
                `[Workflow] Tool "${input.tool}" is blocked in ${parentState.phase}/${parentState.phaseState}. ` +
                `Allowed: ${policy.allowedDescription}`,
              )
            }
            if (policy.bashCommandPredicate && toolName.includes("bash")) {
              const command = (input.args?.["command"] ?? input.args?.["cmd"] ?? input.args?.["script"] ?? "") as string
              if (command && !policy.bashCommandPredicate(command)) {
                throw new Error(
                  `[Workflow] Bash command blocked in INCREMENTAL mode — file-write operators (>, >>, tee, sed -i) are not allowed.`,
                )
              }
            }
            const writeTokens = ["write", "edit", "patch", "create", "overwrite"]
            if (policy.writePathPredicate && writeTokens.some((token) => toolName.includes(token))) {
              enforceWritePathPredicate({
                tool: input.tool,
                phase: parentState.phase,
                phaseState: parentState.phaseState,
                allowedDescription: policy.allowedDescription,
                args: input.args,
                predicate: policy.writePathPredicate,
              })
            }
            return
          }
        }

        const state = store.get(sessionId)
        if (!state) return

        const detectedAgent = extractAgentName(input)
        if (detectedAgent) {
          await persistActiveAgent(store, sessionId, detectedAgent)
        }

        const refreshedState = store.get(sessionId)
        if (!refreshedState) return

        sessions.setActive(sessionId)
        if (!isWorkflowSessionActive(refreshedState, detectedAgent)) return
        if (WORKFLOW_TOOL_NAMES.has(input.tool)) return
        if (passthroughToolNames.has(input.tool.toLowerCase())) return

        const rawTaskFiles = refreshedState.currentTaskId && refreshedState.implDag
          ? getTaskWriteFiles(refreshedState.implDag.find((task) => task.id === refreshedState.currentTaskId))
          : undefined
        const currentTaskFiles = rawTaskFiles?.map((file) => file.startsWith("/") ? file : resolve(projectRoot, file))
        const policy = getPhaseToolPolicy(
          refreshedState.phase,
          refreshedState.phaseState,
          refreshedState.mode,
          refreshedState.fileAllowlist,
          currentTaskFiles,
        )

        const toolName = input.tool.toLowerCase()
        if (policy.blocked.some((blocked) => toolName.includes(blocked))) {
          throw new Error(
            `[Workflow] Tool "${input.tool}" is blocked in ${refreshedState.phase}/${refreshedState.phaseState}. ` +
            `Allowed: ${policy.allowedDescription}`,
          )
        }
        if (policy.bashCommandPredicate && toolName.includes("bash")) {
          const command = (input.args?.["command"] ?? input.args?.["cmd"] ?? input.args?.["script"] ?? "") as string
          if (command && !policy.bashCommandPredicate(command)) {
            throw new Error(
              `[Workflow] Bash command blocked in INCREMENTAL mode — file-write operators (>, >>, tee, sed -i) are not allowed. ` +
              `Use write/edit tools instead so the file allowlist can be enforced.`,
            )
          }
        }
        const writeTokens = ["write", "edit", "patch", "create", "overwrite"]
        if (policy.writePathPredicate && writeTokens.some((token) => toolName.includes(token))) {
          enforceWritePathPredicate({
            tool: input.tool,
            phase: refreshedState.phase,
            phaseState: refreshedState.phaseState,
            allowedDescription: policy.allowedDescription,
            args: input.args,
            predicate: policy.writePathPredicate,
          })
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("[Workflow]")) throw e
        log.error("Unhandled error in tool.execute.before hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    },

    "experimental.session.compacting": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string },
      output: { context?: string[] },
    ) => {
      const { store, log } = ctx
      try {
        const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
        if (!sessionId) return
        const state = store.get(sessionId)
        if (!state) return
        if (!isWorkflowSessionActive(state)) return

        output.context ??= []
        output.context.push(buildCompactionContext(state))
      } catch (e) {
        log.error("Unhandled error in compacting hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    },
  }
}
