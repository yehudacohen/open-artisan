/**
 * Test shim for @opencode-ai/plugin.
 *
 * Provides minimal stubs of the `tool` helper and `Plugin` type
 * so index.ts can be imported and tested without the real OpenCode runtime.
 */

// The real `tool` helper wraps { description, args, execute } into a tool object.
// For tests, we just pass the config through and attach schema helpers.
export function tool(config: {
  description: string
  args: Record<string, unknown>
  execute: (...args: unknown[]) => Promise<string> | string
}) {
  return config
}

// Schema builders — return objects that look enough like the real zod-like API
// for the plugin code to call .describe(), .optional(), .array(), etc.
function createSchema() {
  const base = {
    describe: (_d: string) => base,
    optional: () => base,
  }
  return base
}

tool.schema = {
  string: () => createSchema(),
  boolean: () => createSchema(),
  enum: (_values: string[]) => createSchema(),
  array: (inner: unknown) => ({
    describe: (_d: string) => ({ inner }),
    optional: () => ({ inner }),
  }),
  object: (shape: Record<string, unknown>) => shape,
}

export type Plugin = (ctx: { client: unknown }) => Promise<Record<string, unknown>>
