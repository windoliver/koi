import { describe, expect, test } from "bun:test";
import { createContributionBuilder } from "./contribution-graph.js";

describe("createContributionBuilder", () => {
  test("builds graph with stacks and packages", () => {
    const builder = createContributionBuilder();
    builder.addStack("nexus", "Nexus", "runtime", true, [
      { id: "@koi/nexus", kind: "middleware", source: "static", middlewareNames: ["auth"] },
    ]);
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(1);
    expect(graph.stacks[0]?.packages[0]?.middlewareNames).toEqual(["auth"]);
    expect(typeof graph.generatedAt).toBe("number");
  });

  test("handles stacks with no packages", () => {
    const builder = createContributionBuilder();
    builder.addStack("empty", "Empty Stack", "runtime", true, []);
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(1);
    expect(graph.stacks[0]?.packages).toHaveLength(0);
  });

  test("handles disabled stacks", () => {
    const builder = createContributionBuilder();
    builder.addStack("disabled", "Disabled Stack", "operator", false, [
      { id: "@koi/something", kind: "provider", source: "static" },
    ]);
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(1);
    expect(graph.stacks[0]?.enabled).toBe(false);
    expect(graph.stacks[0]?.source).toBe("operator");
  });

  test("builds graph with multiple stacks", () => {
    const builder = createContributionBuilder();
    builder.addStack("manifest-middleware", "Manifest Middleware", "manifest", true, [
      { id: "@koi/audit", kind: "middleware", source: "manifest", middlewareNames: ["audit"] },
    ]);
    builder.addStack("nexus", "Nexus", "runtime", true, [
      { id: "@koi/nexus", kind: "middleware", source: "static", middlewareNames: ["nexus-auth"] },
      { id: "@koi/nexus", kind: "provider", source: "static", providerNames: ["search"] },
    ]);
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(2);
    expect(graph.stacks[1]?.packages).toHaveLength(2);
  });

  test("build returns a snapshot (not live reference)", () => {
    const builder = createContributionBuilder();
    builder.addStack("first", "First", "runtime", true, []);
    const graph1 = builder.build();
    builder.addStack("second", "Second", "runtime", true, []);
    const graph2 = builder.build();
    expect(graph1.stacks).toHaveLength(1);
    expect(graph2.stacks).toHaveLength(2);
  });
});
