/**
 * Bun test preload script — registers a mock for @opencode-ai/plugin.
 *
 * This runs before any test file imports, ensuring that index.ts can
 * resolve its `import { tool, type Plugin } from "@opencode-ai/plugin"`
 * without the real OpenCode runtime being installed.
 */
import { plugin } from "bun"

plugin({
  name: "opencode-plugin-mock",
  setup(build) {
    build.module("@opencode-ai/plugin", () => {
      // Proxy-based schema builder that supports any method chain
      function createChainable(): Record<string, unknown> {
        const handler: ProxyHandler<Record<string, unknown>> = {
          get(_target, prop) {
            if (prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined
            // Every property access returns a function that returns the same proxy
            return (..._args: unknown[]) => new Proxy({}, handler)
          },
        }
        return new Proxy({}, handler)
      }

      function tool(config: Record<string, unknown>) {
        return config
      }

      tool.schema = {
        string: () => createChainable(),
        boolean: () => createChainable(),
        enum: (_values: string[]) => createChainable(),
        array: (_inner: unknown) => createChainable(),
        object: (shape: Record<string, unknown>) => shape,
      }

      return {
        exports: { tool },
        loader: "object",
      }
    })
  },
})
