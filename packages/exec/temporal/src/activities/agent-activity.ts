/**
 * Host-side activity factory for durable Temporal-backed agent turns.
 *
 * The activity stays in normal Node/Bun runtime code and uses the Temporal SDK
 * only at the execution boundary. The public package surface re-exports the
 * factory and its structural types, but not the SDK imports.
 */

import type { AgentId, ContentBlock, EngineInput } from "@koi/core";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import { mapKoiErrorToApplicationFailure, mapTemporalError } from "../temporal-errors.js";
import type { AgentTurnInput, AgentTurnResult, SpawnChildRequest } from "../types.js";

const HEARTBEAT_INTERVAL_MS = 5_000;

export interface ActivityCacheKey {
  readonly manifestHash: string;
  readonly forgeGeneration: number;
  readonly credentialScope: string;
}

export interface GatewayStreamFrame {
  readonly kind: "agent:text_delta";
  readonly delta: string;
  readonly sessionId: string;
}

export interface ActivityDeps {
  readonly engineCache: {
    getOrCreate: (
      key: ActivityCacheKey,
      options: unknown,
    ) => Promise<{
      readonly run: (input: EngineInput) => AsyncIterable<unknown>;
    }>;
  };
  readonly sendGatewayFrame: (agentId: string, frame: GatewayStreamFrame) => Promise<void>;
  readonly createEngineInput: (input: AgentTurnInput) => EngineInput;
  readonly computeCacheKey: (input: {
    readonly agentId: AgentId;
    readonly delegationId: string | undefined;
    readonly nexusApiKey: string | undefined;
  }) => ActivityCacheKey;
  readonly getCreateKoiOptions: (
    input: Pick<AgentTurnInput, "agentId" | "delegationId" | "nexusApiKey">,
  ) => Promise<unknown>;
}

export function createActivities(deps: ActivityDeps): {
  readonly runAgentTurn: (input: AgentTurnInput) => Promise<AgentTurnResult>;
} {
  return {
    async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
      const turnId = `turn:${Date.now()}`;
      const blocks: ContentBlock[] = [];
      let spawnChild: SpawnChildRequest | undefined;
      let eventCount = 0;
      const heartbeatTimer = startHeartbeatTimer(() => {
        heartbeat({ turnId, eventCount, agentId: input.agentId });
      });

      try {
        const credentialScope = {
          agentId: input.agentId,
          delegationId: input.delegationId,
          nexusApiKey: input.nexusApiKey,
        };
        const runtime = await deps.engineCache.getOrCreate(
          deps.computeCacheKey(credentialScope),
          await deps.getCreateKoiOptions(credentialScope),
        );
        const engineInput = deps.createEngineInput(input);

        for await (const event of runtime.run(engineInput)) {
          const record = event as {
            readonly kind?: string;
            readonly delta?: unknown;
            readonly childAgentId?: unknown;
          };

          if (record.kind === "text_delta") {
            const delta =
              typeof record.delta === "string" ? record.delta : String(record.delta ?? "");
            blocks.push({ kind: "text", text: delta });

            if (input.gatewayUrl !== undefined) {
              await deps.sendGatewayFrame(input.agentId, {
                kind: "agent:text_delta",
                delta,
                sessionId: input.sessionId,
              });
            }
          } else if (record.kind === "spawn_requested") {
            const childAgentId = String(record.childAgentId ?? "");
            spawnChild = {
              childAgentId: childAgentId as AgentId,
              childConfig: {
                stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
              },
            };
          }

          eventCount++;
          if (eventCount % 10 === 0) {
            heartbeat({ turnId, eventCount, agentId: input.agentId });
          }
        }

        return {
          turnId,
          blocks,
          updatedStateRefs: {
            lastTurnId: turnId,
            turnsProcessed: input.stateRefs.turnsProcessed + 1,
          },
          spawnChild,
        };
      } catch (error: unknown) {
        const koiError = mapTemporalError(error);
        const payload = mapKoiErrorToApplicationFailure(koiError);
        throw ApplicationFailure.create({
          message: payload.message,
          type: payload.type,
          nonRetryable: payload.nonRetryable,
          details: [...payload.details],
        });
      } finally {
        stopHeartbeatTimer(heartbeatTimer);
      }
    },
  };
}

function startHeartbeatTimer(sendHeartbeat: () => void): ReturnType<typeof setInterval> {
  const timer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

function stopHeartbeatTimer(timer: ReturnType<typeof setInterval>): void {
  clearInterval(timer);
}
