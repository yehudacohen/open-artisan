import { resolve } from "node:path"

import type { EngineContext } from "#core/engine-context"
import type { WorkflowState } from "#core/workflow-state-types"
import {
  IDLE_COOLDOWN_MS,
  MAX_IDLE_RETRIES,
  MAX_INTENT_BASELINE_CHARS,
} from "#core/constants"
import { WORKFLOW_TOOL_NAMES } from "#core/workflow-tool-names"
import { buildCompactionContext } from "#core/hooks/compaction"
import { buildUserGateHint, processUserMessage, stripInjectedWorkflowGateText } from "#core/hooks/chat-message"
import { handleIdle } from "#core/hooks/idle-handler"
import { buildSubagentContext, buildWorkflowSystemPrompt } from "#core/hooks/system-transform"
import { extractWriteToolPaths, getPhaseToolPolicy, getTaskWriteFiles } from "#core/hooks/tool-guard"
import { detectMode } from "#core/mode-detect"
import { extractAgentName, isArtisanAgent, isWorkflowSessionActive, normalizeAgentName } from "#core/agent-policy"
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
  projectRoot: string
  args: unknown
  predicate: (filePath: string) => boolean
  onMissingTarget?: () => void
}): void {
  const filePaths = extractWriteToolPaths(input.args)
  if (filePaths.length === 0) {
    input.onMissingTarget?.()
    throw new Error(
      `[Workflow] Tool "${input.tool}" is write-like but no target path could be extracted in ${input.phase}/${input.phaseState}. ` +
      `${input.tool === "apply_patch" ? "Native apply_patch payloads do not expose patch text to Open Artisan's guard in OpenCode; use guarded_patch for OpenCode-style diffs, guarded_edit for exact-span edits, or guarded_write for whole-file writes. " : "Use a write/edit tool with an explicit file path. "}${input.allowedDescription}`,
    )
  }
  for (const filePath of filePaths) {
    const checkedPath = filePath.startsWith("/") ? filePath : resolve(input.projectRoot, filePath)
    if (!input.predicate(checkedPath)) {
      throw new Error(
        `[Workflow] Writing to "${filePath}" is blocked in ${input.phase}/${input.phaseState}. ` +
        `${input.allowedDescription}`,
      )
    }
  }
}

function summarizeToolPayload(value: unknown): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "function") return `[Function ${nested.name || "anonymous"}]`
    if (nested && typeof nested === "object") {
      if (seen.has(nested)) return "[Circular]"
      seen.add(nested)
    }
    if (typeof nested === "string" && nested.length > 1200) return `${nested.slice(0, 1200)}...[truncated ${nested.length}]`
    return nested
  })
  return (json ?? String(value)).slice(0, 5000)
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
    "fix open artisan itself",
    "fix open-artisan itself",
    "repair open artisan",
    "repair open-artisan",
    "work on open artisan itself",
    "work on open-artisan itself",
    "open artisan maintenance",
    "open-artisan maintenance",
    "restarted the opencode session",
    "just restarted",
    "restarted",
  ].some((phrase) => normalized.includes(phrase))
}

function shouldActivateWorkflow(text: string): boolean {
  const normalized = text.toLowerCase()
  return [
    "use open artisan",
    "use openartisan",
    "use artisan",
    "turn on open artisan",
    "turn on open-artisan",
    "turn on openartisan",
    "open artisan on",
    "open-artisan on",
    "openartisan on",
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

function shouldInjectIdlePrompts(): boolean {
  const value = process.env["OPENARTISAN_IDLE_PROMPTS"]?.toLowerCase()
  return !["0", "false", "off"].includes(value ?? "")
}

function isUserEscapeIdleEvent(event: SessionEvent): boolean {
  const properties = event.properties ?? {}
  const escapeSignals = new Set(["escaped", "escape", "aborted", "abort", "cancelled", "canceled", "interrupted", "interrupt", "stopped", "stop"])
  for (const [key, value] of Object.entries(properties)) {
    const normalizedKey = key.toLowerCase()
    if (typeof value === "boolean" && value && escapeSignals.has(normalizedKey)) return true
    if (typeof value !== "string") continue
    const normalizedValue = value.toLowerCase()
    const keyCanCarryStopReason = /esc|escape|abort|cancel|interrupt/.test(normalizedKey) ||
      ["reason", "cause", "status", "state", "action", "source"].includes(normalizedKey)
    if (keyCanCarryStopReason && /\b(user[-_ ]?)?(esc|escape|abort|cancel|cancelled|canceled|interrupt|interrupted|stop|stopped)\b/.test(normalizedValue)) {
      return true
    }
  }
  return false
}

export function createPluginHooks({
  ctx,
  projectRoot,
  passthroughToolNames,
  buildModeDetectionNote,
  extractModelConfig,
  logTransition,
}: HookDeps) {
  const nonrecoverableGuardBlocks = new Map<string, string>()
  const dormantSessions = new Set<string>()

  function stateTraceFields(sessionId: string | undefined): Record<string, unknown> {
    if (!sessionId) return {}
    const state = ctx.store.get(sessionId)
    return {
      sessionId,
      activeSessionId: ctx.sessions.getActiveId(),
      phase: state?.phase,
      phaseState: state?.phaseState,
      activeAgent: state?.activeAgent,
      retryCount: state?.retryCount,
      isWorkflowActive: state ? isWorkflowSessionActive(state) : false,
    }
  }

  function traceHookStart(hook: string, fields: Record<string, unknown> = {}): number {
    ctx.trace.record("hook.start", { hook, ...fields })
    return Date.now()
  }

  function traceHookEnd(hook: string, started: number, sessionId?: string, fields: Record<string, unknown> = {}): void {
    ctx.trace.record("hook.end", {
      hook,
      durationMs: Date.now() - started,
      ...stateTraceFields(sessionId),
      ...fields,
    })
  }

  function markNonrecoverableGuardBlock(sessionId: string, message: string): void {
    nonrecoverableGuardBlocks.set(sessionId, message)
  }

  function clearNonrecoverableGuardBlock(sessionId: string): void {
    nonrecoverableGuardBlocks.delete(sessionId)
  }

  function isDormantSession(sessionId: string): boolean {
    return dormantSessions.has(sessionId)
  }

  function markDormantSession(sessionId: string): void {
    dormantSessions.add(sessionId)
    ctx.trace.record("session.dormant", { sessionId, dormant: true })
  }

  function clearDormantSession(sessionId: string): void {
    if (!dormantSessions.delete(sessionId)) return
    ctx.trace.record("session.dormant", { sessionId, dormant: false })
  }

  function stripStaleWorkflowGateNotes(parts: Array<{ type: string; text?: string }>): boolean {
    let changed = false
    for (const part of parts) {
      if (part.type !== "text" || typeof part.text !== "string") continue
      const stripped = stripInjectedWorkflowGateText(part.text)
      if (stripped !== part.text) {
        part.text = stripped
        changed = true
      }
    }
    return changed
  }

  function mutateHookMemory(hook: string, sessionId: string, label: string, mutator: (draft: WorkflowState) => void): boolean {
    const state = ctx.store.get(sessionId)
    if (!state) return false
    mutator(state)
    ctx.trace.record("hook.memoryMutation", {
      hook,
      sessionId,
      label,
      ...stateTraceFields(sessionId),
    })
    return true
  }

  function applyActiveAgentInMemory(hook: string, sessionId: string, agentName: string): string {
    const normalized = normalizeAgentName(agentName)
    if (!normalized) return agentName
    const state = ctx.store.get(sessionId)
    if (!state) return normalized
    const persistedAgent = normalizeAgentName(state.activeAgent)
    if (persistedAgent && !isArtisanAgent(persistedAgent)) return persistedAgent
    if (isArtisanAgent(state.activeAgent) && !isArtisanAgent(normalized)) return persistedAgent ?? normalized
    if (state.activeAgent === normalized) return normalized
    mutateHookMemory(hook, sessionId, "activeAgent", (draft) => {
      draft.activeAgent = normalized
    })
    return normalized
  }

  return {
    event: async ({ event }: { event: SessionEvent }) => {
      const hook = "event"
      const started = traceHookStart(hook, { eventType: event.type })
      let hookSessionId: string | undefined
      let hookError: string | undefined
      const { store, log, sessions, lastRepromptTimestamps, notify } = ctx
      try {
        if (event.type === "session.created") {
          const info = event.properties?.["info"] as { id?: string; parentID?: string; [key: string]: unknown } | undefined
          const sessionId = info?.id
          hookSessionId = sessionId
          if (!sessionId) return

          if (info?.parentID) {
            sessions.registerChild(sessionId, info.parentID)
            return
          }

          clearNonrecoverableGuardBlock(sessionId)
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
            mutateHookMemory(hook, sessionId, "session.created.modeDetection", (draft) => {
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
          hookSessionId = sessionId
          if (!sessionId) return
          clearNonrecoverableGuardBlock(sessionId)
          dormantSessions.delete(sessionId)
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
          hookSessionId = sessionId
          if (!sessionId) return

          if (isUserEscapeIdleEvent(event)) {
            ctx.trace.record("idle.prompt.skipped", { sessionId, reason: "user-escape" })
            return
          }

          const state = store.get(sessionId)
          if (!state) return
          if (isDormantSession(sessionId)) return
          const activeSessionId = sessions.getActiveId()
          if (!isWorkflowSessionActive(state)) return

          if (activeSessionId && activeSessionId !== sessionId) {
            const activeState = store.get(activeSessionId)
            const activeSessionOwnsWorkflow =
              activeState !== null &&
              activeState !== undefined &&
              !sessions.isChild(activeSessionId) &&
              isWorkflowSessionActive(activeState)

            if (activeSessionOwnsWorkflow) {
              log.debug("Idle ignored for non-active workflow session", {
                detail: `sessionId=${sessionId} activeSessionId=${activeSessionId}`,
              })
              return
            }

            sessions.setActive(sessionId)
          }

          const guardBlock = nonrecoverableGuardBlocks.get(sessionId)
          if (guardBlock) {
            log.warn("Idle ignored after nonrecoverable workflow guard blocker", { sessionId, detail: guardBlock })
            return
          }

          const now = Date.now()
          const lastReprompt = lastRepromptTimestamps.get(sessionId) ?? 0
          if (now - lastReprompt < IDLE_COOLDOWN_MS) return

          if (state.childWorkflows.length > 0 && state.phase === "IMPLEMENTATION") {
            const { applyDelegationTimeout, findTimedOutChildren } = await import("#core/tools/complete-sub-workflow")
            const timedOut = findTimedOutChildren(state)
            if (timedOut.length > 0) {
              try {
                mutateHookMemory(hook, sessionId, "idle.subWorkflowTimeout", (draft) => {
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
                if (shouldInjectIdlePrompts()) {
                  await ctx.promptExistingSession(sessionId,
                    `**Sub-workflow timeout detected:**\n${timeoutMsg}\n\n` +
                    `Implement the timed-out task(s) directly or spawn a smaller sub-workflow.`,
                    { reason: "sub-workflow-timeout", caller: "event.session.idle" },
                  )
                } else {
                  ctx.trace.record("idle.prompt.skipped", { sessionId, reason: "sub-workflow-timeout" })
                }
              } catch (err) {
                const detail = err instanceof Error ? err.message : String(err)
                ctx.trace.record("idle.subWorkflowTimeout.failed", { sessionId, error: detail })
                log.warn("Failed to handle idle timeout", { detail })
              }
              return
            }
          }

          const decision = handleIdle(state)
          ctx.trace.record("idle.decision", {
            sessionId,
            action: decision.action,
            phase: state.phase,
            phaseState: state.phaseState,
            activeAgent: state.activeAgent,
            retryCount: state.retryCount,
            nextRetryCount: decision.action === "reprompt" ? decision.retryCount : undefined,
          })
          if (decision.action === "ignore") return

          if (decision.action === "disable") {
            log.warn("Open Artisan auto-disabled after build-mode idle stall", { sessionId, detail: decision.message })
            try {
              notify.toast("Open Artisan Disabled", decision.message, "warning")
            } catch {
              // ignore
            }
            markDormantSession(sessionId)
            mutateHookMemory(hook, sessionId, "idle.buildModeAutoDisable", (draft) => {
              draft.activeAgent = "build"
              draft.retryCount = 0
              draft.userGateMessageReceived = false
            })
            ctx.trace.record("idle.prompt.skipped", { sessionId, reason: "build-mode-auto-disable" })
            return
          }

          if (decision.action === "escalate") {
            log.warn(`Idle escalation: agent stopped ${state.retryCount} times at ${state.phase}/${state.phaseState}`, { sessionId })
            try {
              notify.toast("Workflow Stalled", decision.message, "warning")
            } catch {
              // ignore
            }
            try {
              mutateHookMemory(hook, sessionId, "idle.escalationRetry", (draft) => { draft.retryCount = MAX_IDLE_RETRIES + 1 })
            } catch (e) {
              log.warn("Failed to reset retryCount on escalation", { detail: e instanceof Error ? e.message : String(e), sessionId })
            }
            if (shouldInjectIdlePrompts()) {
              try {
                await ctx.promptExistingSession(sessionId,
                  `WORKFLOW STALLED: You have stopped ${state.retryCount} times during ${state.phase}/${state.phaseState} ` +
                  `without completing the current step. Stop what you are doing and ask the user for guidance. ` +
                  `Explain what you were trying to do and where you got stuck.`,
                  { reason: "idle-escalation", caller: "event.session.idle" },
                )
              } catch (err) {
                ctx.trace.record("idle.escalationPrompt.failed", {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            } else {
              ctx.trace.record("idle.prompt.skipped", { sessionId, reason: "idle-escalation" })
            }
            return
          }

          log.warn(`Idle reprompt ${decision.retryCount}/${MAX_IDLE_RETRIES} at ${state.phase}/${state.phaseState}`, { sessionId })
          try {
            lastRepromptTimestamps.set(sessionId, Date.now())
            if (shouldInjectIdlePrompts()) {
              await ctx.promptExistingSession(sessionId, decision.message, { reason: "idle-reprompt", caller: "event.session.idle" })
            } else {
              ctx.trace.record("idle.prompt.skipped", { sessionId, reason: "idle-reprompt", retryCount: decision.retryCount })
            }
            mutateHookMemory(hook, sessionId, "idle.retryCount", (draft) => {
              draft.retryCount = decision.retryCount
            })
          } catch (err) {
            ctx.trace.record("idle.reprompt.failed", {
              sessionId,
              retryCount: decision.retryCount,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } catch (e) {
        hookError = e instanceof Error ? e.message : String(e)
        log.error("Unhandled error in event hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      } finally {
        traceHookEnd(hook, started, hookSessionId, { eventType: event.type, ...(hookError ? { error: hookError } : {}) })
      }
    },

    "chat.message": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string; messageID?: string; [key: string]: unknown },
      output: { message: { sessionID?: string; sessionId?: string; id?: string }; parts: Array<{ type: string; text?: string; id?: string; sessionID?: string; messageID?: string }> },
    ) => {
      const hook = "chat.message"
      const started = traceHookStart(hook)
      let hookSessionId: string | undefined
      let hookError: string | undefined
      let didMutateOutput = false
      const { store, log, notify, sessions } = ctx
      try {
        const sessionId = (
          (input.sessionID as string | undefined) ??
          (input.sessionId as string | undefined) ??
          (input.session_id as string | undefined) ??
          (output.message?.sessionID as string | undefined) ??
          (output.message?.sessionId as string | undefined)
        )
        hookSessionId = sessionId
        if (!sessionId) return
        sessions.setActive(sessionId)

        const detectedAgent = extractAgentName(input) ?? extractAgentName(output.message)
        const state = store.get(sessionId)
        if (!state) return

        const strippedStaleGate = stripStaleWorkflowGateNotes(output.parts)
        if (strippedStaleGate) didMutateOutput = true

        const textContent = output.parts
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text!)
          .join(" ")
          .trim()

        if (textContent && shouldActivateWorkflow(textContent) && !isArtisanLockedSession(state, detectedAgent)) {
          clearDormantSession(sessionId)
          mutateHookMemory(hook, sessionId, "chat.activateWorkflow", (draft) => {
            draft.activeAgent = "build-artisan"
            draft.retryCount = 0
            draft.userGateMessageReceived = false
          })
          ctx.trace.record("chat.activeAgent.changed", { sessionId, from: state.activeAgent, to: "build-artisan", reason: "explicit-opt-in" })
        }

        if (detectedAgent) {
          if (!isDormantSession(sessionId)) {
            applyActiveAgentInMemory(hook, sessionId, detectedAgent)
          }
        }

        const refreshedState = store.get(sessionId)
        if (!refreshedState) return

        if (textContent && refreshedState.retryCount > MAX_IDLE_RETRIES) {
          mutateHookMemory(hook, sessionId, "chat.retryReset", (draft) => {
            draft.retryCount = 0
          })
        }
        if (textContent) clearNonrecoverableGuardBlock(sessionId)

        if (
          textContent &&
          shouldForceWorkflowDormant(textContent) &&
          !isArtisanLockedSession(refreshedState, detectedAgent)
        ) {
          markDormantSession(sessionId)
          mutateHookMemory(hook, sessionId, "chat.forceDormant", (draft) => {
            draft.activeAgent = "build"
            draft.retryCount = 0
            draft.userGateMessageReceived = false
          })
          ctx.trace.record("chat.activeAgent.changed", { sessionId, from: refreshedState.activeAgent, to: "build", reason: "explicit-opt-out" })
          return
        }
        if (!isWorkflowSessionActive(refreshedState, detectedAgent)) return

        if (refreshedState.phase === "DONE") {
          mutateHookMemory(hook, sessionId, "chat.doneReset", (draft) => {
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
            draft.revisionAutoSkipBlockedReason = null
            draft.reviewArtifactFiles = []
            draft.reviewArtifactSubmissions = []
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
          mutateHookMemory(hook, sessionId, "chat.userMessage", (draft) => {
            draft.userMessages.push(textContent)
            if (!draft.intentBaseline) {
              draft.intentBaseline = textContent.slice(0, MAX_INTENT_BASELINE_CHARS)
            }
          })
        }

        if (refreshedState.phaseState !== "USER_GATE") return

        const result = processUserMessage(refreshedState, output.parts)
        ctx.trace.record("chat.userGate.routing", {
          sessionId,
          intercepted: result.intercepted,
          feedbackType: result.feedbackType,
          phase: refreshedState.phase,
          phaseState: refreshedState.phaseState,
        })
        if (result.intercepted) {
          const injectedText = result.parts[0]?.text ?? ""
          mutateHookMemory(hook, sessionId, "chat.userGateReceived", (draft) => {
            draft.userGateMessageReceived = true
          })

          if (injectedText) {
            output.parts.splice(0, 0, {
              type: "text",
              text: injectedText,
              id: `prt_oa_routing_${Date.now()}`,
              sessionID: sessionId,
              messageID: messageId,
            })
            didMutateOutput = true
          }
        }
      } catch (e) {
        hookError = e instanceof Error ? e.message : String(e)
        log.error("Unhandled error in chat.message hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      } finally {
        traceHookEnd(hook, started, hookSessionId, { didMutateOutput, ...(hookError ? { error: hookError } : {}) })
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string; model?: unknown },
      output: { system: string[] },
    ) => {
      const hook = "experimental.chat.system.transform"
      const started = traceHookStart(hook)
      let hookSessionId: string | undefined
      let hookError: string | undefined
      let injected = false
      const { store, log, sessions } = ctx
      try {
        const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
        hookSessionId = sessionId
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
        if (isDormantSession(sessionId)) return

        const detectedAgent = extractAgentName(input)
        if (detectedAgent) {
          applyActiveAgentInMemory(hook, sessionId, detectedAgent)
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
            mutateHookMemory(hook, sessionId, "system.sessionModel", (draft) => {
              draft.sessionModel = modelConfig
            })
          }
        } else if (input.model) {
          log.warn("Failed to extract model config", { detail: `input.model type: ${typeof input.model}, value: ${JSON.stringify(input.model).slice(0, 200)}` })
        }

        if (!isWorkflowSessionActive(refreshedState, detectedAgent)) return

        output.system.push(buildWorkflowSystemPrompt(refreshedState))
        injected = true
        if (refreshedState.phaseState === "USER_GATE") {
          output.system.push(buildUserGateHint(refreshedState.phase, refreshedState.phaseState))
        }
      } catch (e) {
        hookError = e instanceof Error ? e.message : String(e)
        log.error("Unhandled error in system.transform hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      } finally {
        traceHookEnd(hook, started, hookSessionId, { injected, ...(hookError ? { error: hookError } : {}) })
      }
    },

    "tool.execute.before": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string; tool: string; args?: Record<string, unknown> },
      output?: { args?: Record<string, unknown> },
    ) => {
      const hook = "tool.execute.before"
      const started = traceHookStart(hook, { tool: input.tool })
      let hookSessionId: string | undefined
      let hookError: string | undefined
      let policySource: "session" | "parent" | "none" = "none"
      const { store, log, sessions } = ctx
      try {
        const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
        hookSessionId = sessionId
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
            policySource = "parent"
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
              const toolArgs = output?.args ?? input.args
              const command = (toolArgs?.["command"] ?? toolArgs?.["cmd"] ?? toolArgs?.["script"] ?? "") as string
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
                projectRoot,
                args: { ...input, args: output?.args ?? input.args },
                predicate: policy.writePathPredicate,
                onMissingTarget: () => {
                  const message = `Tool "${input.tool}" had no extractable target path in ${parentState.phase}/${parentState.phaseState}.`
                  markNonrecoverableGuardBlock(parentId, message)
                  if (toolName === "apply_patch") {
                    log.warn("OPENARTISAN_APPLY_PATCH_PAYLOAD_DIAGNOSTIC", { detail: `${message} payload=${summarizeToolPayload(input)}` })
                  }
                },
              })
            }
            clearNonrecoverableGuardBlock(parentId)
            return
          }
        }

        const state = store.get(sessionId)
        if (!state) return
        if (isDormantSession(sessionId)) return

        const detectedAgent = extractAgentName(input)
        if (detectedAgent) {
          applyActiveAgentInMemory(hook, sessionId, detectedAgent)
        }

        const refreshedState = store.get(sessionId)
        if (!refreshedState) return

        sessions.setActive(sessionId)
        if (!isWorkflowSessionActive(refreshedState, detectedAgent)) return
        if (WORKFLOW_TOOL_NAMES.has(input.tool)) return
        if (passthroughToolNames.has(input.tool.toLowerCase())) return
        policySource = "session"

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
          const toolArgs = output?.args ?? input.args
          const command = (toolArgs?.["command"] ?? toolArgs?.["cmd"] ?? toolArgs?.["script"] ?? "") as string
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
            projectRoot,
            args: { ...input, args: output?.args ?? input.args },
            predicate: policy.writePathPredicate,
            onMissingTarget: () => {
              const message = `Tool "${input.tool}" had no extractable target path in ${refreshedState.phase}/${refreshedState.phaseState}.`
              markNonrecoverableGuardBlock(sessionId, message)
              if (toolName === "apply_patch") {
                log.warn("OPENARTISAN_APPLY_PATCH_PAYLOAD_DIAGNOSTIC", { detail: `${message} payload=${summarizeToolPayload(input)}` })
              }
            },
          })
        }
        clearNonrecoverableGuardBlock(sessionId)
      } catch (e) {
        hookError = e instanceof Error ? e.message : String(e)
        if (e instanceof Error && e.message.startsWith("[Workflow]")) throw e
        log.error("Unhandled error in tool.execute.before hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      } finally {
        traceHookEnd(hook, started, hookSessionId, { tool: input.tool, policySource, ...(hookError ? { error: hookError } : {}) })
      }
    },

    "experimental.session.compacting": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string },
      output: { context?: string[] },
    ) => {
      const hook = "experimental.session.compacting"
      const started = traceHookStart(hook)
      let hookSessionId: string | undefined
      let hookError: string | undefined
      let injected = false
      const { store, log } = ctx
      try {
        const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
        hookSessionId = sessionId
        if (!sessionId) return
        const state = store.get(sessionId)
        if (!state) return
        if (isDormantSession(sessionId)) return
        if (!isWorkflowSessionActive(state)) return

        output.context ??= []
        output.context.push(buildCompactionContext(state))
        injected = true
      } catch (e) {
        hookError = e instanceof Error ? e.message : String(e)
        log.error("Unhandled error in compacting hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      } finally {
        traceHookEnd(hook, started, hookSessionId, { injected, ...(hookError ? { error: hookError } : {}) })
      }
    },

    "experimental.compaction.autocontinue": async (
      input: { sessionID?: string; sessionId?: string; session_id?: string },
      output: { enabled: boolean },
    ) => {
      const hook = "experimental.compaction.autocontinue"
      const started = traceHookStart(hook)
      let hookSessionId: string | undefined
      let hookError: string | undefined
      let disabled = false
      const { store, log } = ctx
      try {
        const sessionId = (input.sessionID ?? input.sessionId ?? input.session_id) as string | undefined
        hookSessionId = sessionId
        if (!sessionId) return
        const state = store.get(sessionId)
        if (!state) return
        if (isDormantSession(sessionId)) return
        if (!isWorkflowSessionActive(state)) return

        if (
          state.phaseState === "USER_GATE" ||
          state.phaseState === "ESCAPE_HATCH" ||
          state.phaseState === "HUMAN_GATE" ||
          state.phase === "MODE_SELECT" ||
          state.phase === "DONE"
        ) {
          output.enabled = false
          disabled = true
        }
      } catch (e) {
        hookError = e instanceof Error ? e.message : String(e)
        log.error("Unhandled error in compaction.autocontinue hook", { detail: e instanceof Error ? e.stack ?? e.message : String(e) })
      } finally {
        traceHookEnd(hook, started, hookSessionId, { disabled, ...(hookError ? { error: hookError } : {}) })
      }
    },
  }
}
