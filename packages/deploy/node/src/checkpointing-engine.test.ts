import { describe, expect, mock, test } from "bun:test";
import type { EngineAdapter, EngineEvent, EngineInput, EngineState } from "@koi/core";
import { createCheckpointingEngine } from "./checkpointing-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEngine(events: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "test-engine",
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(_input: EngineInput): AsyncGenerator<EngineEvent> {
      for (const event of events) {
        yield event;
      }
    },
    async saveState(): Promise<EngineState> {
      return { engineId: "test-engine", data: { saved: true } };
    },
    async loadState(_state: EngineState): Promise<void> {
      // no-op
    },
    async dispose(): Promise<void> {
      // no-op
    },
  };
}

const textInput: EngineInput = { kind: "text", text: "hello" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCheckpointingEngine", () => {
  test("auto-checkpoints on turn_end event", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "turn_end", turnIndex: 0 },
    ];
    const onCheckpoint = mock(() => Promise.resolve());
    const wrapped = createCheckpointingEngine(createMockEngine(events), {
      agentId: "a1",
      sessionId: "s1",
      onCheckpoint,
    });

    const collected: EngineEvent[] = [];
    for await (const event of wrapped.stream(textInput)) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]?.kind).toBe("text_delta");
    expect(collected[1]?.kind).toBe("turn_end");
    // Allow microtask to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint).toHaveBeenCalledWith("a1", "s1");
  });

  test("auto-checkpoints on done event", async () => {
    const events: readonly EngineEvent[] = [
      {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 100 },
        },
      },
    ];
    const onCheckpoint = mock(() => Promise.resolve());
    const wrapped = createCheckpointingEngine(createMockEngine(events), {
      agentId: "a1",
      sessionId: "s1",
      onCheckpoint,
    });

    for await (const _event of wrapped.stream(textInput)) {
      // consume
    }

    await new Promise((r) => setTimeout(r, 10));
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
  });

  test("checkpoint failure does not block stream", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "turn_end", turnIndex: 0 },
      { kind: "text_delta", delta: "after" },
    ];
    const onCheckpoint = mock(() => Promise.reject(new Error("checkpoint failed")));
    const wrapped = createCheckpointingEngine(createMockEngine(events), {
      agentId: "a1",
      sessionId: "s1",
      onCheckpoint,
    });

    const collected: EngineEvent[] = [];
    for await (const event of wrapped.stream(textInput)) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[1]?.kind).toBe("text_delta");
    // Allow the rejected promise catch to run
    await new Promise((r) => setTimeout(r, 10));
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
  });

  test("delegates saveState/loadState/dispose to inner", async () => {
    const inner = createMockEngine([]);
    const innerSaveState = inner.saveState;
    const innerLoadState = inner.loadState;
    const innerDispose = inner.dispose;
    if (
      innerSaveState === undefined ||
      innerLoadState === undefined ||
      innerDispose === undefined
    ) {
      throw new Error("Mock engine missing optional methods");
    }
    const saveSpy = mock(innerSaveState);
    const loadSpy = mock(innerLoadState);
    const disposeSpy = mock(innerDispose);
    const spiedInner: EngineAdapter = {
      ...inner,
      saveState: saveSpy,
      loadState: loadSpy,
      dispose: disposeSpy,
    };

    const wrapped = createCheckpointingEngine(spiedInner, {
      agentId: "a1",
      sessionId: "s1",
      onCheckpoint: () => Promise.resolve(),
    });

    if (wrapped.saveState !== undefined) {
      await wrapped.saveState();
    }
    expect(saveSpy).toHaveBeenCalledTimes(1);

    const state: EngineState = { engineId: "test", data: {} };
    if (wrapped.loadState !== undefined) {
      await wrapped.loadState(state);
    }
    expect(loadSpy).toHaveBeenCalledTimes(1);

    if (wrapped.dispose !== undefined) {
      await wrapped.dispose();
    }
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("delegates engineId to inner", () => {
    const inner = createMockEngine([]);
    const wrapped = createCheckpointingEngine(inner, {
      agentId: "a1",
      sessionId: "s1",
      onCheckpoint: () => Promise.resolve(),
    });

    expect(wrapped.engineId).toBe("test-engine");
  });

  test("checkpoints on both turn_end and done in same stream", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "turn_end", turnIndex: 0 },
      { kind: "turn_end", turnIndex: 1 },
      {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 2, durationMs: 200 },
        },
      },
    ];
    const onCheckpoint = mock(() => Promise.resolve());
    const wrapped = createCheckpointingEngine(createMockEngine(events), {
      agentId: "a1",
      sessionId: "s1",
      onCheckpoint,
    });

    for await (const _event of wrapped.stream(textInput)) {
      // consume
    }

    await new Promise((r) => setTimeout(r, 10));
    expect(onCheckpoint).toHaveBeenCalledTimes(3);
  });
});
