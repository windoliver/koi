import { describe, expect, test } from "bun:test";
import { createContributionBuilder } from "./contribution-graph.js";

describe("createContributionBuilder", () => {
  test("builds graph with stacks and packages", () => {
    const builder = createContributionBuilder();
    builder.addStack("nexus", "Nexus", "runtime", "active", [
      { id: "@koi/nexus", kind: "middleware", source: "static", middlewareNames: ["auth"] },
    ]);
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(1);
    expect(graph.stacks[0]?.packages[0]?.middlewareNames).toEqual(["auth"]);
    expect(graph.stacks[0]?.status).toBe("active");
    expect(graph.stacks[0]?.enabled).toBe(true);
    expect(typeof graph.generatedAt).toBe("number");
  });

  test("handles stacks with no packages", () => {
    const builder = createContributionBuilder();
    builder.addStack("empty", "Empty Stack", "runtime", "active", []);
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(1);
    expect(graph.stacks[0]?.packages).toHaveLength(0);
  });

  test("handles failed stacks with reason", () => {
    const builder = createContributionBuilder();
    builder.addStack(
      "disabled",
      "Disabled Stack",
      "operator",
      "failed",
      [{ id: "@koi/something", kind: "provider", source: "static" }],
      "connection refused",
    );
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(1);
    expect(graph.stacks[0]?.enabled).toBe(false);
    expect(graph.stacks[0]?.status).toBe("failed");
    expect(graph.stacks[0]?.reason).toBe("connection refused");
    expect(graph.stacks[0]?.source).toBe("operator");
  });

  test("skipped stacks are disabled", () => {
    const builder = createContributionBuilder();
    builder.addStack("skipped", "Skipped", "runtime", "skipped", [], "not configured");
    const graph = builder.build();
    expect(graph.stacks[0]?.enabled).toBe(false);
    expect(graph.stacks[0]?.status).toBe("skipped");
    expect(graph.stacks[0]?.reason).toBe("not configured");
  });

  test("degraded stacks are enabled", () => {
    const builder = createContributionBuilder();
    builder.addStack("partial", "Partial", "runtime", "degraded", [], "sandbox unavailable");
    const graph = builder.build();
    expect(graph.stacks[0]?.enabled).toBe(true);
    expect(graph.stacks[0]?.status).toBe("degraded");
  });

  test("builds graph with multiple stacks", () => {
    const builder = createContributionBuilder();
    builder.addStack("manifest-middleware", "Manifest Middleware", "manifest", "active", [
      { id: "@koi/audit", kind: "middleware", source: "manifest", middlewareNames: ["audit"] },
    ]);
    builder.addStack("nexus", "Nexus", "runtime", "active", [
      { id: "@koi/nexus", kind: "middleware", source: "static", middlewareNames: ["nexus-auth"] },
      { id: "@koi/nexus", kind: "provider", source: "static", providerNames: ["search"] },
    ]);
    const graph = builder.build();
    expect(graph.stacks).toHaveLength(2);
    expect(graph.stacks[1]?.packages).toHaveLength(2);
  });

  test("build returns a snapshot (not live reference)", () => {
    const builder = createContributionBuilder();
    builder.addStack("first", "First", "runtime", "active", []);
    const graph1 = builder.build();
    builder.addStack("second", "Second", "runtime", "active", []);
    const graph2 = builder.build();
    expect(graph1.stacks).toHaveLength(1);
    expect(graph2.stacks).toHaveLength(2);
  });

  test("reason is omitted when not provided", () => {
    const builder = createContributionBuilder();
    builder.addStack("clean", "Clean", "runtime", "active", []);
    const graph = builder.build();
    expect(graph.stacks[0]?.reason).toBeUndefined();
  });
});
