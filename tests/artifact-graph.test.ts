/**
 * Tests for the artifact dependency graph.
 */
import { describe, expect, it, beforeEach } from "bun:test"

import { createArtifactGraph } from "#plugin/artifacts"
import type { ArtifactGraph } from "#plugin/types"

let graph: ArtifactGraph

beforeEach(() => {
  graph = createArtifactGraph()
})

describe("ArtifactGraph — dependency direction", () => {
  it("plan depends on conventions in REFACTOR mode", () => {
    const deps = graph.getDependencies("plan", "REFACTOR")
    expect(deps).toContain("conventions")
  })

  it("plan has no dependency on conventions in GREENFIELD mode", () => {
    const deps = graph.getDependencies("plan", "GREENFIELD")
    expect(deps).not.toContain("conventions")
  })

  it("interfaces depends on plan", () => {
    const deps = graph.getDependencies("interfaces", "GREENFIELD")
    expect(deps).toContain("plan")
  })

  it("tests depends on interfaces", () => {
    const deps = graph.getDependencies("tests", "GREENFIELD")
    expect(deps).toContain("interfaces")
  })

  it("impl_plan depends on tests", () => {
    const deps = graph.getDependencies("impl_plan", "GREENFIELD")
    expect(deps).toContain("tests")
  })

  it("implementation depends on impl_plan", () => {
    const deps = graph.getDependencies("implementation", "GREENFIELD")
    expect(deps).toContain("impl_plan")
  })
})

describe("ArtifactGraph — transitive dependents", () => {
  it("plan change cascades to interfaces, tests, impl_plan, implementation", () => {
    const dependents = graph.getDependents("plan", "GREENFIELD")
    expect(dependents).toContain("interfaces")
    expect(dependents).toContain("tests")
    expect(dependents).toContain("impl_plan")
    expect(dependents).toContain("implementation")
  })

  it("interfaces change cascades to tests, impl_plan, implementation but not plan", () => {
    const dependents = graph.getDependents("interfaces", "GREENFIELD")
    expect(dependents).toContain("tests")
    expect(dependents).toContain("impl_plan")
    expect(dependents).toContain("implementation")
    expect(dependents).not.toContain("plan")
  })

  it("implementation has no dependents", () => {
    const dependents = graph.getDependents("implementation", "GREENFIELD")
    expect(dependents).toHaveLength(0)
  })

  it("dependents are in topological order: interfaces before tests before impl_plan", () => {
    const dependents = graph.getDependents("plan", "GREENFIELD")
    const idxInterfaces = dependents.indexOf("interfaces")
    const idxTests = dependents.indexOf("tests")
    const idxImplPlan = dependents.indexOf("impl_plan")
    expect(idxInterfaces).toBeLessThan(idxTests)
    expect(idxTests).toBeLessThan(idxImplPlan)
  })
})

describe("ArtifactGraph — owning phase", () => {
  it("conventions → DISCOVERY", () => {
    expect(graph.getOwningPhase("conventions")).toBe("DISCOVERY")
  })

  it("plan → PLANNING", () => {
    expect(graph.getOwningPhase("plan")).toBe("PLANNING")
  })

  it("interfaces → INTERFACES", () => {
    expect(graph.getOwningPhase("interfaces")).toBe("INTERFACES")
  })

  it("tests → TESTS", () => {
    expect(graph.getOwningPhase("tests")).toBe("TESTS")
  })

  it("impl_plan → IMPL_PLAN", () => {
    expect(graph.getOwningPhase("impl_plan")).toBe("IMPL_PLAN")
  })

  it("implementation → IMPLEMENTATION", () => {
    expect(graph.getOwningPhase("implementation")).toBe("IMPLEMENTATION")
  })
})

describe("ArtifactGraph — revise target", () => {
  it("getReviseTarget always returns phaseState REVISE", () => {
    const artifacts = ["conventions", "plan", "interfaces", "tests", "impl_plan", "implementation"] as const
    for (const a of artifacts) {
      const t = graph.getReviseTarget(a)
      expect(t.phaseState).toBe("REVISE")
    }
  })

  it("getReviseTarget for plan returns PLANNING/REVISE", () => {
    const t = graph.getReviseTarget("plan")
    expect(t.phase).toBe("PLANNING")
    expect(t.phaseState).toBe("REVISE")
  })
})
