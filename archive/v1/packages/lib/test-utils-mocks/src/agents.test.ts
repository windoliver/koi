import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineState } from "@koi/core";
import type { MockEngineData } from "./agents.js";
import { createMockStatefulEngine } from "./agents.js";

// ---------------------------------------------------------------------------
// Helper: drain all events from the async iterable
// ---------------------------------------------------------------------------

async function drain(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const e of iter) {
    events.push(e);
  }
  return events;
}

describe("createMockStatefulEngine", () => {
  test("initial state has zero turns and null lastInput", () => {
    const engine = createMockStatefulEngine();
    const data = engine.currentData();
    expect(data.turnCount).toBe(0);
    expect(data.lastInput).toBeNull();
    expect(data.customData).toBeNull();
  });

  test("stream() increments turnCount and captures text input", async () => {
    const engine = createMockStatefulEngine();

    await drain(engine.stream({ kind: "text", text: "hello" }));
    expect(engine.currentData().turnCount).toBe(1);
    expect(engine.currentData().lastInput).toBe("hello");

    await drain(engine.stream({ kind: "text", text: "world" }));
    expect(engine.currentData().turnCount).toBe(2);
    expect(engine.currentData().lastInput).toBe("world");
  });

  test("stream() captures 'messages' label for message inputs", async () => {
    const engine = createMockStatefulEngine();
    await drain(
      engine.stream({
        kind: "messages",
        messages: [
          { senderId: "user", content: [{ kind: "text", text: "hi" }], timestamp: Date.now() },
        ],
      }),
    );
    expect(engine.currentData().lastInput).toBe("messages");
  });

  test("stream() captures 'resume' label for resume inputs", async () => {
    const engine = createMockStatefulEngine();
    const state: EngineState = { engineId: "mock-stateful-engine", data: null };
    await drain(engine.stream({ kind: "resume", state }));
    expect(engine.currentData().lastInput).toBe("resume");
  });

  test("stream() yields a done event with text content", async () => {
    const engine = createMockStatefulEngine();
    const events = await drain(engine.stream({ kind: "text", text: "go" }));
    expect(events.length).toBe(1);
    const event = events[0];
    if (event === undefined) throw new Error("Expected at least one event");
    expect(event.kind).toBe("done");
    if (event.kind === "done") {
      expect(event.output.stopReason).toBe("completed");
      expect(event.output.content[0]).toEqual({ kind: "text", text: "turn-1" });
    }
  });

  test("saveState() returns deterministic EngineState", async () => {
    const engine = createMockStatefulEngine({ engineId: "my-engine" });
    await drain(engine.stream({ kind: "text", text: "first" }));

    if (engine.saveState === undefined) throw new Error("saveState expected");
    const state = await engine.saveState();
    expect(state.engineId).toBe("my-engine");
    const data = state.data as MockEngineData;
    expect(data.turnCount).toBe(1);
    expect(data.lastInput).toBe("first");
    expect(data.customData).toBeNull();
  });

  test("loadState() restores engine to previous state", async () => {
    const engine = createMockStatefulEngine();
    if (engine.saveState === undefined) throw new Error("saveState expected");
    if (engine.loadState === undefined) throw new Error("loadState expected");

    await drain(engine.stream({ kind: "text", text: "a" }));
    await drain(engine.stream({ kind: "text", text: "b" }));
    const saved = await engine.saveState();
    expect(engine.currentData().turnCount).toBe(2);

    // Stream more to change state
    await drain(engine.stream({ kind: "text", text: "c" }));
    expect(engine.currentData().turnCount).toBe(3);

    // Restore and verify
    await engine.loadState(saved);
    expect(engine.currentData().turnCount).toBe(2);
    expect(engine.currentData().lastInput).toBe("b");
  });

  test("state survives JSON round-trip", async () => {
    const engine = createMockStatefulEngine({ initialCustomData: { nested: [1, 2, 3] } });
    if (engine.saveState === undefined) throw new Error("saveState expected");
    if (engine.loadState === undefined) throw new Error("loadState expected");

    await drain(engine.stream({ kind: "text", text: "hello" }));
    await drain(engine.stream({ kind: "text", text: "world" }));

    const state = await engine.saveState();
    const roundTripped: EngineState = JSON.parse(JSON.stringify(state)) as EngineState;

    // Load into a fresh engine and verify
    const engine2 = createMockStatefulEngine();
    if (engine2.loadState === undefined) throw new Error("loadState expected");
    await engine2.loadState(roundTripped);

    expect(engine2.currentData().turnCount).toBe(2);
    expect(engine2.currentData().lastInput).toBe("world");
    expect(engine2.currentData().customData).toEqual({ nested: [1, 2, 3] });
  });

  test("initialCustomData is preserved through turns", async () => {
    const custom = { version: 42, tags: ["a", "b"] };
    const engine = createMockStatefulEngine({ initialCustomData: custom });
    if (engine.saveState === undefined) throw new Error("saveState expected");

    await drain(engine.stream({ kind: "text", text: "turn1" }));
    await drain(engine.stream({ kind: "text", text: "turn2" }));

    expect(engine.currentData().customData).toEqual(custom);
    const state = await engine.saveState();
    expect((state.data as MockEngineData).customData).toEqual(custom);
  });

  test("dispose() does not throw", async () => {
    const engine = createMockStatefulEngine();
    await expect(engine.dispose?.()).resolves.toBeUndefined();
  });

  test("default engineId is 'mock-stateful-engine'", () => {
    const engine = createMockStatefulEngine();
    expect(engine.engineId).toBe("mock-stateful-engine");
  });

  test("custom engineId is used", () => {
    const engine = createMockStatefulEngine({ engineId: "custom-engine" });
    expect(engine.engineId).toBe("custom-engine");
  });
});
