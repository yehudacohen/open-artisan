/**
 * artifacts.ts — Artifact dependency graph. Pure logic, no side effects.
 *
 * The full DAG:
 *
 *   design (optional) ──→ plan
 *   conventions ──→ plan ──→ interfaces ──→ tests ──→ impl_plan ──→ implementation
 *         │                      ↑              │         ↑               ↑
 *         └──────────────────────┘              └─────────┘               │
 *                                                                         │
 *                          plan ──────────────────────────────────────────┘
 *                          interfaces ────────────────────────────────────┘
 *
 * In plain terms:
 *   design       → plan (optional — only when a user-authored design doc exists)
 *   conventions  → plan, interfaces
 *   plan         → interfaces, impl_plan, implementation
 *   interfaces   → tests, impl_plan, implementation
 *   tests        → impl_plan, implementation
 *   impl_plan    → implementation
 *   implementation → (none)
 *
 * The "design" artifact is a user-authored pre-existing document. It does not have
 * an owning Phase (no DESIGN phase exists). When present, it is an upstream dependency
 * of "plan", meaning changes to the design doc cascade through the full dependency chain.
 * When absent, the graph behaves exactly as before.
 */
import type {
  ArtifactKey,
  ArtifactGraph,
  Phase,
  WorkflowMode,
} from "./types"

// ---------------------------------------------------------------------------
// Static dependency graph
// ---------------------------------------------------------------------------

// Direct upstream dependencies for each artifact
// (inverse of "what does X depend on?")
// NOTE: "design" depends on "plan" conditionally — only when a design doc exists.
// The dependency is injected at runtime by getDependencies/getAllDependents based
// on the `hasDesignDoc` parameter, not hardcoded here.
const DEPENDENCIES_MAP: Record<ArtifactKey, ArtifactKey[]> = {
  design:         [],
  conventions:    [],
  plan:           ["conventions"],
  interfaces:     ["conventions", "plan"],
  tests:          ["interfaces"],
  impl_plan:      ["plan", "interfaces", "tests"],
  implementation: ["plan", "impl_plan", "interfaces", "tests"],
}

// Phase → ArtifactKey mapping (inverse of OWNING_PHASE). Single source of truth
// used by index.ts (approval hashing) and route.ts (orchestrator routing).
export const PHASE_TO_ARTIFACT: Partial<Record<Phase, ArtifactKey>> = {
  DISCOVERY:      "conventions",
  PLANNING:       "plan",
  INTERFACES:     "interfaces",
  TESTS:          "tests",
  IMPL_PLAN:      "impl_plan",
  IMPLEMENTATION: "implementation",
}

// Owning phase per artifact. "design" has no owning phase — it is a user-authored
// pre-existing input, not produced by any workflow phase. We use a Partial<Record>
// and handle the missing mapping explicitly in getOwningPhase/getReviseTarget.
const OWNING_PHASE: Partial<Record<ArtifactKey, Phase>> = {
  conventions: "DISCOVERY",
  plan: "PLANNING",
  interfaces: "INTERFACES",
  tests: "TESTS",
  impl_plan: "IMPL_PLAN",
  implementation: "IMPLEMENTATION",
}

// ---------------------------------------------------------------------------
// Topological traversal helpers
// ---------------------------------------------------------------------------

// Canonical artifact order — used for deterministic topological sort tie-breaking
const ARTIFACT_TOPO_ORDER: ArtifactKey[] = [
  "design", "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation",
]

/**
 * Returns all artifacts that transitively depend on the given artifact
 * (i.e., all downstream dependents), in topological order (nearest first,
 * deterministic tie-breaking by ARTIFACT_TOPO_ORDER).
 *
 * Algorithm:
 *  1. Build the forward adjacency (upstream → direct dependents) by inverting DEPENDENCIES_MAP.
 *  2. Collect the reachable subgraph via BFS from `artifact`.
 *  3. Run Kahn's topological sort over the reachable subgraph, treating `artifact` as a
 *     virtual source whose edges have already been "consumed" (i.e., nodes that depend only
 *     on `artifact` start with in-degree 0 inside the subgraph).
 */
function getAllDependents(artifact: ArtifactKey, mode: WorkflowMode, hasDesignDoc = false): ArtifactKey[] {
  // Step 1: build forward adjacency (upstream → list of direct dependents)
  // by iterating DEPENDENCIES_MAP keys explicitly to avoid type-cast issues
  const forwardAdj = new Map<ArtifactKey, ArtifactKey[]>()
  const allKeys = Object.keys(DEPENDENCIES_MAP) as ArtifactKey[]
  for (const downstream of allKeys) {
    const upstreams: ArtifactKey[] = DEPENDENCIES_MAP[downstream]
    for (const upstream of upstreams) {
      let list = forwardAdj.get(upstream)
      if (!list) { list = []; forwardAdj.set(upstream, list) }
      list.push(downstream)
    }
  }

  // Inject design → plan edge if a design doc exists
  if (hasDesignDoc) {
    const planDeps = forwardAdj.get("design") ?? []
    if (!planDeps.includes("plan")) planDeps.push("plan")
    forwardAdj.set("design", planDeps)
  }

  // Step 2: collect reachable descendants via BFS (excludes `artifact` itself)
  const reachable = new Set<ArtifactKey>()
  const bfsQueue: ArtifactKey[] = [...(forwardAdj.get(artifact) ?? [])]
  while (bfsQueue.length > 0) {
    const node = bfsQueue.shift()!
    if (reachable.has(node)) continue
    if (mode === "GREENFIELD" && node === "conventions") continue
    reachable.add(node)
    const children = forwardAdj.get(node) ?? []
    for (const child of children) {
      if (!reachable.has(child)) bfsQueue.push(child)
    }
  }

  if (reachable.size === 0) return []

  // Step 3: Kahn's topological sort over the reachable subgraph.
  // In-degree counts only edges where the upstream is the root `artifact` or in `reachable`.
  const inDegree = new Map<ArtifactKey, number>()
  for (const node of reachable) inDegree.set(node, 0)

  // In-degree counts only edges between nodes WITHIN the reachable subgraph.
  // The root `artifact` is treated as already emitted — its outgoing edges are
  // NOT counted, so nodes that depend only on the root start with in-degree 0.
  for (const node of reachable) {
    const upstreams: ArtifactKey[] = DEPENDENCIES_MAP[node]
    for (const upstream of upstreams) {
      if (mode === "GREENFIELD" && upstream === "conventions") continue
      // Only count edges from within the reachable subgraph (NOT from the root)
      if (reachable.has(upstream)) {
        inDegree.set(node, (inDegree.get(node) ?? 0) + 1)
      }
      // If upstream === artifact (root): don't count — root is treated as consumed
    }
  }

  // Repeatedly emit zero-in-degree nodes in canonical order for determinism
  const result: ArtifactKey[] = []
  while (true) {
    const ready: ArtifactKey[] = []
    for (const [node, deg] of inDegree) {
      if (deg === 0) ready.push(node)
    }
    if (ready.length === 0) break
    ready.sort((a, b) => ARTIFACT_TOPO_ORDER.indexOf(a) - ARTIFACT_TOPO_ORDER.indexOf(b))
    for (const node of ready) {
      inDegree.delete(node)
      result.push(node)
      const children = forwardAdj.get(node) ?? []
      for (const child of children) {
        const cur = inDegree.get(child)
        if (cur !== undefined) inDegree.set(child, cur - 1)
      }
    }
  }

  return result
}

function getDirectDependencies(artifact: ArtifactKey, mode: WorkflowMode, hasDesignDoc = false): ArtifactKey[] {
  const deps: ArtifactKey[] = [...(DEPENDENCIES_MAP[artifact] ?? [])]
  // Inject design as an upstream dependency of plan when a design doc exists
  if (hasDesignDoc && artifact === "plan" && !deps.includes("design")) {
    deps.unshift("design")
  }
  return deps.filter((dep) => !(mode === "GREENFIELD" && dep === "conventions"))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the artifact dependency graph.
 *
 * @param hasDesignDoc If true, "design" is injected as an upstream dependency of
 *   "plan". This makes plan-level acceptance criteria include design invariant
 *   compliance, and orchestrator cascades flow through the design doc.
 *   Default: false (backward compatible — graph behaves as before).
 */
export function createArtifactGraph(hasDesignDoc = false): ArtifactGraph {
  return {
    getDependents(artifact: ArtifactKey, mode: WorkflowMode): ArtifactKey[] {
      return getAllDependents(artifact, mode, hasDesignDoc)
    },

    getDependencies(artifact: ArtifactKey, mode: WorkflowMode): ArtifactKey[] {
      return getDirectDependencies(artifact, mode, hasDesignDoc)
    },

    getOwningPhase(artifact: ArtifactKey): Phase {
      const phase = OWNING_PHASE[artifact]
      if (!phase) {
        // "design" has no owning phase — it's user-authored, not produced by the workflow.
        // Callers should not be asking for the owning phase of "design" directly.
        throw new Error(`Artifact "${artifact}" has no owning phase — it is a pre-existing input, not produced by any workflow phase`)
      }
      return phase
    },

    getReviseTarget(artifact: ArtifactKey): { phase: Phase; phaseState: "REVISE" } {
      // Design doc cascades route to PLANNING — the plan is the nearest agent-controlled
      // artifact that depends on the design doc. If the design doc changes, the plan
      // needs revision to re-align with the new design.
      if (artifact === "design") {
        return { phase: "PLANNING", phaseState: "REVISE" }
      }
      const phase = OWNING_PHASE[artifact]
      if (!phase) {
        throw new Error(`Artifact "${artifact}" has no owning phase — cannot determine revise target`)
      }
      return { phase, phaseState: "REVISE" }
    },
  }
}
