import { describe, expect, mock, test } from "bun:test";
import type {
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
} from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse, TurnContext } from "@koi/core/middleware";
import type { AmbiguityClassifier } from "./ambiguity-classifier.js";
import type { CorrectionDetector } from "./correction-detector.js";
import { createPersonalizationMiddleware } from "./personalization.js";

function createMockMemory(recallResult: readonly MemoryResult[] = []): MemoryComponent & {
  readonly storeCalls: Array<{
    readonly content: string;
    readonly options?: MemoryStoreOptions | undefined;
  }>;
} {
  const storeCalls: Array<{
    readonly content: string;
    readonly options?: MemoryStoreOptions | undefined;
  }> = [];
  return {
    storeCalls,
    async recall(_query: string, _options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      return recallResult;
    },
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      storeCalls.push({ content, options });
    },
  };
}

function createTurnContext(turnIndex: number): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "test-session" as never,
      runId: "test-run" as never,
      metadata: {},
    },
    turnIndex,
    turnId: "test-turn" as never,
    messages: [],
    metadata: {},
  };
}

function createModelRequest(text: string): ModelRequest {
  const message: InboundMessage = {
    senderId: "user",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
  return { messages: [message] };
}

function createMockNext(
  response?: Partial<ModelResponse>,
): ReturnType<typeof mock> & ((req: ModelRequest) => Promise<ModelResponse>) {
  return mock(
    async (_req: ModelRequest): Promise<ModelResponse> => ({
      content: "test response",
      model: "test-model",
      ...response,
    }),
  );
}

describe("createPersonalizationMiddleware", () => {
  test("has correct name and priority", () => {
    const mw = createPersonalizationMiddleware({ memory: createMockMemory() });
    expect(mw.name).toBe("personalization");
    expect(mw.priority).toBe(420);
  });

  test("describeCapabilities returns fragment for both channels", () => {
    const mw = createPersonalizationMiddleware({ memory: createMockMemory() });
    const fragment = mw.describeCapabilities(createTurnContext(0));
    expect(fragment?.label).toBe("personalization");
    expect(fragment?.description).toContain("clarify + correct");
  });

  test("describeCapabilities for pre-action only", () => {
    const mw = createPersonalizationMiddleware({
      memory: createMockMemory(),
      postAction: { enabled: false },
    });
    const fragment = mw.describeCapabilities(createTurnContext(0));
    expect(fragment?.description).toContain("clarify only");
  });

  test("describeCapabilities for post-action only", () => {
    const mw = createPersonalizationMiddleware({
      memory: createMockMemory(),
      preAction: { enabled: false },
    });
    const fragment = mw.describeCapabilities(createTurnContext(0));
    expect(fragment?.description).toContain("correct only");
  });

  describe("pre-action channel", () => {
    test("injects preferences when available", async () => {
      const memory = createMockMemory([{ content: "User prefers dark mode", score: 0.9 }]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("format the output");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      expect(calledWith.messages[0]).toBeDefined();
      expect(calledWith.messages[0]?.content[0]).toEqual(
        expect.objectContaining({
          kind: "text",
          text: expect.stringContaining("[User Preferences]"),
        }),
      );
    });

    test("injects clarification when ambiguous and no preferences", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("should I use dark mode or light mode?");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      expect(calledWith.messages[0]).toBeDefined();
      expect(calledWith.messages[0]?.content[0]).toEqual(
        expect.objectContaining({ kind: "text", text: expect.stringContaining("ask the user") }),
      );
    });

    test("does not inject anything for clear instructions with no preferences", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("deploy to production");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      expect(calledWith.messages).toEqual(request.messages);
    });

    test("filters by relevance threshold", async () => {
      const memory = createMockMemory([{ content: "low relevance pref", score: 0.3 }]);
      const mw = createPersonalizationMiddleware({ memory, relevanceThreshold: 0.7 });
      const next = createMockNext();
      const request = createModelRequest("should I format dates as ISO or locale?");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      // Low score filtered out → ambiguity check kicks in (question + alternative)
      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      expect(calledWith.messages[0]).toBeDefined();
      expect(calledWith.messages[0]?.content[0]).toEqual(
        expect.objectContaining({ kind: "text", text: expect.stringContaining("ask the user") }),
      );
    });

    test("caps injection by token budget", async () => {
      const longPref = "x".repeat(3000); // ~750 tokens, exceeds 500 budget
      const memory = createMockMemory([
        { content: longPref, score: 0.9 },
        { content: "second pref", score: 0.9 },
      ]);
      const mw = createPersonalizationMiddleware({
        memory,
        maxPreferenceTokens: 500,
      });
      const next = createMockNext();
      const request = createModelRequest("format output");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      // Both excluded because first alone exceeds budget → falls through
      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      expect(calledWith.messages).toEqual(request.messages);
    });

    test("uses custom classifier when provided", async () => {
      const customClassifier: AmbiguityClassifier = {
        classify: () => ({ ambiguous: true, suggestedDirective: "Custom directive" }),
      };
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({
        memory,
        preAction: { classifier: customClassifier },
      });
      const next = createMockNext();
      const request = createModelRequest("do the thing");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      expect(calledWith.messages[0]).toBeDefined();
      expect(calledWith.messages[0]?.content[0]).toEqual(
        expect.objectContaining({ kind: "text", text: "Custom directive" }),
      );
    });
  });

  describe("post-action channel", () => {
    test("stores correction on turn > 0", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("No, I prefer dark mode please");

      await mw.wrapModelCall?.(createTurnContext(1), request, next);

      expect(memory.storeCalls.length).toBe(1);
      expect(memory.storeCalls[0]?.options?.category).toBe("preference");
      expect(memory.storeCalls[0]?.options?.namespace).toBe("preferences");
    });

    test("skips correction on turn 0", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("No, I prefer dark mode");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      expect(memory.storeCalls.length).toBe(0);
    });

    test("does not store when no correction detected", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("Please refactor the auth module now");

      await mw.wrapModelCall?.(createTurnContext(1), request, next);

      expect(memory.storeCalls.length).toBe(0);
    });

    test("uses custom detector when provided", async () => {
      const customDetector: CorrectionDetector = {
        detect: () => ({ corrective: true, preferenceUpdate: "custom preference" }),
      };
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({
        memory,
        postAction: { detector: customDetector },
      });
      const next = createMockNext();
      const request = createModelRequest("this is a long enough message for detection");

      await mw.wrapModelCall?.(createTurnContext(1), request, next);

      expect(memory.storeCalls.length).toBe(1);
      expect(memory.storeCalls[0]?.content).toBe("custom preference");
    });
  });

  describe("failure modes", () => {
    test("memory recall throws → gracefully skips, calls next", async () => {
      const memory: MemoryComponent = {
        async recall(): Promise<readonly MemoryResult[]> {
          throw new Error("recall failed");
        },
        async store(): Promise<void> {},
      };
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("test message");

      const response = await mw.wrapModelCall?.(createTurnContext(0), request, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(response?.content).toBe("test response");
    });

    test("memory store throws → logs error, continues", async () => {
      const errors: unknown[] = [];
      const memory: MemoryComponent = {
        async recall(): Promise<readonly MemoryResult[]> {
          return [];
        },
        async store(): Promise<void> {
          throw new Error("store failed");
        },
      };
      const mw = createPersonalizationMiddleware({
        memory,
        onError: (e) => errors.push(e),
      });
      const next = createMockNext();
      const request = createModelRequest("No, I prefer dark mode instead");

      const response = await mw.wrapModelCall?.(createTurnContext(1), request, next);

      expect(errors.length).toBe(1);
      expect(next).toHaveBeenCalledTimes(1);
      expect(response?.content).toBe("test response");
    });

    test("classifier false positive → directive injected, request not corrupted", async () => {
      const alwaysAmbiguous: AmbiguityClassifier = {
        classify: () => ({
          ambiguous: true,
          suggestedDirective: "Clarify please",
        }),
      };
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({
        memory,
        preAction: { classifier: alwaysAmbiguous },
      });
      const next = createMockNext();
      const request = createModelRequest("deploy now");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      // Original message still present
      expect(calledWith.messages[calledWith.messages.length - 1]).toEqual(request.messages[0]);
    });

    test("detector false positive → preference stored, request passes through", async () => {
      const alwaysCorrective: CorrectionDetector = {
        detect: () => ({ corrective: true, preferenceUpdate: "false preference" }),
      };
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({
        memory,
        postAction: { detector: alwaysCorrective },
      });
      const next = createMockNext();
      const request = createModelRequest("this is a long enough message for correction check");

      await mw.wrapModelCall?.(createTurnContext(1), request, next);

      expect(memory.storeCalls.length).toBe(1);
      expect(next).toHaveBeenCalledTimes(1);
    });

    test("empty message → no crash, passes through", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request: ModelRequest = { messages: [] };

      const response = await mw.wrapModelCall?.(createTurnContext(0), request, next);

      expect(response?.content).toBe("test response");
    });

    test("message with no text blocks → passes through", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const msg: InboundMessage = {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "image", url: "https://example.com/img.png" }],
      };
      const request: ModelRequest = { messages: [msg] };

      const response = await mw.wrapModelCall?.(createTurnContext(0), request, next);

      expect(response?.content).toBe("test response");
    });

    test("both channels disabled → pure pass-through", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({
        memory,
        preAction: { enabled: false },
        postAction: { enabled: false },
      });
      const next = createMockNext();
      const request = createModelRequest("No, I prefer dark mode");

      await mw.wrapModelCall?.(createTurnContext(1), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      expect(calledWith).toEqual(request);
      expect(memory.storeCalls.length).toBe(0);
    });
  });

  describe("pinning", () => {
    test("preference injection message has pinned: true", async () => {
      const memory = createMockMemory([{ content: "User prefers dark mode", score: 0.9 }]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("format the output");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      const injected = calledWith.messages[0] as InboundMessage;
      expect(injected.pinned).toBe(true);
    });

    test("clarification directive message has pinned: true", async () => {
      const memory = createMockMemory([]);
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();
      const request = createModelRequest("should I use dark mode or light mode?");

      await mw.wrapModelCall?.(createTurnContext(0), request, next);

      const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
      const injected = calledWith.messages[0] as InboundMessage;
      expect(injected.pinned).toBe(true);
    });
  });

  describe("caching", () => {
    test("second call uses cached preferences", async () => {
      const recallCount = { value: 0 };
      const memory: MemoryComponent & { readonly storeCalls: Array<{ content: string }> } = {
        storeCalls: [],
        async recall(): Promise<readonly MemoryResult[]> {
          recallCount.value++;
          return [{ content: "cached pref", score: 0.9 }];
        },
        async store(): Promise<void> {},
      };
      const mw = createPersonalizationMiddleware({ memory });
      const next = createMockNext();

      await mw.wrapModelCall?.(createTurnContext(0), createModelRequest("first"), next);
      await mw.wrapModelCall?.(createTurnContext(1), createModelRequest("second"), next);

      // Only one recall — second call hits cache
      expect(recallCount.value).toBe(1);
    });
  });
});
