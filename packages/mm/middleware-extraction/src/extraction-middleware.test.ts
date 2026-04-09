import { describe, expect, mock, test } from "bun:test";
import type {
  MemoryComponent,
  ModelHandler,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createExtractionMiddleware } from "./extraction-middleware.js";
import type { HotMemoryNotifier } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockMemory(): MemoryComponent & {
  readonly stored: Array<{ content: string; category?: string | undefined }>;
} {
  const stored: Array<{ content: string; category?: string | undefined }> = [];
  return {
    stored,
    async recall() {
      return [];
    },
    async store(content: string, options?: Parameters<MemoryComponent["store"]>[1]) {
      stored.push({ content, category: options?.category });
    },
  };
}

function createMockModelCall(response: string): ModelHandler {
  return mock(async () => ({
    content: response,
    model: "test-model",
  }));
}

function createMockHotMemory(): HotMemoryNotifier & { readonly notifyCount: { value: number } } {
  const notifyCount = { value: 0 };
  return {
    notifyCount,
    notifyStoreOccurred() {
      notifyCount.value += 1;
    },
  };
}

function createSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "sess-1" as never,
    runId: "run-1" as never,
    metadata: {},
    ...overrides,
  };
}

function createTurnCtx(): TurnContext {
  return {
    session: createSessionCtx(),
    turnIndex: 0,
    turnId: "turn-1" as never,
    messages: [],
    metadata: {},
  };
}

function spawnToolRequest(toolId: string = "Spawn"): ToolRequest {
  return {
    toolId,
    input: { agentName: "worker" },
  };
}

function toolResponse(output: string): ToolResponse {
  return { output };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExtractionMiddleware", () => {
  describe("metadata", () => {
    test("has correct name and priority", () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      expect(mw.name).toBe("koi:extraction");
      expect(mw.priority).toBe(305);
    });

    test("describes capabilities", () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      const caps = mw.describeCapabilities(createTurnCtx());
      expect(caps).toBeDefined();
      expect(caps?.label).toBe("extraction");
    });
  });

  describe("session lifecycle", () => {
    test("initializes clean state on session start", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });

      // Start session
      await mw.onSessionStart?.(createSessionCtx());

      // No errors, state is clean
      expect(memory.stored).toHaveLength(0);
    });

    test("cleans up on session end even without model call", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });

      await mw.onSessionStart?.(createSessionCtx());
      await mw.onSessionEnd?.(createSessionCtx());

      // No stored memories since no model call configured
      expect(memory.stored).toHaveLength(0);
    });
  });

  describe("wrapToolCall — regex extraction", () => {
    test("extracts learnings from spawn tool output", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:gotcha] Always check null"));

      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Wait for fire-and-forget persist
      await new Promise((r) => setTimeout(r, 10));

      expect(next).toHaveBeenCalledTimes(1);
      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.content).toBe("Always check null");
      expect(memory.stored[0]?.category).toBe("gotcha");
    });

    test("ignores non-spawn tools", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:gotcha] Should be ignored"));

      await mw.wrapToolCall?.(createTurnCtx(), { toolId: "read_file", input: {} }, next);

      await new Promise((r) => setTimeout(r, 10));

      expect(next).toHaveBeenCalledTimes(1);
      expect(memory.stored).toHaveLength(0);
    });

    test("passes through response unchanged", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const expected = toolResponse("some output");
      const next = mock(async () => expected);

      const result = await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      expect(result).toBe(expected);
    });

    test("notifies hot-memory after successful store", async () => {
      const memory = createMockMemory();
      const hotMemory = createMockHotMemory();
      const mw = createExtractionMiddleware({ memory, hotMemory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:pattern] Use DI for testing"));

      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(hotMemory.notifyCount.value).toBe(1);
    });
  });

  describe("wrapToolCall — output accumulation", () => {
    test("accumulates spawn outputs for LLM extraction", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("some task output"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Trigger LLM extraction via session end
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).toHaveBeenCalledTimes(1);
    });

    test("caps accumulated outputs at maxSessionOutputs", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({
        memory,
        modelCall,
        maxSessionOutputs: 2,
      });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("output"));
      for (let i = 0; i < 5; i++) {
        await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      }

      await mw.onSessionEnd?.(createSessionCtx());

      // Model call should have been made with at most 2 outputs
      expect(modelCall).toHaveBeenCalledTimes(1);
    });
  });

  describe("onSessionEnd — LLM extraction", () => {
    test("runs LLM extraction and stores results", async () => {
      const memory = createMockMemory();
      const modelResponse = JSON.stringify([
        { content: "Always validate input", category: "heuristic" },
      ]);
      const modelCall = createMockModelCall(modelResponse);
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());

      // Accumulate an output
      const next = mock(async () => toolResponse("did some work"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Trigger extraction
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).toHaveBeenCalledTimes(1);
      expect(memory.stored.some((s) => s.content === "Always validate input")).toBe(true);
    });

    test("skips LLM extraction when no outputs accumulated", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).not.toHaveBeenCalled();
    });

    test("swallows LLM extraction errors", async () => {
      const memory = createMockMemory();
      const modelCall = mock(async () => {
        throw new Error("model failed");
      }) as unknown as ModelHandler;
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("some output"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Should not throw
      await mw.onSessionEnd?.(createSessionCtx());
    });

    test("resets session state after session end", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => toolResponse("output"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await mw.onSessionEnd?.(createSessionCtx());

      // Second session end should not trigger model call (outputs were drained)
      await mw.onSessionEnd?.(createSessionCtx());
      expect(modelCall).toHaveBeenCalledTimes(1);
    });

    test("excludes preference learnings (user type) from persistence", async () => {
      const memory = createMockMemory();
      const modelResponse = JSON.stringify([
        { content: "User prefers tabs", category: "preference" },
        { content: "Always validate input", category: "heuristic" },
      ]);
      const modelCall = createMockModelCall(modelResponse);
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => toolResponse("did work"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await mw.onSessionEnd?.(createSessionCtx());

      // Only the heuristic should be stored, not the preference (user type)
      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.content).toBe("Always validate input");
    });
  });

  describe("session isolation", () => {
    test("interleaved sessions do not share output buffers", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });

      const sessA = createSessionCtx({ sessionId: "sess-a" as never });
      const sessB = createSessionCtx({ sessionId: "sess-b" as never });
      const turnA: TurnContext = {
        session: sessA,
        turnIndex: 0,
        turnId: "turn-a" as never,
        messages: [],
        metadata: {},
      };
      const turnB: TurnContext = {
        session: sessB,
        turnIndex: 0,
        turnId: "turn-b" as never,
        messages: [],
        metadata: {},
      };

      await mw.onSessionStart?.(sessA);
      await mw.onSessionStart?.(sessB);

      // Session A accumulates an output
      const nextA = mock(async () => toolResponse("output from A"));
      await mw.wrapToolCall?.(turnA, spawnToolRequest(), nextA);

      // Session B ends — should NOT trigger LLM call (B has no outputs)
      await mw.onSessionEnd?.(sessB);
      expect(modelCall).not.toHaveBeenCalled();

      // Session A ends — should trigger LLM call (A has an output)
      await mw.onSessionEnd?.(sessA);
      expect(modelCall).toHaveBeenCalledTimes(1);
    });
  });
});
