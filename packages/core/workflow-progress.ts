import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

import type { Phase, PhaseState } from "./workflow-primitives"
import type { WorkflowState } from "./workflow-state-types"

export type WorkflowProgressStatus = "started" | "in-progress" | "succeeded" | "failed" | "blocked"

export interface WorkflowProgressEvent {
  event: "progress"
  id: string
  workflowId: string
  sessionId: string
  featureName: string | null
  phase: Phase
  phaseState: PhaseState
  taskId: string | null
  kind: string
  status: WorkflowProgressStatus
  message: string
  spanId: string | null
  parentSpanId: string | null
  parentEventId: string | null
  createdAt: string
  metadata: Record<string, unknown>
}

export interface BuildWorkflowProgressEventInput {
  sessionId: string
  kind: string
  status: WorkflowProgressStatus
  message: string
  spanId?: string | null
  parentSpanId?: string | null
  parentEventId?: string | null
  taskId?: string | null
  metadata?: Record<string, unknown>
}

export interface ListWorkflowProgressEventsOptions {
  featureName: string | null
  sessionId: string
  sinceEventId?: string | null
  limit?: number
}

const MAX_PROGRESS_EVENTS = 200
const MAX_PROGRESS_MESSAGE_CHARS = 500

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "unknown"
}

export function workflowProgressEventsPath(stateDir: string, featureName: string | null, sessionId: string): string {
  const segment = featureName ? safeSegment(featureName) : `session-${safeSegment(sessionId)}`
  return join(stateDir, segment, "events.jsonl")
}

export function workflowIdForProgress(state: WorkflowState | null | undefined, sessionId: string): string {
  return state?.featureName ? `workflow:${state.featureName}` : `session:${sessionId}`
}

export function buildWorkflowProgressEvent(
  input: BuildWorkflowProgressEventInput,
  state: WorkflowState,
  now = new Date(),
): WorkflowProgressEvent {
  const taskId = input.taskId ?? state.currentTaskId ?? null
  return {
    event: "progress",
    id: randomUUID(),
    workflowId: workflowIdForProgress(state, input.sessionId),
    sessionId: input.sessionId,
    featureName: state.featureName ?? null,
    phase: state.phase,
    phaseState: state.phaseState,
    taskId,
    kind: input.kind.trim(),
    status: input.status,
    message: input.message.trim().slice(0, MAX_PROGRESS_MESSAGE_CHARS),
    spanId: input.spanId?.trim() || null,
    parentSpanId: input.parentSpanId?.trim() || null,
    parentEventId: input.parentEventId?.trim() || null,
    createdAt: now.toISOString(),
    metadata: input.metadata ?? {},
  }
}

export function validateWorkflowProgressEventInput(input: BuildWorkflowProgressEventInput): string | null {
  if (!input.kind.trim()) return "kind is required."
  if (!input.message.trim()) return "message is required."
  if (input.parentSpanId && !input.spanId) return "spanId is required when parentSpanId is provided."
  return null
}

export async function appendWorkflowProgressEvent(stateDir: string, event: WorkflowProgressEvent): Promise<void> {
  const path = workflowProgressEventsPath(stateDir, event.featureName, event.sessionId)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf-8")
}

export async function listWorkflowProgressEvents(
  stateDir: string,
  options: ListWorkflowProgressEventsOptions,
): Promise<WorkflowProgressEvent[]> {
  const path = workflowProgressEventsPath(stateDir, options.featureName, options.sessionId)
  let text = ""
  try {
    text = await readFile(path, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const events = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkflowProgressEvent)
  if (options.sinceEventId) {
    const sinceIndex = events.findIndex((event) => event.id === options.sinceEventId)
    const start = sinceIndex >= 0 ? sinceIndex + 1 : 0
    return events.slice(start, start + (options.limit ?? MAX_PROGRESS_EVENTS))
  }

  const limit = options.limit ?? MAX_PROGRESS_EVENTS
  return events.slice(Math.max(0, events.length - limit))
}
