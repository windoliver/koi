/**
 * Engine-external end-to-end validation.
 *
 * Tests @koi/engine-external through three tiers:
 *
 * 1. **Standalone**: createExternalAdapter with real processes (echo, cat, sh)
 *    to validate adapter mechanics in isolation.
 *
 * 2. **Through createKoi**: External adapter wired through the full L1 runtime
 *    assembly (middleware composition, lifecycle hooks, guards) to validate
 *    that engine-external satisfies the EngineAdapter contract end-to-end.
 *
 * 3. **With real LLM**: A shell script that calls the Anthropic API via curl,
 *    wired through createKoi, proving that engine-external can wrap a real
 *    LLM-backed CLI tool as an agent backend.
 *
 * Tier 3 is gated on ANTHROPIC_API_KEY — skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/engine-external-e2e.test.ts
 *
 * Cost: ~$0.01 per run (single haiku call via curl).
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, KoiMiddleware } from "@koi/core";
import { createKoi } from "@koi/engine";
import {
  createExternalAdapter,
  createJsonLinesParser,
  createLineParser,
} from "@koi/engine-external";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeLLM = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const MODEL_NAME = "claude-haiku-4-5-20251001";

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

function findDone(
  events: readonly EngineEvent[],
): Extract<EngineEvent, { readonly kind: "done" }> | undefined {
  return events.find(
    (e): e is Extract<EngineEvent, { readonly kind: "done" }> => e.kind === "done",
  );
}

// ---------------------------------------------------------------------------
// Tier 1: Standalone adapter with real processes
// ---------------------------------------------------------------------------

describe("e2e: engine-external standalone", () => {
  test("echo produces text_delta + done(completed)", async () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["hello e2e"] });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    const text = textDeltas.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");
    expect(text).toContain("hello e2e");

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.metrics.totalTokens).toBe(0);
    expect(done.output.metrics.durationMs).toBeGreaterThanOrEqual(0);

    await adapter.dispose?.();
  });

  test("cat in long-lived mode: multi-turn write/read cycle", async () => {
    const adapter = createExternalAdapter({
      command: "cat",
      mode: "long-lived",
      timeoutMs: 5000,
      parser: createLineParser((line) => {
        if (line.trim() === "END") return { events: [], turnComplete: true };
        if (line.trim().length === 0) return undefined;
        return { events: [{ kind: "text_delta" as const, delta: line }] };
      }),
    });

    // Turn 1
    const events1 = await collectEvents(adapter.stream({ kind: "text", text: "turn-one\nEND" }));
    const done1 = findDone(events1);
    expect(done1?.output.stopReason).toBe("completed");

    const text1 = events1
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.delta : ""))
      .join("");
    expect(text1).toContain("turn-one");

    // Turn 2 — same process, fresh parser
    const events2 = await collectEvents(adapter.stream({ kind: "text", text: "turn-two\nEND" }));
    const done2 = findDone(events2);
    expect(done2?.output.stopReason).toBe("completed");

    await adapter.dispose?.();
  }, 15_000);

  test("exit 1 produces done(error)", async () => {
    const adapter = createExternalAdapter({ command: "sh", args: ["-c", "exit 1"] });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("error");

    await adapter.dispose?.();
  });

  test("JSON-lines parser with structured output", async () => {
    const adapter = createExternalAdapter({
      command: "echo",
      args: ['{"kind":"text_delta","delta":"structured!"}'],
      parser: createJsonLinesParser(),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.some((e) => e.kind === "text_delta" && e.delta === "structured!")).toBe(true);

    await adapter.dispose?.();
  });

  test("timeout kills process", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 300,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;
    expect(["error", "interrupted"]).toContain(done.output.stopReason);

    await adapter.dispose?.();
  }, 10_000);

  test("noOutputTimeoutMs kills silent process", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "echo start; sleep 30"],
      noOutputTimeoutMs: 300,
      timeoutMs: 0,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;
    expect(done.output.stopReason).toBe("error");

    await adapter.dispose?.();
  }, 10_000);

  test("saveState/loadState round-trip", async () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["state-test"] });
    await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const state = await adapter.saveState?.();
    expect(state.engineId).toBe("external");

    const adapter2 = createExternalAdapter({ command: "echo", args: ["state-test"] });
    await adapter2.loadState?.(state);
    const state2 = await adapter2.saveState?.();
    expect(state2.engineId).toBe("external");

    await adapter.dispose?.();
    await adapter2.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// Tier 2: External adapter through createKoi (full L1 runtime)
// ---------------------------------------------------------------------------

describe("e2e: engine-external through createKoi", () => {
  test(
    "echo adapter through createKoi with lifecycle hooks",
    async () => {
      const hookLog: string[] = []; // let justified: test accumulator

      const lifecycle: KoiMiddleware = {
        name: "e2e-external-lifecycle",
        priority: 100,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onBeforeTurn: async () => {
          hookLog.push("turn:before");
        },
        onAfterTurn: async () => {
          hookLog.push("turn:after");
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
      };

      const adapter = createExternalAdapter({ command: "echo", args: ["hello koi"] });

      const runtime = await createKoi({
        manifest: { name: "e2e-external-echo", version: "0.0.1", model: { name: "external" } },
        adapter,
        middleware: [lifecycle],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "" }));

        // Agent completed successfully
        const done = findDone(events);
        expect(done).toBeDefined();
        if (done === undefined) return;
        expect(done.output.stopReason).toBe("completed");

        // L1 lifecycle hooks fired: session start/end + turn:before
        // Note: onAfterTurn requires the adapter to emit turn_end events.
        // External adapter emits text_delta + done (no turn boundaries),
        // so onAfterTurn does not fire. This is expected — external
        // processes don't have a "turn" concept.
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");
        expect(hookLog).toContain("turn:before");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "error exit propagates through createKoi",
    async () => {
      const adapter = createExternalAdapter({ command: "sh", args: ["-c", "exit 1"] });

      const runtime = await createKoi({
        manifest: { name: "e2e-external-error", version: "0.0.1", model: { name: "external" } },
        adapter,
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "" }));

        const done = findDone(events);
        expect(done).toBeDefined();
        expect(done?.output.stopReason).toBe("error");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "multiple middleware compose with external adapter",
    async () => {
      const order: string[] = []; // let justified: test accumulator

      const first: KoiMiddleware = {
        name: "e2e-external-first",
        priority: 100,
        onSessionStart: async () => {
          order.push("first:start");
        },
        onSessionEnd: async () => {
          order.push("first:end");
        },
      };

      const second: KoiMiddleware = {
        name: "e2e-external-second",
        priority: 200,
        onSessionStart: async () => {
          order.push("second:start");
        },
        onSessionEnd: async () => {
          order.push("second:end");
        },
      };

      const adapter = createExternalAdapter({ command: "echo", args: ["compose"] });

      const runtime = await createKoi({
        manifest: { name: "e2e-external-compose", version: "0.0.1", model: { name: "external" } },
        adapter,
        middleware: [second, first], // Out of order — engine sorts by priority
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "" }));

        // Session hooks fire in priority order (100 before 200)
        expect(order.at(0)).toBe("first:start");
        expect(order.at(1)).toBe("second:start");
        expect(order.at(-2)).toBe("first:end");
        expect(order.at(-1)).toBe("second:end");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Tier 3: External adapter wrapping a real LLM CLI call via curl
// ---------------------------------------------------------------------------

describeLLM("e2e: engine-external with real LLM via curl", () => {
  test(
    "curl-based Anthropic call through createKoi produces real LLM response",
    async () => {
      // Shell script that calls Anthropic API via curl and outputs JSON-lines
      const curlScript = `
        response=$(curl -s https://api.anthropic.com/v1/messages \
          -H "content-type: application/json" \
          -H "x-api-key: ${ANTHROPIC_KEY}" \
          -H "anthropic-version: 2023-06-01" \
          -d '{
            "model": "${MODEL_NAME}",
            "max_tokens": 50,
            "messages": [{"role": "user", "content": "Reply with exactly one word: hello"}]
          }')
        # Extract the text from the response and emit as text_delta
        text=$(echo "$response" | grep -o '"text":"[^"]*"' | head -1 | sed 's/"text":"//;s/"$//')
        if [ -n "$text" ]; then
          echo "$text"
        else
          echo "ERROR: $response" >&2
          exit 1
        fi
      `;

      const adapter = createExternalAdapter({
        command: "sh",
        args: ["-c", curlScript],
        timeoutMs: 30_000,
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-external-llm", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "" }));

        // Got a done event
        const done = findDone(events);
        expect(done).toBeDefined();
        if (done === undefined) return;
        expect(done.output.stopReason).toBe("completed");

        // Got text output from the LLM
        const textDeltas = events.filter((e) => e.kind === "text_delta");
        const fullText = textDeltas
          .map((e) => (e.kind === "text_delta" ? e.delta : ""))
          .join("")
          .toLowerCase();
        expect(fullText).toContain("hello");

        // Metrics: zero tokens (external adapter), real duration
        expect(done.output.metrics.totalTokens).toBe(0);
        expect(done.output.metrics.durationMs).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "real LLM via curl with lifecycle middleware composition",
    async () => {
      const hookLog: string[] = []; // let justified: test accumulator

      const lifecycle: KoiMiddleware = {
        name: "e2e-llm-lifecycle",
        priority: 100,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onBeforeTurn: async () => {
          hookLog.push("turn:before");
        },
        onAfterTurn: async () => {
          hookLog.push("turn:after");
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
      };

      const curlScript = `
        response=$(curl -s https://api.anthropic.com/v1/messages \
          -H "content-type: application/json" \
          -H "x-api-key: ${ANTHROPIC_KEY}" \
          -H "anthropic-version: 2023-06-01" \
          -d '{
            "model": "${MODEL_NAME}",
            "max_tokens": 30,
            "messages": [{"role": "user", "content": "Say yes"}]
          }')
        text=$(echo "$response" | grep -o '"text":"[^"]*"' | head -1 | sed 's/"text":"//;s/"$//')
        if [ -n "$text" ]; then echo "$text"; else exit 1; fi
      `;

      const adapter = createExternalAdapter({
        command: "sh",
        args: ["-c", curlScript],
        timeoutMs: 30_000,
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-llm-hooks", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [lifecycle],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "" }));

        // Completed successfully
        const done = findDone(events);
        expect(done).toBeDefined();
        expect(done?.output.stopReason).toBe("completed");

        // L1 lifecycle fired (onAfterTurn not expected — see Tier 2 note)
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");
        expect(hookLog).toContain("turn:before");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
