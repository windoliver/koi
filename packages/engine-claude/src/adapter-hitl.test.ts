import { describe, expect, test } from "bun:test";
import type { ApprovalDecision, EngineEvent } from "@koi/core";
import type { SdkFunctions, SdkInputMessage } from "./adapter.js";
import { createClaudeAdapter } from "./adapter.js";
import {
  assistantMessage,
  collectEvents,
  createHitlMockSdk,
  createMockSdk,
  initMessage,
  resultMessage,
} from "./adapter-test-helpers.js";
import type { ClaudeAdapterConfig, SdkCanUseToolOptions } from "./types.js";
import { HITL_EVENTS } from "./types.js";

const MOCK_OPTIONS: SdkCanUseToolOptions = {
  signal: AbortSignal.abort(),
  toolUseID: "tool-1",
};

// ---------------------------------------------------------------------------
// saveHumanMessage
// ---------------------------------------------------------------------------

describe("saveHumanMessage", () => {
  test("pushes message to active queue during streaming", async () => {
    let resolveQuery: (() => void) | undefined;
    let capturedPrompt: AsyncIterable<SdkInputMessage> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompt = params.prompt as AsyncIterable<SdkInputMessage>;
        await new Promise<void>((r) => {
          resolveQuery = r;
        });
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    const stream = adapter.stream({ kind: "text", text: "Initial" });
    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await new Promise<void>((r) => setTimeout(r, 10));
    adapter.saveHumanMessage("Follow-up message");

    expect(capturedPrompt).toBeDefined();

    resolveQuery?.();
    await nextPromise;
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }
  });

  test("buffers messages when idle and drains on next stream", async () => {
    const { sdk, getCapturedPrompt } = createHitlMockSdk([
      initMessage("sess-1"),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    adapter.saveHumanMessage("Pre-buffered message 1");
    adapter.saveHumanMessage("Pre-buffered message 2");

    await collectEvents(adapter.stream({ kind: "text", text: "Hello" }));

    const prompt = getCapturedPrompt();
    expect(prompt).toBeDefined();
    expect(typeof prompt).not.toBe("string");
  });

  test("is a no-op after dispose with warning", async () => {
    const adapter = createClaudeAdapter({}, createMockSdk([]));
    await adapter.dispose?.();
    adapter.saveHumanMessage("Should be dropped");
  });

  test("saveHumanMessage is available on adapter", () => {
    const adapter = createClaudeAdapter({}, createMockSdk([]));
    expect(typeof adapter.saveHumanMessage).toBe("function");
  });

  test("multiple sequential streams each get fresh queues", async () => {
    const capturedPrompts: Array<string | AsyncIterable<SdkInputMessage>> = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompts.push(params.prompt);
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "First" }));
    await collectEvents(adapter.stream({ kind: "text", text: "Second" }));

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[0]).not.toBe(capturedPrompts[1]);
  });

  test("pending messages drained before initial message", async () => {
    const consumedMessages: SdkInputMessage[] = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        const queue = params.prompt as AsyncIterable<SdkInputMessage>;
        yield initMessage("sess-1");

        const iter = queue[Symbol.asyncIterator]();
        const readWithTimeout = async (): Promise<SdkInputMessage | undefined> => {
          const result = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), 50),
            ),
          ]);
          if (result.done) return undefined;
          return result.value;
        };

        const msg1 = await readWithTimeout();
        if (msg1) consumedMessages.push(msg1);
        const msg2 = await readWithTimeout();
        if (msg2) consumedMessages.push(msg2);
        const msg3 = await readWithTimeout();
        if (msg3) consumedMessages.push(msg3);

        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    adapter.saveHumanMessage("Pending 1");
    adapter.saveHumanMessage("Pending 2");

    await collectEvents(adapter.stream({ kind: "text", text: "Initial" }));

    expect(consumedMessages).toHaveLength(3);
    expect(consumedMessages[0]?.message.content).toBe("Pending 1");
    expect(consumedMessages[1]?.message.content).toBe("Pending 2");
    expect(consumedMessages[2]?.message.content).toBe("Initial");
  });
});

// ---------------------------------------------------------------------------
// Approval bridge integration (custom event signaling)
// ---------------------------------------------------------------------------

describe("approval bridge integration", () => {
  test("passes canUseTool to SDK options when approvalHandler is configured", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedOptions = params.options as Record<string, unknown> | undefined;
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const config: ClaudeAdapterConfig = {
      approvalHandler: async () => ({ kind: "allow" }) satisfies ApprovalDecision,
    };

    const adapter = createClaudeAdapter(config, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    expect(capturedOptions?.canUseTool).toBeDefined();
    expect(typeof capturedOptions?.canUseTool).toBe("function");
  });

  test("does not pass canUseTool when no approvalHandler", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedOptions = params.options as Record<string, unknown> | undefined;
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    expect(capturedOptions?.canUseTool).toBeUndefined();
  });

  test("emits HITL custom events during approval flow", async () => {
    let canUseToolFn:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          opts: SdkCanUseToolOptions,
        ) => Promise<unknown>)
      | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        canUseToolFn = (params.options as Record<string, unknown>)
          ?.canUseTool as typeof canUseToolFn;
        yield initMessage("sess-1");

        if (canUseToolFn !== undefined) {
          await canUseToolFn("search", { q: "test" }, MOCK_OPTIONS);
        }

        yield assistantMessage([{ type: "text", text: "Done" }]);
        yield resultMessage("success");
      },
    };

    const config: ClaudeAdapterConfig = {
      approvalHandler: async () => ({ kind: "allow" }) satisfies ApprovalDecision,
    };

    const adapter = createClaudeAdapter(config, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    const customEvents = events.filter(
      (e): e is EngineEvent & { readonly kind: "custom" } => e.kind === "custom",
    );

    const hitlRequest = customEvents.find((e) => e.type === HITL_EVENTS.REQUEST);
    expect(hitlRequest).toBeDefined();
    expect((hitlRequest?.data as Record<string, unknown>)?.toolName).toBe("search");

    const hitlResponse = customEvents.find((e) => e.type === HITL_EVENTS.RESPONSE_RECEIVED);
    expect(hitlResponse).toBeDefined();
  });

  test("emits HITL error event when approval handler throws", async () => {
    let canUseToolFn:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          opts: SdkCanUseToolOptions,
        ) => Promise<unknown>)
      | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        canUseToolFn = (params.options as Record<string, unknown>)
          ?.canUseTool as typeof canUseToolFn;
        yield initMessage("sess-1");

        if (canUseToolFn !== undefined) {
          await canUseToolFn("dangerous_tool", {}, MOCK_OPTIONS);
        }

        yield resultMessage("success");
      },
    };

    const config: ClaudeAdapterConfig = {
      approvalHandler: async () => {
        throw new Error("Handler crashed");
      },
    };

    const adapter = createClaudeAdapter(config, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    const customEvents = events.filter(
      (e): e is EngineEvent & { readonly kind: "custom" } => e.kind === "custom",
    );

    const errorEvent = customEvents.find((e) => e.type === HITL_EVENTS.ERROR);
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as Record<string, unknown>)?.error).toBe("Handler crashed");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle edge cases
// ---------------------------------------------------------------------------

describe("lifecycle edge cases", () => {
  test("queue is closed after stream completes", async () => {
    let capturedPrompt: AsyncIterable<SdkInputMessage> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompt = params.prompt as AsyncIterable<SdkInputMessage>;
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    const queue = capturedPrompt as unknown as { readonly closed: boolean };
    expect(queue.closed).toBe(true);
  });

  test("queue is closed after stream errors", async () => {
    let capturedPrompt: AsyncIterable<SdkInputMessage> | undefined;

    const sdk: SdkFunctions = {
      // biome-ignore lint/correctness/useYield: intentionally throws before yielding
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompt = params.prompt as AsyncIterable<SdkInputMessage>;
        throw new Error("SDK crash");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    const queue = capturedPrompt as unknown as { readonly closed: boolean };
    expect(queue.closed).toBe(true);
  });

  test("saveHumanMessage works across sequential streams", async () => {
    const consumedPerStream: SdkInputMessage[][] = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        const messages: SdkInputMessage[] = [];
        const queue = params.prompt as AsyncIterable<SdkInputMessage>;
        const iter = queue[Symbol.asyncIterator]();

        const readWithTimeout = async (): Promise<SdkInputMessage | undefined> => {
          const result = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), 50),
            ),
          ]);
          if (result.done) return undefined;
          return result.value;
        };

        const msg = await readWithTimeout();
        if (msg) messages.push(msg);

        consumedPerStream.push(messages);
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "First" }));

    adapter.saveHumanMessage("Between streams");

    await collectEvents(adapter.stream({ kind: "text", text: "Second" }));

    expect(consumedPerStream).toHaveLength(2);
    expect(consumedPerStream[1]?.[0]?.message.content).toBe("Between streams");
  });

  test("resume input sends no initial message to queue", async () => {
    const consumedMessages: SdkInputMessage[] = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        const queue = params.prompt as AsyncIterable<SdkInputMessage>;
        const iter = queue[Symbol.asyncIterator]();

        const result = await Promise.race([
          iter.next(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 50),
          ),
        ]);
        if (!result.done && result.value) {
          consumedMessages.push(result.value);
        }

        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(
      adapter.stream({
        kind: "resume",
        state: { engineId: "claude", data: { sessionId: "sess-1" } },
      }),
    );

    expect(consumedMessages).toHaveLength(0);
  });

  test("hitl maxQueueSize is passed to message queue", async () => {
    const { sdk } = createHitlMockSdk([initMessage("sess-1"), resultMessage("success")]);
    const config: ClaudeAdapterConfig = { hitl: { maxQueueSize: 5 } };
    const adapter = createClaudeAdapter(config, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));
  });
});
