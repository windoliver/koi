/**
 * Integration test for `koi start` — exercises the full path:
 * koi.yaml → loadManifest → createKoi → engine-loop → stream events → verify output
 *
 * Uses in-process wiring with a mock LLM terminal. No subprocess, deterministic.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, ModelHandler, ModelRequest, ModelResponse } from "@koi/core";
import type { KoiRuntime } from "@koi/engine";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { loadManifest } from "@koi/manifest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `koi-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("koi start integration — full path", () => {
  test("manifest → createKoi → engine-loop → stream produces events", async () => {
    // 1. Create a real manifest file
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestContent = [
      "name: integration-test-agent",
      "version: 1.0.0",
      "description: An agent for integration testing",
      "model:",
      "  name: mock-model",
    ].join("\n");
    writeFileSync(join(dir, "koi.yaml"), manifestContent);

    // 2. Load the manifest (real loadManifest, real YAML parsing, real Zod validation)
    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const { manifest } = loadResult.value;
    expect(manifest.name).toBe("integration-test-agent");
    expect(manifest.version).toBe("1.0.0");

    // 3. Create a mock model terminal
    const modelCall: ModelHandler = async (request: ModelRequest): Promise<ModelResponse> => {
      const inputText = request.messages
        .flatMap((m) => m.content)
        .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
        .map((b) => b.text)
        .join(" ");

      return {
        content: `Integration response to: ${inputText}`,
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    };

    // 4. Create engine adapter (real engine-loop)
    const adapter = createLoopAdapter({ modelCall });

    // 5. Create Koi runtime (real createKoi from @koi/engine)
    const runtime: KoiRuntime = await createKoi({ manifest, adapter });

    // 6. Run the agent
    const events = await collectEvents(runtime.run({ kind: "text", text: "Hello world" }));

    // 7. Verify event stream
    expect(events.length).toBeGreaterThan(0);

    // Should have text_delta events
    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    // Should have a done event
    const doneEvents = events.filter(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(doneEvents.length).toBe(1);

    const done = doneEvents[0];
    expect(done).toBeDefined();
    if (!done) return;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.metrics.turns).toBeGreaterThanOrEqual(1);
    expect(done.output.metrics.totalTokens).toBe(30); // 10 + 20

    // The response text should be in the text_delta events
    const fullText = textDeltas
      .map((e) => {
        if (e.kind === "text_delta") return e.delta;
        return "";
      })
      .join("");
    expect(fullText).toContain("Integration response to:");
    expect(fullText).toContain("Hello world");

    // 8. Cleanup
    await runtime.dispose();
  });

  test("manifest with tool calls → engine-loop → tool round-trip", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      ["name: tool-test-agent", "version: 0.1.0", "model:", "  name: mock-model"].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // Model that returns a tool call on first turn, then text on second
    let turnCount = 0;
    const modelCall: ModelHandler = async (_request: ModelRequest): Promise<ModelResponse> => {
      turnCount++;
      if (turnCount === 1) {
        return {
          content: "",
          model: "mock-model",
          usage: { inputTokens: 5, outputTokens: 10 },
          metadata: {
            toolCalls: [
              {
                toolName: "test-tool",
                callId: "call-1",
                input: { query: "test" },
              },
            ],
          },
        };
      }
      return {
        content: "Tool result processed",
        model: "mock-model",
        usage: { inputTokens: 15, outputTokens: 10 },
      };
    };

    const adapter = createLoopAdapter({
      modelCall,
      toolCall: async (request) => ({ output: `result for ${request.toolId}` }),
    });

    const runtime = await createKoi({ manifest: loadResult.value.manifest, adapter });
    const events = await collectEvents(runtime.run({ kind: "text", text: "use tools" }));

    // Should have tool_call_start and tool_call_end events
    const toolStarts = events.filter((e) => e.kind === "tool_call_start");
    const toolEnds = events.filter((e) => e.kind === "tool_call_end");
    expect(toolStarts.length).toBe(1);
    expect(toolEnds.length).toBe(1);

    // Should have a done event with 2 turns
    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done).toBeDefined();
    if (!done) return;
    expect(done.output.metrics.turns).toBe(2);

    await runtime.dispose();
  });

  test("graceful shutdown via iterator return", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      ["name: shutdown-agent", "version: 0.1.0", "model:", "  name: mock-model"].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // Model that always wants to do more (never stops on its own)
    const modelCall: ModelHandler = async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: "",
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      metadata: {
        toolCalls: [{ toolName: "loop-tool", callId: `call-${Date.now()}`, input: {} }],
      },
    });

    const adapter = createLoopAdapter({
      modelCall,
      toolCall: async () => ({ output: "ok" }),
      maxTurns: 100, // High limit — we'll manually interrupt
    });

    const runtime = await createKoi({ manifest: loadResult.value.manifest, adapter });
    const stream = runtime.run({ kind: "text", text: "start" });
    const iterator = stream[Symbol.asyncIterator]();

    // Take a few events
    const firstEvent = await iterator.next();
    expect(firstEvent.done).toBe(false);

    // Gracefully close the iterator (simulates AbortController abort)
    if (iterator.return) {
      const result = await iterator.return();
      expect(result.done).toBe(true);
    }

    await runtime.dispose();
  });

  test("manifest warnings are propagated correctly", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: warn-agent",
        "version: 0.1.0",
        "model:",
        "  name: mock-model",
        "unknownTopLevel: foo",
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    expect(loadResult.value.warnings.length).toBeGreaterThan(0);
  });
});
