/**
 * End-to-end contract validation with real LLM calls.
 *
 * Validates that the contract test suites (middleware, resolver, engine)
 * work correctly against real implementations wired to actual API providers.
 *
 * Gated on API key + E2E_TESTS=1 — tests are skipped when either
 * is missing. E2E tests require API keys AND explicit opt-in via E2E_TESTS=1
 * to avoid rate-limit failures when 500+ test files run simultaneously.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun test tests/e2e/e2e-contracts.test.ts
 *
 * Cost: ~$0.02-0.05 per run (haiku + gpt-4o-mini, minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
} from "@koi/core";
import { notFound } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import type { Resolver, SourceBundle } from "@koi/core/resolver";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAuditMiddleware, createInMemoryAuditSink } from "@koi/middleware-audit";
import { createInMemoryStore, createMemoryMiddleware } from "@koi/middleware-memory";
import { createTurnAckMiddleware } from "@koi/middleware-turn-ack";
import { createAnthropicAdapter, createOpenAIAdapter } from "@koi/model-router";
import { testEngineAdapter, testMiddlewareContract, testResolverContract } from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_ANTHROPIC = ANTHROPIC_KEY.length > 0;
// E2E tests require API key AND explicit opt-in via E2E_TESTS=1 to avoid
// rate-limit failures when 500+ test files run in parallel.
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeAnthropic = HAS_ANTHROPIC && E2E_OPTED_IN ? describe : describe.skip;

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const HAS_OPENAI = OPENAI_KEY.length > 0;
const describeOpenAI = HAS_OPENAI && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_MODEL = "gpt-4o-mini";

// ---------------------------------------------------------------------------
// Shared provider adapters (lazy — only created when key is present)
// ---------------------------------------------------------------------------

// let justified: lazy singleton — created once on first access, avoids `as never`
let cachedAnthropic: ReturnType<typeof createAnthropicAdapter> | undefined;
function getAnthropicAdapter(): ReturnType<typeof createAnthropicAdapter> {
  if (!HAS_ANTHROPIC) throw new Error("ANTHROPIC_API_KEY not set");
  if (cachedAnthropic === undefined) {
    cachedAnthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  }
  return cachedAnthropic;
}

// let justified: lazy singleton — created once on first access, avoids `as never`
let cachedOpenai: ReturnType<typeof createOpenAIAdapter> | undefined;
function getOpenAIAdapter(): ReturnType<typeof createOpenAIAdapter> {
  if (!HAS_OPENAI) throw new Error("OPENAI_API_KEY not set");
  if (cachedOpenai === undefined) {
    cachedOpenai = createOpenAIAdapter({ apiKey: OPENAI_KEY });
  }
  return cachedOpenai;
}

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
// 1. Engine contract with real Anthropic calls
// ---------------------------------------------------------------------------

describeAnthropic("e2e: engine contract with real Anthropic adapter", () => {
  const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
    getAnthropicAdapter().complete({ ...request, model: ANTHROPIC_MODEL, maxTokens: 50 });

  testEngineAdapter({
    createAdapter: () => createLoopAdapter({ modelCall, maxTurns: 2 }),
    input: { kind: "text", text: "Reply with exactly one word: hello" },
    timeoutMs: TIMEOUT_MS,
  });
});

// ---------------------------------------------------------------------------
// 2. Middleware contract with a real pass-through middleware + Anthropic
// ---------------------------------------------------------------------------

describeAnthropic("e2e: middleware contract with real LLM-backed middleware", () => {
  /**
   * A middleware that actually intercepts real LLM calls.
   * Tracks call counts to prove interception happened.
   */
  function createTrackingMiddleware(): {
    readonly middleware: KoiMiddleware;
    readonly counts: {
      sessionStarts: number;
      sessionEnds: number;
      beforeTurns: number;
      afterTurns: number;
      modelCalls: number;
      toolCalls: number;
    };
  } {
    const counts = {
      sessionStarts: 0,
      sessionEnds: 0,
      beforeTurns: 0,
      afterTurns: 0,
      modelCalls: 0,
      toolCalls: 0,
    };

    const middleware: KoiMiddleware = {
      name: "e2e-tracking",
      priority: 500,

      onSessionStart: async () => {
        counts.sessionStarts += 1;
      },
      onSessionEnd: async () => {
        counts.sessionEnds += 1;
      },
      onBeforeTurn: async () => {
        counts.beforeTurns += 1;
      },
      onAfterTurn: async () => {
        counts.afterTurns += 1;
      },

      wrapModelCall: async (_ctx, request, next: ModelHandler) => {
        counts.modelCalls += 1;
        return next(request);
      },

      wrapModelStream: (_ctx, request, next: ModelStreamHandler): AsyncIterable<ModelChunk> => {
        // Note: can't increment here because stream is lazy;
        // increment happens on first chunk
        return next(request);
      },

      wrapToolCall: async (_ctx, request, next: ToolHandler) => {
        counts.toolCalls += 1;
        return next(request);
      },
    };

    return { middleware, counts };
  }

  // Run the standard contract suite against our tracking middleware
  testMiddlewareContract({
    createMiddleware: () => createTrackingMiddleware().middleware,
  });

  // Additional E2E test: verify middleware actually intercepts a real LLM call
  test(
    "middleware intercepts real LLM call through createKoi",
    async () => {
      const { middleware, counts } = createTrackingMiddleware();

      const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
        getAnthropicAdapter().complete({ ...request, model: ANTHROPIC_MODEL, maxTokens: 50 });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 2 });

      const runtime = await createKoi({
        manifest: { name: "e2e-test-agent", version: "0.0.1", model: { name: ANTHROPIC_MODEL } },
        adapter,
        middleware: [middleware],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

        // Verify middleware hooks actually fired
        expect(counts.sessionStarts).toBe(1);
        expect(counts.sessionEnds).toBe(1);
        expect(counts.beforeTurns).toBeGreaterThanOrEqual(1);
        expect(counts.afterTurns).toBeGreaterThanOrEqual(1);

        // Verify we got real LLM output
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
          expect(doneEvent.output.metrics.outputTokens).toBeGreaterThan(0);
        }
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. Resolver contract with a real in-memory resolver backed by LLM metadata
// ---------------------------------------------------------------------------

interface ToolMeta {
  readonly id: string;
  readonly name: string;
}

interface ToolFull {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/**
 * Creates a resolver that resolves "tools" backed by real data.
 * This tests the resolver contract against a non-trivial implementation
 * that could be backed by a database in production.
 */
function createLiveToolResolver(): Resolver<ToolMeta, ToolFull> {
  const store = new Map<string, ToolFull>([
    ["calc", { id: "calc", name: "Calculator", description: "Basic arithmetic" }],
    ["search", { id: "search", name: "Web Search", description: "Search the web" }],
  ]);

  const listeners = new Set<() => void>();

  return {
    discover: async (): Promise<readonly ToolMeta[]> =>
      [...store.values()].map((t) => ({ id: t.id, name: t.name })),

    load: async (id: string): Promise<Result<ToolFull, KoiError>> => {
      const item = store.get(id);
      if (item === undefined) {
        return { ok: false, error: notFound(id) };
      }
      return { ok: true, value: item };
    },

    onChange: (listener: () => void): (() => void) => {
      listeners.add(listener);
      let removed = false; // let: toggled in unsubscribe closure
      return (): void => {
        if (removed) return;
        removed = true;
        listeners.delete(listener);
      };
    },

    source: async (id: string): Promise<Result<SourceBundle, KoiError>> => {
      if (!store.has(id)) {
        return { ok: false, error: notFound(id) };
      }
      return {
        ok: true,
        value: { content: `// Tool source for ${id}`, language: "typescript" },
      };
    },
  };
}

describe("e2e: resolver contract with live tool resolver", () => {
  testResolverContract<ToolMeta, ToolFull>({
    createResolver: createLiveToolResolver,
    seedItems: [
      { id: "calc", name: "Calculator" },
      { id: "search", name: "Web Search" },
    ],
    getId: (meta) => meta.id,
  });
});

// ---------------------------------------------------------------------------
// 4. Full-stack: middleware interposition on real streaming LLM call
// ---------------------------------------------------------------------------

describeAnthropic("e2e: full-stack middleware interposition with streaming", () => {
  test(
    "wrapModelCall intercepts and can observe real Anthropic response",
    async () => {
      const interceptedModels: string[] = [];

      const observerMiddleware: KoiMiddleware = {
        name: "e2e-observer",
        wrapModelCall: async (_ctx, request, next) => {
          const response = await next(request);
          interceptedModels.push(response.model);
          return response;
        },
      };

      const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
        getAnthropicAdapter().complete({ ...request, model: ANTHROPIC_MODEL, maxTokens: 30 });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-observer-agent",
          version: "0.0.1",
          model: { name: ANTHROPIC_MODEL },
        },
        adapter,
        middleware: [observerMiddleware],
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Say hi" }));

        // Middleware observed the real model name
        expect(interceptedModels.length).toBeGreaterThanOrEqual(1);
        const firstModel = interceptedModels[0];
        expect(firstModel).toBeDefined();
        if (firstModel !== undefined) {
          expect(firstModel).toContain("claude");
        }
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "multiple middleware compose correctly on real calls",
    async () => {
      const order: string[] = [];

      const first: KoiMiddleware = {
        name: "e2e-first",
        priority: 100,
        onSessionStart: async () => {
          order.push("first:start");
        },
        onSessionEnd: async () => {
          order.push("first:end");
        },
        wrapModelCall: async (_ctx, request, next) => {
          order.push("first:before-model");
          const response = await next(request);
          order.push("first:after-model");
          return response;
        },
      };

      const second: KoiMiddleware = {
        name: "e2e-second",
        priority: 200,
        onSessionStart: async () => {
          order.push("second:start");
        },
        onSessionEnd: async () => {
          order.push("second:end");
        },
        wrapModelCall: async (_ctx, request, next) => {
          order.push("second:before-model");
          const response = await next(request);
          order.push("second:after-model");
          return response;
        },
      };

      const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
        getAnthropicAdapter().complete({ ...request, model: ANTHROPIC_MODEL, maxTokens: 10 });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: { name: "e2e-compose-agent", version: "0.0.1", model: { name: ANTHROPIC_MODEL } },
        adapter,
        middleware: [second, first], // Pass out of order — engine sorts by priority
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "OK" }));

        // Session hooks: priority order (100 before 200)
        expect(order[0]).toBe("first:start");
        expect(order[1]).toBe("second:start");

        // Model call onion: outer (first) wraps inner (second)
        const modelIdx = order.indexOf("first:before-model");
        expect(modelIdx).toBeGreaterThan(-1);
        expect(order[modelIdx + 1]).toBe("second:before-model");
        expect(order[modelIdx + 2]).toBe("second:after-model");
        expect(order[modelIdx + 3]).toBe("first:after-model");

        // Session end: priority order
        expect(order[order.length - 2]).toBe("first:end");
        expect(order[order.length - 1]).toBe("second:end");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 5. OpenAI engine contract with real OpenAI calls
// ---------------------------------------------------------------------------

describeOpenAI("e2e: engine contract with real OpenAI adapter", () => {
  const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
    getOpenAIAdapter().complete({ ...request, model: OPENAI_MODEL, maxTokens: 50 });

  testEngineAdapter({
    createAdapter: () => createLoopAdapter({ modelCall, maxTurns: 2 }),
    input: { kind: "text", text: "Reply with exactly one word: hello" },
    timeoutMs: TIMEOUT_MS,
  });
});

// ---------------------------------------------------------------------------
// 6. OpenAI middleware interposition
// ---------------------------------------------------------------------------

describeOpenAI("e2e: middleware interposition with real OpenAI adapter", () => {
  test(
    "wrapModelCall intercepts and can observe real OpenAI response",
    async () => {
      const interceptedModels: string[] = [];

      const observerMiddleware: KoiMiddleware = {
        name: "e2e-openai-observer",
        wrapModelCall: async (_ctx, request, next) => {
          const response = await next(request);
          interceptedModels.push(response.model);
          return response;
        },
      };

      const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
        getOpenAIAdapter().complete({ ...request, model: OPENAI_MODEL, maxTokens: 30 });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: { name: "e2e-openai-agent", version: "0.0.1", model: { name: OPENAI_MODEL } },
        adapter,
        middleware: [observerMiddleware],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hi" }));

        // Middleware observed the real model name
        expect(interceptedModels.length).toBeGreaterThanOrEqual(1);
        const firstModel = interceptedModels[0];
        expect(firstModel).toBeDefined();
        if (firstModel !== undefined) {
          expect(firstModel).toContain("gpt");
        }

        // Verify we got a done event
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 7. Middleware combination matrix with real LLM calls
// ---------------------------------------------------------------------------

describeAnthropic("e2e: middleware combination matrix", () => {
  /**
   * Tests that real middleware packages compose correctly when stacked.
   * Uses audit (priority 300), memory (400), and turn-ack (50) —
   * three different priorities, three different hook patterns.
   */
  test(
    "audit + memory + turn-ack compose without interference",
    async () => {
      const auditSink = createInMemoryAuditSink();
      const memoryStore = createInMemoryStore();

      const audit = createAuditMiddleware({ sink: auditSink });
      const memory = createMemoryMiddleware({ store: memoryStore });
      const turnAck = createTurnAckMiddleware({ debounceMs: 10 });

      const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
        getAnthropicAdapter().complete({ ...request, model: ANTHROPIC_MODEL, maxTokens: 30 });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: { name: "e2e-matrix-agent", version: "0.0.1", model: { name: ANTHROPIC_MODEL } },
        adapter,
        middleware: [audit, memory, turnAck],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

        // Verify we got a successful completion
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Audit middleware captured entries
        expect(auditSink.entries.length).toBeGreaterThanOrEqual(1);
        const modelEntry = auditSink.entries.find((e) => e.kind === "model_call");
        expect(modelEntry).toBeDefined();
        expect(modelEntry?.durationMs).toBeGreaterThanOrEqual(0);

        // Memory middleware stored the exchange
        const recalled = await memoryStore.recall("hello", 4000);
        expect(recalled.length).toBeGreaterThanOrEqual(1);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "audit + turn-ack pair: audit logs session lifecycle",
    async () => {
      const auditSink = createInMemoryAuditSink();

      const audit = createAuditMiddleware({ sink: auditSink });
      const turnAck = createTurnAckMiddleware({ debounceMs: 10 });

      const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
        getAnthropicAdapter().complete({ ...request, model: ANTHROPIC_MODEL, maxTokens: 10 });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: { name: "e2e-pair-agent", version: "0.0.1", model: { name: ANTHROPIC_MODEL } },
        adapter,
        middleware: [audit, turnAck],
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "OK" }));

        // Audit captured session lifecycle + model call
        const kinds = auditSink.entries.map((e) => e.kind);
        expect(kinds).toContain("session_start");
        expect(kinds).toContain("session_end");
        expect(kinds).toContain("model_call");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "memory + audit: both operate independently on the same call",
    async () => {
      const auditSink = createInMemoryAuditSink();
      const memoryStore = createInMemoryStore();

      // Pre-seed a memory so it gets injected by memory middleware
      await memoryStore.store("pre-seed", "The user likes TypeScript");

      const audit = createAuditMiddleware({ sink: auditSink });
      const memory = createMemoryMiddleware({ store: memoryStore });

      const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
        getAnthropicAdapter().complete({ ...request, model: ANTHROPIC_MODEL, maxTokens: 30 });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: { name: "e2e-enrich-agent", version: "0.0.1", model: { name: ANTHROPIC_MODEL } },
        adapter,
        middleware: [audit, memory],
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "What do I like?" }));

        // Audit captured the model call (outer middleware, sees original request)
        const modelEntry = auditSink.entries.find((e) => e.kind === "model_call");
        expect(modelEntry).toBeDefined();
        expect(modelEntry?.response).toBeDefined();
        expect(modelEntry?.durationMs).toBeGreaterThanOrEqual(0);

        // Memory stored the model response for future recall
        // (the pre-seeded entry + the new exchange)
        const recalled = await memoryStore.recall("TypeScript", 4000);
        expect(recalled.length).toBeGreaterThanOrEqual(1);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
