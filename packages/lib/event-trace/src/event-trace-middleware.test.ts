import { describe, expect, test } from "bun:test";
import type {
  ModelChunk,
  ModelRequest,
  ModelResponse,
  RunId,
  SessionContext,
  SessionId,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { createInMemoryTrajectoryStore } from "./atif-store.js";
import { createEventTraceMiddleware } from "./event-trace-middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionId(id: string): SessionId {
  return id as SessionId;
}

function makeSessionCtx(sid = "sess-1"): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: sessionId(sid),
    runId: "run-1" as RunId,
    metadata: {},
  };
}

function makeTurnCtx(sid = "sess-1", turnIndex = 0): TurnContext {
  return {
    session: makeSessionCtx(sid),
    turnIndex,
    turnId: `run-1:t${String(turnIndex)}` as TurnId,
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(text = "hello"): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text", text }] } as never],
    model: "test-model",
  };
}

function makeModelResponse(content = "world"): ModelResponse {
  return {
    content,
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeToolRequest(toolId = "read_file"): ToolRequest {
  return {
    toolId,
    input: { path: "foo.ts" },
  };
}

function makeToolResponse(output = "file contents"): ToolResponse {
  return { output };
}

let clockTime = 1000;
function testClock(): number {
  return clockTime;
}
function advanceClock(ms: number): void {
  clockTime += ms;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEventTraceMiddleware", () => {
  test("wrapModelCall records request, response, duration, metrics", async () => {
    clockTime = 1000;
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store, clock: testClock });

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const response = await handle.middleware.wrapModelCall?.(
      makeTurnCtx(),
      makeModelRequest("hi"),
      async () => {
        advanceClock(500);
        return makeModelResponse("bye");
      },
    );

    expect(response?.content).toBe("bye");

    const steps = await handle.getTrajectory("sess-1");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("model_call");
    expect(steps[0]?.identifier).toBe("test-model");
    expect(steps[0]?.outcome).toBe("success");
    expect(steps[0]?.durationMs).toBe(500);
    expect(steps[0]?.metrics?.promptTokens).toBe(10);
    expect(steps[0]?.metrics?.completionTokens).toBe(5);
    expect(steps[0]?.response?.text).toBe("bye");

    await handle.middleware.onSessionEnd?.(makeSessionCtx());
  });

  test("wrapToolCall records tool name, args, result, duration", async () => {
    clockTime = 1000;
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store, clock: testClock });

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeToolRequest("write_file"),
      async () => {
        advanceClock(200);
        return makeToolResponse("ok");
      },
    );

    expect(response?.output).toBe("ok");

    const steps = await handle.getTrajectory("sess-1");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("tool_call");
    expect(steps[0]?.identifier).toBe("write_file");
    expect(steps[0]?.outcome).toBe("success");
    expect(steps[0]?.durationMs).toBe(200);
    expect(steps[0]?.request?.data).toEqual({ path: "foo.ts" });
    expect(steps[0]?.response?.text).toBe("ok");

    await handle.middleware.onSessionEnd?.(makeSessionCtx());
  });

  test("wrapModelStream records streaming call", async () => {
    clockTime = 1000;
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store, clock: testClock });

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const doneResponse = makeModelResponse("streamed");
    const stream = handle.middleware.wrapModelStream?.(makeTurnCtx(), makeModelRequest(), () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "text_delta" as const, delta: "str" };
        advanceClock(300);
        yield { kind: "done" as const, response: doneResponse };
      },
    }));

    const chunks: ModelChunk[] = [];
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    }

    expect(chunks).toHaveLength(2);

    const steps = await handle.getTrajectory("sess-1");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("model_call");
    expect(steps[0]?.durationMs).toBe(300);
    expect(steps[0]?.response?.text).toBe("streamed");

    await handle.middleware.onSessionEnd?.(makeSessionCtx());
  });

  test("error in model call records failure outcome", async () => {
    clockTime = 1000;
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store, clock: testClock });

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    try {
      await handle.middleware.wrapModelCall?.(makeTurnCtx(), makeModelRequest(), async () => {
        advanceClock(100);
        throw new Error("model error");
      });
    } catch {
      // expected
    }

    const steps = await handle.getTrajectory("sess-1");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.outcome).toBe("failure");
    expect(steps[0]?.response).toBeUndefined();

    await handle.middleware.onSessionEnd?.(makeSessionCtx());
  });

  test("error in tool call records failure outcome", async () => {
    clockTime = 1000;
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store, clock: testClock });

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    try {
      await handle.middleware.wrapToolCall?.(makeTurnCtx(), makeToolRequest(), async () => {
        throw new Error("tool error");
      });
    } catch {
      // expected
    }

    const steps = await handle.getTrajectory("sess-1");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.outcome).toBe("failure");

    await handle.middleware.onSessionEnd?.(makeSessionCtx());
  });

  test("per-turn segmentation: steps accumulate across turns", async () => {
    clockTime = 1000;
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store, clock: testClock });

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    // Turn 0
    await handle.middleware.onBeforeTurn?.(makeTurnCtx("sess-1", 0));
    await handle.middleware.wrapModelCall?.(
      makeTurnCtx("sess-1", 0),
      makeModelRequest(),
      async () => {
        advanceClock(100);
        return makeModelResponse();
      },
    );
    await handle.middleware.onAfterTurn?.(makeTurnCtx("sess-1", 0));

    // Turn 1
    await handle.middleware.onBeforeTurn?.(makeTurnCtx("sess-1", 1));
    await handle.middleware.wrapToolCall?.(
      makeTurnCtx("sess-1", 1),
      makeToolRequest(),
      async () => {
        advanceClock(50);
        return makeToolResponse();
      },
    );
    await handle.middleware.onAfterTurn?.(makeTurnCtx("sess-1", 1));

    const steps = await handle.getTrajectory("sess-1");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.stepIndex).toBe(0);
    expect(steps[1]?.stepIndex).toBe(1);

    expect(handle.getStepCount("sess-1")).toBe(2);

    await handle.middleware.onSessionEnd?.(makeSessionCtx());
  });

  test("getStepCount returns 0 for unknown session", () => {
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store });
    expect(handle.getStepCount("unknown")).toBe(0);
  });

  test("describeCapabilities returns tracing label", () => {
    const store = createInMemoryTrajectoryStore();
    const handle = createEventTraceMiddleware({ store });
    const caps = handle.middleware.describeCapabilities({} as TurnContext);
    expect(caps?.label).toBe("tracing");
  });
});
