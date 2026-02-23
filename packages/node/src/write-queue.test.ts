import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentId, KoiError, Result } from "@koi/core";
import { agentId } from "@koi/core";
import type { NodeCheckpoint, NodeSessionStore } from "./types.js";
import { createWriteQueue } from "./write-queue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(aid: string, gen: number): NodeCheckpoint {
  return {
    id: `cp-${aid}-${String(gen)}`,
    agentId: agentId(aid) as AgentId,
    sessionId: `session-${aid}`,
    engineState: { engineId: "test", data: { gen } },
    processState: "running",
    generation: gen,
    metadata: {},
    createdAt: Date.now(),
  };
}

function createMockStore(): NodeSessionStore & {
  readonly savedCheckpoints: NodeCheckpoint[];
} {
  const savedCheckpoints: NodeCheckpoint[] = [];

  return {
    savedCheckpoints,
    saveSession: mock(() => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    removeSession: mock(() => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    saveCheckpoint: mock((cp: NodeCheckpoint) => {
      savedCheckpoints.push(cp);
      return { ok: true, value: undefined } as Result<void, KoiError>;
    }),
    loadLatestCheckpoint: mock(
      () => ({ ok: true, value: undefined }) as Result<NodeCheckpoint | undefined, KoiError>,
    ),
    savePendingFrame: mock(() => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    loadPendingFrames: mock(() => ({ ok: true, value: [] }) as Result<readonly never[], KoiError>),
    clearPendingFrames: mock(() => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    removePendingFrame: mock(() => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    recover: mock(
      () =>
        ({
          ok: true,
          value: {
            sessions: [],
            checkpoints: new Map(),
            pendingFrames: new Map(),
          },
        }) as Result<
          {
            sessions: readonly never[];
            checkpoints: ReadonlyMap<string, NodeCheckpoint>;
            pendingFrames: ReadonlyMap<string, readonly never[]>;
          },
          KoiError
        >,
    ),
    close: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWriteQueue", () => {
  let queue: ReturnType<typeof createWriteQueue>;
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
    // Use a long interval so auto-flush doesn't interfere with manual tests
    queue = createWriteQueue(store, { flushIntervalMs: 60_000 });
  });

  afterEach(async () => {
    await queue.dispose();
  });

  test("enqueue stores latest checkpoint per agent", async () => {
    queue.enqueue("a1", makeCheckpoint("a1", 1));
    queue.enqueue("a1", makeCheckpoint("a1", 2));
    queue.enqueue("a2", makeCheckpoint("a2", 1));

    await queue.flush();

    expect(store.savedCheckpoints.length).toBe(2);
    // a1 should have generation 2 (latest)
    const a1cp = store.savedCheckpoints.find((cp) => cp.agentId === agentId("a1"));
    expect(a1cp?.generation).toBe(2);
    const a2cp = store.savedCheckpoints.find((cp) => cp.agentId === agentId("a2"));
    expect(a2cp?.generation).toBe(1);
  });

  test("flush writes all pending to store", async () => {
    queue.enqueue("a1", makeCheckpoint("a1", 1));
    queue.enqueue("a2", makeCheckpoint("a2", 1));
    queue.enqueue("a3", makeCheckpoint("a3", 1));

    await queue.flush();

    expect(store.savedCheckpoints.length).toBe(3);
  });

  test("flush clears the queue", async () => {
    queue.enqueue("a1", makeCheckpoint("a1", 1));
    await queue.flush();
    expect(store.savedCheckpoints.length).toBe(1);

    // Second flush should be a no-op
    await queue.flush();
    expect(store.savedCheckpoints.length).toBe(1);
  });

  test("flush is a no-op when queue is empty", async () => {
    await queue.flush();
    expect(store.savedCheckpoints.length).toBe(0);
  });

  test("auto-flushes on interval", async () => {
    // Create queue with very short interval
    await queue.dispose(); // dispose the default one
    queue = createWriteQueue(store, { flushIntervalMs: 50 });

    queue.enqueue("a1", makeCheckpoint("a1", 1));

    // Wait for auto-flush
    await new Promise((r) => setTimeout(r, 100));

    expect(store.savedCheckpoints.length).toBe(1);
  });

  test("dispose flushes remaining and stops timer", async () => {
    queue.enqueue("a1", makeCheckpoint("a1", 1));
    queue.enqueue("a2", makeCheckpoint("a2", 1));

    await queue.dispose();

    expect(store.savedCheckpoints.length).toBe(2);

    // Enqueue after dispose should be ignored
    queue.enqueue("a3", makeCheckpoint("a3", 1));
    await queue.flush();
    expect(store.savedCheckpoints.length).toBe(2);
  });

  test("multiple enqueues for same agent keep only latest", async () => {
    queue.enqueue("a1", makeCheckpoint("a1", 1));
    queue.enqueue("a1", makeCheckpoint("a1", 2));
    queue.enqueue("a1", makeCheckpoint("a1", 3));

    await queue.flush();

    expect(store.savedCheckpoints.length).toBe(1);
    expect(store.savedCheckpoints[0]?.generation).toBe(3);
  });

  test("dispose is idempotent", async () => {
    queue.enqueue("a1", makeCheckpoint("a1", 1));
    await queue.dispose();
    await queue.dispose(); // should not throw or double-flush
    expect(store.savedCheckpoints.length).toBe(1);
  });
});
