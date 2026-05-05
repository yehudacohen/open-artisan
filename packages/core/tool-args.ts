/**
 * tool-args.ts — shared tool argument parsing helpers.
 */

import { formatZodError, type z } from "./schemas"

export type ParsedToolArgs<TSchema extends z.ZodType> =
  | { success: true; data: z.output<TSchema> }
  | { success: false; error: string }

export function parseToolArgs<TSchema extends z.ZodType>(
  schema: TSchema,
  args: Record<string, unknown>,
): ParsedToolArgs<TSchema> {
  const parsed = schema.safeParse(args)
  if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }
  return { success: true, data: parsed.data }
}
