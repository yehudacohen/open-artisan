import { JSONRPCErrorException } from "json-rpc-2.0"

import {
  BridgeCapabilitiesSchema,
  LifecycleInitParamsSchema,
  OpenArtisanPersistenceSchema,
  formatZodError,
  z,
} from "../core/schemas"
import { INVALID_PARAMS } from "./protocol"

const TraceSchema = z.object({ traceId: z.string().optional() }).strict()

const LifecycleSessionParamsSchema = z.object({
  sessionId: z.string().min(1),
  parentId: z.string().optional(),
  agent: z.string().optional(),
  traceId: z.string().optional(),
}).strict()

const LifecycleShutdownParamsSchema = z.object({ force: z.boolean().optional(), traceId: z.string().optional() }).strict()

const StateGetParamsSchema = z.object({
  sessionId: z.string().min(1),
  includeRuntimeHealth: z.boolean().optional(),
  traceId: z.string().optional(),
}).strict()

const GuardCheckParamsSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  sessionId: z.string().min(1),
  traceId: z.string().optional(),
}).strict()

const GuardPolicyParamsSchema = z.object({
  phase: z.string().min(1),
  phaseState: z.string().min(1),
  mode: z.enum(["GREENFIELD", "REFACTOR", "INCREMENTAL"]).nullable(),
  allowlist: z.array(z.string()),
  taskExpectedFiles: z.array(z.string()).optional(),
  traceId: z.string().optional(),
}).strict()

const SessionParamsSchema = z.object({ sessionId: z.string().min(1), traceId: z.string().optional() }).strict()

const MessageProcessParamsSchema = z.object({
  sessionId: z.string().min(1),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  source: z.enum(["user", "synthetic"]).default("user"),
  traceId: z.string().optional(),
}).strict()

const ToolExecuteParamsSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  context: z.object({
    sessionId: z.string().min(1),
    directory: z.string().optional(),
    agent: z.string().optional(),
    invocation: z.enum(["author", "isolated-reviewer", "system"]).optional(),
  }).strict(),
  traceId: z.string().optional(),
}).strict()

const BridgeMethodSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  "lifecycle.init": LifecycleInitParamsSchema as z.ZodType<Record<string, unknown>>,
  "lifecycle.ping": TraceSchema,
  "lifecycle.shutdown": LifecycleShutdownParamsSchema,
  "lifecycle.sessionCreated": LifecycleSessionParamsSchema,
  "lifecycle.sessionDeleted": LifecycleSessionParamsSchema,
  "state.get": StateGetParamsSchema,
  "state.health": SessionParamsSchema,
  "guard.check": GuardCheckParamsSchema,
  "guard.policy": GuardPolicyParamsSchema,
  "prompt.build": SessionParamsSchema,
  "prompt.compaction": SessionParamsSchema,
  "message.process": MessageProcessParamsSchema,
  "idle.check": SessionParamsSchema,
  "tool.execute": ToolExecuteParamsSchema,
  "task.getReviewContext": SessionParamsSchema,
  "task.getPhaseReviewContext": SessionParamsSchema,
  "task.getAutoApproveContext": SessionParamsSchema,
}

export function validateBridgeMethodParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const schema = BridgeMethodSchemas[method]
  if (!schema) return params
  const parsed = schema.safeParse(params ?? {})
  if (!parsed.success) {
    throw new JSONRPCErrorException(`Invalid params for ${method}: ${formatZodError(parsed.error)}`, INVALID_PARAMS)
  }
  return parsed.data
}

export { BridgeCapabilitiesSchema, OpenArtisanPersistenceSchema }
