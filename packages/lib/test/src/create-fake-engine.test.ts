import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineInput } from "@koi/core";
import { toolCallId } from "@koi/core";
import { createFakeEngine, type TurnBodyEvent } from "./create-fake-engine.js";

const textInput: EngineInput = { kind: "text", text: "hi" };

async function drain(adapter: {
  stream: (i: EngineInput) => AsyncIterable<EngineEvent>;
}): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const evt of adapter.stream(textInput)) {
    out.push(evt);
  }
  return out;
}

describe("createFakeEngine", () => {
  test("emits turn_start / body / turn_end / done", async () => {
    const { adapter } = createFakeEngine({
      turns: [[{ kind: "text_delta", delta: "hello" }]],
    });
    const events = await drain(adapter);
    expect(events).toHaveLength(4);
    expect(events[0]?.kind).toBe("turn_start");
    expect(events[1]?.kind).toBe("text_delta");
    expect(events[2]?.kind).toBe("turn_end");
    expect(events[3]?.kind).toBe("done");
  });

  test("multiple turns are wrapped independently", async () => {
    const { adapter } = createFakeEngine({
      turns: [[{ kind: "text_delta", delta: "a" }], [{ kind: "text_delta", delta: "b" }]],
    });
    const events = await drain(adapter);
    // 2 turns × 3 events (start + body + end) + 1 done
    expect(events).toHaveLength(7);
    expect(events.filter((e) => e.kind === "turn_start")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "turn_end")).toHaveLength(2);
  });

  test("inject records messages", () => {
    const { adapter, injectedMessages } = createFakeEngine({ turns: [[]] });
    adapter.inject?.({
      content: [{ kind: "text", text: "injected" }],
      senderId: "user",
      timestamp: 0,
    });
    expect(injectedMessages).toHaveLength(1);
  });

  test("rejects turn_start inside turn body", () => {
    expect(() =>
      createFakeEngine({
        // Cast around the type to trigger the runtime guard
        turns: [[{ kind: "turn_start", turnIndex: 0 } as unknown as TurnBodyEvent]],
      }),
    ).toThrow(/forbidden control event "turn_start"/);
  });

  test("rejects done inside turn body", () => {
    expect(() =>
      createFakeEngine({
        turns: [
          [
            {
              kind: "done",
              output: {
                content: [],
                stopReason: "completed",
                metrics: {
                  totalTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  turns: 0,
                  durationMs: 0,
                },
              },
            } as unknown as TurnBodyEvent,
          ],
        ],
      }),
    ).toThrow(/forbidden control event "done"/);
  });

  test("supports tool_call events in body", async () => {
    const callId = toolCallId("call-1");
    const body: TurnBodyEvent[] = [
      { kind: "tool_call_start", toolName: "search", callId },
      { kind: "tool_call_end", callId, result: { ok: true } },
    ];
    const { adapter } = createFakeEngine({ turns: [body] });
    const events = await drain(adapter);
    const toolStart = events.find((e) => e.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
  });

  test("honors engineId override", () => {
    const { adapter } = createFakeEngine({ turns: [], engineId: "custom-engine" });
    expect(adapter.engineId).toBe("custom-engine");
  });

  test("honors finalStopReason override", async () => {
    const { adapter } = createFakeEngine({
      turns: [[]],
      finalStopReason: "max_turns",
    });
    const events = await drain(adapter);
    const done = events.find((e) => e.kind === "done");
    expect(done?.kind).toBe("done");
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("max_turns");
    }
  });
});
