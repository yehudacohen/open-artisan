/**
 * Tests for the artifact dependency graph.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createArtifactGraph } from "#core/artifacts"
import { detectDesignDoc } from "#core/artifact-store"
import type { ArtifactGraph } from "#core/types"

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

  it("dependents are in topological order: interfaces before tests before impl_plan before implementation", () => {
    const dependents = graph.getDependents("plan", "GREENFIELD")
    const idxInterfaces = dependents.indexOf("interfaces")
    const idxTests = dependents.indexOf("tests")
    const idxImplPlan = dependents.indexOf("impl_plan")
    const idxImpl = dependents.indexOf("implementation")
    expect(idxInterfaces).toBeLessThan(idxTests)
    expect(idxTests).toBeLessThan(idxImplPlan)
    expect(idxImplPlan).toBeLessThan(idxImpl)
  })

  it("tests dependents are in topological order: impl_plan before implementation", () => {
    const dependents = graph.getDependents("tests", "GREENFIELD")
    expect(dependents).toContain("impl_plan")
    expect(dependents).toContain("implementation")
    const idxImplPlan = dependents.indexOf("impl_plan")
    const idxImpl = dependents.indexOf("implementation")
    expect(idxImplPlan).toBeLessThan(idxImpl)
  })

  it("conventions change cascades to all 5 downstream artifacts in REFACTOR mode", () => {
    const dependents = graph.getDependents("conventions", "REFACTOR")
    expect(dependents).toContain("plan")
    expect(dependents).toContain("interfaces")
    expect(dependents).toContain("tests")
    expect(dependents).toContain("impl_plan")
    expect(dependents).toContain("implementation")
    expect(dependents).toHaveLength(5)
  })

  it("conventions is excluded from getDependents results in GREENFIELD mode", () => {
    // In GREENFIELD, conventions is not used — getDependents of any artifact should not include it
    const dependents = graph.getDependents("plan", "GREENFIELD")
    expect(dependents).not.toContain("conventions")
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

// ---------------------------------------------------------------------------
// Design artifact graph edges
// ---------------------------------------------------------------------------
describe("ArtifactGraph — design artifact edges", () => {
  it("createArtifactGraph(false): plan does NOT depend on design", () => {
    const g = createArtifactGraph(false)
    const deps = g.getDependencies("plan", "GREENFIELD")
    expect(deps).not.toContain("design")
  })

  it("createArtifactGraph(true): plan depends on design", () => {
    const g = createArtifactGraph(true)
    const deps = g.getDependencies("plan", "GREENFIELD")
    expect(deps).toContain("design")
  })

  it("createArtifactGraph(true): design has no dependencies (empty array)", () => {
    const g = createArtifactGraph(true)
    const deps = g.getDependencies("design", "GREENFIELD")
    expect(deps).toHaveLength(0)
  })

  it("createArtifactGraph(true): changing design cascades to plan and all downstream", () => {
    const g = createArtifactGraph(true)
    const dependents = g.getDependents("design", "GREENFIELD")
    expect(dependents).toContain("plan")
    expect(dependents).toContain("interfaces")
    expect(dependents).toContain("tests")
    expect(dependents).toContain("impl_plan")
    expect(dependents).toContain("implementation")
  })

  it("createArtifactGraph(true): design is NOT in getDependents('plan', ...) — design is upstream, not downstream", () => {
    const g = createArtifactGraph(true)
    const dependents = g.getDependents("plan", "GREENFIELD")
    expect(dependents).not.toContain("design")
  })
})

// ---------------------------------------------------------------------------
// detectDesignDoc
// ---------------------------------------------------------------------------

describe("detectDesignDoc", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dd-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns null when no design doc exists", () => {
    expect(detectDesignDoc(tmpDir)).toBeNull()
  })

  it("returns path when docs/design.md exists", async () => {
    const docsDir = join(tmpDir, "docs")
    await mkdir(docsDir, { recursive: true })
    await writeFile(join(docsDir, "design.md"), "# Design")
    const result = detectDesignDoc(tmpDir)
    expect(result).not.toBeNull()
    expect(result).toBe(join(docsDir, "design.md"))
  })

  it("returns feature-scoped path when .openartisan/<feature>/design.md exists", async () => {
    const featureDir = join(tmpDir, ".openartisan", "my-feature")
    await mkdir(featureDir, { recursive: true })
    await writeFile(join(featureDir, "design.md"), "# Feature Design")
    const result = detectDesignDoc(tmpDir, "my-feature")
    expect(result).not.toBeNull()
    expect(result).toBe(join(featureDir, "design.md"))
  })

  it("prefers feature-scoped path over docs/design.md", async () => {
    // Create both paths
    const docsDir = join(tmpDir, "docs")
    await mkdir(docsDir, { recursive: true })
    await writeFile(join(docsDir, "design.md"), "# Docs Design")

    const featureDir = join(tmpDir, ".openartisan", "my-feature")
    await mkdir(featureDir, { recursive: true })
    await writeFile(join(featureDir, "design.md"), "# Feature Design")

    const result = detectDesignDoc(tmpDir, "my-feature")
    expect(result).toBe(join(featureDir, "design.md"))
  })

  it("returns path for DESIGN.md at root", async () => {
    await writeFile(join(tmpDir, "DESIGN.md"), "# Root Design")
    const result = detectDesignDoc(tmpDir)
    expect(result).not.toBeNull()
    expect(result).toBe(join(tmpDir, "DESIGN.md"))
  })
})
