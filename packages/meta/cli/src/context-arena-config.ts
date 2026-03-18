/**
 * Shared context-arena config factory for `koi up` (and future `koi serve` refactor).
 *
 * Constructs a ContextArenaConfig with the appropriate ThreadStore backend
 * based on preset configuration (Decision 1A, 2A).
 */

import { resolve } from "node:path";
import type { ContextArenaConfig } from "@koi/context-arena";
import type { InboundMessage, SessionId, ThreadSnapshotStore } from "@koi/core";
import { sessionId } from "@koi/core";
import type { ModelHandler } from "@koi/core/middleware";
import type { ThreadStoreBackend } from "@koi/runtime-presets";
import {
  createInMemorySnapshotChainStore,
  createSqliteSnapshotChainStore,
  createThreadStore,
} from "@koi/snapshot-chain-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateContextArenaConfigInput {
  /** LLM handler for compaction summaries. */
  readonly summarizer: ModelHandler;
  /** Agent manifest name (used for session ID namespace). */
  readonly manifestName: string;
  /** Thread store backend selection from preset. Default: "memory". */
  readonly threadStoreBackend?: ThreadStoreBackend;
  /** Data directory for SQLite stores. Default: ".koi/data". */
  readonly dataDir?: string;
  /**
   * Pre-built Nexus snapshot store for the "nexus" backend.
   * When threadStoreBackend is "nexus" and this is undefined,
   * falls back to SQLite.
   */
  readonly nexusSnapshotStore?: ThreadSnapshotStore;
  /** Returns current message buffer for squash partitioning. */
  readonly getMessages: () => readonly InboundMessage[];
  /** Returns the current thread key for conversation middleware. */
  readonly resolveThreadId?: () => string | undefined;
}

export interface ContextArenaConfigResult {
  /** Ready-to-use config for createContextArena. */
  readonly config: ContextArenaConfig;
  /** Session ID created for this runtime. */
  readonly sessionId: SessionId;
  /** Disposer — closes the thread store and backing snapshot store. */
  readonly dispose: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ContextArenaConfig with the appropriate ThreadStore backend.
 *
 * Backend resolution:
 * - "memory" → in-memory SnapshotChainStore (ephemeral, fast)
 * - "sqlite" → SQLite SnapshotChainStore at `dataDir/threads.db` (persistent)
 * - "nexus"  → uses `nexusSnapshotStore` if provided, else falls back to SQLite
 */
export function createContextArenaConfigForUp(
  input: CreateContextArenaConfigInput,
): ContextArenaConfigResult {
  const backend = input.threadStoreBackend ?? "memory";
  const dataDir = input.dataDir ?? ".koi/data";

  let store: ThreadSnapshotStore;

  switch (backend) {
    case "memory": {
      store = createInMemorySnapshotChainStore();
      break;
    }
    case "sqlite": {
      const dbPath = resolve(dataDir, "threads.db");
      store = createSqliteSnapshotChainStore(dbPath);
      break;
    }
    case "nexus": {
      // Use provided Nexus store, or fall back to SQLite if unavailable
      if (input.nexusSnapshotStore !== undefined) {
        store = input.nexusSnapshotStore;
      } else {
        const dbPath = resolve(dataDir, "threads.db");
        store = createSqliteSnapshotChainStore(dbPath);
      }
      break;
    }
  }

  const threadStore = createThreadStore({ store, maxRetained: 500 });
  const sid = sessionId(`up:${input.manifestName}:${String(Date.now())}`);

  return {
    config: {
      summarizer: input.summarizer,
      sessionId: sid,
      getMessages: input.getMessages,
      threadStore,
      conversation: {
        resolveThreadId: input.resolveThreadId,
      },
    },
    sessionId: sid,
    dispose: () => threadStore.close(),
  };
}
