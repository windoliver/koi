/**
 * Test doubles and mock factories for @koi/competitive-broadcast tests.
 * NOT exported from the public API (index.ts).
 */

import { agentId } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type {
  BroadcastReport,
  BroadcastResult,
  BroadcastSink,
  Proposal,
  SelectionStrategy,
} from "./types.js";
import { proposalId } from "./types.js";

// ---------------------------------------------------------------------------
// Counter for unique IDs
// ---------------------------------------------------------------------------

/* let is required for monotonic counter across mock calls */
let nextId = 1;

/** Reset the internal mock counter. Call in beforeEach. */
export function resetMockCounter(): void {
  nextId = 1;
}

// ---------------------------------------------------------------------------
// Mock proposal factory
// ---------------------------------------------------------------------------

/** Creates a valid Proposal with sensible defaults. Override any field. */
export function mockProposal(
  overrides?: Partial<Omit<Proposal, "id">> & { readonly id?: string },
): Proposal {
  const id = overrides?.id ?? `p-${nextId++}`;
  return {
    id: proposalId(id),
    agentId: overrides?.agentId ?? agentId(`agent-${id}`),
    output: overrides?.output ?? `output-${id}`,
    durationMs: overrides?.durationMs ?? 100,
    submittedAt: overrides?.submittedAt ?? Date.now(),
    salience: overrides?.salience,
    metadata: overrides?.metadata,
  };
}

// ---------------------------------------------------------------------------
// Spy broadcast sink (doubles as in-memory implementation)
// ---------------------------------------------------------------------------

export interface SpyBroadcastSink {
  readonly sink: BroadcastSink;
  readonly broadcasts: readonly BroadcastResult[];
}

/** Creates a BroadcastSink that records all broadcast calls. */
export function createSpyBroadcastSink(): SpyBroadcastSink {
  const broadcasts: BroadcastResult[] = [];
  const sink: BroadcastSink = {
    broadcast: async (result: BroadcastResult): Promise<BroadcastReport> => {
      broadcasts.push(result);
      return { delivered: 1, failed: 0 };
    },
  };
  return { sink, broadcasts };
}

// ---------------------------------------------------------------------------
// Spy selection strategy
// ---------------------------------------------------------------------------

/** Creates a SelectionStrategy that always picks the first proposal (or a specific winner). */
export function createSpySelectionStrategy(winnerId?: string): SelectionStrategy {
  return {
    name: "spy",
    select: (proposals: readonly Proposal[]): Result<Proposal, KoiError> => {
      if (winnerId !== undefined) {
        const found = proposals.find((p) => p.id === winnerId);
        if (found !== undefined) {
          return { ok: true, value: found };
        }
      }
      const first = proposals[0];
      if (first === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "No proposals to select from",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
      return { ok: true, value: first };
    },
  };
}

// ---------------------------------------------------------------------------
// Failing doubles
// ---------------------------------------------------------------------------

/** Creates a BroadcastSink that always throws. */
export function createFailingBroadcastSink(error: Error): BroadcastSink {
  return {
    broadcast: async (): Promise<BroadcastReport> => {
      throw error;
    },
  };
}

/** Creates a SelectionStrategy that always returns an error. */
export function createFailingSelectionStrategy(error: KoiError): SelectionStrategy {
  return {
    name: "failing",
    select: (): Result<Proposal, KoiError> => {
      return { ok: false, error };
    },
  };
}
