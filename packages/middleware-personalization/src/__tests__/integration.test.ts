/**
 * Integration test — multi-turn preference learning loop.
 *
 * Uses a stateful mock memory to simulate the full lifecycle:
 * cold start → preference recall → correction → corrected behavior.
 */

import { describe, expect, mock, test } from "bun:test";
import type { MemoryRecallOptions, MemoryResult, MemoryStoreOptions } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse, TurnContext } from "@koi/core/middleware";
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

function createTurnContext(turnIndex: number): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "integration-session" as never,
      runId: "integration-run" as never,
      metadata: {},
    },
    turnIndex,
    turnId: `turn-${turnIndex}` as never,
    messages: [],
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

describe("multi-turn preference learning", () => {
  test("cold start → preference recall → correction → corrected behavior", async () => {
    const memory = createStatefulMemory();
    const mw = createPersonalizationMiddleware({ memory });

    // --- Turn 1: cold start, ambiguous instruction ---
    const next1 = createNext();
    await mw.wrapModelCall?.(
      createTurnContext(0),
      createRequest("How should I format dates — ISO or locale?"),
      next1,
    );

    // Expect clarification directive (no preferences exist)
    const call1 = next1.mock.calls[0]?.[0] as ModelRequest;
    expect(call1.messages[0]).toBeDefined();
    expect(call1.messages[0]?.content[0]).toEqual(
      expect.objectContaining({ kind: "text", text: expect.stringContaining("ask the user") }),
    );

    // Simulate: user answered, middleware stores the preference externally
    await memory.store("User prefers ISO-8601 format", {
      namespace: "preferences",
      category: "preference",
    });

    // --- Turn 2: preference recall (non-ambiguous instruction) ---
    // Create a new middleware instance to reset cache (simulating real scenario)
    const mw2 = createPersonalizationMiddleware({ memory });
    const next2 = createNext();
    await mw2.wrapModelCall?.(
      createTurnContext(1),
      createRequest("Format the timestamps in the report"),
      next2,
    );

    // Expect [User Preferences] injected
    const call2 = next2.mock.calls[0]?.[0] as ModelRequest;
    expect(call2.messages[0]).toBeDefined();
    expect(call2.messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("[User Preferences]"),
      }),
    );
    expect(call2.messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("ISO-8601"),
      }),
    );

    // --- Turn 3: preference correction ---
    const mw3 = createPersonalizationMiddleware({ memory });
    const next3 = createNext();
    await mw3.wrapModelCall?.(
      createTurnContext(2),
      createRequest("Actually, I prefer US date format MM/DD/YYYY instead"),
      next3,
    );

    // Correction should have been stored
    const prefEntries = memory.entries.filter((e) => e.category === "preference");
    expect(prefEntries.length).toBe(2); // original + correction
    expect(prefEntries[1]?.content).toContain("MM/DD/YYYY");

    // --- Turn 4: corrected behavior ---
    const mw4 = createPersonalizationMiddleware({ memory });
    const next4 = createNext();
    await mw4.wrapModelCall?.(createTurnContext(3), createRequest("Display the dates"), next4);

    // Expect [User Preferences] with both entries (new + old)
    const call4 = next4.mock.calls[0]?.[0] as ModelRequest;
    expect(call4.messages[0]).toBeDefined();
    expect(call4.messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("[User Preferences]"),
      }),
    );
    expect(call4.messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("MM/DD/YYYY"),
      }),
    );
  });
});
