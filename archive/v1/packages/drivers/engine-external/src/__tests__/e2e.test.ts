/**
 * End-to-end tests for @koi/engine-external.
 *
 * Uses real processes (echo, cat, sh -c) — no mocking.
 * Includes the contract test suite from @koi/test-utils.
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { testEngineAdapter } from "@koi/test-utils";
import { createExternalAdapter } from "../adapter.js";
import { createJsonLinesParser, createLineParser } from "../parsers.js";

/** Collect all events from an async iterable. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Find the done event. */
function findDone(
  events: readonly EngineEvent[],
): Extract<EngineEvent, { readonly kind: "done" }> | undefined {
  return events.find(
    (e): e is Extract<EngineEvent, { readonly kind: "done" }> => e.kind === "done",
  );
}

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

describe("engine adapter contract", () => {
  testEngineAdapter({
    createAdapter: () =>
      createExternalAdapter({ command: "echo", args: ["hello"], mode: "single-shot" }),
  });
});

// ---------------------------------------------------------------------------
// E2E: real processes
// ---------------------------------------------------------------------------

describe("e2e: echo", () => {
  test("echo produces text_delta events with expected content", async () => {
    const adapter = createExternalAdapter({
      command: "echo",
      args: ["hello world"],
      mode: "single-shot",
    });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    const allText = textDeltas.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");
    expect(allText.trim()).toBe("hello world");

    const done = findDone(events);
    expect(done?.output.stopReason).toBe("completed");

    await adapter.dispose?.();
  });
});

describe("e2e: exit code", () => {
  test("exit 1 produces done with error stopReason", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "exit 1"],
      mode: "single-shot",
    });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done?.output.stopReason).toBe("error");

    await adapter.dispose?.();
  });
});

describe("e2e: cat long-lived", () => {
  test("write/read cycle with parser-driven completion", async () => {
    const adapter = createExternalAdapter({
      command: "cat",
      mode: "long-lived",
      parser: createLineParser((line) => {
        if (line.trim() === "END") return { events: [], turnComplete: true };
        if (line.trim().length === 0) return undefined;
        return { events: [{ kind: "text_delta" as const, delta: line }] };
      }),
      timeoutMs: 5000,
    });

    // Turn 1
    const events1 = await collectEvents(adapter.stream({ kind: "text", text: "first\nEND" }));
    expect(findDone(events1)?.output.stopReason).toBe("completed");

    // Turn 2
    const events2 = await collectEvents(adapter.stream({ kind: "text", text: "second\nEND" }));
    expect(findDone(events2)?.output.stopReason).toBe("completed");

    await adapter.dispose?.();
  }, 15_000);
});

describe("e2e: timeout", () => {
  test("sleep with short timeout is killed", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 10"],
      mode: "single-shot",
      timeoutMs: 200,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;
    expect(["error", "interrupted"]).toContain(done.output.stopReason);

    await adapter.dispose?.();
  }, 10_000);
});

describe("e2e: JSON-lines parser", () => {
  test("echo of valid JSON line is parsed as EngineEvent", async () => {
    const adapter = createExternalAdapter({
      command: "echo",
      args: ['{"kind":"text_delta","delta":"from json"}'],
      mode: "single-shot",
      parser: createJsonLinesParser(),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.some((e) => e.kind === "text_delta" && e.delta === "from json")).toBe(true);

    await adapter.dispose?.();
  });
});
