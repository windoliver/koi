import { beforeEach, describe, expect, test } from "bun:test";

import type { Playbook, PlaybookStore, TrajectoryEntry, TrajectoryStore } from "@koi/ace-types";
import type {
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { SessionId, TurnId } from "@koi/core/ecs";

import { createAceMiddleware } from "./ace-middleware.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface InMemoryStores {
  readonly playbookStore: PlaybookStore;
  readonly trajectoryStore: TrajectoryStore;
  readonly snapshotPlaybooks: () => readonly Playbook[];
  readonly snapshotTrajectories: () => ReadonlyMap<string, readonly TrajectoryEntry[]>;
  seed: (pb: Playbook) => void;
}

function createInMemoryStores(): InMemoryStores {
  const playbooks = new Map<string, Playbook>();
  const trajectories = new Map<string, readonly TrajectoryEntry[]>();
  return {
    playbookStore: {
      get: async (id) => playbooks.get(id),
      list: async () => [...playbooks.values()],
      save: async (pb) => {
        playbooks.set(pb.id, pb);
      },
      remove: async (id) => playbooks.delete(id),
    },
    trajectoryStore: {
      append: async (sessionId, entries) => {
        const prev = trajectories.get(sessionId) ?? [];
        trajectories.set(sessionId, [...prev, ...entries]);
      },
      getSession: async (sessionId) => trajectories.get(sessionId) ?? [],
      listSessions: async () => [...trajectories.keys()],
    },
    snapshotPlaybooks: () => [...playbooks.values()],
    snapshotTrajectories: () => trajectories,
    seed: (pb) => {
      playbooks.set(pb.id, pb);
    },
  };
}

const SESSION_ID = "session-1" as SessionId;

function sessionCtx(): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: SESSION_ID,
    runId: "run-1" as never,
    metadata: {},
  };
}

function turnCtx(turnIndex = 0): TurnContext {
  return {
    session: sessionCtx(),
    turnIndex,
    turnId: `turn-${turnIndex}` as TurnId,
    messages: [],
    metadata: {},
  };
}

function makeRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return { messages: [], model: "model-x", ...overrides };
}

function makeResponse(overrides?: Partial<ModelResponse>): ModelResponse {
  return { content: "ok", model: "model-x", ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let now = 1_000;
let stores: InMemoryStores;

beforeEach(() => {
  now = 1_000;
  stores = createInMemoryStores();
});

const advance = (deltaMs: number): void => {
  now += deltaMs;
};

const tick = (): number => now;

describe("ACE middleware — injection", () => {
  test("injects [Active Playbooks] into systemPrompt when playbooks exist", async () => {
    stores.seed({
      id: "ace:tool_call:fs.read",
      title: "Tool: fs.read",
      strategy: "fs.read: 90% success rate across 10 calls",
      tags: ["tool_call"],
      confidence: 0.9,
      source: "curated",
      createdAt: 0,
      updatedAt: 0,
      sessionCount: 1,
      version: 1,
    });
    const mw = createAceMiddleware({
      playbookStore: stores.playbookStore,
      clock: tick,
    });
    await mw.onSessionStart?.(sessionCtx());

    let captured: ModelRequest | undefined;
    const handler: ModelHandler = async (req) => {
      captured = req;
      return makeResponse();
    };

    await mw.wrapModelCall?.(turnCtx(), makeRequest({ systemPrompt: "base" }), handler);

    expect(captured?.systemPrompt).toContain("[Active Playbooks]");
    expect(captured?.systemPrompt).toContain("fs.read: 90%");
    expect(captured?.systemPrompt).toContain("base");
  });

  test("does not modify request when no playbooks loaded", async () => {
    const mw = createAceMiddleware({
      playbookStore: stores.playbookStore,
      clock: tick,
    });
    await mw.onSessionStart?.(sessionCtx());
    let captured: ModelRequest | undefined;
    const handler: ModelHandler = async (req) => {
      captured = req;
      return makeResponse();
    };
    const req = makeRequest({ systemPrompt: "only base" });
    await mw.wrapModelCall?.(turnCtx(), req, handler);
    expect(captured?.systemPrompt).toBe("only base");
  });
});

describe("ACE middleware — trajectory recording", () => {
  test("records model_call success entries with measured duration", async () => {
    const mw = createAceMiddleware({
      playbookStore: stores.playbookStore,
      trajectoryStore: stores.trajectoryStore,
      clock: tick,
    });
    await mw.onSessionStart?.(sessionCtx());

    const handler: ModelHandler = async () => {
      advance(50);
      return makeResponse();
    };
    await mw.wrapModelCall?.(turnCtx(), makeRequest(), handler);
    await mw.onSessionEnd?.(sessionCtx());

    const trajectory = stores.snapshotTrajectories().get(SESSION_ID) ?? [];
    expect(trajectory.length).toBe(1);
    const entry = trajectory[0];
    expect(entry?.kind).toBe("model_call");
    expect(entry?.identifier).toBe("model-x");
    expect(entry?.outcome).toBe("success");
    expect(entry?.durationMs).toBe(50);
  });

  test("records tool_call failure when handler throws and re-raises the error", async () => {
    const mw = createAceMiddleware({
      playbookStore: stores.playbookStore,
      trajectoryStore: stores.trajectoryStore,
      clock: tick,
    });
    await mw.onSessionStart?.(sessionCtx());

    const failing: ToolHandler = async (_req: ToolRequest) => {
      advance(20);
      throw new Error("boom");
    };
    const req: ToolRequest = { toolId: "fs.write", input: {} };
    let raised: unknown;
    try {
      await mw.wrapToolCall?.(turnCtx(), req, failing);
    } catch (err: unknown) {
      raised = err;
    }
    expect((raised as Error).message).toBe("boom");

    await mw.onSessionEnd?.(sessionCtx());
    const trajectory = stores.snapshotTrajectories().get(SESSION_ID) ?? [];
    expect(trajectory[0]?.kind).toBe("tool_call");
    expect(trajectory[0]?.identifier).toBe("fs.write");
    expect(trajectory[0]?.outcome).toBe("failure");
    expect(trajectory[0]?.durationMs).toBe(20);
  });
});

describe("ACE middleware — session-end consolidation", () => {
  test("consolidates trajectory into a versioned playbook on session end", async () => {
    const mw = createAceMiddleware({
      playbookStore: stores.playbookStore,
      clock: tick,
      minScore: 0,
    });
    await mw.onSessionStart?.(sessionCtx());

    const ok: ToolHandler = async () => {
      advance(5);
      return { output: "x" } satisfies ToolResponse;
    };
    for (let i = 0; i < 3; i += 1) {
      await mw.wrapToolCall?.(turnCtx(), { toolId: "fs.read", input: {} }, ok);
    }

    await mw.onSessionEnd?.(sessionCtx());
    const stored = stores.snapshotPlaybooks();
    expect(stored.length).toBe(1);
    expect(stored[0]?.id).toBe("ace:tool_call:fs.read");
    expect(stored[0]?.version).toBe(1);
    expect(stored[0]?.confidence).toBeGreaterThan(0);
  });

  test("clears session state on end (no leak across sessions)", async () => {
    const mw = createAceMiddleware({
      playbookStore: stores.playbookStore,
      clock: tick,
    });
    await mw.onSessionStart?.(sessionCtx());
    await mw.wrapToolCall?.(
      turnCtx(),
      { toolId: "fs.read", input: {} },
      async () => ({ output: 1 }) satisfies ToolResponse,
    );
    await mw.onSessionEnd?.(sessionCtx());

    // Second cycle starts clean.
    await mw.onSessionStart?.(sessionCtx());
    const cap = mw.describeCapabilities?.(turnCtx());
    expect(cap?.description).toContain("active playbook(s)");
    await mw.onSessionEnd?.(sessionCtx());
  });
});

describe("ACE middleware — describeCapabilities", () => {
  test("reports active-playbook count loaded for the session", async () => {
    stores.seed({
      id: "p1",
      title: "t",
      strategy: "s",
      tags: [],
      confidence: 0.5,
      source: "curated",
      createdAt: 0,
      updatedAt: 0,
      sessionCount: 1,
      version: 1,
    });
    const mw = createAceMiddleware({
      playbookStore: stores.playbookStore,
      clock: tick,
    });
    await mw.onSessionStart?.(sessionCtx());
    const cap = mw.describeCapabilities?.(turnCtx());
    expect(cap?.label).toBe("ace");
    expect(cap?.description).toContain("1 active playbook");
  });
});
