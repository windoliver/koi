/**
 * Configuration, constants, and tool descriptor for @koi/tool-squash.
 *
 * L2 — imports from @koi/core only.
 */

import type { SnapshotChainStore } from "@koi/core";
import type { CompactionResult, TokenEstimator } from "@koi/core/context";
import type { MemoryComponent, SessionId, ToolDescriptor } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** User-facing configuration for createSquashProvider. */
export interface SquashConfig {
  /** Required: archive store for snapshotting squashed messages. */
  readonly archiver: SnapshotChainStore<readonly InboundMessage[]>;
  /** Optional: memory component for fact extraction. */
  readonly memory?: MemoryComponent | undefined;
  /** Optional: token estimator override. Defaults to 4 chars/token heuristic. */
  readonly tokenEstimator?: TokenEstimator | undefined;
  /** Number of most recent messages to preserve. Default: 4. */
  readonly preserveRecent?: number | undefined;
  /** Maximum pending squashes before oldest is dropped. Default: 3. */
  readonly maxPendingSquashes?: number | undefined;
  /** Session ID for archive chain naming. */
  readonly sessionId: SessionId;
}

/** Fully resolved config with defaults applied. Internal only. */
export interface ResolvedSquashConfig {
  readonly archiver: SnapshotChainStore<readonly InboundMessage[]>;
  readonly memory: MemoryComponent | undefined;
  readonly tokenEstimator: TokenEstimator;
  readonly preserveRecent: number;
  readonly maxPendingSquashes: number;
  readonly sessionId: SessionId;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Structured metrics returned to the agent after a squash call. */
export type SquashResult =
  | {
      readonly ok: true;
      readonly phase: string;
      readonly originalMessages: number;
      readonly originalTokens: number;
      readonly compactedTokens: number;
      readonly archivedNodeId: string | undefined;
      readonly factsStored: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: string;
    };

// ---------------------------------------------------------------------------
// Pending queue — encapsulated mutable channel between tool and middleware
// ---------------------------------------------------------------------------

/** A pending squash queued for the middleware to apply. */
export interface PendingSquash {
  readonly result: CompactionResult;
}

/** Encapsulated mutable queue shared between the squash tool and middleware. */
export interface PendingQueue {
  /** Current number of pending squashes. */
  readonly length: number;
  /** Drain all pending items, returning them. Queue becomes empty. */
  readonly drain: () => readonly PendingSquash[];
  /** Add a new pending squash to the queue. */
  readonly enqueue: (item: PendingSquash) => void;
  /** Remove all items from the queue. */
  readonly clear: () => void;
  /** Drop oldest items to stay within the given max size. */
  readonly trimTo: (maxSize: number) => void;
}

/** Creates an encapsulated mutable pending queue. */
export function createPendingQueue(): PendingQueue {
  // Mutable array encapsulated — not exposed directly
  const items: PendingSquash[] = [];
  return {
    get length(): number {
      return items.length;
    },
    drain(): readonly PendingSquash[] {
      return items.splice(0);
    },
    enqueue(item: PendingSquash): void {
      items.push(item);
    },
    clear(): void {
      items.splice(0);
    },
    trimTo(maxSize: number): void {
      if (items.length >= maxSize) {
        items.splice(0, items.length - maxSize + 1);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface SquashDefaults {
  readonly preserveRecent: number;
  readonly maxPendingSquashes: number;
}

export const SQUASH_DEFAULTS: Readonly<SquashDefaults> = Object.freeze({
  preserveRecent: 4,
  maxPendingSquashes: 3,
});

/** Tool descriptor exposed to the model for the squash tool. */
export const SQUASH_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "squash",
  description:
    "Compress conversation history at a phase boundary. Replaces old messages with your summary, archives originals for retrieval, and optionally stores facts to memory. Call at natural transitions (e.g., done planning, starting implementation) to free context space.",
  inputSchema: {
    type: "object",
    properties: {
      phase: {
        type: "string",
        description:
          "Label for the completed phase (e.g., 'planning', 'research', 'implementation'). Used as the archive category.",
      },
      summary: {
        type: "string",
        description:
          "Your summary of the completed phase. This replaces the old messages in context. Be thorough — include key decisions, outcomes, and any state needed for the next phase.",
      },
      facts: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of discrete facts to persist to long-term memory (e.g., 'User prefers TypeScript', 'API key stored in .env'). Each fact is stored independently.",
      },
    },
    required: ["phase", "summary"],
  },
};
