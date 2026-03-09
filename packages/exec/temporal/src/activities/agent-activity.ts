/**
 * Agent turn Activity — executes a single agent turn via createKoi().
 *
 * Decisions:
 * - 5C: Single Activity for v1 (turn-boundary retry granularity)
 * - 2A: Stream text_delta via gateway WebSocket
 * - 13A: Engine cached across turns (via engine-cache.ts)
 * - 6A: Error mapping via temporal-errors.ts
 *
 * This file runs in normal Bun/Node.js context (NOT in the sandbox).
 * It CAN perform I/O, use Date.now(), etc.
 */

import type { AgentId, ContentBlock, EngineInput } from "@koi/core";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import type { EngineCache } from "../engine-cache.js";
import { mapKoiErrorToApplicationFailure } from "../temporal-errors.js";
import type {
  AgentStateRefs,
  AgentTurnInput,
  AgentTurnResult,
  SpawnChildRequest,
} from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected dependencies for the Activity (set up by the Worker factory). */
export interface ActivityDeps {
  /** Cached engine factory (Decision 13A). */
  readonly engineCache: EngineCache;
  /** Send a gateway frame for live streaming (Decision 2A). */
  readonly sendGatewayFrame: (agentId: string, frame: GatewayStreamFrame) => Promise<void>;
  /** Create engine input from turn input. */
  readonly createEngineInput: (input: AgentTurnInput) => EngineInput;
  /** Compute the cache key for the current manifest. */
  readonly computeCacheKey: () => {
    readonly manifestHash: string;
    readonly forgeGeneration: number;
  };
  /** Get the createKoi options for the current agent. */
  readonly getCreateKoiOptions: (agentId: string) => Promise<CreateKoiOptionsLike>;
}

/** Minimal gateway frame for streaming text deltas. */
export interface GatewayStreamFrame {
  readonly kind: "agent:text_delta";
  readonly delta: string;
  readonly sessionId: string;
}

/** Structural type for CreateKoiOptions (avoids deep import). */
export interface CreateKoiOptionsLike {
  readonly manifest: unknown;
  readonly adapter: unknown;
  readonly middleware?: readonly unknown[];
  readonly providers?: readonly unknown[];
  readonly extensions?: readonly unknown[];
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Activity factory
// ---------------------------------------------------------------------------

/**
 * Create the activity functions to register with the Temporal Worker.
 *
 * Dependencies are injected via closure — this keeps the Activity
 * functions pure and testable.
 */
export function createActivities(deps: ActivityDeps): {
  readonly runAgentTurn: (input: AgentTurnInput) => Promise<AgentTurnResult>;
} {
  return {
    async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
      const turnId = `turn:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
      const blocks: ContentBlock[] = [];
      // Populated when the engine emits a spawn_requested event.
      // Only the last spawn request per turn is honoured (single-child model).
      let spawnChild: SpawnChildRequest | undefined;

      try {
        // Get or create cached engine (Decision 13A)
        const cacheKey = deps.computeCacheKey();
        const options = await deps.getCreateKoiOptions(input.agentId);
        const runtime = await deps.engineCache.getOrCreate(cacheKey, options);

        // Create engine input from the turn's message
        const engineInput = deps.createEngineInput(input);

        // Execute the agent turn
        let eventCount = 0;
        for await (const event of runtime.run(engineInput)) {
          const evt = event as {
            readonly kind: string;
            readonly delta?: unknown;
            readonly [key: string]: unknown;
          };

          switch (evt.kind) {
            case "text_delta": {
              const delta = typeof evt.delta === "string" ? evt.delta : String(evt.delta);
              blocks.push({ kind: "text", text: delta } satisfies ContentBlock);

              // Stream to gateway (Decision 2A)
              if (input.gatewayUrl !== undefined) {
                await deps.sendGatewayFrame(input.agentId, {
                  kind: "agent:text_delta",
                  delta,
                  sessionId: input.sessionId,
                });
              }
              break;
            }
            case "tool_call_start":
            case "tool_call_end":
              // Tool events are tracked but not streamed
              break;
            case "spawn_requested": {
              const childAgentId = evt.childAgentId as AgentId;
              spawnChild = {
                childAgentId,
                childConfig: {
                  agentId: childAgentId,
                  sessionId: input.sessionId,
                  stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
                },
              };
              break;
            }
            case "done":
              // Turn complete
              break;
          }

          // Heartbeat every 10 events to prevent Activity timeout
          eventCount++;
          if (eventCount % 10 === 0) {
            heartbeat({ eventsProcessed: eventCount, turnId });
          }
        }

        // Build updated state refs (Decision 16A — lightweight)
        const updatedStateRefs: AgentStateRefs = {
          lastTurnId: turnId,
          turnsProcessed: input.stateRefs.turnsProcessed + 1,
        };

        return {
          turnId,
          blocks,
          updatedStateRefs,
          spawnChild,
        };
      } catch (error: unknown) {
        // Map to Temporal ApplicationFailure (Decision 6A)
        const payload = mapKoiErrorToApplicationFailure({
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          context: { turnId, agentId: input.agentId },
        });

        // Throw a real Temporal ApplicationFailure so metadata round-trips correctly
        throw ApplicationFailure.create({
          message: payload.message,
          type: payload.type,
          nonRetryable: payload.nonRetryable,
          details: [...payload.details],
        });
      }
    },
  };
}
