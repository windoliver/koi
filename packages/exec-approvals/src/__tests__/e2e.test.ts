/**
 * E2E tests for @koi/exec-approvals through the full createKoi path.
 *
 * Part 1 (describeE2E) — real Pi adapter + real LLM calls:
 *   Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *   Smoke-tests that the middleware integrates cleanly with a live LLM call.
 *   Run: E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e.test.ts
 *
 * Part 2 (describe) — createKoi integration via cooperating adapter (no LLM):
 *   Runs always. Full middleware chain through L1. Covers:
 *     - All 5 ProgressiveDecision variants (allow_once/session/always, deny_once/always)
 *     - Session isolation (A's allow_session doesn't leak to B)
 *     - Cross-session persistence (allow_always via shared store)
 *     - Base deny security invariant (absolute, cannot be overridden)
 *     - Timeout on approval
 *     - Store failure resilience (load/save errors)
 *     - Compound pattern matching (tool:command prefix)
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { ExecApprovalRequest, ProgressiveDecision } from "../index.js";
import { createExecApprovalsMiddleware, createInMemoryRulesStore } from "../index.js";

// ---------------------------------------------------------------------------
// Environment gate (Part 1 only)
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

// ---------------------------------------------------------------------------
// add_numbers tool — used in both parts
// ---------------------------------------------------------------------------

const ADD_NUMBERS_DESCRIPTOR = {
  name: "add_numbers",
  description: "Adds two integers together and returns the sum.",
  inputSchema: {
    type: "object" as const,
    properties: {
      a: { type: "integer" as const, description: "First number" },
      b: { type: "integer" as const, description: "Second number" },
    },
    required: ["a", "b"],
  },
};

function makeAddNumbersProvider(onExecute?: () => void): {
  readonly name: string;
  readonly attach: () => Promise<Map<string, unknown>>;
} {
  return {
    name: "add-numbers-provider",
    attach: async () =>
      new Map([
        [
          toolToken("add_numbers") as string,
          {
            descriptor: ADD_NUMBERS_DESCRIPTOR,
            trustTier: "verified" as const,
            execute: async (input: unknown) => {
              onExecute?.();
              const { a, b } = input as { readonly a: number; readonly b: number };
              return String(a + b);
            },
          },
        ],
      ]),
  };
}

// ---------------------------------------------------------------------------
// Cooperating adapter helpers (Part 2 — no real LLM)
// ---------------------------------------------------------------------------

function makeDoneOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
  };
}

/**
 * Creates a cooperating adapter that calls callHandlers.toolCall() for each
 * entry in `calls`, then emits done. If any call throws, the error propagates
 * out of the async generator, which createKoi catches and converts to
 * done { stopReason: "error" }.
 */
function makeCooperatingAdapter(
  calls: ReadonlyArray<{ readonly toolId: string; readonly input?: Record<string, unknown> }>,
): EngineAdapter {
  return {
    engineId: "e2e-cooperating",
    terminals: {
      modelCall: async () => ({ content: "ok", model: "test" }),
    },
    stream: (input: EngineInput) => ({
      async *[Symbol.asyncIterator]() {
        if (input.callHandlers) {
          for (const call of calls) {
            await input.callHandlers.toolCall({ toolId: call.toolId, input: call.input ?? {} });
          }
        }
        yield { kind: "done" as const, output: makeDoneOutput() };
      },
    }),
  };
}

const BASE_MANIFEST: AgentManifest = {
  name: "exec-approvals-e2e",
  version: "1.0.0",
  model: { name: "test-model" },
};

// ---------------------------------------------------------------------------
// Part 1: Real Pi adapter + real LLM
// ---------------------------------------------------------------------------

describeE2E("e2e: exec-approvals + Pi adapter (real LLM)", () => {
  // ── Test 1: Allow pattern — tool executes, no onAsk call ─────────────────

  test(
    "allow pattern: tool executes without calling onAsk",
    async () => {
      let askCalled = false;
      let toolExecuted = false;

      const middleware = createExecApprovalsMiddleware({
        rules: { allow: ["add_numbers"], deny: [], ask: [] },
        onAsk: async () => {
          askCalled = true;
          return { kind: "allow_once" };
        },
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-allow-test",
          version: "1.0.0",
          model: { name: "claude-haiku" },
        },
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt:
            "You MUST use the add_numbers tool for any arithmetic. Do not compute in your head.",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        middleware: [middleware],
        providers: [
          makeAddNumbersProvider(() => {
            toolExecuted = true;
          }),
        ],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 110_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 7 + 5. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Tool should have run, onAsk should never fire
      expect(toolExecuted).toBe(true);
      expect(askCalled).toBe(false);

      // LLM should mention the result in its response
      const text = extractText(events);
      expect(text).toContain("12");
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Ask → allow_once — onAsk fires, tool runs ────────────────────

  test(
    "ask → allow_once: onAsk fires and tool executes for the real LLM call",
    async () => {
      let askCallCount = 0;
      let capturedRequest: ExecApprovalRequest | undefined;

      const middleware = createExecApprovalsMiddleware({
        rules: { allow: [], deny: [], ask: ["add_numbers"] },
        onAsk: async (req) => {
          askCallCount++;
          capturedRequest = req;
          return { kind: "allow_once" };
        },
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-ask-once-test",
          version: "1.0.0",
          model: { name: "claude-haiku" },
        },
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt:
            "You MUST use the add_numbers tool for any arithmetic. Do not compute in your head.",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        middleware: [middleware],
        providers: [makeAddNumbersProvider()],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 110_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 3 + 4. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // onAsk must have been called at least once
      expect(askCallCount).toBeGreaterThanOrEqual(1);
      expect(capturedRequest?.toolId).toBe("add_numbers");
      expect(capturedRequest?.matchedPattern).toBe("add_numbers");

      const text = extractText(events);
      expect(text).toContain("7");
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Deny rule — onAsk never fires, tool never executes ───────────
  //
  // We can't deterministically force the LLM to call the tool, so we verify
  // the invariants that hold regardless of whether the LLM calls it:
  //   - onAsk is NEVER invoked when a tool is in the deny list
  //   - the tool's execute() is NEVER called when denied
  // If the LLM does try the tool → PERMISSION → stopReason=error.
  // If the LLM answers directly → stopReason=completed.
  // Both outcomes are acceptable here; the invariants are what matter.

  test(
    "deny rule: onAsk never called and tool never executed regardless of LLM behavior",
    async () => {
      let askCalled = false;
      let toolExecuted = false;

      const middleware = createExecApprovalsMiddleware({
        rules: { allow: [], deny: ["add_numbers"], ask: [] },
        onAsk: async () => {
          askCalled = true;
          return { kind: "allow_once" };
        },
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-deny-test",
          version: "1.0.0",
          model: { name: "claude-haiku" },
        },
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt:
            "You MUST use the add_numbers tool for any arithmetic. Do not compute in your head.",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        middleware: [middleware],
        providers: [
          makeAddNumbersProvider(() => {
            toolExecuted = true;
          }),
        ],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 110_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the add_numbers tool to compute 7 + 5. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      // Core invariants: deny blocks tool execution and preempts onAsk
      expect(toolExecuted).toBe(false);
      expect(askCalled).toBe(false);
      // stopReason is "error" if LLM tried the tool, "completed" if it answered directly
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Part 2: Full createKoi integration via cooperating adapter
// ---------------------------------------------------------------------------

describe("exec-approvals middleware integration via createKoi (cooperating adapter)", () => {
  // ── Basic allow/deny/default-deny ─────────────────────────────────────────

  test("allow pattern: tool executes without onAsk", async () => {
    let toolExecuted = false;
    let askCalled = false;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: ["add_numbers"], deny: [], ask: [] },
      onAsk: async () => {
        askCalled = true;
        return { kind: "allow_once" };
      },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 7, b: 5 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");
    expect(toolExecuted).toBe(true);
    expect(askCalled).toBe(false);
  });

  test("deny pattern: tool blocked, done.stopReason=error, onAsk not called", async () => {
    let toolExecuted = false;
    let askCalled = false;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: ["add_numbers"], ask: [] },
      onAsk: async () => {
        askCalled = true;
        return { kind: "allow_once" };
      },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 7, b: 5 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("error");
    expect(toolExecuted).toBe(false);
    expect(askCalled).toBe(false);
  });

  test("default deny: unmatched tool is blocked", async () => {
    let toolExecuted = false;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: [] },
      onAsk: async () => ({ kind: "allow_once" }),
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("error");
    expect(toolExecuted).toBe(false);
  });

  // ── Ask → all 5 ProgressiveDecision variants ─────────────────────────────

  test("ask → allow_once: tool runs, onAsk called with correct request", async () => {
    let toolExecuted = false;
    let capturedReq: ExecApprovalRequest | undefined;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async (req) => {
        capturedReq = req;
        return { kind: "allow_once" };
      },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 3, b: 4 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");
    expect(toolExecuted).toBe(true);
    expect(capturedReq?.toolId).toBe("add_numbers");
    expect(capturedReq?.matchedPattern).toBe("add_numbers");
  });

  test("ask → allow_session: subsequent calls in same session skip onAsk", async () => {
    let askCallCount = 0;
    let toolExecuteCount = 0;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => {
        askCallCount++;
        return { kind: "allow_session", pattern: "add_numbers" };
      },
    });

    // Two calls to add_numbers in the same session
    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([
        { toolId: "add_numbers", input: { a: 1, b: 2 } },
        { toolId: "add_numbers", input: { a: 3, b: 4 } },
      ]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuteCount++;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");
    expect(toolExecuteCount).toBe(2);
    // onAsk only fires once — second call uses session allow
    expect(askCallCount).toBe(1);
  });

  test("ask → allow_always: tool runs and pattern saved to store", async () => {
    let toolExecuted = false;
    let saveCallCount = 0;
    const store = createInMemoryRulesStore();
    const originalSave = store.save.bind(store);
    const spyStore = {
      load: store.load.bind(store),
      save: async (rules: Parameters<typeof originalSave>[0]) => {
        saveCallCount++;
        return originalSave(rules);
      },
    };

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => ({ kind: "allow_always", pattern: "add_numbers" }),
      store: spyStore,
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 5, b: 6 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");
    expect(toolExecuted).toBe(true);
    expect(saveCallCount).toBe(1);

    // Verify the store now contains the persisted pattern
    const persisted = await store.load();
    expect(persisted.allow).toContain("add_numbers");
  });

  test("ask → deny_once: tool blocked, no state change, next call asks again", async () => {
    let askCallCount = 0;
    let toolExecuted = false;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => {
        askCallCount++;
        return { kind: "deny_once", reason: "test denial" };
      },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      // First call will be denied (deny_once, no state change)
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("error");
    expect(toolExecuted).toBe(false);
    expect(askCallCount).toBe(1);

    // Since deny_once doesn't accumulate state, a NEW session will ask again
    const _secondSessionAskCount = 0;
    const runtime2 = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 3, b: 4 } }]),
      middleware: [middleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });

    // Override decision for second session — allow this time
    // But the spied askCallCount will increment
    // (We can't easily override the middleware decision here, so just check count increments)
    await collectEvents(runtime2.run({ kind: "text", text: "test" }));
    // onAsk was called for the second session too (deny_once left no state)
    expect(askCallCount).toBe(2);
  });

  test("ask → deny_always: pattern saved, future calls in same session blocked without asking", async () => {
    let askCallCount = 0;
    let toolExecuted = false;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => {
        askCallCount++;
        return { kind: "deny_always", pattern: "add_numbers", reason: "always denied" };
      },
    });

    // First call: deny_always fires, adds to extraDeny
    const runtime1 = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events1 = await collectEvents(runtime1.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events1)?.stopReason).toBe("error");
    expect(toolExecuted).toBe(false);
    expect(askCallCount).toBe(1);

    // Second call in new session: store has the deny, onAsk should NOT fire
    // (session extraDeny is populated from store on session start)
    const runtime2 = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 3, b: 4 } }]),
      middleware: [middleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });

    const events2 = await collectEvents(runtime2.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events2)?.stopReason).toBe("error");
    // onAsk NOT called again — the persisted deny blocked it before the ask step
    expect(askCallCount).toBe(1);
  });

  // ── Security invariant ────────────────────────────────────────────────────

  test("base deny is absolute: fires before ask, onAsk is never called", async () => {
    let askCalled = false;

    const middleware = createExecApprovalsMiddleware({
      // Both deny AND ask for add_numbers — deny must fire first (evaluation step 1 vs 5)
      rules: { allow: [], deny: ["add_numbers"], ask: ["add_numbers"] },
      onAsk: async () => {
        askCalled = true;
        return { kind: "allow_once" };
      },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 2, b: 3 } }]),
      middleware: [middleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events)?.stopReason).toBe("error");
    // Base deny checked at step 1 — ask rule at step 5 never fires
    expect(askCalled).toBe(false);
  });

  // ── Session isolation ─────────────────────────────────────────────────────

  test("session isolation: allow_session in session A does not affect session B", async () => {
    let askCallCount = 0;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => {
        askCallCount++;
        return { kind: "allow_session", pattern: "add_numbers" };
      },
    });

    // Session A: two calls, only one ask (second uses session allow)
    const runtimeA = await createKoi({
      manifest: { ...BASE_MANIFEST, name: "session-a" },
      adapter: makeCooperatingAdapter([
        { toolId: "add_numbers", input: { a: 1, b: 2 } },
        { toolId: "add_numbers", input: { a: 3, b: 4 } },
      ]),
      middleware: [middleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });
    await collectEvents(runtimeA.run({ kind: "text", text: "test" }));
    expect(askCallCount).toBe(1); // A asked only once (second call used session allow)

    // Session B: starts fresh — no session state from A, ask fires again
    const runtimeB = await createKoi({
      manifest: { ...BASE_MANIFEST, name: "session-b" },
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 5, b: 6 } }]),
      middleware: [middleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });
    await collectEvents(runtimeB.run({ kind: "text", text: "test" }));
    // Session B is isolated — its tool call triggers a fresh ask
    expect(askCallCount).toBe(2);
  });

  // ── Cross-session persistence via allow_always ────────────────────────────

  test("allow_always persists across sessions via shared store", async () => {
    const sharedStore = createInMemoryRulesStore();
    let askCallCount = 0;

    // Session 1: ask fires, allow_always saves to shared store
    const mw1 = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => {
        askCallCount++;
        return { kind: "allow_always", pattern: "add_numbers" };
      },
      store: sharedStore,
    });

    const runtime1 = await createKoi({
      manifest: { ...BASE_MANIFEST, name: "persist-session-1" },
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [mw1],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });
    const events1 = await collectEvents(runtime1.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events1)?.stopReason).toBe("completed");
    expect(askCallCount).toBe(1);

    // Session 2: different middleware instance, same shared store
    // onSessionStart loads store → extraAllow has "add_numbers" → no ask
    const mw2 = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => {
        askCallCount++;
        return { kind: "allow_once" };
      },
      store: sharedStore,
    });

    const runtime2 = await createKoi({
      manifest: { ...BASE_MANIFEST, name: "persist-session-2" },
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 3, b: 4 } }]),
      middleware: [mw2],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });
    const events2 = await collectEvents(runtime2.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events2)?.stopReason).toBe("completed");
    // No second ask — persisted pattern loaded from store
    expect(askCallCount).toBe(1);
  });

  // ── Session lifecycle hooks ───────────────────────────────────────────────

  test("onSessionStart and onSessionEnd are called exactly once per session", async () => {
    let sessionStartCount = 0;
    let sessionEndCount = 0;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: ["add_numbers"], deny: [], ask: [] },
      onAsk: async () => ({ kind: "allow_once" }),
    });

    // We verify lifecycle by adding a second tracking middleware alongside exec-approvals
    const trackingMiddleware = {
      name: "session-tracker",
      describeCapabilities: () => undefined,
      priority: 200,
      onSessionStart: async () => {
        sessionStartCount++;
      },
      onSessionEnd: async () => {
        sessionEndCount++;
      },
    };

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware, trackingMiddleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(sessionStartCount).toBe(1);
    expect(sessionEndCount).toBe(1);
  });

  // ── Error resilience ──────────────────────────────────────────────────────

  test("store.load failure: onLoadError called, session proceeds with empty state", async () => {
    let loadErrorCalled = false;
    let capturedLoadError: unknown;
    let askCalled = false;

    const failingStore = {
      load: async () => {
        throw new Error("disk unavailable");
      },
      save: async () => {},
    };

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => {
        askCalled = true;
        return { kind: "allow_once" };
      },
      store: failingStore,
      onLoadError: (e) => {
        loadErrorCalled = true;
        capturedLoadError = e;
      },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    // Session should proceed (load failure → empty state, tool gets asked)
    expect(loadErrorCalled).toBe(true);
    expect((capturedLoadError as Error).message).toBe("disk unavailable");
    expect(askCalled).toBe(true);
    expect(output?.stopReason).toBe("completed");
  });

  test("store.save failure: onSaveError called, allow_always tool call still succeeds", async () => {
    let saveErrorCalled = false;
    let toolExecuted = false;

    const failingStore = {
      load: async () => ({ allow: [], deny: [] }),
      save: async () => {
        throw new Error("write permission denied");
      },
    };

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () => ({ kind: "allow_always", pattern: "add_numbers" }),
      store: failingStore,
      onSaveError: () => {
        saveErrorCalled = true;
      },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    // Save failed, but the tool call must still succeed
    expect(saveErrorCalled).toBe(true);
    expect(toolExecuted).toBe(true);
    expect(output?.stopReason).toBe("completed");
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  test("onAsk timeout: approval times out, session ends with error", async () => {
    const middleware = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["add_numbers"] },
      onAsk: async () =>
        new Promise<ProgressiveDecision>((resolve) =>
          setTimeout(() => resolve({ kind: "allow_once" }), 500),
        ),
      approvalTimeoutMs: 50, // 50ms timeout, onAsk takes 500ms → always times out
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware],
      providers: [makeAddNumbersProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const output = findDoneOutput(events);
    // Timeout → TIMEOUT KoiRuntimeError → koi.ts maps TIMEOUT code to "max_turns"
    expect(output?.stopReason).toBe("max_turns");
  });

  // ── Compound pattern matching ─────────────────────────────────────────────

  test("compound pattern: bash:git* allows matching commands, blocks others", async () => {
    let gitStatusExecuted = false;
    let gitPushExecuted = false;

    // Register two bash tools: one with command "git status", one with "rm -rf /"
    const bashProvider = {
      name: "bash-provider",
      attach: async () =>
        new Map([
          [
            toolToken("bash") as string,
            {
              descriptor: {
                name: "bash",
                description: "Execute a bash command.",
                inputSchema: {
                  type: "object" as const,
                  properties: { command: { type: "string" as const } },
                  required: ["command"],
                },
              },
              trustTier: "verified" as const,
              execute: async (input: unknown) => {
                const { command } = input as { readonly command: string };
                if (command.startsWith("git")) gitStatusExecuted = true;
                if (command.startsWith("rm")) gitPushExecuted = true;
                return `executed: ${command}`;
              },
            },
          ],
        ]),
    };

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: ["bash:git*"], deny: [], ask: [] },
      onAsk: async () => ({ kind: "allow_once" }),
    });

    // Call 1: bash with "git status" — matches bash:git* → allowed
    const runtime1 = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "bash", input: { command: "git status" } }]),
      middleware: [middleware],
      providers: [bashProvider],
      loopDetection: false,
    });
    const events1 = await collectEvents(runtime1.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events1)?.stopReason).toBe("completed");
    expect(gitStatusExecuted).toBe(true);

    // Call 2: bash with "rm -rf /" — does NOT match bash:git* → default deny
    const runtime2 = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "bash", input: { command: "rm -rf /" } }]),
      middleware: [middleware],
      providers: [bashProvider],
      loopDetection: false,
    });
    const events2 = await collectEvents(runtime2.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events2)?.stopReason).toBe("error");
    expect(gitPushExecuted).toBe(false);
  });

  test("wildcard allow * matches any tool", async () => {
    let toolExecuted = false;

    const middleware = createExecApprovalsMiddleware({
      rules: { allow: ["*"], deny: [], ask: [] },
      onAsk: async () => ({ kind: "allow_once" }),
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          toolExecuted = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");
    expect(toolExecuted).toBe(true);
  });
});
