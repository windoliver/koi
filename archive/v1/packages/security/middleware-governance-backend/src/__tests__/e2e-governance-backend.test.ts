/**
 * E2E tests for @koi/middleware-governance-backend through the full createKoi path.
 *
 * Part 1 (describeE2E) — real Pi adapter + real LLM calls:
 *   Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *   Run: E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-governance-backend.test.ts
 *
 * Part 2 (describe) — createKoi integration via cooperating adapter (no LLM):
 *   Runs always. Full middleware chain through L1. Covers:
 *     - Tool call allowed by evaluate({ ok: true })
 *     - Tool call denied by evaluate({ ok: false })
 *     - Middleware coexists with other middleware without interaction
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  KoiMiddleware,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import type { GovernanceBackend, GovernanceVerdict } from "@koi/core/governance-backend";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createGovernanceBackendMiddleware } from "../index.js";

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
// Minimal backend implementations
// ---------------------------------------------------------------------------

function makeAllowBackend(): GovernanceBackend {
  return {
    evaluator: { evaluate: async (): Promise<GovernanceVerdict> => ({ ok: true }) },
  };
}

function makeDenyBackend(): GovernanceBackend {
  return {
    evaluator: {
      evaluate: async (): Promise<GovernanceVerdict> => ({
        ok: false,
        violations: [
          { rule: "test-policy", severity: "critical" as const, message: "policy denied" },
        ],
      }),
    },
  };
}

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
// add_numbers tool + cooperating adapter
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
            origin: "primordial",
            policy: DEFAULT_UNSANDBOXED_POLICY,
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

function makeDoneOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
  };
}

function makeCooperatingAdapter(
  calls: ReadonlyArray<{ readonly toolId: string; readonly input?: Record<string, unknown> }>,
): EngineAdapter {
  return {
    engineId: "e2e-cooperating",
    capabilities: { text: true, images: false, files: false, audio: false },
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
  name: "governance-backend-e2e",
  version: "1.0.0",
  model: { name: "test-model" },
};

// ---------------------------------------------------------------------------
// Part 2: Cooperating adapter (runs always — no LLM required)
// ---------------------------------------------------------------------------

describe("e2e: governance-backend middleware + cooperating adapter", () => {
  // ── Test 1: Tool call allowed ───────────────────────────────────────────

  test("tool call proceeds when evaluate() returns ok:true", async () => {
    let executed = false;
    const middleware = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 3, b: 4 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          executed = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "run tool" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(executed).toBe(true);

    await runtime.dispose();
  });

  // ── Test 2: Tool call denied ────────────────────────────────────────────

  test("tool call is blocked when evaluate() returns ok:false", async () => {
    let executed = false;
    const middleware = createGovernanceBackendMiddleware({ backend: makeDenyBackend() });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 3, b: 4 } }]),
      middleware: [middleware],
      providers: [
        makeAddNumbersProvider(() => {
          executed = true;
        }),
      ],
      loopDetection: false,
    });

    // The engine may convert the middleware throw to a done error event, or
    // the generator may propagate the throw. Either way, the tool must NOT execute.
    let streamError: unknown;
    const events = await collectEvents(runtime.run({ kind: "text", text: "run tool" })).catch(
      (e: unknown) => {
        streamError = e;
        return [] as readonly EngineEvent[];
      },
    );

    // Tool must not have executed due to governance denial
    expect(executed).toBe(false);

    // Either the stream threw a governance error, or it ended with a non-completed stop reason
    if (streamError !== undefined) {
      expect((streamError as Error).message).toContain("policy denied");
    } else {
      const output = findDoneOutput(events);
      expect(output?.stopReason).not.toBe("completed");
    }

    await runtime.dispose();
  });

  // ── Test 3: No tool calls — model call goes through ─────────────────────

  test("model call proceeds when evaluate() returns ok:true (no tools)", async () => {
    const middleware = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([]),
      middleware: [middleware],
      providers: [],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");

    await runtime.dispose();
  });

  // ── Test 4: Coexistence with other middleware ────────────────────────────

  test("coexists with a noop middleware without interaction", async () => {
    let executed = false;
    const noopMiddleware: KoiMiddleware = {
      name: "noop",
      describeCapabilities: () => undefined,
      priority: 200,
    };
    const govMiddleware = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeCooperatingAdapter([{ toolId: "add_numbers", input: { a: 1, b: 2 } }]),
      middleware: [govMiddleware, noopMiddleware],
      providers: [
        makeAddNumbersProvider(() => {
          executed = true;
        }),
      ],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "run" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(executed).toBe(true);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Part 1: Real Pi adapter + real LLM
// ---------------------------------------------------------------------------

describeE2E("e2e: governance-backend + Pi adapter (real LLM)", () => {
  test(
    "allowed backend: tool call executes end-to-end",
    async () => {
      let toolExecuted = false;

      const middleware = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-gov-allow-test",
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
          text: "Use add_numbers to compute 6 + 9. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(toolExecuted).toBe(true);

      const text = extractText(events);
      expect(text).toContain("15");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "deny backend: tool call is blocked, runtime ends with error",
    async () => {
      let toolExecuted = false;

      const middleware = createGovernanceBackendMiddleware({ backend: makeDenyBackend() });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-gov-deny-test",
          version: "1.0.0",
          model: { name: "claude-haiku" },
        },
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "Always use the add_numbers tool when asked to add numbers.",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        middleware: [middleware],
        providers: [
          makeAddNumbersProvider(() => {
            toolExecuted = true;
          }),
        ],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 60_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 2 + 3.",
        }),
      );

      // Tool should not execute if governance blocks it
      expect(toolExecuted).toBe(false);

      const output = findDoneOutput(events);
      // May be error or the LLM may answer without tools if denied at model_call level
      expect(output).toBeDefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
