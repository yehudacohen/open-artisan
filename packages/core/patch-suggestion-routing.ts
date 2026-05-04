/**
 * patch-suggestion-routing.ts — Runtime routing for persisted reviewer patch suggestions.
 */

import type { DbPatchSuggestion } from "./open-artisan-repository"
import type { WorkflowState } from "./types"

export type PatchSuggestionRoute = "apply-current-task" | "defer-downstream" | "backtrack" | "ask-user"

export interface RoutedPatchSuggestion {
  suggestion: DbPatchSuggestion
  route: PatchSuggestionRoute
  reason: string
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

function pathMatches(left: string, right: string): boolean {
  const a = normalize(left)
  const b = normalize(right)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

function includesPath(paths: string[], targetPath: string): boolean {
  return paths.some((path) => pathMatches(path, targetPath))
}

export function routePatchSuggestion(state: WorkflowState, suggestion: DbPatchSuggestion): RoutedPatchSuggestion {
  const targetPath = normalize(suggestion.targetPath)
  const currentTask = state.currentTaskId
    ? state.implDag?.find((task) => task.id === state.currentTaskId)
    : null
  const owner = state.implDag?.find((task) => includesPath(task.expectedFiles, targetPath)) ?? null
  const allowlisted = state.mode !== "INCREMENTAL" || state.fileAllowlist.length === 0 || includesPath(state.fileAllowlist, targetPath)

  if (!allowlisted) {
    return {
      suggestion,
      route: "ask-user",
      reason: `Target path ${targetPath} is outside the approved incremental allowlist.`,
    }
  }

  if (currentTask && includesPath(currentTask.expectedFiles, targetPath)) {
    return {
      suggestion,
      route: "apply-current-task",
      reason: `Target path ${targetPath} belongs to the current task ${currentTask.id}.`,
    }
  }

  if (owner && owner.status !== "complete") {
    return {
      suggestion,
      route: "defer-downstream",
      reason: `Target path ${targetPath} is owned by pending task ${owner.id}.`,
    }
  }

  if (owner && owner.status === "complete") {
    return {
      suggestion,
      route: "backtrack",
      reason: `Target path ${targetPath} belongs to already-complete task ${owner.id}; applying it requires resetting that boundary.`,
    }
  }

  return {
    suggestion,
    route: state.phase === "IMPLEMENTATION" ? "ask-user" : "backtrack",
    reason: `No current DAG task owns ${targetPath}; user or upstream artifact direction is needed before applying it.`,
  }
}

export function routePatchSuggestions(state: WorkflowState, suggestions: DbPatchSuggestion[]): RoutedPatchSuggestion[] {
  return suggestions.map((suggestion) => routePatchSuggestion(state, suggestion))
}
