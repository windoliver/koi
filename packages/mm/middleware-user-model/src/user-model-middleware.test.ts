import { beforeEach, describe, expect, test } from "bun:test";
import type { MemoryComponent, MemoryResult, MemoryStoreOptions } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type {
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import type { SignalSource } from "@koi/core/user-model";
import { createUserModelMiddleware } from "./user-model-middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMessage(text: string): InboundMessage {
  return {
    senderId: "user:test",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

function createSessionCtx(sessionId: string): SessionContext {
  return { sessionId } as SessionContext;
}

function createTurnCtx(
  sessionId: string,
  messages: readonly InboundMessage[],
  turnIndex: number,
): TurnContext {
  return {
    session: { sessionId } as SessionContext,
    messages,
    turnIndex,
    turnId: `turn-${turnIndex}`,
    metadata: {},
  } as unknown as TurnContext;
}

interface StoredEntry {
  readonly content: string;
  readonly category?: string | undefined;
  readonly supersedes?: readonly string[] | undefined;
}

interface MockMemory {
  readonly component: MemoryComponent;
  readonly stored: StoredEntry[];
  readonly facts: Array<{
    readonly id: string;
    readonly content: string;
    readonly category: string;
    readonly status: string;
  }>;
}

function createMockMemory(): MockMemory {
  const stored: StoredEntry[] = [];
  const facts: Array<{
    readonly id: string;
    readonly content: string;
    readonly category: string;
    readonly status: string;
  }> = [];

  let factCounter = 0; // let: incrementing fact counter

  const component: MemoryComponent = {
    async recall(_query: string): Promise<readonly MemoryResult[]> {
      return facts
        .filter((f) => f.status === "active")
        .map((f) => ({
          content: f.content,
          score: 0.9,
          metadata: { id: f.id, category: f.category, status: f.status },
        }));
    },
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      factCounter += 1;
      const id = `fact-${factCounter}`;
      const category = options?.category ?? "context";
      facts.push({ id, content, category, status: "active" });
      stored.push({ content, category, supersedes: options?.supersedes });
    },
  };

  return { component, stored, facts };
}

function createModelRequest(text: string): ModelRequest {
  return { messages: [createMessage(text)] };
}

function createModelResponse(text: string): ModelResponse {
  return { content: text, model: "test-model" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createUserModelMiddleware", () => {
  let mockMem: MockMemory;

  beforeEach(() => {
    mockMem = createMockMemory();
  });

  test("factory creates middleware with correct name, priority, and phase", () => {
    const mw = createUserModelMiddleware({ memory: mockMem.component });
    expect(mw.name).toBe("user-model");
    expect(mw.priority).toBe(415);
    expect(mw.phase).toBe("resolve");
  });

  test("describeCapabilities returns correct fragment with all channels", () => {
    const source: SignalSource = {
      name: "test-sensor",
      read: () => ({ kind: "sensor", source: "test", values: {} }),
    };
    const mw = createUserModelMiddleware({
      memory: mockMem.component,
      signalSources: [source],
    });
    const ctx = createTurnCtx("s1", [], 0);
    const cap = mw.describeCapabilities(ctx);
    expect(cap?.label).toBe("user-model");
    expect(cap?.description).toContain("clarify");
    expect(cap?.description).toContain("correct");
    expect(cap?.description).toContain("drift");
    expect(cap?.description).toContain("sensor");
  });

  test("describeCapabilities returns inactive when all channels disabled", () => {
    const mw = createUserModelMiddleware({
      memory: mockMem.component,
      preAction: { enabled: false },
      postAction: { enabled: false },
      drift: { enabled: false },
    });
    const ctx = createTurnCtx("s1", [], 0);
    const cap = mw.describeCapabilities(ctx);
    expect(cap?.description).toBe("User model inactive");
  });

  test("wrapModelCall injects [User Context] block when preferences exist", async () => {
    // Seed a preference
    await mockMem.component.store("Use dark mode", { category: "preference" });

    const mw = createUserModelMiddleware({ memory: mockMem.component });
    await mw.onSessionStart?.(createSessionCtx("s1"));

    const request = createModelRequest("Format my code");
    let capturedRequest: ModelRequest | undefined;

    await mw.wrapModelCall?.(
      createTurnCtx("s1", [createMessage("Format my code")], 0),
      request,
      async (req) => {
        capturedRequest = req;
        return createModelResponse("Done");
      },
    );

    expect(capturedRequest).toBeDefined();
    const injectedMsg = capturedRequest?.messages[0];
    expect(injectedMsg?.content[0]).toMatchObject({
      kind: "text",
    });
    const text = injectedMsg?.content[0]?.kind === "text" ? injectedMsg.content[0].text : "";
    expect(text).toContain("[User Context]");
    expect(text).toContain("Use dark mode");
  });

  test("wrapModelCall passes through when no preferences and no ambiguity", async () => {
    const mw = createUserModelMiddleware({
      memory: mockMem.component,
      preAction: { enabled: false },
    });
    await mw.onSessionStart?.(createSessionCtx("s1"));

    const request = createModelRequest("Hello");
    let capturedRequest: ModelRequest | undefined;

    await mw.wrapModelCall?.(
      createTurnCtx("s1", [createMessage("Hello")], 0),
      request,
      async (req) => {
        capturedRequest = req;
        return createModelResponse("Hi");
      },
    );

    // Should pass through unchanged
    expect(capturedRequest?.messages).toHaveLength(1);
  });

  test("post-action correction detection stores preference", async () => {
    const mw = createUserModelMiddleware({ memory: mockMem.component });
    await mw.onSessionStart?.(createSessionCtx("s1"));

    // Turn 1: correction message
    const turnCtx = createTurnCtx("s1", [createMessage("Actually, I prefer tabs over spaces")], 1);
    await mw.onBeforeTurn?.(turnCtx);

    // Check that the correction was stored
    expect(mockMem.stored.length).toBeGreaterThan(0);
    const lastStored = mockMem.stored[mockMem.stored.length - 1];
    expect(lastStored?.category).toBe("preference");
  });

  test("drift detection stores preference with supersession", async () => {
    // Seed an old preference
    await mockMem.component.store("Use spaces", { category: "preference" });

    const mw = createUserModelMiddleware({ memory: mockMem.component });
    await mw.onSessionStart?.(createSessionCtx("s1"));

    // Drift message
    const turnCtx = createTurnCtx(
      "s1",
      [createMessage("I no longer want spaces, switch to tabs")],
      1,
    );
    await mw.onBeforeTurn?.(turnCtx);

    // Should have stored a new preference
    const driftStores = mockMem.stored.filter((s) => s.category === "preference");
    expect(driftStores.length).toBeGreaterThanOrEqual(2); // original + drift
  });

  test("signal source failure does not block preference pipeline", async () => {
    const failingSource: SignalSource = {
      name: "broken-sensor",
      read: () => {
        throw new Error("sensor crash");
      },
    };

    const mw = createUserModelMiddleware({
      memory: mockMem.component,
      signalSources: [failingSource],
    });
    await mw.onSessionStart?.(createSessionCtx("s1"));

    // Should not throw — sensor failure is isolated
    const turnCtx = createTurnCtx("s1", [createMessage("Hello")], 0);
    await mw.onBeforeTurn?.(turnCtx);
  });

  test("zero signal sources works as personalization-only middleware", async () => {
    await mockMem.component.store("Use camelCase", { category: "preference" });

    const mw = createUserModelMiddleware({
      memory: mockMem.component,
      drift: { enabled: false },
    });
    await mw.onSessionStart?.(createSessionCtx("s1"));

    const request = createModelRequest("Name my variable");
    let capturedRequest: ModelRequest | undefined;

    await mw.wrapModelCall?.(
      createTurnCtx("s1", [createMessage("Name my variable")], 0),
      request,
      async (req) => {
        capturedRequest = req;
        return createModelResponse("foo");
      },
    );

    const text =
      capturedRequest?.messages[0]?.content[0]?.kind === "text"
        ? capturedRequest.messages[0].content[0].text
        : "";
    expect(text).toContain("Use camelCase");
  });

  test("all channels disabled results in pass-through", async () => {
    const mw = createUserModelMiddleware({
      memory: mockMem.component,
      preAction: { enabled: false },
      postAction: { enabled: false },
      drift: { enabled: false },
    });
    await mw.onSessionStart?.(createSessionCtx("s1"));

    const request = createModelRequest("Hello");
    let capturedRequest: ModelRequest | undefined;

    await mw.wrapModelCall?.(
      createTurnCtx("s1", [createMessage("Hello")], 0),
      request,
      async (req) => {
        capturedRequest = req;
        return createModelResponse("Hi");
      },
    );

    expect(capturedRequest?.messages).toHaveLength(1);
    expect(mockMem.stored).toHaveLength(0);
  });

  test("onSessionEnd cleans up state", async () => {
    const mw = createUserModelMiddleware({ memory: mockMem.component });
    const sessionCtx = createSessionCtx("s1");
    await mw.onSessionStart?.(sessionCtx);
    await mw.onSessionEnd?.(sessionCtx);

    // After session end, onBeforeTurn should be a no-op
    await mw.onBeforeTurn?.(createTurnCtx("s1", [createMessage("anything")], 1));
    expect(mockMem.stored).toHaveLength(0);
  });

  test("onBeforeTurn reads signal sources in parallel", async () => {
    const readOrder: string[] = [];

    const source1: SignalSource = {
      name: "s1",
      read: async () => {
        readOrder.push("s1");
        return { kind: "sensor", source: "s1", values: { a: 1 } };
      },
    };

    const source2: SignalSource = {
      name: "s2",
      read: async () => {
        readOrder.push("s2");
        return { kind: "sensor", source: "s2", values: { b: 2 } };
      },
    };

    const mw = createUserModelMiddleware({
      memory: mockMem.component,
      signalSources: [source1, source2],
      drift: { enabled: false },
      postAction: { enabled: false },
    });

    await mw.onSessionStart?.(createSessionCtx("sess1"));
    await mw.onBeforeTurn?.(createTurnCtx("sess1", [createMessage("test")], 0));

    // Both sources should have been read
    expect(readOrder).toContain("s1");
    expect(readOrder).toContain("s2");
  });
});
