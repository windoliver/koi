/**
 * Integration: @koi/forge-optimizer ⟷ @koi/forge-tools (memory store).
 *
 * Drives the optimizer against a real BrickStore (`createInMemoryForgeStore`)
 * to catch contract drift the unit tests cannot see — most importantly:
 *
 *   - `validateStoreTransition` MUST agree with what `memory-store.update`
 *     actually accepts (terminal-lifecycle no-go set is duplicated; this
 *     test catches drift).
 *   - `recordUsage` round-trip through `store.update({ fitness })` must
 *     preserve sampler invariants the store does not validate itself.
 *   - Advisory passes (`suggestRetirement`, `suggestMerge`,
 *     `suggestSimplify`) must produce signals callers can safely act on
 *     against the actual store API.
 */

import { describe, expect, test } from "bun:test";
import type {
  BrickFitnessMetrics,
  BrickId,
  BrickLifecycle,
  CompositeArtifact,
  ForgeProvenance,
  ToolArtifact,
} from "@koi/core";
import { DEFAULT_BRICK_FITNESS, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import {
  computePerformanceScore,
  recordUsage,
  suggestMerge,
  suggestRetirement,
  suggestSimplify,
  validateStoreTransition,
} from "@koi/forge-optimizer";
import { computeIdentityBrickId, createInMemoryForgeStore } from "@koi/forge-tools";

const PROVENANCE: ForgeProvenance = {
  source: "test",
  metadata: { agentId: "test-agent" },
} as unknown as ForgeProvenance;

function tool(overrides: Partial<ToolArtifact> = {}): ToolArtifact {
  const merged = {
    name: overrides.name ?? "sample-tool",
    description: overrides.description ?? "sample description",
    version: "1.0.0",
    scope: overrides.scope ?? "agent",
    implementation: overrides.implementation ?? "function impl() { return 0 }",
    inputSchema: overrides.inputSchema ?? { type: "object" },
  };
  const id = computeIdentityBrickId({
    kind: "tool",
    name: merged.name,
    description: merged.description,
    version: merged.version,
    scope: merged.scope,
    ownerAgentId: "test-agent",
    content: { implementation: merged.implementation, inputSchema: merged.inputSchema },
  });
  // Spread overrides first then enforce computed id last — caller can
  // pass overrides to vary lifecycle/scope/etc. but never the id itself.
  return {
    kind: "tool",
    name: merged.name,
    description: merged.description,
    scope: merged.scope,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: PROVENANCE,
    version: merged.version,
    tags: [],
    usageCount: 0,
    implementation: merged.implementation,
    inputSchema: merged.inputSchema,
    ...overrides,
    id,
  } as ToolArtifact;
}

function composite(name: string, steps: number): CompositeArtifact {
  const port = { name: "p", schema: { type: "object" } };
  const stepArr = Array.from({ length: steps }, (_, i) => ({
    brickId: `sha256:${"0".repeat(60)}step${String(i).padStart(3, "0")}` as BrickId,
    inputPort: port,
    outputPort: port,
  }));
  const id = computeIdentityBrickId({
    kind: "composite",
    name,
    description: "",
    version: "1.0.0",
    scope: "agent",
    ownerAgentId: "test-agent",
    content: { steps: stepArr, exposedInput: port, exposedOutput: port, outputKind: "tool" },
  });
  return {
    id,
    kind: "composite",
    name,
    description: "",
    scope: "agent",
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: PROVENANCE,
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    steps: stepArr,
    exposedInput: port,
    exposedOutput: port,
    outputKind: "tool",
  } as CompositeArtifact;
}

describe("integration: optimizer + memory-store round-trip", () => {
  test("recordUsage → store.update({ fitness }) → store.read preserves the new fitness exactly", async () => {
    const store = createInMemoryForgeStore();
    const t = tool({ name: "fitness-roundtrip" });
    const saved = await store.save(t);
    expect(saved.ok).toBe(true);

    const next: BrickFitnessMetrics = recordUsage(
      DEFAULT_BRICK_FITNESS,
      { outcome: "success", latencyMs: 25, at: 1_000 },
      1_000,
    );
    const updated = await store.update(t.id, { fitness: next });
    expect(updated.ok).toBe(true);

    const read = await store.load(t.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.fitness).toEqual(next);
  });

  test("validateStoreTransition agrees with memory-store about terminal lifecycles", async () => {
    const store = createInMemoryForgeStore();
    const t = tool({ name: "terminal-test", lifecycle: "quarantined" });
    const saved = await store.save(t);
    expect(saved.ok).toBe(true);

    // Optimizer says: cannot exit quarantined. Verify the store agrees.
    const optimizerCheck = validateStoreTransition("quarantined", "draft");
    expect(optimizerCheck.ok).toBe(false);

    const storeAttempt = await store.update(t.id, { lifecycle: "draft" });
    expect(storeAttempt.ok).toBe(false);
  });

  test("validateStoreTransition agrees with memory-store about valid graph edges", async () => {
    const store = createInMemoryForgeStore();
    const t = tool({ name: "graph-test", lifecycle: "draft" });
    const saved = await store.save(t);
    expect(saved.ok).toBe(true);

    // Optimizer says: draft → verifying is valid.
    const optimizerCheck = validateStoreTransition("draft", "verifying");
    expect(optimizerCheck.ok).toBe(true);

    const storeUpdate = await store.update(t.id, { lifecycle: "verifying" });
    expect(storeUpdate.ok).toBe(true);
  });

  test("validateStoreTransition agrees with memory-store on every (from, to) lifecycle pair", async () => {
    // Drive the FULL transition matrix through both APIs and assert they
    // either both accept or both reject. This is the contract-drift net:
    // if memory-store.ts changes its TERMINAL_LIFECYCLES set or its
    // validation rules, this test catches the divergence.
    const lifecycles: BrickLifecycle[] = [
      "draft",
      "verifying",
      "active",
      "deprecated",
      "quarantined",
      "failed",
    ];
    const disagreements: string[] = [];
    for (const from of lifecycles) {
      for (const to of lifecycles) {
        if (from === to) continue;
        const store = createInMemoryForgeStore();
        const t = tool({ name: `m-${from}-${to}`, lifecycle: from });
        const save = await store.save(t);
        if (!save.ok) continue; // some seed states the store rejects on save; skip
        const opt = validateStoreTransition(from, to);
        const storeRes = await store.update(t.id, { lifecycle: to });
        if (opt.ok !== storeRes.ok) {
          disagreements.push(
            `${from} → ${to}: optimizer=${String(opt.ok)} store=${String(storeRes.ok)}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("suggestRetirement against a populated store: integrity findings never collide with retire findings", async () => {
    const store = createInMemoryForgeStore();
    const healthy = tool({
      name: "healthy",
      usageCount: 100,
      fitness: {
        successCount: 100,
        errorCount: 0,
        latency: { samples: [10], count: 100, cap: 200 },
        lastUsedAt: 5_000,
      },
    });
    const idle = tool({
      name: "idle",
      usageCount: 100,
      fitness: {
        successCount: 100,
        errorCount: 0,
        latency: { samples: [10], count: 100, cap: 200 },
        lastUsedAt: 0,
      },
    });
    await store.save(healthy);
    await store.save(idle);

    const search = await store.search({});
    expect(search.ok).toBe(true);
    if (!search.ok) return;

    const suggestions = suggestRetirement(
      search.value,
      { minUsageCount: 1, maxIdleMs: 1_000 },
      10_000,
    );
    // Each brick appears in at most one suggestion (no double-counting).
    const ids = suggestions.map((s) => s.brickId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("suggestMerge against the store: groupings respect trust boundaries", async () => {
    const store = createInMemoryForgeStore();
    const local = tool({ name: "shared-name", description: "shared", scope: "agent" });
    const global_ = tool({
      name: "shared-name",
      description: "shared",
      scope: "global",
    });
    await store.save(local);
    await store.save(global_);

    const search = await store.search({});
    expect(search.ok).toBe(true);
    if (!search.ok) return;

    const result = suggestMerge(search.value);
    // Same name+description but different scope → no merge suggestion.
    expect(result.suggestions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("suggestSimplify against a real composite stored in the memory store", async () => {
    const store = createInMemoryForgeStore();
    const c = composite("single-step-noop", 1);
    const saved = await store.save(c);
    expect(saved.ok).toBe(true);

    const read = await store.load(c.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const suggestion = suggestSimplify(read.value);
    expect(suggestion).toBeDefined();
    expect(suggestion?.kind).toBe("simplify");
    expect(suggestion?.brickId).toBe(c.id);
  });

  test("computePerformanceScore over a store-sourced batch produces non-negative finite scores", async () => {
    const store = createInMemoryForgeStore();
    for (let i = 0; i < 10; i++) {
      const t = tool({
        name: `score-${String(i)}`,
        fitness: {
          successCount: i * 10,
          errorCount: i,
          latency: { samples: [Math.max(1, i * 5)], count: i * 10 + i, cap: 200 },
          lastUsedAt: i * 1_000,
        },
      });
      const saved = await store.save(t);
      expect(saved.ok).toBe(true);
    }

    const search = await store.search({});
    expect(search.ok).toBe(true);
    if (!search.ok) return;

    for (const brick of search.value) {
      if (brick.fitness === undefined) continue;
      const score = computePerformanceScore(brick.fitness, 10_000);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });

  test("multi-step ingest: recordUsage 50 events, store update each, final state matches direct compute", async () => {
    const store = createInMemoryForgeStore();
    const t = tool({ name: "ingest-stream" });
    await store.save(t);

    let fitness: BrickFitnessMetrics = DEFAULT_BRICK_FITNESS;
    for (let i = 1; i <= 50; i++) {
      fitness = recordUsage(
        fitness,
        { outcome: i % 7 === 0 ? "error" : "success", latencyMs: 5 + (i % 20), at: i * 100 },
        i * 100,
      );
      const updated = await store.update(t.id, { fitness });
      expect(updated.ok).toBe(true);
    }

    const read = await store.load(t.id);
    expect(read.ok).toBe(true);
    if (!read.ok || !read.value.fitness) return;
    expect(read.value.fitness).toEqual(fitness);
    expect(read.value.fitness.successCount + read.value.fitness.errorCount).toBe(50);
  });
});
