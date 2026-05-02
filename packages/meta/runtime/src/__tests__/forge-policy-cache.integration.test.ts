/**
 * Cross-package integration: @koi/forge-tools (in-memory store) ↔
 * @koi/middleware-policy-cache. Proves the new `generation` contract on
 * `StoreChangeEvent` propagates end-to-end so policy-cache can refuse stale
 * notifier events that would otherwise silently downgrade authorization.
 *
 * Why this lives in @koi/runtime: L2 packages cannot depend on each other
 * directly under `linker = "isolated"`. @koi/runtime is the integration
 * boundary that already declares both packages.
 */

import { describe, expect, test } from "bun:test";
import type {
  BrickId,
  ForgeProvenance,
  StoreChangeEvent,
  StoreChangeNotifier,
  ToolArtifact,
} from "@koi/core";
import { computeIdentityBrickId, createInMemoryForgeStore } from "@koi/forge-tools";
import { createPolicyCacheMiddleware, type PolicyEntry } from "@koi/middleware-policy-cache";

const TRUST_ALL = (): boolean => true;

interface ToolBrickOpts {
  readonly name?: string;
  readonly implementation?: string;
}

const makeToolBrick = (opts: ToolBrickOpts = {}): ToolArtifact => {
  const name = opts.name ?? "rm-tool";
  const implementation = opts.implementation ?? "return { ok: true };";
  const inputSchema: Readonly<Record<string, unknown>> = { type: "object" };
  const id: BrickId = computeIdentityBrickId({
    kind: "tool",
    name,
    description: `${name} description`,
    version: "0.0.1",
    scope: "agent",
    ownerAgentId: "agent-A",
    content: { implementation, inputSchema },
  });
  const provenance: ForgeProvenance = {
    source: { origin: "forged", forgedBy: "agent-A" },
    buildDefinition: { buildType: "test", externalParameters: {} },
    builder: { id: "test-builder" },
    metadata: {
      invocationId: "inv-1",
      startedAt: 0,
      finishedAt: 0,
      sessionId: "sess-1",
      agentId: "agent-A",
      depth: 0,
    },
    verification: { passed: true, sandbox: true, totalDurationMs: 0, stageResults: [] },
    classification: "internal",
    contentMarkers: [],
    contentHash: id,
  };
  return {
    kind: "tool",
    id,
    name,
    description: `${name} description`,
    scope: "agent",
    origin: "forged",
    policy: { sandbox: true, capabilities: {} },
    lifecycle: "draft",
    provenance,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation,
    inputSchema,
  };
};

// Adapter: forge store exposes `watch` (= notifier.subscribe). Policy cache
// expects a full StoreChangeNotifier; `notify` is unused on the consumer
// side so we stub it.
const adaptForgeWatchToNotifier = (
  watch: NonNullable<ReturnType<typeof createInMemoryForgeStore>["watch"]>,
): StoreChangeNotifier => ({
  notify: () => {},
  subscribe: watch,
});

const makePolicyEntry = (
  brickId: string,
  generation: number | undefined,
  toolId = "rm",
): PolicyEntry => ({
  scope: "agent",
  agentId: "agent-A",
  toolId,
  brickId,
  ...(generation !== undefined ? { generation } : {}),
  execute: () => ({ action: "block", reason: "denied by policy" }),
});

describe("forge-tools ↔ policy-cache: generation propagation", () => {
  test("forge.save emits generation = storeVersion via watch", async () => {
    const store = createInMemoryForgeStore();
    const events: StoreChangeEvent[] = [];
    if (store.watch === undefined) throw new Error("watch missing");
    store.watch((e) => events.push(e));

    const brick = makeToolBrick();
    const r = await store.save(brick);
    expect(r.ok).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("saved");
    expect(events[0]?.brickId).toBe(brick.id);
    // Per memory-store.ts: storeVersion seeded to 1 on save.
    expect(events[0]?.generation).toBe(1);
  });

  test("forge.update bumps generation", async () => {
    const store = createInMemoryForgeStore();
    const events: StoreChangeEvent[] = [];
    if (store.watch === undefined) throw new Error("watch missing");
    store.watch((e) => events.push(e));

    const brick = makeToolBrick();
    await store.save(brick);
    const u = await store.update(brick.id, { usageCount: 1 });
    expect(u.ok).toBe(true);

    const updated = events.find((e) => e.kind === "updated");
    expect(updated?.generation).toBeGreaterThan(1);
  });

  test("forge.remove emits generation snapshot", async () => {
    const store = createInMemoryForgeStore();
    const events: StoreChangeEvent[] = [];
    if (store.watch === undefined) throw new Error("watch missing");
    store.watch((e) => events.push(e));

    const brick = makeToolBrick();
    await store.save(brick);
    await store.remove(brick.id);

    const removed = events.find((e) => e.kind === "removed");
    expect(removed?.brickId).toBe(brick.id);
    expect(removed?.generation).toBe(1);
  });

  test("forge → policy-cache: matching-generation `removed` evicts cached entry", async () => {
    const store = createInMemoryForgeStore();
    if (store.watch === undefined) throw new Error("watch missing");
    const handle = createPolicyCacheMiddleware({
      verifier: TRUST_ALL,
      notifier: adaptForgeWatchToNotifier(store.watch),
    });

    const brick = makeToolBrick();
    await store.save(brick); // emits generation=1
    handle.register(makePolicyEntry(brick.id, 1));
    expect(handle.size()).toBe(1);

    await store.remove(brick.id); // emits generation=1 → matches, evict.
    expect(handle.size()).toBe(0);
    handle.dispose();
  });

  test("stale `removed` from older generation is suppressed (rollback protection)", async () => {
    const store = createInMemoryForgeStore();
    if (store.watch === undefined) throw new Error("watch missing");
    const handle = createPolicyCacheMiddleware({
      verifier: TRUST_ALL,
      notifier: adaptForgeWatchToNotifier(store.watch),
    });

    // Cached entry is at generation=5; a delayed `removed` event for
    // generation=2 must NOT evict — a stale event for an older promotion
    // could otherwise silently roll back authorization.
    handle.register(makePolicyEntry("brick-X", 5));
    expect(handle.size()).toBe(1);

    // Fire a synthetic stale event directly via the same notifier path.
    // (Cannot get gen=2 from real save/remove because the store has no
    // such brick; this exercises the consumer-side gate.)
    const adapter = adaptForgeWatchToNotifier(store.watch);
    let received: StoreChangeEvent | undefined;
    adapter.subscribe((e) => {
      received = e;
    });
    expect(received).toBeUndefined(); // sanity — no events yet

    // Drive a stale event through a parallel synthetic notifier wired
    // into the same handle. Use config.notifier directly for the gate test.
    const synthHandle = createPolicyCacheMiddleware({
      verifier: TRUST_ALL,
      notifier: {
        notify: () => {},
        subscribe: (listener) => {
          // Immediately deliver a stale `removed` for an entry we'll register.
          queueMicrotask(() =>
            listener({ kind: "removed", brickId: "brick-X" as BrickId, generation: 2 }),
          );
          return () => {};
        },
      },
    });
    synthHandle.register(makePolicyEntry("brick-X", 5));
    await new Promise((r) => setTimeout(r, 5));
    // Stale event refused → entry retained.
    expect(synthHandle.size()).toBe(1);

    handle.dispose();
    synthHandle.dispose();
  });

  test("versioned-by-unversioned slot replacement is refused", () => {
    const handle = createPolicyCacheMiddleware({ verifier: TRUST_ALL });
    const ok1 = handle.register(makePolicyEntry("brick-V", 5));
    expect(ok1.ok).toBe(true);
    // Different brickId, no generation → versioned cached entry must
    // not be displaced by an unversioned legacy registration.
    const ok2 = handle.register(makePolicyEntry("brick-LEGACY", undefined));
    expect(ok2.ok).toBe(false);
    if (!ok2.ok) expect(ok2.error.code).toBe("VALIDATION");
    expect(handle.size()).toBe(1);
    handle.dispose();
  });

  test("unversioned cached entry CAN be displaced (legacy hosts can install fresh denies)", () => {
    const handle = createPolicyCacheMiddleware({ verifier: TRUST_ALL });
    handle.register(makePolicyEntry("brick-LEGACY-1", undefined));
    const r = handle.register(makePolicyEntry("brick-LEGACY-2", undefined));
    expect(r.ok).toBe(true);
    expect(handle.size()).toBe(1);
    handle.dispose();
  });

  test("dispose unsubscribes from forge notifier", async () => {
    const store = createInMemoryForgeStore();
    if (store.watch === undefined) throw new Error("watch missing");
    const handle = createPolicyCacheMiddleware({
      verifier: TRUST_ALL,
      notifier: adaptForgeWatchToNotifier(store.watch),
    });
    handle.register(makePolicyEntry("brick-D", 1));
    handle.dispose();

    // After dispose, a real forge mutation must not flow into the
    // (already-cleared) cache. Size stays at 0.
    const brick = makeToolBrick({ name: "different-tool" });
    await store.save(brick);
    expect(handle.size()).toBe(0);
  });
});
