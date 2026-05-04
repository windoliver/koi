/**
 * Unit tests for createContextEngineProvider — L1 ECS slot wiring (issue #1767).
 */

import { describe, expect, test } from "bun:test";
import type { Agent, ContextEngine } from "@koi/core";
import { CONTEXT_ENGINE } from "@koi/core/context-engine";
import { createContextEngineProvider } from "./context-engine-provider.js";

const stubEngine: ContextEngine = {
  identity: { name: "@test/stub-engine", version: "0.0.1" },
  prepare: (_ctx, msgs) => msgs,
};

describe("createContextEngineProvider", () => {
  test("returns a provider with the conventional name", () => {
    const provider = createContextEngineProvider(stubEngine);
    expect(provider.name).toBe("context-engine");
  });

  test("attach maps the engine onto the CONTEXT_ENGINE token key", async () => {
    const provider = createContextEngineProvider(stubEngine);
    const components = await provider.attach({} as Agent);
    const map = "components" in components ? components.components : components;
    expect(map.get(CONTEXT_ENGINE as string)).toBe(stubEngine);
  });

  test("uses BUNDLED priority by default so user providers can override", async () => {
    const provider = createContextEngineProvider(stubEngine);
    expect(provider.priority).toBeGreaterThan(0);
  });

  test("priority override is honored", () => {
    const provider = createContextEngineProvider(stubEngine, { priority: 0 });
    expect(provider.priority).toBe(0);
  });

  test("two providers with different engines remain distinguishable", async () => {
    const a: ContextEngine = { ...stubEngine, identity: { name: "a", version: "1" } };
    const b: ContextEngine = { ...stubEngine, identity: { name: "b", version: "1" } };
    const pa = createContextEngineProvider(a);
    const pb = createContextEngineProvider(b);
    const ma = await pa.attach({} as Agent);
    const mb = await pb.attach({} as Agent);
    const mapA = "components" in ma ? ma.components : ma;
    const mapB = "components" in mb ? mb.components : mb;
    expect((mapA.get(CONTEXT_ENGINE as string) as ContextEngine).identity.name).toBe("a");
    expect((mapB.get(CONTEXT_ENGINE as string) as ContextEngine).identity.name).toBe("b");
  });
});
