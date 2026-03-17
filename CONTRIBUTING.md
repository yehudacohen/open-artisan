# Contributing to Open Artisan

Thank you for your interest in contributing to Open Artisan! This guide will help you get started, whether you're fixing a bug, adding a feature, improving documentation, or just exploring the codebase.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (v1.0 or later) -- used as the runtime and test runner
- [OpenCode](https://opencode.ai) -- needed to run the plugin in a real environment
- Git

### Setting Up the Development Environment

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/<your-username>/open-artisan.git
   cd open-artisan
   ```

2. **Install dependencies:**

   ```bash
   bun install
   cd .opencode && bun install && cd ..
   ```

3. **Run the tests** to make sure everything works:

   ```bash
   bun test
   ```

   You should see all 1,100+ tests pass across 38 test files.

4. **Try it out** by symlinking the plugin into an OpenCode project:

   ```bash
   ln -s /path/to/open-artisan/.opencode/plugins/open-artisan /your-project/.opencode/plugins/open-artisan
   ```

   Then start OpenCode in that project and select the `artisan` agent.

### Project Layout

Here's what you'll find in the repository:

```
open-artisan/
+-- .opencode/
|   +-- agents/                  # Agent definitions (markdown files)
|   +-- plugins/open-artisan/    # Plugin source code (TypeScript)
|       +-- index.ts             # Entry point -- hooks and tool wiring
|       +-- types.ts             # Type definitions and state validation
|       +-- state-machine.ts     # Table-driven finite state machine
|       +-- session-state.ts     # State persistence with schema migration
|       +-- hooks/               # OpenCode hook handlers
|       +-- tools/               # Tool argument parsing and handlers
|       +-- orchestrator/        # Feedback classification and routing
|       +-- discovery/           # Parallel codebase scanner fleet
|       +-- prompts/             # Phase-specific prompt templates
+-- tests/                       # Test suite (bun test)
+-- docs/                        # Design documents
```

For a deeper understanding of the architecture, see the [design document](docs/structured-workflow-design.md).

## How to Contribute

### Reporting Bugs

If you've found a bug, please [open an issue](https://github.com/yehudacohen/open-artisan/issues/new) and include:

- What you expected to happen
- What actually happened
- Steps to reproduce, if possible
- The contents of `.opencode/openartisan-errors.log` (if relevant)
- Your OpenCode and Bun versions

### Suggesting Features

Feature ideas are welcome! Please open an issue describing:

- The problem you're trying to solve
- How you'd like the solution to work
- Whether this changes the workflow phases or is an internal improvement

### Submitting Changes

1. **Create a branch** from `main`:

   ```bash
   git checkout -b my-feature
   ```

2. **Make your changes.** Write or update tests for anything you change.

3. **Run the full test suite:**

   ```bash
   bun test
   ```

   All tests must pass before submitting.

4. **Commit** with a descriptive message. We use conventional commit prefixes:

   - `feat:` -- New features or capabilities
   - `fix:` -- Bug fixes
   - `docs:` -- Documentation changes
   - `refactor:` -- Code restructuring without behavior change
   - `test:` -- Adding or updating tests

   Example:
   ```bash
   git commit -m "fix: prevent stale revision baseline after cascade auto-skip"
   ```

5. **Push** and open a pull request against `main`.

## Development Guidelines

### Writing Tests

- Tests live in `tests/` and use Bun's built-in test runner.
- Every source module should have a corresponding test file.
- Test behavior, not implementation. Focus on inputs and outputs rather than internal details.
- Use descriptive test names that explain the scenario:
  ```typescript
  it("rejects featureName containing '..'", () => { ... })
  it("concurrent updates to different sessions do not lose writes", () => { ... })
  ```
- Clean up after yourself: use `mkdtemp()` / `afterEach` cleanup for any filesystem operations.
- Mock only external dependencies (the OpenCode SDK). Test pure logic modules directly.

### Code Style

- **TypeScript strict mode** -- the project uses `strict: true` with `noUncheckedIndexedAccess`.
- **No `any`** unless absolutely necessary (and document why with an eslint-disable comment).
- **Prefer `??` over `||`** for default values, unless you intentionally want falsy-coalescing.
- **Use discriminated unions** for result types (`{ success: true; data: T } | { success: false; error: string }`).
- **Extract constants** to `constants.ts` -- avoid magic numbers and strings.
- **Name things clearly**: `create*` for factories, `dispatch*` for subagent calls, `build*` for string construction, `handle*` for event handlers.

### State Machine Changes

The state machine in `state-machine.ts` is the heart of the plugin. If you're modifying it:

1. Update the transition table in `buildTable()`.
2. Update `VALID_PHASE_STATES` in `types.ts` if adding new phase/state combinations.
3. Update `validateWorkflowState()` in `types.ts` for any new state fields.
4. Bump `SCHEMA_VERSION` in `constants.ts` and add migration logic in `session-state.ts`.
5. Add transition tests in `tests/state-machine.test.ts`.
6. Update the design document in `docs/structured-workflow-design.md`.

### Adding a New Tool

1. Define the tool schema and `execute` handler in `index.ts` (or extract the handler into `tools/`).
2. Add the tool name to `WORKFLOW_TOOL_NAMES` in `index.ts` so it's always allowed by the tool guard.
3. Add tests in `tests/`.
4. Document the tool in the design document.

### Security Considerations

This plugin enforces quality gates on AI agents. Keep these principles in mind:

- **Gates must be structural, not advisory.** If a gate can be bypassed by agent rationalization, it must be enforced in the state machine or tool guard, not in a prompt.
- **Tool guards must fail safe.** The default case in `getPhaseToolPolicy()` blocks all writes. New phases must be explicitly handled.
- **Validate all state mutations.** `validateWorkflowState()` runs before every persist. New fields need validation rules.
- **Never trust LLM output.** Parse, validate, and sanitize. The `mark_satisfied` tool recomputes `satisfied` from individual criteria rather than trusting the model's summary.

## Understanding the Codebase

If you're new to the project, here's a suggested reading order:

1. **[Design document](docs/structured-workflow-design.md)** -- Start here for the big picture. Sections 1-3 cover the problem, principles, and phases.
2. **`types.ts`** -- All the type definitions. Pay attention to `WorkflowState`, `Phase`, `PhaseState`, and the result types.
3. **`state-machine.ts`** -- The transition table. Short, pure, and central to everything.
4. **`constants.ts`** -- All the tuning knobs in one place.
5. **`hooks/tool-guard.ts`** -- How tool restrictions are enforced per phase.
6. **`hooks/system-transform.ts`** -- How the system prompt is constructed per phase.
7. **`index.ts`** -- The wiring. Start with the hook registrations (search for `"event"`, `"chat.message"`, etc.) before diving into the tool handlers.

### Debug Tips

- Set `OPENARTISAN_DEBUG=1` to enable debug output to stderr.
- Check `.opencode/openartisan-errors.log` for persisted errors and warnings (JSON lines format).
- OpenCode logs are at `~/.local/share/opencode/log/` -- useful for diagnosing SDK-level issues.
- Run individual test files: `bun test tests/state-machine.test.ts`

## Code of Conduct

Be kind, be constructive, and assume good intent. We're building tools that make AI agents better engineers -- let's hold ourselves to the same standard.

## License

By contributing to Open Artisan, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
