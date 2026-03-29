/**
 * Integration test: tool child spans flow through the engine into the debug waterfall.
 *
 * Verifies the full data path: tool.execute() → getSpanRecorder()?.record()
 * → debugInstrumentation.recordToolChildSpans() → getTrace() contains children.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  ModelRequest,
  ModelResponse,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import { type ChildSpanRecord, getSpanRecorder } from "@koi/execution-context";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Child Span Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      turns: 1,
      durationMs: 100,
    },
  };
}

/**
 * Creates an adapter that calls a tool via callHandlers.toolCall().
 */
function adapterWithToolCall(toolId: string): EngineAdapter {
  const rawModelCall = async (_req: ModelRequest): Promise<ModelResponse> => ({
    content: "ok",
    model: "test",
  });

  return {
    engineId: "child-span-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: rawModelCall,
    },
    stream: (input: EngineInput) => ({
      async *[Symbol.asyncIterator]() {
        if (input.callHandlers) {
          await input.callHandlers.toolCall({ toolId, input: {} });
        }
        yield { kind: "turn_end" as const, turnIndex: 0 };
        yield { kind: "done" as const, output: doneOutput() };
      },
    }),
  };
}

/** Tool that reports child spans via the span recorder. */
function spanRecordingTool(
  name: string,
  childSpans: readonly ChildSpanRecord[],
): {
  readonly provider: {
    readonly name: string;
    readonly attach: () => Promise<Map<string, unknown>>;
  };
} {
  return {
    provider: {
      name: `${name}-provider`,
      attach: async () =>
        new Map([
          [
            toolToken(name) as string,
            {
              descriptor: {
                name,
                description: `Test tool: ${name}`,
                inputSchema: {},
              },
              origin: "primordial",
              policy: DEFAULT_UNSANDBOXED_POLICY,
              execute: async (_input: unknown) => {
                const recorder = getSpanRecorder();
                for (const span of childSpans) {
                  recorder?.record(span);
                }
                return { ok: true };
              },
            },
          ],
        ]),
    },
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool child spans in debug waterfall", () => {
  test("child spans from tool.execute() appear in debug trace", async () => {
    const { provider } = spanRecordingTool("span-tool", [
      { label: "tool-exec:validate", durationMs: 0.5 },
      { label: "sandbox-wasm", durationMs: 12.3, metadata: { memoryUsedBytes: 1024 } },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: adapterWithToolCall("span-tool"),
      providers: [provider],
      loopDetection: false,
      debug: { enabled: true },
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // The debug trace should contain the tool child spans
    const trace = runtime.debug?.getTrace(0);
    expect(trace).toBeDefined();

    // Find the wrapToolCall group
    const toolCallGroup = trace?.spans.find((s) => s.name === "wrapToolCall");
    expect(toolCallGroup).toBeDefined();

    // Find the tool exec span within the group
    const execSpan = toolCallGroup?.children?.find((c) => c.name === "span-tool");
    expect(execSpan).toBeDefined();
    expect(execSpan?.hook).toBe("toolExec");

    // Verify child spans
    expect(execSpan?.children).toHaveLength(2);
    expect(execSpan?.children?.[0]?.name).toBe("tool-exec:validate");
    expect(execSpan?.children?.[0]?.durationMs).toBe(0.5);
    expect(execSpan?.children?.[1]?.name).toBe("sandbox-wasm");
    expect(execSpan?.children?.[1]?.durationMs).toBe(12.3);
  });

  test("span recorder is undefined outside tool execution", async () => {
    // Outside any tool execution, there should be no recorder
    expect(getSpanRecorder()).toBeUndefined();
  });

  test("child spans with errors are preserved", async () => {
    const { provider } = spanRecordingTool("err-tool", [
      { label: "sandbox-wasm", durationMs: 5.0, error: "TIMEOUT: exceeded 30s" },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: adapterWithToolCall("err-tool"),
      providers: [provider],
      loopDetection: false,
      debug: { enabled: true },
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    const trace = runtime.debug?.getTrace(0);
    const toolCallGroup = trace?.spans.find((s) => s.name === "wrapToolCall");
    const execSpan = toolCallGroup?.children?.find((c) => c.name === "err-tool");
    expect(execSpan?.children?.[0]?.error).toBe("TIMEOUT: exceeded 30s");
  });

  test("no child spans when tool does not record any", async () => {
    // Tool that doesn't use the span recorder
    const provider = {
      name: "silent-provider",
      attach: async () =>
        new Map([
          [
            toolToken("silent-tool") as string,
            {
              descriptor: {
                name: "silent-tool",
                description: "Tool that reports no spans",
                inputSchema: {},
              },
              origin: "primordial" as const,
              policy: DEFAULT_UNSANDBOXED_POLICY,
              execute: async (_input: unknown) => ({ ok: true }),
            },
          ],
        ]),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: adapterWithToolCall("silent-tool"),
      providers: [provider],
      loopDetection: false,
      debug: { enabled: true },
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    const trace = runtime.debug?.getTrace(0);
    const toolCallGroup = trace?.spans.find((s) => s.name === "wrapToolCall");
    // Should have middleware children but no toolExec span
    const execSpan = toolCallGroup?.children?.find((c) => c.hook === "toolExec");
    expect(execSpan).toBeUndefined();
  });
});
