/**
 * Integration test — validates that the deprecation shim delegates correctly.
 *
 * Since the shim delegates to @koi/middleware-user-model, we verify the
 * unified middleware behavior: [User Context] format and onBeforeTurn processing.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MemoryRecallOptions, MemoryResult, MemoryStoreOptions } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type {
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { createPersonalizationMiddleware } from "../personalization.js";

interface StoredEntry {
  readonly content: string;
  readonly namespace?: string | undefined;
  readonly category?: string | undefined;
}

function createStatefulMemory(): {
  readonly recall: (
    query: string,
    options?: MemoryRecallOptions,
  ) => Promise<readonly MemoryResult[]>;
  readonly store: (content: string, options?: MemoryStoreOptions) => Promise<void>;
  readonly entries: StoredEntry[];
} {
  const entries: StoredEntry[] = [];

  return {
    entries,
    async recall(_query: string, options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      return entries
        .filter((e) => !options?.namespace || e.namespace === options.namespace)
        .map((e) => ({ content: e.content, score: 0.95 }));
    },
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      entries.push({
        content,
        namespace: options?.namespace,
        category: options?.category,
      });
    },
  };
}

function createSessionCtx(): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "integration-session" as never,
    runId: "integration-run" as never,
    metadata: {},
  };
}

function createTurnContext(
  turnIndex: number,
  messages: readonly InboundMessage[] = [],
): TurnContext {
  return {
    session: createSessionCtx(),
    turnIndex,
    turnId: `turn-${turnIndex}` as never,
    messages,
    metadata: {},
  };
}

function createRequest(text: string): ModelRequest {
  const msg: InboundMessage = {
    senderId: "user",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
  return { messages: [msg] };
}

function createNext(): ReturnType<typeof mock> & ((req: ModelRequest) => Promise<ModelResponse>) {
  return mock(
    async (_req: ModelRequest): Promise<ModelResponse> => ({
      content: "ok",
      model: "test-model",
    }),
  );
}

describe("personalization shim integration", () => {
  const originalWarn = console.warn;

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("shim creates middleware that injects [User Context] block", async () => {
    console.warn = mock(() => {});

    const memory = createStatefulMemory();
    // Pre-seed a preference
    await memory.store("User prefers dark mode", {
      namespace: "preferences",
      category: "preference",
    });

    const mw = createPersonalizationMiddleware({ memory });

    // Start session
    await mw.onSessionStart?.(createSessionCtx());

    // Call wrapModelCall
    const next = createNext();
    await mw.wrapModelCall?.(createTurnContext(0), createRequest("Format the output"), next);

    const calledWith = next.mock.calls[0]?.[0] as ModelRequest;
    expect(calledWith.messages[0]).toBeDefined();
    const text =
      calledWith.messages[0]?.content[0]?.kind === "text"
        ? calledWith.messages[0].content[0].text
        : "";
    expect(text).toContain("[User Context]");
    expect(text).toContain("dark mode");
  });

  test("shim preserves ambiguity detection behavior", async () => {
    console.warn = mock(() => {});

    const memory = createStatefulMemory();
    const mw = createPersonalizationMiddleware({ memory });
    await mw.onSessionStart?.(createSessionCtx());

    const next = createNext();
    await mw.wrapModelCall?.(
      createTurnContext(0),
      createRequest("How should I format dates — ISO or locale?"),
      next,
    );

    // With unified middleware, ambiguity detected → [User Context] with clarification
    const calledWith = next.mock.calls[0]?.[0] as ModelRequest;
    const text =
      calledWith.messages[0]?.content[0]?.kind === "text"
        ? calledWith.messages[0].content[0].text
        : "";
    expect(text).toContain("Clarification");
  });
});
