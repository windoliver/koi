import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  ReconcileContext,
  ReconciliationController,
  RegistryEntry,
} from "@koi/core";
import { agentId } from "@koi/core";
import type { InMemoryRegistry } from "./registry.js";
import { createInMemoryRegistry } from "./registry.js";
import { createToolReconciler } from "./tool-reconciler.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function entry(
  id: string,
  phase: "created" | "running" | "terminated" = "running",
  generation = 0,
): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    priority: 10,
    metadata: {},
    registeredAt: Date.now(),
  };
}

function manifest(toolNames: readonly string[]): AgentManifest {
  return {
    name: "test-agent",
    version: "1.0.0",
    model: { name: "test-model" },
    tools: toolNames.map((name) => ({ name })),
  };
}

function ctx(registry: InMemoryRegistry, m: AgentManifest): ReconcileContext {
  return { registry, manifest: m };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToolReconciler", () => {
  let registry: InMemoryRegistry;
  let reconciler: ReconciliationController;
  let attachedTools: Map<string, readonly string[]>;
  let missingAlerts: Array<{ agentId: AgentId; missing: readonly string[] }>;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    attachedTools = new Map();
    missingAlerts = [];

    reconciler = createToolReconciler({
      getAttachedToolNames: (id) => attachedTools.get(id) ?? [],
      onMissingTools: (id, missing) => {
        missingAlerts.push({ agentId: id, missing });
      },
    });
  });

  afterEach(async () => {
    await reconciler[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  test("agent with all manifest tools returns converged", () => {
    const id = agentId("agent-1");
    registry.register(entry("agent-1", "running"));
    attachedTools.set(id, ["tool-a", "tool-b"]);

    const result = reconciler.reconcile(id, ctx(registry, manifest(["tool-a", "tool-b"])));
    expect(result).toEqual({ kind: "converged" });
  });

  test("agent missing a manifest tool returns recheck with alert", () => {
    const id = agentId("agent-1");
    registry.register(entry("agent-1", "running"));
    attachedTools.set(id, ["tool-a"]); // missing tool-b

    const result = reconciler.reconcile(id, ctx(registry, manifest(["tool-a", "tool-b"])));
    expect(result).toEqual({ kind: "recheck", afterMs: 10_000 });
    expect(missingAlerts).toHaveLength(1);
    expect(missingAlerts[0]?.missing).toEqual(["tool-b"]);
  });

  test("terminated agent returns converged", () => {
    const id = agentId("agent-1");
    registry.register(entry("agent-1", "terminated"));

    const result = reconciler.reconcile(id, ctx(registry, manifest(["tool-a"])));
    expect(result).toEqual({ kind: "converged" });
  });

  test("agent not found returns converged", () => {
    const id = agentId("nonexistent");

    const result = reconciler.reconcile(id, ctx(registry, manifest(["tool-a"])));
    expect(result).toEqual({ kind: "converged" });
  });

  test("agent with extra forged tools returns converged", () => {
    const id = agentId("agent-1");
    registry.register(entry("agent-1", "running"));
    // Has all manifest tools plus an extra forged one
    attachedTools.set(id, ["tool-a", "tool-b", "forged-tool"]);

    const result = reconciler.reconcile(id, ctx(registry, manifest(["tool-a", "tool-b"])));
    expect(result).toEqual({ kind: "converged" });
    expect(missingAlerts).toHaveLength(0);
  });

  test("multiple missing tools trigger single recheck with all alerts", () => {
    const id = agentId("agent-1");
    registry.register(entry("agent-1", "running"));
    attachedTools.set(id, []); // all tools missing

    const result = reconciler.reconcile(
      id,
      ctx(registry, manifest(["tool-a", "tool-b", "tool-c"])),
    );
    expect(result).toEqual({ kind: "recheck", afterMs: 10_000 });
    expect(missingAlerts).toHaveLength(1);
    expect(missingAlerts[0]?.missing).toEqual(["tool-a", "tool-b", "tool-c"]);
  });

  test("agent with no manifest tools returns converged", () => {
    const id = agentId("agent-1");
    registry.register(entry("agent-1", "running"));

    const noToolsManifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "test-model" },
    };
    const result = reconciler.reconcile(id, ctx(registry, noToolsManifest));
    expect(result).toEqual({ kind: "converged" });
  });
});
