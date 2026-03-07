/**
 * E2E tests for activity-based timeout reconciler through the full L1 runtime.
 *
 * Validates that the timeout reconciler works end-to-end with real LLM calls:
 *   - Active agents survive inactivity timeout (heartbeat middleware records activity)
 *   - Idle agents are terminated by inactivity timeout (CAS transition to terminated)
 *   - Full stack: createKoi + Pi adapter + registry + health monitor + reconcile runner
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — skipped during parallel `bun test --recursive`
 * to avoid rate-limit failures when 500+ test files run simultaneously.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/timeout-reconciler.e2e.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  EngineEvent,
  EngineOutput,
  HealthMonitorConfig,
  KoiMiddleware,
  RegistryEntry,
} from "@koi/core";
import { agentId } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import type { InMemoryHealthMonitor, ReconcileRunner } from "@koi/engine-reconcile";
import {
  createHealthMonitor,
  createInMemoryRegistry,
  createReconcileRunner,
  createTimeoutReconciler,
} from "@koi/engine-reconcile";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const E2E_MANIFEST: AgentManifest = {
  name: "timeout-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

/** Health monitor config with high flush/sweep intervals to prevent auto-flush during tests. */
const HEALTH_CONFIG: HealthMonitorConfig = {
  flushIntervalMs: 100_000,
  sweepIntervalMs: 100_000,
  suspectThresholdMs: 60_000,
  deadThresholdMs: 120_000,
};

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function entry(
  id: string,
  phase: "created" | "running" | "terminated" = "running",
  registeredAt = Date.now(),
  generation = 0,
): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [] as const,
      lastTransitionAt: registeredAt,
    },
    agentType: "worker",
    priority: 10,
    metadata: {},
    registeredAt,
  };
}

// ---------------------------------------------------------------------------
// Infrastructure factory — shared setup for all tests
// ---------------------------------------------------------------------------

interface TestInfra {
  readonly registry: ReturnType<typeof createInMemoryRegistry>;
  readonly healthMonitor: InMemoryHealthMonitor;
  readonly reconcileRunner: ReconcileRunner;
  readonly manifests: Map<string, AgentManifest>;
}

function createTestInfra(
  trackFn: <T extends AsyncDisposable>(d: T) => T,
  overrides?: {
    readonly maxRunDurationMs?: number;
    readonly driftCheckIntervalMs?: number;
    readonly minReconcileIntervalMs?: number;
  },
): TestInfra {
  const registry = trackFn(createInMemoryRegistry());
  const healthMonitor = trackFn(createHealthMonitor(registry, HEALTH_CONFIG));

  const timeoutReconciler = trackFn(
    createTimeoutReconciler({
      maxRunDurationMs: overrides?.maxRunDurationMs ?? 30_000,
      lastActivityAt: (id) => {
        const snap = healthMonitor.check(id);
        return snap.lastHeartbeat > 0 ? snap.lastHeartbeat : undefined;
      },
    }),
  );

  const manifests = new Map<string, AgentManifest>();
  const reconcileRunner = trackFn(
    createReconcileRunner({
      registry,
      manifests,
      config: {
        driftCheckIntervalMs: overrides?.driftCheckIntervalMs ?? 2_000,
        minReconcileIntervalMs: overrides?.minReconcileIntervalMs ?? 1_000,
      },
    }),
  );
  reconcileRunner.register(timeoutReconciler);

  return { registry, healthMonitor, reconcileRunner, manifests };
}

/** Create a heartbeat middleware that records model calls to the health monitor. */
function createHeartbeatMiddleware(
  healthMonitor: InMemoryHealthMonitor,
  getAgentId: () => AgentId | undefined,
): KoiMiddleware {
  return {
    name: "e2e:heartbeat",
    describeCapabilities: () => undefined,
    priority: 100,
    wrapModelCall: async (_ctx, request, next) => {
      const id = getAgentId();
      if (id !== undefined) {
        healthMonitor.record(id);
      }
      return next(request);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: activity-based timeout reconciler through full L1 runtime", () => {
  // let justified: replaced on each afterEach cleanup
  let disposables: readonly AsyncDisposable[] = [];

  function track<T extends AsyncDisposable>(d: T): T {
    disposables = [...disposables, d];
    return d;
  }

  afterEach(async () => {
    // Dispose in reverse order (LIFO) — ensures dependent resources
    // (reconcileRunner, healthMonitor) are cleaned up before registry
    for (let i = disposables.length - 1; i >= 0; i--) {
      try {
        await disposables[i]?.[Symbol.asyncDispose]();
      } catch (err: unknown) {
        console.error("[timeout-reconciler.e2e] disposal error:", err);
      }
    }
    disposables = [];
  });

  test(
    "active agent survives inactivity timeout — heartbeats keep it alive",
    async () => {
      const { registry, healthMonitor, reconcileRunner, manifests } = createTestInfra(track, {
        maxRunDurationMs: 30_000,
      });

      // let justified: set after createKoi returns; used by heartbeat middleware closure
      let runtimeAgentId: AgentId | undefined;

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        middleware: [createHeartbeatMiddleware(healthMonitor, () => runtimeAgentId)],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
      });
      track({ [Symbol.asyncDispose]: () => runtime.dispose() });

      // Register agent in registry and manifests map
      runtimeAgentId = runtime.agent.pid.id as AgentId;
      registry.register(entry(runtimeAgentId, "created"));
      registry.transition(runtimeAgentId, "running", 0, { kind: "assembly_complete" });
      manifests.set(runtimeAgentId, E2E_MANIFEST);

      // Start reconcile runner (background loop)
      reconcileRunner.start();

      // --- Run agent (real LLM call) ---
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: pong" }),
      );

      // --- Verify real LLM output ---
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.totalTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // --- Verify agent was NOT terminated by reconciler ---
      const registryEntry = registry.lookup(runtimeAgentId);
      expect(registryEntry).toBeDefined();
      expect(registryEntry?.status.phase).toBe("running");

      // --- Verify health monitor recorded heartbeats ---
      const healthStats = healthMonitor.stats();
      expect(healthStats.totalRecorded).toBeGreaterThan(0);

      // --- Verify reconcile runner processed passes ---
      await new Promise((resolve) => setTimeout(resolve, 500));
      const runnerStats = reconcileRunner.stats();
      expect(runnerStats.activeControllers).toBe(1);

      // --- Verify lifecycle ---
      expect(runtime.agent.state).toBe("terminated");
    },
    TIMEOUT_MS,
  );

  test(
    "idle agent terminated by inactivity timeout — no heartbeats after initial",
    async () => {
      const { registry, healthMonitor, reconcileRunner, manifests } = createTestInfra(track, {
        maxRunDurationMs: 1_000,
        driftCheckIntervalMs: 500,
        minReconcileIntervalMs: 200,
      });

      // Register an agent as "running" with one initial heartbeat
      const testId = agentId("idle-test-agent");
      registry.register(entry("idle-test-agent", "created"));
      registry.transition(testId, "running", 0, { kind: "assembly_complete" });
      manifests.set("idle-test-agent", E2E_MANIFEST);

      // Record a single heartbeat, then stop
      healthMonitor.record(testId);

      // Start reconcile runner
      reconcileRunner.start();

      // Wait for inactivity timeout to expire + reconcile loop to fire
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // --- Verify agent was terminated by reconciler ---
      const updated = registry.lookup(testId);
      expect(updated).toBeDefined();
      expect(updated?.status.phase).toBe("terminated");
      expect(updated?.status.reason).toEqual({ kind: "timeout" });

      // --- Verify reconcile runner stats ---
      const runnerStats = reconcileRunner.stats();
      expect(runnerStats.totalReconciled).toBeGreaterThan(0);
      expect(runnerStats.activeControllers).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "full stack: createKoi + Pi + reconciler — agent completes without premature termination",
    async () => {
      const { registry, healthMonitor, reconcileRunner, manifests } = createTestInfra(track, {
        maxRunDurationMs: 60_000,
      });

      // let justified: set after createKoi returns; used by heartbeat middleware closure
      let runtimeAgentId: AgentId | undefined;

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        middleware: [createHeartbeatMiddleware(healthMonitor, () => runtimeAgentId)],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
      });
      track({ [Symbol.asyncDispose]: () => runtime.dispose() });

      // Register agent in registry and manifests
      runtimeAgentId = runtime.agent.pid.id as AgentId;
      registry.register(entry(runtimeAgentId, "created"));
      registry.transition(runtimeAgentId, "running", 0, { kind: "assembly_complete" });
      manifests.set(runtimeAgentId, E2E_MANIFEST);

      // Start reconcile runner (background)
      reconcileRunner.start();

      // --- Run agent (real LLM call, simple text reply) ---
      const events = await collectEvents(runtime.run({ kind: "text", text: "Reply with: hello" }));

      // --- Verify real LLM output ---
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // --- Verify agent was NOT prematurely terminated ---
      const registryEntry = registry.lookup(runtimeAgentId);
      expect(registryEntry).toBeDefined();
      expect(registryEntry?.status.phase).toBe("running");

      // --- Verify health monitor recorded activity ---
      const healthStats = healthMonitor.stats();
      expect(healthStats.totalRecorded).toBeGreaterThan(0);

      // --- Verify reconcile runner operated ---
      await new Promise((resolve) => setTimeout(resolve, 500));
      const runnerStats = reconcileRunner.stats();
      expect(runnerStats.totalReconciled).toBeGreaterThan(0);
      expect(runnerStats.activeControllers).toBe(1);

      // --- Verify lifecycle completed normally ---
      expect(runtime.agent.state).toBe("terminated");
    },
    TIMEOUT_MS,
  );
});
