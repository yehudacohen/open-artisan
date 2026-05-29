import type { WorkflowState } from "./workflow-state-types"

function unresolvedHumanGateIds(state: WorkflowState): string[] {
  return (state.implDag ?? [])
    .filter((task) => task.status === "human-gated" && (!task.humanGate || !task.humanGate.resolved))
    .map((task) => task.id)
}

function questionToolPreamble(): string {
  return (
    "If the runtime exposes the `question` tool, prefer a structured multiple-choice gate instead of asking for free-form approval. " +
    "If `question` is unavailable, present the same choices in chat and wait for the user."
  )
}

export function buildUserGateChoiceInstruction(state: WorkflowState): string | null {
  if (state.phaseState === "USER_GATE") {
    return [
      "### Structured User Gate",
      questionToolPreamble(),
      "Ask one single-choice question with these labels exactly: `approve`, `revise`, `status question`.",
      "Use `custom: true` so the user can type detailed revision feedback or a clarification.",
      "After the answer: `approve` means call `submit_feedback(feedback_type=\"approve\")`; substantive custom feedback or `revise` with details means call `submit_feedback(feedback_type=\"revise\")`; `status question` or a clarification means answer normally and keep waiting at the gate.",
      "Do not call `submit_feedback` for `revise` if the user gave no actual change request; ask for the requested changes instead.",
    ].join("\n")
  }

  if (state.phaseState === "HUMAN_GATE") {
    const ids = unresolvedHumanGateIds(state)
    const idText = ids.length > 0 ? ` Unresolved human-gated task IDs: ${ids.join(", ")}.` : ""
    return [
      "### Structured Human Gate",
      questionToolPreamble(),
      `${idText} Ask one single-choice question with these labels exactly: \`resolved\`, \`backtrack\`, \`status question\`.`,
      "Use `custom: true` so the user can name resolved task IDs, describe a plan/design reroute, or ask a clarification.",
      "After the answer: `resolved` means resolve only the task IDs the user clearly confirmed; `backtrack` or substantive custom reroute feedback means call `propose_backtrack`; `status question` or a clarification means answer normally and keep waiting at the gate.",
      "Do not resolve all human gates from an ambiguous answer when multiple gates are listed; ask which task IDs were completed.",
    ].join("\n")
  }

  if (state.phaseState === "ESCAPE_HATCH") {
    return [
      "### Structured Escape Hatch Gate",
      questionToolPreamble(),
      "Ask one single-choice question with these labels exactly: `accept`, `new direction`, `abort`, `status question`.",
      "Use `custom: true` so the user can describe an alternative direction.",
      "After the answer: `accept`, `new direction` with details, or `abort` must be routed through `submit_feedback(feedback_type=\"revise\")`; `status question` or a clarification means answer normally and keep waiting at the escape hatch.",
    ].join("\n")
  }

  return null
}

export function buildUserGateChoiceToolReminder(): string {
  return (
    "Advancing to USER_GATE. Present a concise review summary, then prefer the " +
    "`question` tool with choices `approve`, `revise`, and `status question` when available. " +
    "Use plain chat fallback only when structured questions are unavailable."
  )
}
