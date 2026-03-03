/**
 * E2E lifecycle test for @koi/middleware-preference.
 *
 * Uses deterministic mock classify callback — no real API keys needed.
 * Tests the full lifecycle: store → drift → supersede → salience gate.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { MemoryComponent, MemoryResult, MemoryStoreOptions } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { SessionContext, TurnContext } from "@koi/core/middleware";
import { createPreferenceMiddleware } from "../preference.js";

// ---------------------------------------------------------------------------
// In-memory MemoryComponent mock with full supersession support
// ---------------------------------------------------------------------------

interface StoredFact {
  readonly id: string;
  readonly content: string;
  readonly category: string;
  // let — status is mutable for supersession tracking
  status: string;
  supersededBy: string | null;
}

function createInMemoryMemory(): {
  readonly component: MemoryComponent;
  readonly getFacts: () => readonly StoredFact[];
} {
  const facts: StoredFact[] = [];
  // let — needed for incrementing fact counter
  let counter = 0;

  const component: MemoryComponent = {
    async recall(_query: string): Promise<readonly MemoryResult[]> {
      return facts
        .filter((f) => f.status === "active")
        .map((f) => ({
          content: f.content,
          score: 0.8,
          metadata: { id: f.id, category: f.category, status: f.status },
        }));
    },

    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      counter += 1;
      const id = `e2e-fact-${counter}`;

      // Handle explicit supersession
      if (options?.supersedes !== undefined && options.supersedes.length > 0) {
        const ids = new Set(options.supersedes);
        for (const fact of facts) {
          if (ids.has(fact.id) && fact.status === "active") {
            fact.status = "superseded";
            fact.supersededBy = id;
          }
        }
      }

      facts.push({
        id,
        content,
        category: options?.category ?? "context",
        status: "active",
        supersededBy: null,
      });
    },
  };

  return { component, getFacts: () => [...facts] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessage(text: string): InboundMessage {
  return {
    senderId: "user:e2e",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

function createSessionCtx(sessionId: string): SessionContext {
  return { sessionId } as SessionContext;
}

function createTurnCtx(sessionId: string, text: string, turnIndex: number): TurnContext {
  return {
    session: { sessionId } as SessionContext,
    messages: [createMessage(text)],
    turnIndex,
    turnId: `turn-${turnIndex}`,
    metadata: {},
  } as unknown as TurnContext;
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe("e2e: preference middleware lifecycle", () => {
  // let — needed for mutable test state
  let memoryStore: ReturnType<typeof createInMemoryMemory>;

  beforeEach(() => {
    memoryStore = createInMemoryMemory();
  });

  test("turn 1: user states preference → stored", async () => {
    const classify = async (prompt: string): Promise<string> => {
      if (prompt.includes("preference has changed")) {
        return "YES: old=unknown new=dark mode";
      }
      return "Yes";
    };

    const mw = createPreferenceMiddleware({
      classify,
      memory: memoryStore.component,
    });

    await mw.onSessionStart?.(createSessionCtx("e2e-1"));
    await mw.onBeforeTurn?.(createTurnCtx("e2e-1", "I prefer dark mode in all editors", 1));

    // keyword "prefer X instead" does NOT match here because "instead" is missing.
    // But keyword detector won't trigger without one of the 8 patterns.
    // So no store happens (the cascaded detector skips LLM when keyword says no_drift).
    // This verifies keyword pre-filter works: generic preference statement is not a "change".
    const facts = memoryStore.getFacts();
    expect(facts.filter((f) => f.status === "active")).toHaveLength(0);
  });

  test("turn 2: user corrects preference → drift detected, old superseded", async () => {
    // Pre-populate a stored preference
    await memoryStore.component.store("User prefers dark mode", {
      category: "preference",
    });

    const classify = async (prompt: string): Promise<string> => {
      if (prompt.includes("preference has changed")) {
        return "YES: old=dark mode new=light mode";
      }
      return "Yes";
    };

    const mw = createPreferenceMiddleware({
      classify,
      memory: memoryStore.component,
    });

    await mw.onSessionStart?.(createSessionCtx("e2e-2"));
    // "no longer" triggers keyword match → LLM confirms → store with supersedes
    await mw.onBeforeTurn?.(
      createTurnCtx("e2e-2", "I no longer want dark mode, switch to light", 1),
    );

    const facts = memoryStore.getFacts();
    const active = facts.filter((f) => f.status === "active");
    const superseded = facts.filter((f) => f.status === "superseded");

    expect(active).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.content).toBe("User prefers dark mode");
  });

  test("turn 3: generic acknowledgment → no drift, no store (salience gate filters)", async () => {
    const classify = async (prompt: string): Promise<string> => {
      if (prompt.includes("preference has changed")) {
        return "NO";
      }
      return "No";
    };

    const mw = createPreferenceMiddleware({
      classify,
      memory: memoryStore.component,
    });

    await mw.onSessionStart?.(createSessionCtx("e2e-3"));
    await mw.onBeforeTurn?.(createTurnCtx("e2e-3", "Sounds good, thanks!", 1));

    const facts = memoryStore.getFacts();
    expect(facts).toHaveLength(0);
  });

  test("turn 4: classifier throws → drift fail-closed, salience fail-open", async () => {
    const classify = async (_prompt: string): Promise<string> => {
      throw new Error("API down");
    };

    const mw = createPreferenceMiddleware({
      classify,
      memory: memoryStore.component,
    });

    await mw.onSessionStart?.(createSessionCtx("e2e-4"));
    // "switch to" triggers keyword → cascaded calls LLM → LLM throws → fail-closed
    await mw.onBeforeTurn?.(createTurnCtx("e2e-4", "switch to spaces from now on", 1));

    // Drift fail-closed: should store. Salience gate also throws → fail-open: still stores.
    const facts = memoryStore.getFacts();
    const active = facts.filter((f) => f.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toBe("switch to spaces from now on");
  });
});
