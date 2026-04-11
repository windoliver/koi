/**
 * Round-trip integration test: record → serialize → load → replay → assert.
 * Catches serialization bugs at the format boundary that unit tests miss.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ModelChunk } from "@koi/core";
import { createReplayAdapter } from "../create-replay-adapter.js";
import { clearCassetteCache, loadCassette } from "../load-cassette.js";
import type { Cassette } from "../types.js";
import { CASSETTE_SCHEMA_VERSION } from "../types.js";

const tmpFiles: string[] = [];

afterEach(() => {
  clearCassetteCache();
  for (const f of tmpFiles) {
    try {
      rmSync(f);
    } catch {
      /* best-effort */
    }
  }
  tmpFiles.length = 0;
});

async function writeCassette(cassette: Cassette): Promise<string> {
  const path = `/tmp/koi-round-trip-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(path);
  await Bun.write(path, JSON.stringify(cassette, null, 2));
  return path;
}

describe("round-trip: serialize → loadCassette → replay", () => {
  test("text-only cassette survives full round-trip", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "hello" },
      { kind: "text_delta", delta: " world" },
      { kind: "usage", inputTokens: 5, outputTokens: 2 },
      { kind: "done", response: { content: "hello world", model: "test-model" } },
    ];

    const cassette: Cassette = {
      schemaVersion: CASSETTE_SCHEMA_VERSION,
      name: "round-trip-text",
      model: "test-model",
      recordedAt: 1_000_000,
      chunks,
    };

    const path = await writeCassette(cassette);
    const loaded = await loadCassette(path);

    expect(loaded.schemaVersion).toBe("cassette-v1");
    expect(loaded.name).toBe("round-trip-text");
    expect(loaded.chunks).toHaveLength(4);

    // Replay the loaded cassette and confirm the done event is correct
    const adapter = createReplayAdapter(loaded.chunks);
    const events: import("@koi/core").EngineEvent[] = [];
    for await (const e of adapter.stream({ kind: "text", text: "ping" })) events.push(e);

    const done = events.at(-1) as Extract<import("@koi/core").EngineEvent, { kind: "done" }>;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.metrics.inputTokens).toBe(5);
  });

  test("tool-use cassette survives full round-trip", async () => {
    const callId = "tc-round-trip" as import("@koi/core").ToolCallId;
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "add", callId },
      { kind: "tool_call_delta", callId, delta: '{"a":3,"b":4}' },
      { kind: "tool_call_end", callId },
      { kind: "done", response: { content: "7", model: "test-model" } },
    ];

    const cassette: Cassette = {
      schemaVersion: CASSETTE_SCHEMA_VERSION,
      name: "round-trip-tool",
      model: "test-model",
      recordedAt: 1_000_001,
      chunks,
    };

    const path = await writeCassette(cassette);
    const loaded = await loadCassette(path);
    const adapter = createReplayAdapter(loaded.chunks);

    const events: import("@koi/core").EngineEvent[] = [];
    for await (const e of adapter.stream({ kind: "text", text: "add" })) events.push(e);

    const toolEnd = events.find((e) => e.kind === "tool_call_end") as
      | Extract<import("@koi/core").EngineEvent, { kind: "tool_call_end" }>
      | undefined;
    expect(toolEnd).toBeDefined();
    expect((toolEnd?.result as { parsedArgs: unknown }).parsedArgs).toEqual({ a: 3, b: 4 });
  });

  test("volatile fields are absent after write→load cycle", async () => {
    // Cassette with no volatile fields (already normalized) — verifies format stability
    const cassette: Cassette = {
      schemaVersion: CASSETTE_SCHEMA_VERSION,
      name: "round-trip-volatile",
      model: "test-model",
      recordedAt: 1_000_002,
      chunks: [
        {
          kind: "done",
          response: {
            content: "ok",
            model: "test-model",
            // No responseId, no metadata — clean cassette
          },
        },
      ],
    };

    const path = await writeCassette(cassette);
    const loaded = await loadCassette(path);
    const done = loaded.chunks[0];
    expect(done?.kind).toBe("done");
    if (done?.kind === "done") {
      expect((done.response as Record<string, unknown>).responseId).toBeUndefined();
      expect((done.response as Record<string, unknown>).metadata).toBeUndefined();
    }
  });
});
