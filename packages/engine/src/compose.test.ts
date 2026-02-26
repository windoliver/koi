import { describe, expect, mock, test } from "bun:test";
import {
  type AgentManifest,
  type ApprovalHandler,
  agentId,
  type ComponentProvider,
  type KoiMiddleware,
  type ModelChunk,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamHandler,
  runId,
  type SessionContext,
  sessionId,
  type ToolRequest,
  type ToolResponse,
  type TurnContext,
  toolToken,
  turnId,
} from "@koi/core";
import { AgentEntity } from "./agent-entity.js";
import {
  collectCapabilities,
  composeModelChain,
  composeModelStreamChain,
  composeToolChain,
  createComposedCallHandlers,
  createTerminalHandlers,
  formatCapabilityMessage,
  injectCapabilities,
  runSessionHooks,
  runTurnHooks,
} from "./compose.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockTurnContext(overrides?: Partial<TurnContext>): TurnContext {
  const rid = runId("r1");
  return {
    session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function mockModelRequest(): ModelRequest {
  return { messages: [] };
}

function mockModelResponse(content = "hello"): ModelResponse {
  return { content, model: "test-model" };
}

function mockToolRequest(toolId = "calc"): ToolRequest {
  return { toolId, input: { a: 1 } };
}

function mockToolResponse(output: unknown = 42): ToolResponse {
  return { output };
}

// ---------------------------------------------------------------------------
// composeModelChain — happy path
// ---------------------------------------------------------------------------

describe("composeModelChain", () => {
  test("calls terminal when no middleware has wrapModelCall", async () => {
    const terminal = mock(() => Promise.resolve(mockModelResponse()));
    const chain = composeModelChain([], terminal);
    const result = await chain(mockTurnContext(), mockModelRequest());
    expect(result.content).toBe("hello");
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("skips middleware without wrapModelCall", async () => {
    const terminal = mock(() => Promise.resolve(mockModelResponse()));
    const mw: KoiMiddleware = { name: "no-wrap" };
    const chain = composeModelChain([mw], terminal);
    await chain(mockTurnContext(), mockModelRequest());
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("calls middleware in order (outermost first)", async () => {
    const order: string[] = [];
    const mw1: KoiMiddleware = {
      name: "first",
      wrapModelCall: async (_ctx, req, next) => {
        order.push("first:before");
        const res = await next(req);
        order.push("first:after");
        return res;
      },
    };
    const mw2: KoiMiddleware = {
      name: "second",
      wrapModelCall: async (_ctx, req, next) => {
        order.push("second:before");
        const res = await next(req);
        order.push("second:after");
        return res;
      },
    };
    const terminal = mock(() => {
      order.push("terminal");
      return Promise.resolve(mockModelResponse());
    });

    const chain = composeModelChain([mw1, mw2], terminal);
    await chain(mockTurnContext(), mockModelRequest());

    expect(order).toEqual([
      "first:before",
      "second:before",
      "terminal",
      "second:after",
      "first:after",
    ]);
  });

  test("middleware can modify request before next", async () => {
    const mw: KoiMiddleware = {
      name: "modifier",
      wrapModelCall: async (_ctx, _req, next) => {
        return next({ messages: [], model: "modified-model" });
      },
    };
    const terminal = mock((req: ModelRequest) => {
      expect(req.model).toBe("modified-model");
      return Promise.resolve(mockModelResponse());
    });

    const chain = composeModelChain([mw], terminal);
    await chain(mockTurnContext(), mockModelRequest());
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("middleware can modify response after next", async () => {
    const mw: KoiMiddleware = {
      name: "response-modifier",
      wrapModelCall: async (_ctx, req, next) => {
        const res = await next(req);
        return { ...res, content: `${res.content} modified` };
      },
    };
    const terminal = mock(() => Promise.resolve(mockModelResponse("original")));
    const chain = composeModelChain([mw], terminal);
    const result = await chain(mockTurnContext(), mockModelRequest());
    expect(result.content).toBe("original modified");
  });

  test("middleware can short-circuit without calling next", async () => {
    const mw: KoiMiddleware = {
      name: "blocker",
      wrapModelCall: async () => {
        return mockModelResponse("blocked");
      },
    };
    const terminal = mock(() => Promise.resolve(mockModelResponse()));
    const chain = composeModelChain([mw], terminal);
    const result = await chain(mockTurnContext(), mockModelRequest());
    expect(result.content).toBe("blocked");
    expect(terminal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// composeModelChain — error propagation
// ---------------------------------------------------------------------------

describe("composeModelChain error propagation", () => {
  test("error from terminal propagates through all middleware", async () => {
    const order: string[] = [];
    const mw: KoiMiddleware = {
      name: "logger",
      wrapModelCall: async (_ctx, req, next) => {
        order.push("before");
        try {
          return await next(req);
        } finally {
          order.push("after");
        }
      },
    };
    const terminal = () => {
      throw new Error("adapter crash");
    };
    const chain = composeModelChain([mw], terminal);
    await expect(chain(mockTurnContext(), mockModelRequest())).rejects.toThrow("adapter crash");
    expect(order).toEqual(["before", "after"]);
  });

  test("error from middleware before next propagates to caller", async () => {
    const mw: KoiMiddleware = {
      name: "thrower",
      wrapModelCall: async () => {
        throw new Error("middleware error");
      },
    };
    const terminal = mock(() => Promise.resolve(mockModelResponse()));
    const chain = composeModelChain([mw], terminal);
    await expect(chain(mockTurnContext(), mockModelRequest())).rejects.toThrow("middleware error");
    expect(terminal).not.toHaveBeenCalled();
  });

  test("error from middleware after next propagates (downstream already ran)", async () => {
    const terminal = mock(() => Promise.resolve(mockModelResponse()));
    const mw: KoiMiddleware = {
      name: "post-error",
      wrapModelCall: async (_ctx, req, next) => {
        await next(req);
        throw new Error("post-next error");
      },
    };
    const chain = composeModelChain([mw], terminal);
    await expect(chain(mockTurnContext(), mockModelRequest())).rejects.toThrow("post-next error");
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("double next() call throws", async () => {
    const mw: KoiMiddleware = {
      name: "double-next",
      wrapModelCall: async (_ctx, req, next) => {
        await next(req);
        return next(req); // Second call
      },
    };
    const terminal = mock(() => Promise.resolve(mockModelResponse()));
    const chain = composeModelChain([mw], terminal);
    await expect(chain(mockTurnContext(), mockModelRequest())).rejects.toThrow(
      /called next\(\) multiple times/,
    );
  });

  test("async rejection propagates through chain", async () => {
    const terminal = () => Promise.reject(new Error("async rejection"));
    const chain = composeModelChain([], terminal);
    await expect(chain(mockTurnContext(), mockModelRequest())).rejects.toThrow("async rejection");
  });

  test("next() can be called again after inner chain rejects (retry-on-error)", async () => {
    let callCount = 0;
    const mw: KoiMiddleware = {
      name: "retry-mw",
      wrapModelCall: async (_ctx, req, next) => {
        try {
          return await next(req);
        } catch {
          // Retry once after error
          return next(req);
        }
      },
    };
    const terminal = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("transient error"));
      return Promise.resolve(mockModelResponse("recovered"));
    });
    const chain = composeModelChain([mw], terminal);
    const result = await chain(mockTurnContext(), mockModelRequest());
    expect(result.content).toBe("recovered");
    expect(callCount).toBe(2);
  });

  test("next() still throws on double-call after success (not error)", async () => {
    const mw: KoiMiddleware = {
      name: "double-after-success",
      wrapModelCall: async (_ctx, req, next) => {
        await next(req); // succeeds
        return next(req); // should still throw
      },
    };
    const terminal = mock(() => Promise.resolve(mockModelResponse()));
    const chain = composeModelChain([mw], terminal);
    await expect(chain(mockTurnContext(), mockModelRequest())).rejects.toThrow(
      /called next\(\) multiple times/,
    );
  });
});

// ---------------------------------------------------------------------------
// composeToolChain
// ---------------------------------------------------------------------------

describe("composeToolChain", () => {
  test("calls terminal when no middleware has wrapToolCall", async () => {
    const terminal = mock(() => Promise.resolve(mockToolResponse()));
    const chain = composeToolChain([], terminal);
    const result = await chain(mockTurnContext(), mockToolRequest());
    expect(result.output).toBe(42);
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("calls middleware in onion order", async () => {
    const order: string[] = [];
    const mw1: KoiMiddleware = {
      name: "first",
      wrapToolCall: async (_ctx, req, next) => {
        order.push("first:before");
        const res = await next(req);
        order.push("first:after");
        return res;
      },
    };
    const mw2: KoiMiddleware = {
      name: "second",
      wrapToolCall: async (_ctx, req, next) => {
        order.push("second:before");
        const res = await next(req);
        order.push("second:after");
        return res;
      },
    };
    const terminal = mock(() => {
      order.push("terminal");
      return Promise.resolve(mockToolResponse());
    });

    const chain = composeToolChain([mw1, mw2], terminal);
    await chain(mockTurnContext(), mockToolRequest());

    expect(order).toEqual([
      "first:before",
      "second:before",
      "terminal",
      "second:after",
      "first:after",
    ]);
  });

  test("double next() call throws", async () => {
    const mw: KoiMiddleware = {
      name: "double-next",
      wrapToolCall: async (_ctx, req, next) => {
        await next(req);
        return next(req);
      },
    };
    const terminal = mock(() => Promise.resolve(mockToolResponse()));
    const chain = composeToolChain([mw], terminal);
    await expect(chain(mockTurnContext(), mockToolRequest())).rejects.toThrow(
      /called next\(\) multiple times/,
    );
  });
});

// ---------------------------------------------------------------------------
// runSessionHooks
// ---------------------------------------------------------------------------

describe("runSessionHooks", () => {
  const sessionCtx: SessionContext = {
    agentId: "a1",
    sessionId: sessionId("s1"),
    runId: runId("r1"),
    metadata: {},
  };

  test("calls onSessionStart hooks in order", async () => {
    const order: string[] = [];
    const mw1: KoiMiddleware = {
      name: "first",
      onSessionStart: async () => {
        order.push("first");
      },
    };
    const mw2: KoiMiddleware = {
      name: "second",
      onSessionStart: async () => {
        order.push("second");
      },
    };
    await runSessionHooks([mw1, mw2], "onSessionStart", sessionCtx);
    expect(order).toEqual(["first", "second"]);
  });

  test("calls onSessionEnd hooks in order", async () => {
    const order: string[] = [];
    const mw1: KoiMiddleware = {
      name: "first",
      onSessionEnd: async () => {
        order.push("first");
      },
    };
    const mw2: KoiMiddleware = {
      name: "second",
      onSessionEnd: async () => {
        order.push("second");
      },
    };
    await runSessionHooks([mw1, mw2], "onSessionEnd", sessionCtx);
    expect(order).toEqual(["first", "second"]);
  });

  test("skips middleware without the hook", async () => {
    const called = mock(() => Promise.resolve());
    const mw1: KoiMiddleware = { name: "no-hook" };
    const mw2: KoiMiddleware = { name: "has-hook", onSessionStart: called };
    await runSessionHooks([mw1, mw2], "onSessionStart", sessionCtx);
    expect(called).toHaveBeenCalledTimes(1);
  });

  test("error in hook propagates", async () => {
    const mw: KoiMiddleware = {
      name: "throws",
      onSessionStart: async () => {
        throw new Error("hook error");
      },
    };
    await expect(runSessionHooks([mw], "onSessionStart", sessionCtx)).rejects.toThrow("hook error");
  });
});

// ---------------------------------------------------------------------------
// runTurnHooks
// ---------------------------------------------------------------------------

describe("runTurnHooks", () => {
  test("calls onBeforeTurn hooks in order", async () => {
    const order: string[] = [];
    const mw1: KoiMiddleware = {
      name: "first",
      onBeforeTurn: async () => {
        order.push("first");
      },
    };
    const mw2: KoiMiddleware = {
      name: "second",
      onBeforeTurn: async () => {
        order.push("second");
      },
    };
    await runTurnHooks([mw1, mw2], "onBeforeTurn", mockTurnContext());
    expect(order).toEqual(["first", "second"]);
  });

  test("calls onAfterTurn hooks in order", async () => {
    const order: string[] = [];
    const mw1: KoiMiddleware = {
      name: "first",
      onAfterTurn: async () => {
        order.push("first");
      },
    };
    const mw2: KoiMiddleware = {
      name: "second",
      onAfterTurn: async () => {
        order.push("second");
      },
    };
    await runTurnHooks([mw1, mw2], "onAfterTurn", mockTurnContext());
    expect(order).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// Helper: create a started agent entity for lifecycle tests
// ---------------------------------------------------------------------------

const testManifest: AgentManifest = {
  name: "Test",
  version: "0.1.0",
  model: { name: "test-model" },
};

async function createStartedAgent(): Promise<AgentEntity> {
  const pid = { id: agentId("a1"), name: "Test", type: "copilot" as const, depth: 0 };
  const { agent } = await AgentEntity.assemble(pid, testManifest, []);
  agent.transition({ kind: "start" });
  return agent;
}

// ---------------------------------------------------------------------------
// createTerminalHandlers
// ---------------------------------------------------------------------------

describe("createTerminalHandlers", () => {
  test("model call transitions running → waiting → running", async () => {
    const agent = await createStartedAgent();
    expect(agent.state).toBe("running");

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const { modelHandler } = createTerminalHandlers(agent, rawModel, rawTool);

    await modelHandler(mockModelRequest());

    expect(rawModel).toHaveBeenCalledTimes(1);
    expect(agent.state).toBe("running");
  });

  test("tool call transitions running → waiting → running", async () => {
    const agent = await createStartedAgent();
    expect(agent.state).toBe("running");

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const { toolHandler } = createTerminalHandlers(agent, rawModel, rawTool);

    await toolHandler(mockToolRequest());

    expect(rawTool).toHaveBeenCalledTimes(1);
    expect(agent.state).toBe("running");
  });

  test("model call resumes even on error (not stuck in waiting)", async () => {
    const agent = await createStartedAgent();

    const rawModel = mock(() => Promise.reject(new Error("model exploded")));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const { modelHandler } = createTerminalHandlers(agent, rawModel, rawTool);

    await expect(modelHandler(mockModelRequest())).rejects.toThrow("model exploded");
    // Agent should be back to running, not stuck in waiting
    expect(agent.state).toBe("running");
  });

  test("tool call resumes even on error (not stuck in waiting)", async () => {
    const agent = await createStartedAgent();

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.reject(new Error("tool exploded")));
    const { toolHandler } = createTerminalHandlers(agent, rawModel, rawTool);

    await expect(toolHandler(mockToolRequest())).rejects.toThrow("tool exploded");
    expect(agent.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// createComposedCallHandlers
// ---------------------------------------------------------------------------

describe("createComposedCallHandlers", () => {
  test("middleware wraps terminals in correct order", async () => {
    const agent = await createStartedAgent();
    const order: string[] = [];

    const mw: KoiMiddleware = {
      name: "tracker",
      wrapModelCall: async (_ctx, req, next) => {
        order.push("mw:before");
        const res = await next(req);
        order.push("mw:after");
        return res;
      },
    };

    const rawModel = mock(() => {
      order.push("terminal");
      return Promise.resolve(mockModelResponse());
    });
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    await handlers.modelCall(mockModelRequest());

    expect(order).toEqual(["mw:before", "terminal", "mw:after"]);
  });

  test("tool call middleware fires through composed handlers", async () => {
    const agent = await createStartedAgent();
    const intercepted = mock(() => {});

    const mw: KoiMiddleware = {
      name: "interceptor",
      wrapToolCall: async (_ctx, req, next) => {
        intercepted();
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    await handlers.toolCall(mockToolRequest());

    expect(intercepted).toHaveBeenCalledTimes(1);
    expect(rawTool).toHaveBeenCalledTimes(1);
  });

  test("tools is empty when agent has no tool components", async () => {
    const agent = await createStartedAgent();
    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    expect(handlers.tools).toEqual([]);
  });

  test("tools contains descriptors from agent tool components", async () => {
    const toolProvider: ComponentProvider = {
      name: "test-tools",
      attach: async () => {
        return new Map<string, unknown>([
          [
            toolToken("calc") as string,
            {
              descriptor: { name: "calc", description: "Calculator", inputSchema: {} },
              trustTier: "sandboxed",
              execute: async (): Promise<unknown> => 42,
            },
          ],
          [
            toolToken("search") as string,
            {
              descriptor: {
                name: "search",
                description: "Web search",
                inputSchema: { type: "object" },
              },
              trustTier: "sandboxed",
              execute: async (): Promise<unknown> => "results",
            },
          ],
        ]);
      },
    };
    const pid = { id: agentId("a1"), name: "Test", type: "copilot" as const, depth: 0 };
    const { agent } = await AgentEntity.assemble(pid, testManifest, [toolProvider]);
    agent.transition({ kind: "start" });

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    expect(handlers.tools).toHaveLength(2);
    expect(handlers.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["calc", "search"]));
  });

  test("injects tools into ModelRequest when not already set", async () => {
    const agent = await createStartedAgent();
    let receivedRequest: ModelRequest | undefined;

    const mw: KoiMiddleware = {
      name: "spy",
      wrapModelCall: async (_ctx, req, next) => {
        receivedRequest = req;
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    await handlers.modelCall(mockModelRequest());

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.tools).toEqual([]);
  });

  test("preserves existing tools on ModelRequest", async () => {
    const agent = await createStartedAgent();
    const customTools = [{ name: "custom", description: "Custom tool", inputSchema: {} }];
    let receivedRequest: ModelRequest | undefined;

    const mw: KoiMiddleware = {
      name: "spy",
      wrapModelCall: async (_ctx, req, next) => {
        receivedRequest = req;
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    await handlers.modelCall({ ...mockModelRequest(), tools: customTools });

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.tools).toEqual(customTools);
  });
});

// ---------------------------------------------------------------------------
// Streaming test helpers
// ---------------------------------------------------------------------------

function mockStreamChunks(chunks: readonly ModelChunk[]): ModelStreamHandler {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  });
}

async function collectChunks(iter: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const result: ModelChunk[] = [];
  for await (const chunk of iter) {
    result.push(chunk);
  }
  return result;
}

const sampleChunks: ModelChunk[] = [
  { kind: "text_delta", delta: "Hello" },
  { kind: "text_delta", delta: " world" },
  { kind: "done", response: mockModelResponse("Hello world") },
];

// ---------------------------------------------------------------------------
// composeModelStreamChain
// ---------------------------------------------------------------------------

describe("composeModelStreamChain", () => {
  test("calls terminal when no middleware has wrapModelStream", async () => {
    const terminal = mockStreamChunks(sampleChunks);
    const chain = composeModelStreamChain([], terminal);
    const chunks = await collectChunks(chain(mockTurnContext(), mockModelRequest()));
    expect(chunks).toEqual(sampleChunks);
  });

  test("skips middleware without wrapModelStream", async () => {
    const terminal = mockStreamChunks(sampleChunks);
    const mw: KoiMiddleware = { name: "no-wrap" };
    const chain = composeModelStreamChain([mw], terminal);
    const chunks = await collectChunks(chain(mockTurnContext(), mockModelRequest()));
    expect(chunks).toEqual(sampleChunks);
  });

  test("middleware observes and passes through chunks", async () => {
    const observed: ModelChunk[] = [];
    const mw: KoiMiddleware = {
      name: "observer",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          for await (const chunk of next(req)) {
            observed.push(chunk);
            yield chunk;
          }
        },
      }),
    };
    const terminal = mockStreamChunks(sampleChunks);
    const chain = composeModelStreamChain([mw], terminal);
    const chunks = await collectChunks(chain(mockTurnContext(), mockModelRequest()));
    expect(chunks).toEqual(sampleChunks);
    expect(observed).toEqual(sampleChunks);
  });

  test("middleware transforms chunks (e.g., uppercase text deltas)", async () => {
    const mw: KoiMiddleware = {
      name: "uppercaser",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          for await (const chunk of next(req)) {
            if (chunk.kind === "text_delta") {
              yield { kind: "text_delta" as const, delta: chunk.delta.toUpperCase() };
            } else {
              yield chunk;
            }
          }
        },
      }),
    };
    const terminal = mockStreamChunks(sampleChunks);
    const chain = composeModelStreamChain([mw], terminal);
    const chunks = await collectChunks(chain(mockTurnContext(), mockModelRequest()));
    expect(chunks[0]).toEqual({ kind: "text_delta", delta: "HELLO" });
    expect(chunks[1]).toEqual({ kind: "text_delta", delta: " WORLD" });
    expect(chunks[2]).toEqual(sampleChunks[2]); // done chunk unchanged
  });

  test("middleware short-circuits without calling next", async () => {
    const shortCircuitChunks: ModelChunk[] = [
      { kind: "text_delta", delta: "blocked" },
      { kind: "done", response: mockModelResponse("blocked") },
    ];
    const mw: KoiMiddleware = {
      name: "blocker",
      wrapModelStream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const chunk of shortCircuitChunks) {
            yield chunk;
          }
        },
      }),
    };
    const terminalCalled = mock(() => {});
    const terminal: ModelStreamHandler = () => {
      terminalCalled();
      return { async *[Symbol.asyncIterator]() {} };
    };
    const chain = composeModelStreamChain([mw], terminal);
    const chunks = await collectChunks(chain(mockTurnContext(), mockModelRequest()));
    expect(chunks).toEqual(shortCircuitChunks);
    expect(terminalCalled).not.toHaveBeenCalled();
  });

  test("calls middleware in onion order (outermost first)", async () => {
    const order: string[] = [];
    const mw1: KoiMiddleware = {
      name: "first",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          order.push("first:before");
          yield* next(req);
          order.push("first:after");
        },
      }),
    };
    const mw2: KoiMiddleware = {
      name: "second",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          order.push("second:before");
          yield* next(req);
          order.push("second:after");
        },
      }),
    };
    const terminal = mockStreamChunks(sampleChunks);
    const chain = composeModelStreamChain([mw1, mw2], terminal);
    await collectChunks(chain(mockTurnContext(), mockModelRequest()));
    expect(order).toEqual(["first:before", "second:before", "second:after", "first:after"]);
  });

  test("double next() call throws", async () => {
    const mw: KoiMiddleware = {
      name: "double-next",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          yield* next(req);
          yield* next(req); // second call should throw
        },
      }),
    };
    const terminal = mockStreamChunks(sampleChunks);
    const chain = composeModelStreamChain([mw], terminal);
    await expect(collectChunks(chain(mockTurnContext(), mockModelRequest()))).rejects.toThrow(
      /called next\(\) multiple times/,
    );
  });

  test("error propagation through chain", async () => {
    const errorTerminal: ModelStreamHandler = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ModelChunk>> {
            throw new Error("stream crash");
          },
        };
      },
    });
    const order: string[] = [];
    const mw: KoiMiddleware = {
      name: "logger",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          order.push("before");
          try {
            yield* next(req);
          } finally {
            order.push("after");
          }
        },
      }),
    };
    const chain = composeModelStreamChain([mw], errorTerminal);
    await expect(collectChunks(chain(mockTurnContext(), mockModelRequest()))).rejects.toThrow(
      "stream crash",
    );
    expect(order).toEqual(["before", "after"]);
  });

  test("next() can be called again after inner stream throws (retry-on-error)", async () => {
    let callCount = 0;
    const mw: KoiMiddleware = {
      name: "stream-retry",
      wrapModelStream: async function* (_ctx, req, next) {
        try {
          yield* next(req);
        } catch {
          // Retry once after error
          yield* next(req);
        }
      },
    };
    const terminal: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        callCount++;
        if (callCount === 1) throw new Error("transient stream error");
        yield* sampleChunks;
      },
    });
    const chain = composeModelStreamChain([mw], terminal);
    const chunks = await collectChunks(chain(mockTurnContext(), mockModelRequest()));
    expect(callCount).toBe(2);
    expect(chunks).toEqual(sampleChunks);
  });

  test("next() still throws on double-call after successful stream (not error)", async () => {
    const mw: KoiMiddleware = {
      name: "double-after-success-stream",
      wrapModelStream: async function* (_ctx, req, next) {
        yield* next(req); // succeeds
        yield* next(req); // should still throw
      },
    };
    const terminal = mockStreamChunks(sampleChunks);
    const chain = composeModelStreamChain([mw], terminal);
    await expect(collectChunks(chain(mockTurnContext(), mockModelRequest()))).rejects.toThrow(
      /called next\(\) multiple times/,
    );
  });
});

// ---------------------------------------------------------------------------
// createTerminalHandlers — streaming
// ---------------------------------------------------------------------------

describe("createTerminalHandlers streaming", () => {
  test("streaming call transitions running → waiting(model_stream) → running", async () => {
    const agent = await createStartedAgent();
    expect(agent.state).toBe("running");

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const rawStream = mockStreamChunks(sampleChunks);
    const handlers = createTerminalHandlers(agent, rawModel, rawTool, rawStream);

    expect(handlers.modelStreamHandler).toBeDefined();
    if (handlers.modelStreamHandler) {
      await collectChunks(handlers.modelStreamHandler(mockModelRequest()));
    }
    expect(agent.state).toBe("running");
  });

  test("streaming resumes on mid-stream error", async () => {
    const agent = await createStartedAgent();
    const errorStream: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "text_delta" as const, delta: "hello" };
        throw new Error("mid-stream error");
      },
    });
    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const handlers = createTerminalHandlers(agent, rawModel, rawTool, errorStream);

    try {
      if (handlers.modelStreamHandler) {
        await collectChunks(handlers.modelStreamHandler(mockModelRequest()));
      }
    } catch {
      // expected
    }
    expect(agent.state).toBe("running");
  });

  test("streaming resumes on early break (return())", async () => {
    const agent = await createStartedAgent();
    const infiniteStream: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        let i = 0;
        while (true) {
          yield { kind: "text_delta" as const, delta: `chunk${i++}` };
        }
      },
    });
    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const handlers = createTerminalHandlers(agent, rawModel, rawTool, infiniteStream);
    expect(handlers.modelStreamHandler).toBeDefined();

    // Consume only 2 chunks, then break
    let count = 0;
    if (handlers.modelStreamHandler) {
      for await (const _chunk of handlers.modelStreamHandler(mockModelRequest())) {
        count++;
        if (count >= 2) break;
      }
    }
    expect(count).toBe(2);
    expect(agent.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// createComposedCallHandlers — streaming
// ---------------------------------------------------------------------------

describe("createComposedCallHandlers streaming", () => {
  test("TurnContext.requestApproval is accessible in wrapToolCall middleware", async () => {
    const agent = await createStartedAgent();
    const approvalHandler: ApprovalHandler = async () => ({ kind: "allow" });
    const ctxWithApproval = mockTurnContext({ requestApproval: approvalHandler });
    let receivedHandler: ApprovalHandler | undefined;

    const mw: KoiMiddleware = {
      name: "hitl-mw",
      wrapToolCall: async (ctx, req, next) => {
        receivedHandler = ctx.requestApproval;
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => ctxWithApproval,
      agent,
      rawModel,
      rawTool,
    );

    await handlers.toolCall(mockToolRequest());
    expect(receivedHandler).toBe(approvalHandler);
  });

  test("middleware can deny tool call via requestApproval", async () => {
    const agent = await createStartedAgent();
    const approvalHandler: ApprovalHandler = async () => ({
      kind: "deny",
      reason: "not allowed",
    });
    const ctxWithApproval = mockTurnContext({ requestApproval: approvalHandler });

    const mw: KoiMiddleware = {
      name: "hitl-gate",
      wrapToolCall: async (ctx, req, next) => {
        if (ctx.requestApproval) {
          const decision = await ctx.requestApproval({
            toolId: req.toolId,
            input: req.input,
            reason: "requires approval",
          });
          if (decision.kind === "deny") {
            return { output: `Denied: ${decision.reason}` };
          }
        }
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => ctxWithApproval,
      agent,
      rawModel,
      rawTool,
    );

    const result = await handlers.toolCall(mockToolRequest());
    expect(result.output).toBe("Denied: not allowed");
    expect(rawTool).not.toHaveBeenCalled();
  });

  test("middleware can modify tool input via requestApproval returning modify", async () => {
    const agent = await createStartedAgent();
    const approvalHandler: ApprovalHandler = async () => ({
      kind: "modify",
      updatedInput: { a: 99 },
    });
    const ctxWithApproval = mockTurnContext({ requestApproval: approvalHandler });

    const mw: KoiMiddleware = {
      name: "hitl-modify",
      wrapToolCall: async (ctx, req, next) => {
        if (ctx.requestApproval) {
          const decision = await ctx.requestApproval({
            toolId: req.toolId,
            input: req.input,
            reason: "requires approval",
          });
          if (decision.kind === "modify") {
            return next({ ...req, input: decision.updatedInput });
          }
        }
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock((req: ToolRequest) => Promise.resolve({ output: req.input }));

    const handlers = createComposedCallHandlers(
      [mw],
      () => ctxWithApproval,
      agent,
      rawModel,
      rawTool,
    );

    const result = await handlers.toolCall(mockToolRequest());
    expect(result.output).toEqual({ a: 99 });
  });

  test("middleware passes through when requestApproval is undefined", async () => {
    const agent = await createStartedAgent();
    const ctxWithoutApproval = mockTurnContext(); // no requestApproval

    const mw: KoiMiddleware = {
      name: "hitl-optional",
      wrapToolCall: async (ctx, req, next) => {
        if (ctx.requestApproval) {
          const decision = await ctx.requestApproval({
            toolId: req.toolId,
            input: req.input,
            reason: "requires approval",
          });
          if (decision.kind === "deny") {
            return { output: "denied" };
          }
        }
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse(42)));

    const handlers = createComposedCallHandlers(
      [mw],
      () => ctxWithoutApproval,
      agent,
      rawModel,
      rawTool,
    );

    const result = await handlers.toolCall(mockToolRequest());
    expect(result.output).toBe(42);
    expect(rawTool).toHaveBeenCalledTimes(1);
  });

  test("includes modelStream when rawModelStreamTerminal provided", async () => {
    const agent = await createStartedAgent();
    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const rawStream = mockStreamChunks(sampleChunks);

    const handlers = createComposedCallHandlers(
      [],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
      rawStream,
    );

    expect(handlers.modelStream).toBeDefined();
    expect(typeof handlers.modelStream).toBe("function");
  });

  test("omits modelStream when rawModelStreamTerminal not provided", async () => {
    const agent = await createStartedAgent();
    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    expect(handlers.modelStream).toBeUndefined();
  });

  test("streaming middleware fires through composed handlers", async () => {
    const agent = await createStartedAgent();
    const observed: string[] = [];

    const mw: KoiMiddleware = {
      name: "stream-observer",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          observed.push("mw:start");
          yield* next(req);
          observed.push("mw:end");
        },
      }),
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const rawStream = mockStreamChunks(sampleChunks);

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
      rawStream,
    );

    expect(handlers.modelStream).toBeDefined();
    if (handlers.modelStream) {
      const chunks = await collectChunks(handlers.modelStream(mockModelRequest()));
      expect(chunks).toEqual(sampleChunks);
    }
    expect(observed).toEqual(["mw:start", "mw:end"]);
  });
});

// ---------------------------------------------------------------------------
// collectCapabilities
// ---------------------------------------------------------------------------

describe("collectCapabilities", () => {
  test("returns empty array when no middleware has describeCapabilities", () => {
    const mw: KoiMiddleware = { name: "plain" };
    const result = collectCapabilities([mw], mockTurnContext());
    expect(result).toEqual([]);
  });

  test("collects fragment from one middleware", () => {
    const mw: KoiMiddleware = {
      name: "perms",
      describeCapabilities: () => ({ label: "permissions", description: "All tools allowed" }),
    };
    const result = collectCapabilities([mw], mockTurnContext());
    expect(result).toEqual([{ label: "permissions", description: "All tools allowed" }]);
  });

  test("collects fragments from multiple middleware in order", () => {
    const mw1: KoiMiddleware = {
      name: "perms",
      describeCapabilities: () => ({ label: "permissions", description: "perms desc" }),
    };
    const mw2: KoiMiddleware = {
      name: "budget",
      describeCapabilities: () => ({ label: "budget", description: "budget desc" }),
    };
    const result = collectCapabilities([mw1, mw2], mockTurnContext());
    expect(result).toHaveLength(2);
    expect(result[0]?.label).toBe("permissions");
    expect(result[1]?.label).toBe("budget");
  });

  test("skips middleware that returns undefined", () => {
    const mw1: KoiMiddleware = {
      name: "conditional",
      describeCapabilities: () => undefined,
    };
    const mw2: KoiMiddleware = {
      name: "active",
      describeCapabilities: () => ({ label: "active", description: "active desc" }),
    };
    const result = collectCapabilities([mw1, mw2], mockTurnContext());
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("active");
  });

  test("catches and skips middleware that throws", () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    const mw1: KoiMiddleware = {
      name: "broken",
      describeCapabilities: () => {
        throw new Error("oops");
      },
    };
    const mw2: KoiMiddleware = {
      name: "healthy",
      describeCapabilities: () => ({ label: "healthy", description: "still works" }),
    };
    const result = collectCapabilities([mw1, mw2], mockTurnContext());

    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("healthy");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    console.warn = originalWarn;
  });

  test("treats empty string description as valid", () => {
    const mw: KoiMiddleware = {
      name: "empty-desc",
      describeCapabilities: () => ({ label: "test", description: "" }),
    };
    const result = collectCapabilities([mw], mockTurnContext());
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatCapabilityMessage
// ---------------------------------------------------------------------------

describe("formatCapabilityMessage", () => {
  test("formats single fragment", () => {
    const msg = formatCapabilityMessage([{ label: "perms", description: "All allowed" }]);
    expect(msg.senderId).toBe("system:capabilities");
    expect(msg.content).toHaveLength(1);
    const text = msg.content[0];
    expect(text?.kind).toBe("text");
    if (text?.kind === "text") {
      expect(text.text).toContain("[Active Capabilities]");
      expect(text.text).toContain("- **perms**: All allowed");
    }
  });

  test("formats multiple fragments", () => {
    const msg = formatCapabilityMessage([
      { label: "perms", description: "desc1" },
      { label: "budget", description: "desc2" },
    ]);
    const text = msg.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("- **perms**: desc1");
      expect(text.text).toContain("- **budget**: desc2");
    }
  });
});

// ---------------------------------------------------------------------------
// injectCapabilities
// ---------------------------------------------------------------------------

describe("injectCapabilities", () => {
  test("returns request unchanged when no middleware has describeCapabilities", () => {
    const mw: KoiMiddleware = { name: "plain" };
    const request = mockModelRequest();
    const result = injectCapabilities([mw], mockTurnContext(), request);
    expect(result).toBe(request); // same reference = zero allocation
  });

  test("prepends capability message before existing messages", () => {
    const mw: KoiMiddleware = {
      name: "perms",
      describeCapabilities: () => ({ label: "permissions", description: "test" }),
    };
    const existingMsg = {
      senderId: "user",
      timestamp: Date.now(),
      content: [{ kind: "text" as const, text: "hello" }],
    };
    const request: ModelRequest = { messages: [existingMsg] };
    const result = injectCapabilities([mw], mockTurnContext(), request);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.senderId).toBe("system:capabilities");
    expect(result.messages[1]?.senderId).toBe("user");
  });

  test("maxCapabilityTokens truncates fragments from end", () => {
    const mw1: KoiMiddleware = {
      name: "short",
      describeCapabilities: () => ({ label: "a", description: "short" }),
    };
    const mw2: KoiMiddleware = {
      name: "long",
      describeCapabilities: () => ({
        label: "b",
        description: "x".repeat(1000),
      }),
    };
    const request = mockModelRequest();
    const result = injectCapabilities([mw1, mw2], mockTurnContext(), request, {
      maxCapabilityTokens: 20,
    });

    // Should include only the first fragment since second would exceed budget
    const text = result.messages[0]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("**a**");
      expect(text.text).not.toContain("**b**");
    }
  });

  test("returns request unchanged when maxCapabilityTokens is too small for any fragment", () => {
    const mw: KoiMiddleware = {
      name: "verbose",
      describeCapabilities: () => ({
        label: "verbose",
        description: "x".repeat(1000),
      }),
    };
    const request = mockModelRequest();
    const result = injectCapabilities([mw], mockTurnContext(), request, {
      maxCapabilityTokens: 1,
    });
    expect(result).toBe(request);
  });
});

// ---------------------------------------------------------------------------
// createComposedCallHandlers — capability injection integration
// ---------------------------------------------------------------------------

describe("createComposedCallHandlers capability injection", () => {
  test("injects capabilities into modelCall request", async () => {
    const agent = await createStartedAgent();
    let receivedRequest: ModelRequest | undefined;

    const mw: KoiMiddleware = {
      name: "cap-mw",
      describeCapabilities: () => ({ label: "test-cap", description: "test description" }),
      wrapModelCall: async (_ctx, req, next) => {
        receivedRequest = req;
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    await handlers.modelCall(mockModelRequest());

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.messages[0]?.senderId).toBe("system:capabilities");
    const text = receivedRequest?.messages[0]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("**test-cap**: test description");
    }
  });

  test("injects capabilities into modelStream request", async () => {
    const agent = await createStartedAgent();
    let receivedRequest: ModelRequest | undefined;

    const mw: KoiMiddleware = {
      name: "cap-stream-mw",
      describeCapabilities: () => ({ label: "stream-cap", description: "stream desc" }),
      wrapModelStream: (_ctx, req, next) => {
        receivedRequest = req;
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));
    const rawStream = mockStreamChunks(sampleChunks);

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
      rawStream,
    );

    expect(handlers.modelStream).toBeDefined();
    if (handlers.modelStream) {
      await collectChunks(handlers.modelStream(mockModelRequest()));
    }

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.messages[0]?.senderId).toBe("system:capabilities");
  });

  test("skips capability injection when no middleware has describeCapabilities", async () => {
    const agent = await createStartedAgent();
    let receivedRequest: ModelRequest | undefined;

    const mw: KoiMiddleware = {
      name: "no-caps",
      wrapModelCall: async (_ctx, req, next) => {
        receivedRequest = req;
        return next(req);
      },
    };

    const rawModel = mock(() => Promise.resolve(mockModelResponse()));
    const rawTool = mock(() => Promise.resolve(mockToolResponse()));

    const handlers = createComposedCallHandlers(
      [mw],
      () => mockTurnContext(),
      agent,
      rawModel,
      rawTool,
    );

    await handlers.modelCall(mockModelRequest());

    expect(receivedRequest).toBeDefined();
    // Only injected tools message, no capabilities message
    const capMsg = receivedRequest?.messages.find((m) => m.senderId === "system:capabilities");
    expect(capMsg).toBeUndefined();
  });
});
