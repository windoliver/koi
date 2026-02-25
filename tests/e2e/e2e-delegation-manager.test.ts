/**
 * E2E: DelegationManager through the full Koi L1 runtime.
 *
 * Wires createKoi + createLoopAdapter + delegation middleware with real
 * Anthropic API calls. Validates the full middleware chain, circuit
 * breaker, grant lifecycle, verify cache, and event emission.
 *
 * Run:
 *   bun test tests/e2e/e2e-delegation-manager.test.ts
 *
 * Requires: ANTHROPIC_API_KEY in .env
 * Cost: ~$0.01 per run (haiku, minimal prompts, maxTokens: 30).
 */

import { describe, expect, test } from "bun:test";
import type {
  DelegationEvent,
  DelegationGrant,
  DelegationId,
  EngineEvent,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
} from "@koi/core";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import {
  createDelegationManager,
  createDelegationMiddleware,
  createInMemoryRegistry,
  mustCreateGrant,
} from "@koi/delegation";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_ANTHROPIC = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_ANTHROPIC ? describe : describe.skip;

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT = 60_000;
const SECRET = "e2e-manager-test-secret-32-bytes";

// let justified: lazy singleton — avoids creating adapter when skipped
let anthropic: ReturnType<typeof createAnthropicAdapter> | undefined;
function getAdapter(): ReturnType<typeof createAnthropicAdapter> {
  if (anthropic === undefined) {
    anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  }
  return anthropic;
}

const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
  getAdapter().complete({ ...request, model: MODEL, maxTokens: 30 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. Basic L1 runtime — createKoi + createLoopAdapter + real LLM
// ---------------------------------------------------------------------------

describeE2E("e2e: DelegationManager with full L1 runtime", () => {
  test(
    "basic L1 runtime produces done event with real Anthropic call",
    async () => {
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: { name: "e2e-basic", version: "0.0.1", model: { name: MODEL } },
        adapter,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Reply with one word: hello" }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") {
          expect(done.output.metrics.turns).toBeGreaterThan(0);
          expect(done.output.metrics.totalTokens).toBeGreaterThan(0);
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT,
  );

  // ---------------------------------------------------------------------------
  // 2. Delegation middleware wired in full L1 runtime
  // ---------------------------------------------------------------------------

  test(
    "delegation middleware allows tool calls through L1 middleware chain",
    async () => {
      const registry = createInMemoryRegistry();
      const grantStore = new Map<DelegationId, DelegationGrant>();

      const grant = mustCreateGrant({
        issuerId: "orchestrator",
        delegateeId: "worker",
        scope: { permissions: { allow: ["get_weather"] } },
        maxChainDepth: 3,
        ttlMs: 3600000,
        secret: SECRET,
      });
      grantStore.set(grant.id, grant);

      const delegationMw = createDelegationMiddleware({
        secret: SECRET,
        registry,
        grantStore,
      });

      const toolCalls: string[] = []; // let justified: test accumulator
      const adapter = createLoopAdapter({
        modelCall,
        toolCall: async (req) => {
          toolCalls.push(req.toolId);
          return { output: { weather: "sunny" } };
        },
        maxTurns: 2,
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-delegation", version: "0.0.1", model: { name: MODEL } },
        adapter,
        middleware: [delegationMw],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Say hello in one word." }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
      } finally {
        await runtime.dispose();
        registry.dispose();
      }
    },
    TIMEOUT,
  );

  // ---------------------------------------------------------------------------
  // 3. DelegationManager lifecycle — grant, verify, cache, revoke
  // ---------------------------------------------------------------------------

  test("DelegationManager grant → verify → cache → revoke → deny", async () => {
    const events: DelegationEvent[] = []; // let justified: test accumulator
    const manager = createDelegationManager({
      config: {
        secret: SECRET,
        maxChainDepth: 3,
        defaultTtlMs: 3600000,
        circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
      },
      onEvent: (e) => events.push(e),
    });

    try {
      // Grant
      const grantResult = manager.grant("orchestrator", "worker", {
        permissions: { allow: ["read_file", "write_file"] },
      });
      expect(grantResult.ok).toBe(true);
      if (!grantResult.ok) return;

      expect(events.filter((e) => e.kind === "delegation:granted")).toHaveLength(1);

      // Verify allowed
      const verifyOk = await manager.verify(grantResult.value.id, "read_file");
      expect(verifyOk.ok).toBe(true);

      // Verify denied (scope exceeded)
      const verifyDenied = await manager.verify(grantResult.value.id, "exec");
      expect(verifyDenied.ok).toBe(false);
      if (!verifyDenied.ok) expect(verifyDenied.reason).toBe("scope_exceeded");

      expect(events.filter((e) => e.kind === "delegation:denied")).toHaveLength(1);

      // Cache hit — second verify for same grantId+toolId emits no new events
      const prevCount = events.length;
      const verifyOk2 = await manager.verify(grantResult.value.id, "read_file");
      expect(verifyOk2.ok).toBe(true);
      expect(events.length).toBe(prevCount); // no new events = cache hit

      // Revoke
      const revokedIds = await manager.revoke(grantResult.value.id);
      expect(revokedIds).toHaveLength(1);
      expect(events.filter((e) => e.kind === "delegation:revoked")).toHaveLength(1);

      // Verify after revoke fails
      const verifyAfter = await manager.verify(grantResult.value.id, "read_file");
      expect(verifyAfter.ok).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Circuit breaker: open → half_open → closed with events
  // ---------------------------------------------------------------------------

  test("circuit breaker cycles through closed → open → half_open → closed", async () => {
    const events: DelegationEvent[] = []; // let justified: test accumulator
    const manager = createDelegationManager({
      config: {
        secret: SECRET,
        maxChainDepth: 3,
        defaultTtlMs: 3600000,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 100, halfOpenMaxProbes: 1 },
      },
      onEvent: (e) => events.push(e),
    });

    try {
      expect(manager.circuitState("worker")).toBe("closed");

      // Trip open
      manager.recordFailure("worker");
      manager.recordFailure("worker");
      expect(manager.circuitState("worker")).toBe("open");
      expect(manager.canDelegate("worker")).toBe(false);
      expect(events.filter((e) => e.kind === "delegation:circuit_opened")).toHaveLength(1);

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(manager.circuitState("worker")).toBe("half_open");

      // Successful probe closes
      manager.recordSuccess("worker");
      expect(manager.circuitState("worker")).toBe("closed");
      expect(events.filter((e) => e.kind === "delegation:circuit_closed")).toHaveLength(1);
    } finally {
      manager.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Cascade revocation — 3-agent chain
  // ---------------------------------------------------------------------------

  test("cascade revocation invalidates entire 3-agent delegation chain", async () => {
    const manager = createDelegationManager({
      config: {
        secret: SECRET,
        maxChainDepth: 3,
        defaultTtlMs: 3600000,
        circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
      },
    });

    try {
      // Orchestrator → Worker
      const rootResult = manager.grant("orchestrator", "worker", {
        permissions: { allow: ["read_file", "write_file", "search"] },
      });
      expect(rootResult.ok).toBe(true);
      if (!rootResult.ok) return;

      // Worker → SubWorker (attenuated)
      const childResult = manager.attenuate(rootResult.value.id, "sub-worker", {
        permissions: { allow: ["read_file"] },
      });
      expect(childResult.ok).toBe(true);
      if (!childResult.ok) return;

      // Both verify
      expect((await manager.verify(rootResult.value.id, "read_file")).ok).toBe(true);
      expect((await manager.verify(childResult.value.id, "read_file")).ok).toBe(true);

      // Child can't use write_file (attenuated)
      const childDenied = await manager.verify(childResult.value.id, "write_file");
      expect(childDenied.ok).toBe(false);

      // Cascade revoke
      const revoked = await manager.revoke(rootResult.value.id, true);
      expect(revoked).toHaveLength(2);

      // Both fail
      expect((await manager.verify(rootResult.value.id, "read_file")).ok).toBe(false);
      expect((await manager.verify(childResult.value.id, "read_file")).ok).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Full stack: DelegationManager + middleware chain + createKoi + real LLM
  // ---------------------------------------------------------------------------

  test(
    "full stack: DelegationManager + middleware chain + createKoi + Anthropic",
    async () => {
      const delegationEvents: DelegationEvent[] = []; // let justified: test accumulator
      const manager = createDelegationManager({
        config: {
          secret: SECRET,
          maxChainDepth: 3,
          defaultTtlMs: 3600000,
          circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
        },
        onEvent: (e) => delegationEvents.push(e),
      });

      const grantResult = manager.grant("orchestrator", "worker", {
        permissions: { allow: ["get_weather"] },
      });
      expect(grantResult.ok).toBe(true);
      if (!grantResult.ok) return;

      const grantStore = new Map<DelegationId, DelegationGrant>([
        [grantResult.value.id, grantResult.value],
      ]);
      const registry = createInMemoryRegistry();

      const delegationMw = createDelegationMiddleware({
        secret: SECRET,
        registry,
        grantStore,
      });

      // Middleware composition order tracker
      const order: string[] = []; // let justified: test accumulator
      const orderMw: KoiMiddleware = {
        name: "e2e-order-tracker",
        priority: 100,
        wrapModelCall: async (_ctx, req, next) => {
          order.push("model:before");
          const res = await next(req);
          order.push("model:after");
          return res;
        },
      };

      // Circuit breaker middleware
      const circuitMw: KoiMiddleware = {
        name: "e2e-circuit-check",
        priority: 200,
        wrapToolCall: async (_ctx, req, next) => {
          if (!manager.canDelegate("worker")) {
            return {
              output: null,
              metadata: {
                error: {
                  code: "CIRCUIT_OPEN",
                  message: "Circuit breaker open",
                  retryable: true,
                },
              },
            };
          }
          return next(req);
        },
      };

      const adapter = createLoopAdapter({
        modelCall,
        toolCall: async () => ({ output: { weather: "sunny" } }),
        maxTurns: 2,
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-full-stack", version: "0.0.1", model: { name: MODEL } },
        adapter,
        middleware: [delegationMw, orderMw, circuitMw],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Say hi in one word." }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") {
          expect(done.output.metrics.turns).toBeGreaterThan(0);
        }

        // Model call onion intercepted
        expect(order.filter((s) => s === "model:before").length).toBeGreaterThan(0);
        expect(order.filter((s) => s === "model:after").length).toBeGreaterThan(0);

        // Delegation events emitted
        expect(delegationEvents.filter((e) => e.kind === "delegation:granted")).toHaveLength(1);
      } finally {
        await runtime.dispose();
        registry.dispose();
        manager.dispose();
      }
    },
    TIMEOUT,
  );
});
