/**
 * Tests for SessionRegistry — session lifecycle and parent-child tracking.
 */
import { describe, expect, it, beforeEach } from "bun:test"
import { createSessionRegistry } from "#core/session-registry"
import type { SessionRegistry } from "#core/session-registry-types"

let registry: SessionRegistry

beforeEach(() => {
  registry = createSessionRegistry()
})

describe("SessionRegistry — primary sessions", () => {
  it("registers a primary session", () => {
    registry.registerPrimary("s1")
    expect(registry.count()).toBe(1)
  })

  it("registering the same primary session twice is idempotent", () => {
    registry.registerPrimary("s1")
    registry.registerPrimary("s1")
    expect(registry.count()).toBe(1)
  })

  it("unregisters a primary session", () => {
    registry.registerPrimary("s1")
    registry.unregister("s1")
    expect(registry.count()).toBe(0)
  })

  it("unregister is no-op for unknown session", () => {
    registry.unregister("nonexistent")
    expect(registry.count()).toBe(0)
  })

  it("primary session is not a child", () => {
    registry.registerPrimary("s1")
    expect(registry.isChild("s1")).toBe(false)
    expect(registry.getParent("s1")).toBeNull()
  })
})

describe("SessionRegistry — child sessions", () => {
  it("registers a child session with parent", () => {
    registry.registerPrimary("parent")
    registry.registerChild("child", "parent")
    expect(registry.count()).toBe(2)
    expect(registry.isChild("child")).toBe(true)
    expect(registry.getParent("child")).toBe("parent")
  })

  it("unregisters a child session", () => {
    registry.registerChild("child", "parent")
    registry.unregister("child")
    expect(registry.isChild("child")).toBe(false)
    expect(registry.getParent("child")).toBeNull()
    expect(registry.count()).toBe(0)
  })

  it("getParent returns null for primary sessions", () => {
    registry.registerPrimary("s1")
    expect(registry.getParent("s1")).toBeNull()
  })

  it("getParent returns null for unknown sessions", () => {
    expect(registry.getParent("unknown")).toBeNull()
  })

  it("isChild returns false for unknown sessions", () => {
    expect(registry.isChild("unknown")).toBe(false)
  })
})

describe("SessionRegistry — active session tracking", () => {
  it("getActiveId returns undefined initially", () => {
    expect(registry.getActiveId()).toBeUndefined()
  })

  it("setActive tracks the most recently active session", () => {
    registry.registerPrimary("s1")
    registry.registerPrimary("s2")
    registry.setActive("s1")
    expect(registry.getActiveId()).toBe("s1")
    registry.setActive("s2")
    expect(registry.getActiveId()).toBe("s2")
  })

  it("unregistering the active session clears activeId", () => {
    registry.registerPrimary("s1")
    registry.setActive("s1")
    registry.unregister("s1")
    expect(registry.getActiveId()).toBeUndefined()
  })

  it("unregistering a non-active session does not clear activeId", () => {
    registry.registerPrimary("s1")
    registry.registerPrimary("s2")
    registry.setActive("s1")
    registry.unregister("s2")
    expect(registry.getActiveId()).toBe("s1")
  })
})

describe("SessionRegistry — count", () => {
  it("counts primary and child sessions separately", () => {
    registry.registerPrimary("p1")
    registry.registerPrimary("p2")
    registry.registerChild("c1", "p1")
    expect(registry.count()).toBe(3)
  })

  it("count decreases on unregister", () => {
    registry.registerPrimary("p1")
    registry.registerChild("c1", "p1")
    expect(registry.count()).toBe(2)
    registry.unregister("c1")
    expect(registry.count()).toBe(1)
    registry.unregister("p1")
    expect(registry.count()).toBe(0)
  })
})
