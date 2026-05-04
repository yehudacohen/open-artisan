# Open Artisan

**Like Ralph Wiggums but smart: A structured workflow plugin for [OpenCode](https://opencode.ai) that enforces phased, quality-gated software development on AI coding agents.**

Open Artisan mirrors how experienced engineers build software: understand what exists, plan, define interfaces, write tests, plan the implementation, then implement one task at a time -- verifying alignment at every step. If the agent can bypass a quality gate through rationalization, the gate is enforced in code, not prompts.

---

## Why

AI coding agents fail not because the models lack capability, but because they skip the engineering discipline that produces correct code. They lunge into implementation without a plan, produce interfaces ad-hoc, write tests as an afterthought, and have no mechanism to detect when their foundations are wrong.

Open Artisan fixes this by wrapping the agent in a state machine that enforces a phased workflow with independent quality review at every gate.

## How It Works

### The Workflow

Every task progresses through eight phases:

```
MODE_SELECT --> DISCOVERY --> PLANNING --> INTERFACES --> TESTS --> IMPL_PLAN --> IMPLEMENTATION --> DONE
```

Each phase follows a repeating cycle:

```
DRAFT --> REVIEW --> USER_GATE --> next phase
                         |
                     (revise) --> REVISE --> REVIEW --> ...
```

The agent drafts an artifact, an **isolated reviewer subagent** evaluates it against acceptance criteria, and the user approves or requests revisions. The state machine makes it structurally impossible to skip phases or approve without review.

### Three Modes

| Mode | When to Use | Discovery |
|------|-------------|-----------|
| **Greenfield** | New or empty projects | Skipped |
| **Refactor** | Restructure existing code | Full 6-scanner discovery |
| **Incremental** | Add or fix specific functionality | Full discovery, do-no-harm file allowlist |

### Key Enforcement Mechanisms

- **State machine transitions** -- Phase progression is a table-driven FSM. No prompt can cause a phase skip; the agent must call the correct tool, which validates the current state before transitioning.
- **Isolated reviewer** -- Self-review runs in a fresh ephemeral session that sees only the artifact and acceptance criteria, never the authoring conversation. This eliminates anchoring bias.
- **Artifact dependency graph** -- Seven artifacts connected by twelve dependency edges. Revising an upstream artifact triggers cascading re-validation of all downstream dependents.
- **Orchestrator routing** -- User feedback is classified as tactical (agent handles autonomously) or strategic (escalated to the user via escape hatch). Cascade depth >= 3 forces escalation.
- **Revision baseline** -- A diff gate prevents lazy no-op revisions by comparing artifact state at REVISE entry vs. review submission.
- **Per-task review and drift detection** -- After each implementation task, an isolated reviewer checks the work and a lightweight drift check updates downstream task descriptions.
- **Tool guards** -- Phase-specific tool restrictions enforced in code. Write/edit tools are blocked during planning phases; bash write operators are blocked in incremental mode.
- **Git checkpoints** -- A tagged commit is created at every approval gate (`workflow/<phase>-v<N>`).

### Agent Architecture

Open Artisan uses a five-agent architecture:

| Agent | Role |
|-------|------|
| **artisan** | Primary agent -- follows the workflow with human approval gates |
| **robot-artisan** | Autonomous variant -- AI-delegated approvals for unattended operation |
| **workflow-reviewer** | Hidden subagent -- isolated, read-only artifact review |
| **workflow-orchestrator** | Hidden subagent -- feedback classification and routing |
| **auto-approver** | Hidden subagent -- robot-artisan approval evaluation |

### Discovery Phase

In Refactor and Incremental modes, six parallel scanner subagents analyze the existing codebase:

| Scanner | What It Discovers |
|---------|-------------------|
| Structure Scanner | File tree, module boundaries, package structure |
| Convention Detector | Coding style, naming patterns, import conventions |
| Architecture Analyzer | Dependency graph, key abstractions, interface patterns |
| Test Pattern Scanner | Test framework, organization, coverage patterns |
| History Analyzer | Git log, commit patterns, active development areas |
| Docs Reader | Existing documented conventions, setup instructions |

Scanners run with a 3-minute timeout. At least 3 of 6 must succeed for discovery to proceed.

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) installed and configured
- [Bun](https://bun.sh) runtime (for development and testing)

### Setup

1. Clone this repository into your project (or symlink it):

```bash
# Option A: Clone directly into your project's .opencode directory
git clone https://github.com/yehudacohen/open-artisan.git
cp -r open-artisan/.opencode/plugins/open-artisan /your-project/.opencode/plugins/
cp -r open-artisan/.opencode/agents /your-project/.opencode/

# Option B: Symlink for development
ln -s /path/to/open-artisan/.opencode/plugins/open-artisan /your-project/.opencode/plugins/open-artisan
cp -r /path/to/open-artisan/.opencode/agents /your-project/.opencode/
```

2. Install the plugin SDK dependency:

```bash
cd /your-project/.opencode
npm install @opencode-ai/plugin
# or: bun add @opencode-ai/plugin
```

3. Start OpenCode and select the **artisan** (or **robot-artisan**) agent.

The plugin activates automatically when an artisan agent is selected and is dormant for all other agents.

## Usage

When you've installed the plugin, you will gain access to two more agents in addition to your regular OpenCode BUILD and PLAN agents: "artisan", and "robot-artisan".

Once the artisan agent is active, the workflow should begin automatically (although it occasionally doesn't in which case you can just tell it to use the open artisan plugin). 

When using the plugin, simply:

1. **Describe your task** -- The agent will select a mode (Greenfield, Refactor, or Incremental) based on auto-detection of your project.
2. **Discovery** (Refactor/Incremental) -- Six scanners analyze your codebase. Review and approve the discovery report.
3. **Planning** -- The agent creates a plan artifact. An isolated reviewer evaluates it. You approve or request revisions.
4. **Interfaces** -- Interface definitions are drafted, reviewed, and approved.
5. **Tests** -- Test specifications are drafted, reviewed, and approved.
6. **Implementation Plan** -- A task DAG (directed acyclic graph) is created, breaking the work into ordered tasks with dependencies.
7. **Implementation** -- Tasks are executed one at a time. Each task gets a per-task review and drift check before proceeding.
8. **Done** -- All tasks complete. Send a new message to start a fresh workflow cycle.

### Incremental Mode

In Incremental mode, the plugin enforces a **do-no-harm** policy:

- Only files in the allowlist can be written or edited
- Bash write operators (`>`, `>>`, `tee`, `sed -i`, heredocs) are blocked
- Existing tests must continue to pass
- If the allowlist contains no interface or test files, those phases are automatically skipped

### Phase Fast-Forward

When returning to a project with previously approved artifacts, the plugin automatically fast-forwards through phases whose artifacts are still intact on disk (verified by content hash).

### Escape Hatch

When the orchestrator detects a strategic change (scope expansion, architectural shift, or deep cascade), it escalates to the user with four options:

- **Accept** -- Acknowledge the drift and continue
- **Alternative direction** -- Provide a different approach within the current scope
- **New direction** -- Redirect the entire effort
- **Abort** -- Stop the current cascade

## Project Structure

```
open-artisan/
+-- .opencode/
|   +-- agents/                  # Agent definitions (artisan, robot-artisan, subagents)
|   +-- plugins/open-artisan/    # Plugin source code
|       +-- index.ts             # Entry point: hooks, tools, wiring
|       +-- types.ts             # All type definitions and validation
|       +-- state-machine.ts     # Table-driven FSM (zero side effects)
|       +-- session-state.ts     # State persistence with schema migration
|       +-- constants.ts         # Named constants
|       +-- hooks/               # OpenCode hook handlers
|       +-- tools/               # Tool argument parsing and validation
|       +-- orchestrator/        # Feedback classification and routing
|       +-- discovery/           # Parallel scanner fleet
|       +-- prompts/             # Phase-specific prompt templates
|       +-- ...                  # Other modules (DAG, scheduler, review, etc.)
+-- tests/                       # 1,121 tests across 38 files
+-- docs/                        # Design documents
    +-- structured-workflow-design.md   # Full design specification (v14)
```

## Development

### Running Tests

```bash
bun run test
```

The full suite uses the repository test script because PGlite-heavy tests need a longer timeout and serial execution. Use `bun test <file>` for focused files.

### Watching Tests

```bash
bun test --watch
```

### Debug Logging

Set the `OPENARTISAN_DEBUG` environment variable to enable debug output:

```bash
OPENARTISAN_DEBUG=1 opencode
```

Errors and warnings are always persisted to `.opencode/openartisan-errors.log` as JSON lines, regardless of the debug flag.

## Design Documents

For a deep dive into the architecture and design decisions:

- **[Structured Workflow Design](docs/structured-workflow-design.md)** -- The full design specification (v14), covering all 8 phases, 34 valid state combinations, the artifact dependency graph, orchestrator routing, escape hatch flow, tool policy table, and more.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to get started.
