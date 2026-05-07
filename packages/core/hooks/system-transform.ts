/**
 * system-transform.ts — Injects phase-specific instructions into every LLM call.
 *
 * Uses the `experimental.chat.system.transform` hook. Prepends a block at the
 * beginning of the system prompt array describing:
 * - Current phase and sub-state
 * - Workflow mode (and its constraints)
 * - Conventions document (if in REFACTOR/INCREMENTAL mode and approved)
 * - File allowlist (INCREMENTAL mode only)
 * - Acceptance criteria for this phase
 * - Which tools are allowed/blocked
 * - What the agent should do next
 */
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import type { WorkflowState } from "../workflow-state-types"
import type { Phase, PhaseState, WorkflowMode } from "../workflow-primitives"
import { MAX_CONVENTIONS_CHARS, MAX_REPORT_CHARS } from "../constants"
import { createImplDAG } from "../dag"
import { nextSchedulerDecision } from "../scheduler"
import { getPhaseToolPolicy } from "./tool-guard"
import { countExpectedBlockingCriteria } from "../tools/mark-satisfied"
import {
  buildPhaseAcceptanceCriteria,
  getAcceptanceCriteria as getSharedAcceptanceCriteria,
  getAcceptanceCriteriaPreview as getSharedAcceptanceCriteriaPreview,
} from "../rubrics"

// ---------------------------------------------------------------------------
// Prompt file loader (cached)
// ---------------------------------------------------------------------------

const PROMPTS_DIR = join(import.meta.dirname, "..", "prompts")

const promptCache = new Map<string, string>()

function loadPrompt(filename: string): string {
  if (promptCache.has(filename)) return promptCache.get(filename)!
  try {
    // Synchronous read — cached after first call so only runs once per prompt file.
    // Uses readFileSync (imported at module level) since Bun.file().text() is async
    // and this function is synchronous by design (called from buildWorkflowSystemPrompt).
    const content = readFileSync(join(PROMPTS_DIR, filename), "utf-8")
    promptCache.set(filename, content)
    return content
  } catch {
    return `## Phase: ${filename.replace(".txt", "")}\n(prompt file not found)`
  }
}

function getPhasePromptFilename(phase: Phase, mode: WorkflowMode | null): string | null {
  switch (phase) {
    case "DISCOVERY":
      if (mode === "REFACTOR") return "discovery-refactor.txt"
      if (mode === "INCREMENTAL") return "discovery-incremental.txt"
      return null // GREENFIELD skips discovery
    case "PLANNING":
      return "planning.txt"
    case "INTERFACES":
      return "interfaces.txt"
    case "TESTS":
      return "tests.txt"
    case "IMPL_PLAN":
      return "impl-plan.txt"
    case "IMPLEMENTATION":
      return "implementation.txt"
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// State header builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase progress indicator
// ---------------------------------------------------------------------------

const GREENFIELD_PHASES: Phase[] = ["PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"]
const FULL_PHASES: Phase[] = ["DISCOVERY", "PLANNING", "INTERFACES", "TESTS", "IMPL_PLAN", "IMPLEMENTATION"]

function phaseProgress(phase: Phase, mode: WorkflowMode | null): string | null {
  const phases = mode === "GREENFIELD" ? GREENFIELD_PHASES : FULL_PHASES
  const idx = phases.indexOf(phase)
  if (idx < 0) return null
  return `Phase ${idx + 1} of ${phases.length}`
}

function buildStateHeader(state: WorkflowState): string {
  const lines: string[] = []

  lines.push("---")
  lines.push("## STRUCTURED WORKFLOW — ACTIVE")
  lines.push("")
  lines.push(`**Phase:** ${state.phase} / **Sub-state:** ${state.phaseState}`)
  lines.push(`**Mode:** ${state.mode ?? "not yet selected"}`)
  if (state.featureName) {
    lines.push(`**Feature:** ${state.featureName} → artifacts at \`.openartisan/${state.featureName}/\``)
  }

  const progress = phaseProgress(state.phase, state.mode)
  if (progress) {
    lines.push(`**Progress:** ${progress}`)
  }

  if (state.iterationCount > 0) {
    lines.push(`**Iteration:** ${state.iterationCount} (in current phase/sub-state)`)
  }
  if (state.lastCheckpointTag) {
    lines.push(`**Last checkpoint:** \`${state.lastCheckpointTag}\``)
  }
  lines.push("")

  // At MODE_SELECT, show the mode-detection suggestion (stored in dedicated field)
  if (state.phase === "MODE_SELECT" && state.modeDetectionNote) {
    lines.push("### Auto-Detection Result")
    lines.push(state.modeDetectionNote)
    lines.push("")
  }

  // Mode constraints summary
  if (state.mode === "INCREMENTAL") {
    lines.push("### Do-No-Harm Directive (INCREMENTAL mode)")
    lines.push("- Modify ONLY files in the approved allowlist")
    lines.push("- Do NOT refactor outside the requested scope")
    lines.push("- Follow existing conventions exactly")
    lines.push("- All existing tests must continue to pass")
    lines.push(state.phase === "IMPLEMENTATION"
      ? "- If you need to touch an unlisted file, STOP and call `propose_backtrack` so the approved scope can be revised truthfully"
      : "- If you need to touch an unlisted file, STOP and route through the approval workflow")
    lines.push("")
    if (state.fileAllowlist.length > 0) {
      lines.push("**Approved file allowlist:**")
      for (const f of state.fileAllowlist) {
        lines.push(`  - ${f}`)
      }
      lines.push("")
    }
  } else if (state.mode === "REFACTOR") {
    lines.push("### Refactor Mode Constraints")
    lines.push("- Follow the target patterns from the conventions document")
    lines.push("- All existing tests must pass after each task")
    lines.push("- New patterns must be documented")
    lines.push("")
  }

  if (state.phase !== "MODE_SELECT" && state.phase !== "DONE") {
    lines.push("### Uncertainty Handling")
    lines.push("- If you are unsure between viable approaches, make the best decision yourself; do not stop to ask the user unless human action or credentials are required.")
    lines.push("- Document the decision explicitly in the current artifact, including the alternatives considered and the tradeoffs/risks.")
    lines.push("- Carry that decision summary forward so it can be reported at USER_GATE with the artifact approval request.")
    lines.push("")
  }

  // Conventions document injection
  // If the conventions file has been written to disk, instruct the agent to read it
  // rather than embedding the full text inline (avoids truncation in long contexts).
  if (state.conventions && state.mode !== "GREENFIELD") {
    const conventionsPath = state.artifactDiskPaths?.["conventions"]
    lines.push("### Conventions Document (from Discovery Phase)")
    lines.push("The following conventions are MANDATORY. Treat them as hard requirements.")
    lines.push("")
    if (conventionsPath && existsSync(conventionsPath)) {
      lines.push(`The approved conventions document is saved at \`${conventionsPath}\`.`)
      lines.push("**Read this file now** before doing any work. It contains binding constraints.")
    } else {
      // Fallback: inline injection for sessions pre-dating disk path tracking (v8 → v9 migration)
      const text = state.conventions.length > MAX_CONVENTIONS_CHARS
        ? state.conventions.slice(0, MAX_CONVENTIONS_CHARS) +
          `\n\n[... conventions truncated at ${MAX_CONVENTIONS_CHARS} chars — read the full file for complete constraints ...]`
        : state.conventions
      lines.push(text)
    }
    lines.push("")
  }

  // Approved artifacts summary
  if (Object.keys(state.approvedArtifacts).length > 0) {
    lines.push("### Approved Artifacts")
    lines.push("These artifacts have been reviewed and approved by the user:")
    for (const [artifact, hash] of Object.entries(state.approvedArtifacts)) {
      lines.push(`  - **${artifact}** (content hash: ${hash})`)
      const approvedFiles = state.approvedArtifactFiles?.[artifact as keyof typeof state.approvedArtifactFiles]
      if (approvedFiles && approvedFiles.length > 0) {
        lines.push(`    source files: ${approvedFiles.map((path) => `\`${path}\``).join(", ")}`)
      }
    }
    lines.push("")
  }

  lines.push("---")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Acceptance criteria compatibility exports
// ---------------------------------------------------------------------------
/**
 * Returns a preview of the acceptance criteria for authoring states (DRAFT, CONVENTIONS, REVISE).
 * The agent sees these while drafting so it knows what the reviewer will evaluate.
 * Returns null for states where criteria preview is not applicable.
 */
export function getAcceptanceCriteriaPreview(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null, designDocPath?: string | null): string | null {
  return getSharedAcceptanceCriteriaPreview(phase, phaseState, mode, designDocPath)
}

export function getAcceptanceCriteria(phase: Phase, phaseState: PhaseState, mode: WorkflowMode | null, designDocPath?: string | null): string | null {
  return getSharedAcceptanceCriteria(phase, phaseState, mode, designDocPath)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface SystemTransformInput {
  sessionId: string
  /** The current mutable system prompt array (will be mutated in place via unshift) */
  parts: Array<{ type: string; text: string }>
}

/**
 * Builds the workflow system prompt block for the given state.
 * Returns the string to prepend to the system prompt.
 * Pure function — does NOT mutate anything.
 */
export interface WorkflowSystemPromptOptions {
  reviewMode?: "agent" | "isolated"
}

export function buildWorkflowSystemPrompt(state: WorkflowState, options: WorkflowSystemPromptOptions = {}): string {
  const blocks: string[] = []
  const reviewMode = options.reviewMode ?? "agent"

  // 1. State header (phase, mode, constraints)
  blocks.push(buildStateHeader(state))

  // 2. Phase-specific instructions
  const structuralStateUsesCustomContext =
    state.phase === "IMPLEMENTATION" &&
    (state.phaseState === "SCHEDULING" ||
      state.phaseState === "TASK_REVIEW" ||
      state.phaseState === "TASK_REVISE" ||
      state.phaseState === "HUMAN_GATE" ||
      state.phaseState === "DELEGATED_WAIT")
  const promptFile = structuralStateUsesCustomContext ? null : getPhasePromptFilename(state.phase, state.mode)
  if (promptFile) {
    blocks.push(loadPrompt(promptFile))
  }

  // 2b. Design document constraint block (if a design doc is tracked)
  const designDocPath = state.artifactDiskPaths?.design ?? null
  if (designDocPath && (state.phase === "PLANNING" || state.phase === "IMPL_PLAN" || state.phase === "IMPLEMENTATION")) {
    blocks.push(
      `### Design Document — Mandatory Constraint\n\n` +
      `A user-authored design document is tracked at \`${designDocPath}\`.\n` +
      `Read this document before drafting. It defines structural invariants that the ` +
      `${state.phase === "PLANNING" ? "plan" : state.phase === "IMPL_PLAN" ? "implementation plan" : "implementation"} ` +
      `must comply with.\n\n` +
      (state.phase === "PLANNING"
        ? `**You MUST include a "Design Deviations" section** in the plan that lists every point ` +
          `where the plan deviates from the design document. Each deviation must be classified as:\n` +
          `- **equivalent** — no structural guarantee lost (different approach, same protection)\n` +
          `- **downgraded** — structural guarantee replaced with a procedural check (with risk note)\n` +
          `- **deferred** — feature/guarantee cut from this iteration\n\n` +
          `An empty deviation register is valid if the plan fully conforms to the design. ` +
          `The deviation register will be presented to the user at the approval gate.`
        : `The plan's "Design Deviations" register (if present) defines approved deviations. ` +
          `Do not introduce new deviations beyond what was approved in the plan.`),
    )
  }

  // 3. Current sub-state context (with MODE_SELECT and DONE special cases)
  blocks.push(buildSubStateContext(state, reviewMode))

  // 4. Blocked tools list (M10 — impl plan §4.6)
  if (state.phase !== "MODE_SELECT" && state.phase !== "DONE") {
    const policy = getPhaseToolPolicy(state.phase, state.phaseState, state.mode, state.fileAllowlist)
    if (policy.blocked.length > 0) {
      blocks.push(`### Blocked Tools\nThe following tool categories are **blocked** in ${state.phase}/${state.phaseState}: ${policy.blocked.map((t) => `\`${t}\``).join(", ")}.\n${policy.allowedDescription}`)
    }
  }

  // 5. Acceptance criteria injection:
  //    - At REVIEW: full structured criteria so the agent knows what to evaluate for mark_satisfied.
  //    - At DRAFT/CONVENTIONS/REVISE: criteria preview so the agent knows what to satisfy before submitting.
  //    If a design doc is tracked, [D] criteria are injected for design compliance.
  const criteria = getAcceptanceCriteria(state.phase, state.phaseState, state.mode, designDocPath)
  if (criteria) {
    blocks.push(criteria)
    // Inject the expected blocking criteria count so the agent knows exactly
    // how many assessments to provide in mark_satisfied. Without this, the
    // agent has to count numbered lines manually and often gets it wrong,
    // wasting review iterations.
    const expectedCount = countExpectedBlockingCriteria(criteria)
    if (expectedCount > 0) {
      blocks.push(reviewMode === "isolated"
        ? `**Reviewer requirement:** The isolated reviewer must provide exactly **${expectedCount}** blocking criteria assessments with \`criterion\`, \`met\` (boolean), \`evidence\` (specific quote or file reference), and \`severity: "blocking"\`.`
        : `**Required:** You must provide exactly **${expectedCount}** blocking criteria assessments when calling \`mark_satisfied\`. Each must have \`criterion\`, \`met\` (boolean), \`evidence\` (specific quote or file reference), and \`severity: "blocking"\`.`)
    }
  }
  const criteriaPreview = getAcceptanceCriteriaPreview(state.phase, state.phaseState, state.mode, designDocPath)
  if (criteriaPreview) {
    blocks.push(criteriaPreview)
  }

  return blocks.join("\n\n")
}

/**
 * Builds a context block for Task subagent sessions that inherit a parent's
 * workflow state. Provides the subagent with:
 *
 *   - Current phase/mode/feature context (so it knows WHERE it is in the workflow)
 *   - Artifact disk paths (so it can read conventions, interfaces, tests, plan)
 *   - Mode constraints (INCREMENTAL allowlist, REFACTOR conventions, etc.)
 *   - Full DAG with task statuses (so it can see what's done and what's pending)
 *   - Tool restrictions (workflow tools are blocked; file writes follow parent policy)
 *   - Instructions on how to report completion (back to parent, not via workflow tools)
 *
 * Does NOT include: workflow tool descriptions, acceptance criteria, review
 * instructions, or sub-state routing hints — those are parent-only concerns.
 *
 * Pure function — does NOT mutate anything.
 */
export function buildSubagentContext(parentState: WorkflowState): string {
  const lines: string[] = []

  lines.push("---")
  lines.push("## WORKFLOW CONTEXT — SUBAGENT SESSION")
  lines.push("")
  lines.push("You are a **Task subagent** working within a structured workflow.")
  lines.push("The parent session manages workflow state — you focus on implementation work.")
  lines.push("")
  lines.push(`**Phase:** ${parentState.phase} / **Sub-state:** ${parentState.phaseState}`)
  lines.push(`**Mode:** ${parentState.mode ?? "not yet selected"}`)
  if (parentState.featureName) {
    lines.push(`**Feature:** ${parentState.featureName}`)
  }
  lines.push("")

  // Mode constraints
  if (parentState.mode === "INCREMENTAL") {
    lines.push("### Do-No-Harm Directive (INCREMENTAL mode)")
    lines.push("- Modify ONLY files in the approved allowlist")
    lines.push("- Do NOT refactor outside the requested scope")
    lines.push("- Follow existing conventions exactly — your code must be indistinguishable from existing code")
    lines.push("- All existing tests must continue to pass")
    lines.push("- Do NOT use bash to write/modify files — use write/edit tools only")
    lines.push("")
    if (parentState.fileAllowlist.length > 0) {
      lines.push("**Approved file allowlist:**")
      for (const f of parentState.fileAllowlist) {
        lines.push(`  - ${f}`)
      }
      lines.push("")
    }
  } else if (parentState.mode === "REFACTOR") {
    lines.push("### Refactor Mode Constraints")
    lines.push("- Follow the target patterns from the conventions document")
    lines.push("- All existing tests must pass after each change")
    lines.push("")
  }

  // Conventions reference
  if (parentState.conventions && parentState.mode !== "GREENFIELD") {
    const conventionsPath = parentState.artifactDiskPaths?.["conventions"]
    lines.push("### Conventions Document")
    lines.push("The following conventions are MANDATORY. Treat them as hard requirements.")
    lines.push("")
    if (conventionsPath && existsSync(conventionsPath)) {
      lines.push(`Read the conventions document at \`${conventionsPath}\` before starting any work.`)
    } else {
      const text = parentState.conventions.length > MAX_CONVENTIONS_CHARS
        ? parentState.conventions.slice(0, MAX_CONVENTIONS_CHARS) + "\n\n[... truncated ...]"
        : parentState.conventions
      lines.push(text)
    }
    lines.push("")
  }

  // Artifact disk paths — so the subagent can reference upstream artifacts
  const pathEntries = Object.entries(parentState.artifactDiskPaths).filter(([, v]) => v)
  if (pathEntries.length > 0) {
    lines.push("### Upstream Artifacts (on disk)")
    lines.push("Reference these approved artifacts while working:")
    lines.push("")
    for (const [key, path] of pathEntries) {
      lines.push(`- **${key}**: \`${path}\``)
    }
    lines.push("")
  }

  // DAG status — full task list with current statuses
  if (parentState.implDag && parentState.implDag.length > 0) {
    const tasks = parentState.implDag
    const complete = tasks.filter((t) => t.status === "complete").length
    const total = tasks.length
    lines.push(`### Implementation DAG (${complete}/${total} complete)`)
    lines.push("")
    lines.push("| Task | Status | Description | Expected Tests |")
    lines.push("|------|--------|-------------|----------------|")
    for (const t of tasks) {
      const statusIcon =
        t.status === "complete" ? "DONE" :
        t.status === "in-flight" ? "IN-FLIGHT" :
        t.status === "aborted" ? "ABORTED" :
        t.status === "delegated" ? "DELEGATED" :
        t.status === "human-gated" ? "HUMAN-GATED" :
        "PENDING"
      const tests = t.expectedTests.length > 0 ? t.expectedTests.join(", ") : "—"
      const desc = t.description.length > 80 ? t.description.slice(0, 77) + "..." : t.description
      lines.push(`| ${t.id} | ${statusIcon} | ${desc} | ${tests} |`)
    }
    lines.push("")
  }

  // Phase-specific instructions (implementation.txt content)
  if (parentState.phase === "IMPLEMENTATION") {
    const promptFile = getPhasePromptFilename(parentState.phase, parentState.mode)
    if (promptFile) {
      lines.push(loadPrompt(promptFile))
      lines.push("")
    }
    const finalImplementationRubric = buildPhaseAcceptanceCriteria(
      "IMPLEMENTATION",
      parentState.mode,
      parentState.artifactDiskPaths?.design ?? null,
    )
    if (finalImplementationRubric) {
      lines.push("### Final Implementation Review Rubric")
      lines.push("Your task contributes to this final scoring gate. Keep this rubric satisfied while implementing.")
      lines.push("")
      lines.push(finalImplementationRubric)
      lines.push("")
    }
  }

  // Tool restrictions
  lines.push("### Subagent Tool Restrictions")
  lines.push("")
  lines.push("You **cannot** call workflow control tools (`mark_task_complete`, `request_review`,")
  lines.push("`submit_feedback`, `select_mode`, `mark_satisfied`, etc.). Only the parent session")
  lines.push("manages workflow state transitions.")
  lines.push("")
  lines.push("You **can** use all other tools (read, write, edit, bash, glob, grep, etc.)")
  lines.push("subject to the mode constraints above.")
  lines.push("")
  lines.push("### Reporting Completion")
  lines.push("")
  lines.push("When you finish your assigned work:")
  lines.push("1. Ensure all relevant tests pass (run them with bash)")
  lines.push("2. Report what you implemented, which files were created/modified, and test results")
  lines.push("3. The parent session will call `mark_task_complete` for each finished task")
  lines.push("")
  lines.push("---")

  return lines.join("\n")
}

function buildSubStateContext(state: WorkflowState, reviewMode: "agent" | "isolated"): string {
  const lines: string[] = ["### Current Action"]

  // Special-case terminal and entry phases before checking phaseState
  if (state.phase === "MODE_SELECT") {
    lines.push("You are at the start of the workflow. Select the appropriate mode:")
    lines.push("")
    lines.push("- **GREENFIELD** — New project from scratch. No discovery phase. Full creative freedom.")
    lines.push("- **REFACTOR** — Existing project where you want to restructure patterns or architecture.")
    lines.push("- **INCREMENTAL** — Existing project where you want to add or fix specific functionality (do-no-harm).")
    lines.push("")
    lines.push("The auto-detection suggestion (if shown above) is advisory — you can override it.")
    lines.push("")
    lines.push("Call `select_mode` with the chosen mode AND a `feature_name`.")
    lines.push("The `feature_name` is **required** — derive a short kebab-case slug from the user's request")
    lines.push("(e.g. 'cloud-cost-platform', 'auth-refactor', 'fix-billing-bug').")
    lines.push("All artifacts will be written to `.openartisan/<feature_name>/`.")
    return lines.join("\n")
  }

  if (state.phase === "DONE") {
    lines.push("The workflow is complete. All phases have been approved and a final git checkpoint has been created.")
    lines.push("You may present a summary of what was built and what decisions were made.")
    return lines.join("\n")
  }

  switch (state.phaseState) {
    case "SCAN":
      lines.push("You are scanning the codebase. Use read-only tools only (glob, grep, read, list).")
      lines.push("Continue immediately in this turn; do not wait for user input.")
      lines.push("When finished, call `mark_scan_complete`.")
      break
    case "ANALYZE":
      lines.push("You are analyzing the scan results. Synthesize your findings.")
      lines.push("Continue immediately in this turn; do not wait for user input.")
      lines.push("When analysis is complete, call `mark_analyze_complete` to transition to CONVENTIONS state.")
      lines.push("Do NOT start drafting until you have called `mark_analyze_complete`.")
      break
    case "CONVENTIONS":
      lines.push("You are drafting the conventions document.")
      lines.push("Continue immediately in this turn; do not wait for user input.")
      lines.push("Write the artifact to `.openartisan/<feature>/conventions.md`, then call `request_review` with `artifact_files` pointing at that file.")
      // Inject discovery fleet report reference if available
      if (state.discoveryReport) {
        lines.push("")
        lines.push("### Discovery Fleet Report")
        lines.push("The following was gathered by parallel scanner subagents. Use it as your primary source for the conventions draft.")
        lines.push("")
        const reportPath = state.artifactDiskPaths?.["discovery_report" as keyof typeof state.artifactDiskPaths]
        if (reportPath && existsSync(reportPath as string)) {
          lines.push(`The discovery fleet report is saved at \`${reportPath}\`.`)
          lines.push("**Read this file now** — it contains the full codebase analysis from all 6 scanner subagents.")
        } else {
          // Fallback: inline for sessions pre-dating disk path tracking
          const report = state.discoveryReport
          lines.push(
            report.length > MAX_REPORT_CHARS
              ? report.slice(0, MAX_REPORT_CHARS) + `\n\n[... discovery report truncated at ${MAX_REPORT_CHARS} chars — the .openartisan/${state.featureName ? state.featureName + "/" : ""}discovery-report.md file contains the full report ...]`
              : report,
          )
        }
      }
      break
    case "DRAFT":
      lines.push(`You are drafting the ${state.phase} artifact.`)
      lines.push("When the draft is complete, call `request_review` with `artifact_files`; legacy `artifact_content` is not accepted. For DISCOVERY, PLANNING, and IMPL_PLAN markdown artifacts only, `artifact_markdown` may be used with `artifact_files: []` to materialize the canonical .openartisan file.")
      lines.push("If you must choose between alternatives, choose one now and record the decision, alternatives, and tradeoffs in the artifact instead of asking the user.")
      lines.push("If this phase is not applicable, submit the appropriate on-disk artifact with a specific pass-through/fast-forward justification so review can approve or reject the skip.")
      lines.push("If you discover a fundamental flaw in an earlier phase's artifact that cannot be addressed here, call `propose_backtrack`.")
      // Layer 4: Inject next task from DAG when in IMPLEMENTATION/DRAFT
      if (state.phase === "IMPLEMENTATION" && !state.implDag) {
        // No DAG available — point the agent to the plan artifacts for context.
        // This happens when IMPL_PLAN was approved without an on-disk task plan
        // (e.g. pass-through in INCREMENTAL mode).
        lines.push("")
        lines.push("**No task DAG available** — implement according to the approved plan.")
        const planPath = state.artifactDiskPaths?.["plan"]
        const implPlanPath = state.artifactDiskPaths?.["impl_plan"]
        if (implPlanPath && existsSync(implPlanPath)) {
          lines.push(`Read the implementation plan at \`${implPlanPath}\` for task details.`)
        } else if (planPath && existsSync(planPath)) {
          lines.push(`Read the plan at \`${planPath}\` for implementation details.`)
        }
        lines.push("Implement all tasks described in the plan, then call `request_review` with `artifact_files` listing changed implementation files.")
      }
      if (state.phase === "IMPLEMENTATION" && state.implDag) {
        try {
          const dag = createImplDAG(Array.from(state.implDag))
          const decision = nextSchedulerDecision(dag)
          if (decision.action === "dispatch") {
            lines.push("")
            lines.push("### Next Implementation Task (from approved DAG)")
            lines.push(decision.prompt)
          } else if (decision.action === "complete") {
            lines.push("")
            lines.push(`**DAG status: All tasks complete.** ${decision.message}`)
            lines.push("Call `request_review` now with `artifact_files` listing changed implementation files to submit the completed implementation for review.")
          } else if (decision.action === "blocked") {
            lines.push("")
            if (decision.blockedTasks.length > 0) {
              // DAG state inconsistency — tasks have unresolvable dependencies
              lines.push("**DAG BLOCKED:** All remaining tasks have incomplete dependencies.")
              lines.push("Call `propose_backtrack` to route the scheduling conflict through a truthful upstream workflow revision.")
            } else {
              // Waiting for active work (in-flight tasks or delegated sub-workflows)
              lines.push(`**Waiting:** ${decision.message}`)
            }
          }
        } catch (err) {
          // Non-fatal — scheduler failure should not block the DRAFT phase
          lines.push("")
          lines.push(`**Warning:** DAG scheduler error — proceed with manual task ordering. (${err instanceof Error ? err.message : String(err)})`)
        }
      }
      break
    case "REDRAFT":
      lines.push(`You are redrafting the ${state.phase} artifact after an approved structural backtrack.`)
      if (state.backtrackContext) {
        lines.push(`Backtrack source: ${state.backtrackContext.sourcePhase} → ${state.backtrackContext.targetPhase}.`)
        lines.push(`Reason: ${state.backtrackContext.reason}`)
      }
      lines.push("When the redraft is complete, call `request_review` with `artifact_files`.")
      break
    case "SKIP_CHECK":
      lines.push("You are in a structural skip-decision state, not ordinary drafting.")
      lines.push("Resolve whether the phase should advance via `phase_skipped` or enter active work via `scheduling_complete`.")
      break
    case "CASCADE_CHECK":
      lines.push("You are in a structural cascade-decision state, not ordinary revision drafting.")
      lines.push("Resolve whether this cascade step should advance via `cascade_step_skipped` or continue into work via `scheduling_complete`.")
      break
    case "SCHEDULING":
      lines.push("You are in IMPLEMENTATION/SCHEDULING. Dispatch and lifecycle coordination are in progress; this is not ordinary authoring.")
      lines.push("The next transition out of this state is `scheduling_complete` once the runnable task or wait condition is established.")
      break
    case "TASK_REVIEW":
      lines.push("You are in IMPLEMENTATION/TASK_REVIEW. The completed task is awaiting isolated review.")
      if (reviewMode === "isolated") {
        lines.push("Do not call `submit_task_review` from the authoring conversation. The adapter/reviewer runtime will request isolated review context and submit the result.")
      } else {
        lines.push("Call `submit_task_review` with the isolated review result to advance the lifecycle.")
      }
      break
    case "TASK_REVISE":
      lines.push("You are in IMPLEMENTATION/TASK_REVISE. Apply targeted repair for the current task only.")
      lines.push("When the repair is complete, return with `revision_complete` into task review.")
      break
    case "HUMAN_GATE":
      lines.push("You are in IMPLEMENTATION/HUMAN_GATE. Manual action is required before the workflow can continue.")
      lines.push("This is not a generic approval gate and should not be handled through ordinary approval routing.")
      break
    case "DELEGATED_WAIT":
      lines.push("You are in IMPLEMENTATION/DELEGATED_WAIT. Progress depends on a delegated sub-workflow completing.")
      lines.push("Resume only after `delegated_task_completed` returns control to scheduling.")
      break
    case "REVIEW":
      if (reviewMode === "isolated") {
        lines.push("Isolated phase review is in progress.")
        lines.push("Do not call `mark_satisfied` from the authoring conversation. The isolated reviewer evaluates the criteria and submits the review result.")
        lines.push("Wait for the reviewer/adapter runtime to advance the workflow. If review returns revisions, address them in REVISE.")
      } else {
        lines.push("Self-review is in progress.")
        lines.push("Read the acceptance criteria for this phase (listed below) and evaluate each one independently.")
        lines.push("Do NOT assume quality — read the actual files you produced and verify each criterion.")
        lines.push("When evaluation is complete, call `mark_satisfied` with your per-criterion assessment.")
        lines.push("If any blocking criterion is not met, address it first, then call `mark_satisfied` again.")
        lines.push("If a blocking issue is caused by an upstream artifact (e.g. plan, interfaces, conventions),")
        lines.push("note it in the evidence and mark it unmet — it will escalate to the user after repeated failures.")
      }
      // Remind the agent where the artifact lives so it can verify claims
      {
        const artifactKey = state.phase === "DISCOVERY" ? "conventions"
          : state.phase === "PLANNING" ? "plan"
          : state.phase === "IMPL_PLAN" ? "impl-plan"
          : null
        const diskPath = artifactKey ? state.artifactDiskPaths?.[artifactKey as keyof typeof state.artifactDiskPaths] : null
        if (diskPath && existsSync(diskPath as string)) {
          lines.push("")
          if (reviewMode === "isolated") {
            lines.push(`**Artifact location:** \`${diskPath}\` — the isolated reviewer reads this file directly.`)
          } else {
            lines.push(`**Artifact location:** \`${diskPath}\` — read this file to verify your criteria assessments.`)
            lines.push("Do NOT pass artifact text to `mark_satisfied` — the reviewer reads the file directly.")
          }
        }
      }
      break
    case "ESCAPE_HATCH":
      lines.push("**ESCAPE HATCH ACTIVE** — A strategic change was detected.")
      lines.push("The escape hatch presentation has been shown to the user.")
      lines.push("**MANDATORY:** Call `submit_feedback` as your FIRST and ONLY tool call with the user's response.")
      lines.push("The user's response is one of: `accept`, a description of alternative direction, or `abort`.")
      lines.push("Do NOT perform any research, analysis, or other tool calls before calling `submit_feedback`.")
      lines.push("Do NOT proceed with any work until the escape hatch is resolved.")
      break
    case "USER_GATE":
      {
        lines.push("The artifact is awaiting user approval.")
        lines.push("")
        lines.push("**MANDATORY PROTOCOL — READ CAREFULLY:**")
        lines.push("1. If the user's message is artifact feedback (approval, revision requests, or comments about the artifact):")
        lines.push("   a. Your FIRST and ONLY tool call must be `submit_feedback`.")
        lines.push("   b. Do NOT do research, searches, analysis, or any other tool calls first.")
        lines.push("   c. Do NOT rewrite, improve, or re-review the artifact before routing the feedback.")
        lines.push("   d. If the user approves → call `submit_feedback(feedback_type='approve', ...)`.")
        lines.push("   e. If the user requests changes → call `submit_feedback(feedback_type='revise', ...)`.")
        lines.push("   f. Capture the user's message verbatim in `feedback_text`.")
        lines.push("2. If the user's message is casual conversation, a status question, a dogfood/experience question, or meta-discussion NOT requesting artifact changes:")
        lines.push("   Simply respond conversationally. Do NOT call `submit_feedback`. The user can chat with you without every message being treated as artifact feedback.")
        lines.push("   Examples: asking whether tasks are complete, asking how Open Artisan felt, discussing the project generally, asking clarifying questions.")
        lines.push("3. When presenting the artifact for approval, summarize any decisions you made under uncertainty, the alternatives considered, and their tradeoffs/risks.")
        lines.push("")
        lines.push("Routing non-feedback messages through `submit_feedback` corrupts the workflow state.")
      }
      break
    case "REVISE":
      lines.push("You are in REVISE state. Apply the feedback and call `request_review` with `artifact_files` — no check-ins needed.")
      lines.push("")
      lines.push("**MANDATORY PROTOCOL — REVISE IS AUTONOMOUS:**")
      lines.push("1. Apply ALL recorded feedback points for the current artifact.")
      lines.push("2. Make targeted, incremental changes only. Do NOT rewrite from scratch.")
      lines.push("3. Preserve all prior approved decisions. Only change what the feedback specifically addresses.")
      lines.push("4. If the feedback leaves multiple viable fixes, choose the best one, document the decision plus alternatives/tradeoffs in the artifact, and continue.")
      lines.push("5. When ALL changes are made, call `request_review` with `artifact_files` pointing at the revised files on disk.")
      lines.push("6. Do NOT ask the user for confirmation before calling `request_review`.")
      lines.push("7. Do NOT ask 'Shall I proceed?' or 'Ready to review?' — just call `request_review`.")
      lines.push("8. Do NOT present a summary and wait — finish the work and call the tool.")
      lines.push("")
      lines.push("The next human interaction point is USER_GATE after review passes. Until then, proceed autonomously.")
      lines.push("If the revision reveals a fundamental upstream problem, call `propose_backtrack` instead of trying to fix it in-place.")
      break
  }

  return lines.join("\n")
}
