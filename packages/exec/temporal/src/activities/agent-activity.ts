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
import type {
  AgentTurnInput,
  AgentTurnResult,
  IncomingMessage,
  SpawnChildRequest,
} from "../types.js";

const HEARTBEAT_INTERVAL_MS = 5_000;

export interface ActivityCacheKey {
  readonly manifestHash: string;
  readonly forgeGeneration: number;
  readonly credentialScope: string;
}

export type GatewayStreamFrame =
  | {
      readonly kind: "agent:text_delta";
      readonly delta: string;
      readonly sessionId: string;
      /**
       * Stable turn identifier. Combined with `frameIndex` it forms an idempotency
       * key consumers can use to dedupe replayed deltas when the activity retries.
       */
      readonly turnId: string;
      /** Monotonically increasing index of this frame within `turnId`, starting at 0. */
      readonly frameIndex: number;
    }
  | {
      /**
       * Emitted when the engine requested a child spawn but the activity is
       * running in a no-spawn mode (e.g. scheduled firings). Gives operators
       * a durable observable signal for the dropped delegation; the turn
       * itself commits normally.
       */
      readonly kind: "agent:spawn_dropped";
      readonly sessionId: string;
      readonly turnId: string;
      readonly frameIndex: number;
      readonly reason: string;
      readonly childAgentId: string;
    };

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
      // Use the workflow-supplied turnId verbatim. It is stable across
      // Temporal activity retries, so gateway frames keyed on (turnId,
      // frameIndex) remain a valid idempotency key when the activity reruns
      // after a transient failure.
      const turnId = input.turnId;
      const blocks: ContentBlock[] = [];
      let spawnChild: SpawnChildRequest | undefined;
      let eventCount = 0;
      let frameIndex = 0;
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
            readonly request?: {
              readonly description?: unknown;
              readonly systemPrompt?: unknown;
              readonly context?: unknown;
              readonly maxTurns?: unknown;
              readonly maxTokens?: unknown;
              readonly nonInteractive?: unknown;
              readonly toolAllowlist?: unknown;
              readonly toolDenylist?: unknown;
              readonly fork?: unknown;
              readonly allowNestedSpawn?: unknown;
              readonly timeoutMs?: unknown;
              readonly absoluteDeadlineMs?: unknown;
              readonly outputSchema?: unknown;
              readonly requiredOutputToolName?: unknown;
              readonly additionalTools?: unknown;
              readonly manifest?: unknown;
              readonly delivery?: unknown;
              readonly taskIndex?: unknown;
              readonly taskId?: unknown;
              readonly agentName?: unknown;
            };
          };

          if (record.kind === "text_delta") {
            const delta =
              typeof record.delta === "string" ? record.delta : String(record.delta ?? "");
            blocks.push({ kind: "text", text: delta });

            if (input.gatewayUrl !== undefined) {
              // Gateway delivery is the only place streamed assistant output
              // surfaces to the user — `result.blocks` is not durably
              // published downstream. Propagate failures so Temporal can
              // retry the turn rather than silently completing with no
              // visible output.
              await deps.sendGatewayFrame(input.agentId, {
                kind: "agent:text_delta",
                delta,
                sessionId: input.sessionId,
                turnId,
                frameIndex: frameIndex++,
              });
            }
          } else if (record.kind === "spawn_requested") {
            // Scheduled firings forbid spawning: the parent auto-terminates
            // when its queue drains, and a child launched with ABANDON
            // parent close policy could outlive the parent, breaking schedule
            // overlap. We drop the spawn (no startChild) but commit the turn
            // normally — text deltas already streamed to the gateway must
            // not be invalidated by a post-hoc throw, since the next cron
            // tick would replay them and duplicate user-visible output.
            if (input.allowSpawn === false) {
              await deps.sendGatewayFrame(input.agentId, {
                kind: "agent:spawn_dropped",
                sessionId: input.sessionId,
                turnId,
                frameIndex: frameIndex++,
                reason: "scheduled-firing-no-spawn",
                childAgentId: String(record.childAgentId ?? ""),
              });
              continue;
            }
            const childAgentId = String(record.childAgentId ?? "");
            const description =
              typeof record.request?.description === "string" ? record.request.description : "";
            const systemPrompt =
              typeof record.request?.systemPrompt === "string"
                ? record.request.systemPrompt
                : undefined;
            const rawContext = record.request?.context;
            let context: Record<string, unknown> | undefined;
            if (rawContext !== undefined && rawContext !== null) {
              // Recursively reject non-plain values. JSON.stringify alone is
              // lossy: it silently coerces Date → string, Map/Set → {}, class
              // instances → plain objects, etc., so we explicitly check each
              // node's prototype before accepting the context. This makes the
              // child workflow fail fast on structurally surprising input
              // rather than running with mutated context.
              const validatePlainJson = (value: unknown, path: string): void => {
                if (value === null) return;
                const t = typeof value;
                if (t === "string" || t === "boolean") return;
                if (t === "number") {
                  if (!Number.isFinite(value as number)) {
                    throw ApplicationFailure.create({
                      message: `spawn_requested.context${path}: non-finite number`,
                      type: "InvalidSpawnRequest",
                      nonRetryable: true,
                    });
                  }
                  return;
                }
                if (t !== "object") {
                  throw ApplicationFailure.create({
                    message: `spawn_requested.context${path}: ${t} is not JSON-serializable`,
                    type: "InvalidSpawnRequest",
                    nonRetryable: true,
                  });
                }
                if (Array.isArray(value)) {
                  for (let i = 0; i < value.length; i++) {
                    validatePlainJson(value[i], `${path}[${i}]`);
                  }
                  return;
                }
                const proto = Object.getPrototypeOf(value);
                if (proto !== Object.prototype && proto !== null) {
                  throw ApplicationFailure.create({
                    message: `spawn_requested.context${path}: only plain objects are allowed (got ${proto?.constructor?.name ?? "unknown"})`,
                    type: "InvalidSpawnRequest",
                    nonRetryable: true,
                  });
                }
                for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                  validatePlainJson(v, `${path}.${k}`);
                }
              };
              if (typeof rawContext !== "object" || Array.isArray(rawContext)) {
                throw ApplicationFailure.create({
                  message: "spawn_requested.context must be a plain object",
                  type: "InvalidSpawnRequest",
                  nonRetryable: true,
                });
              }
              try {
                validatePlainJson(rawContext, "");
              } catch (err: unknown) {
                if (err instanceof Error && err.name === "ApplicationFailure") throw err;
                throw ApplicationFailure.create({
                  message: `spawn_requested.context validation failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  type: "InvalidSpawnRequest",
                  nonRetryable: true,
                });
              }
              context = rawContext as Record<string, unknown>;
            }
            const metadata: Record<string, unknown> = {};
            if (systemPrompt !== undefined) metadata.systemPrompt = systemPrompt;
            if (context !== undefined) metadata.context = context;
            const initialMessage: IncomingMessage | undefined =
              description.length > 0 || context !== undefined || systemPrompt !== undefined
                ? {
                    id: `spawn:${childAgentId}:${turnId}`,
                    senderId: input.agentId,
                    content: [{ kind: "text", text: description }],
                    timestamp: Date.now(),
                    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
                  }
                : undefined;
            const req = record.request;
            const stringArray = (v: unknown, field: string): readonly string[] | undefined => {
              if (v === undefined) return undefined;
              if (!Array.isArray(v) || !v.every((item) => typeof item === "string")) {
                throw ApplicationFailure.create({
                  message: `spawn_requested.${field} must be string[]`,
                  type: "InvalidSpawnRequest",
                  nonRetryable: true,
                });
              }
              return v as readonly string[];
            };
            const positiveInt = (v: unknown, field: string): number | undefined => {
              if (v === undefined) return undefined;
              if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
                throw ApplicationFailure.create({
                  message: `spawn_requested.${field} must be a positive integer`,
                  type: "InvalidSpawnRequest",
                  nonRetryable: true,
                });
              }
              return v;
            };
            const boolField = (v: unknown, field: string): boolean | undefined => {
              if (v === undefined) return undefined;
              if (typeof v !== "boolean") {
                throw ApplicationFailure.create({
                  message: `spawn_requested.${field} must be boolean`,
                  type: "InvalidSpawnRequest",
                  nonRetryable: true,
                });
              }
              return v;
            };
            // Reject SpawnRequest fields the durable Temporal path cannot
            // safely preserve. Carrying these silently would let a turn
            // spawn a child that runs with weaker/different limits than
            // the parent intended.
            // Only reject fields that materially change child execution
            // and that the Temporal path cannot carry. agentName/agentId/
            // taskIndex/taskId are correlation/identity hints already
            // resolved (childAgentId is set after AgentResolver runs); we
            // accept them but don't propagate. additionalTools/manifest/
            // delivery would change child semantics and aren't carried.
            // outputSchema/requiredOutputToolName depend on a paired
            // additionalTools injection (the verdict tool) that the Temporal
            // path cannot serialize; reject the structured-output trio
            // together until the spawn contract can carry the verdict tool.
            // Detect unsupported spawn fields. Drop the spawn (no startChild)
            // and emit an observable gateway frame instead of throwing —
            // text deltas may have already streamed to the gateway, and a
            // post-hoc throw would either lose them or replay them on retry.
            // The parent turn commits normally; operators see the dropped
            // delegation via the spawn_dropped frame.
            const unsupportedFields = [
              "manifest",
              "delivery",
              "outputSchema",
              "requiredOutputToolName",
            ] as const;
            const additionalTools = req?.additionalTools;
            const additionalToolsRequested =
              Array.isArray(additionalTools) && additionalTools.length > 0;
            const presentUnsupported = unsupportedFields.find(
              (f) => req !== undefined && (req as Record<string, unknown>)[f] !== undefined,
            );
            if (presentUnsupported !== undefined || additionalToolsRequested) {
              const fieldName = presentUnsupported ?? "additionalTools";
              await deps.sendGatewayFrame(input.agentId, {
                kind: "agent:spawn_dropped",
                sessionId: input.sessionId,
                turnId,
                frameIndex: frameIndex++,
                reason: `unsupported-spawn-field:${fieldName}`,
                childAgentId: String(record.childAgentId ?? ""),
              });
              continue;
            }
            const nonNegativeNumber = (v: unknown, field: string): number | undefined => {
              if (v === undefined) return undefined;
              if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
                throw ApplicationFailure.create({
                  message: `spawn_requested.${field} must be a non-negative finite number`,
                  type: "InvalidSpawnRequest",
                  nonRetryable: true,
                });
              }
              return v;
            };
            const rawTimeoutMs = nonNegativeNumber(req?.timeoutMs, "timeoutMs");
            const rawAbsoluteDeadlineMs = nonNegativeNumber(
              req?.absoluteDeadlineMs,
              "absoluteDeadlineMs",
            );
            // Snapshot the deadline at spawn capture time so any delay
            // before the child workflow actually starts (queue, retries,
            // worker scheduling) is charged against the caller's budget.
            // This matches the in-process spawn path which captures an
            // effective deadline immediately rather than letting the child
            // restart its full timer on every attempt. timeoutMs: 0 is the
            // documented "disable timeout" signal — preserve that by only
            // deriving an absolute deadline when timeoutMs > 0.
            const effectiveDeadlineMs =
              rawAbsoluteDeadlineMs ??
              (rawTimeoutMs !== undefined && rawTimeoutMs > 0
                ? Date.now() + rawTimeoutMs
                : undefined);
            const constraints = {
              maxTurns: positiveInt(req?.maxTurns, "maxTurns"),
              maxTokens: positiveInt(req?.maxTokens, "maxTokens"),
              nonInteractive: boolField(req?.nonInteractive, "nonInteractive"),
              toolAllowlist: stringArray(req?.toolAllowlist, "toolAllowlist"),
              toolDenylist: stringArray(req?.toolDenylist, "toolDenylist"),
              fork: boolField(req?.fork, "fork"),
              allowNestedSpawn: boolField(req?.allowNestedSpawn, "allowNestedSpawn"),
              timeoutMs: rawTimeoutMs,
              absoluteDeadlineMs: effectiveDeadlineMs,
            };
            // toolAllowlist and toolDenylist are mutually exclusive per SpawnRequest contract.
            if (constraints.toolAllowlist !== undefined && constraints.toolDenylist !== undefined) {
              throw ApplicationFailure.create({
                message: "spawn_requested.toolAllowlist and toolDenylist are mutually exclusive",
                type: "InvalidSpawnRequest",
                nonRetryable: true,
              });
            }
            // fork is also mutually exclusive with toolAllowlist per SpawnRequest contract.
            if (constraints.fork === true && constraints.toolAllowlist !== undefined) {
              throw ApplicationFailure.create({
                message: "spawn_requested.fork is mutually exclusive with toolAllowlist",
                type: "InvalidSpawnRequest",
                nonRetryable: true,
              });
            }
            const hasAnyConstraint = Object.values(constraints).some((v) => v !== undefined);
            spawnChild = {
              childAgentId: childAgentId as AgentId,
              childConfig: {
                stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
                ...(initialMessage !== undefined ? { initialMessage } : {}),
                // Do NOT propagate the parent's nexusApiKey/delegationId.
                // The in-process spawn path mints child-scoped credentials
                // (see kernel/engine/spawn-child.ts) so each child runs
                // with attenuated authority, not the parent's full scope.
                // Until the Temporal spawn path issues its own attenuated
                // child credentials, fail closed: the child starts without
                // delegated auth rather than widening the parent's grant.
                ...(constraints.maxTurns !== undefined ? { maxTurns: constraints.maxTurns } : {}),
                ...(constraints.maxTokens !== undefined
                  ? { maxTokens: constraints.maxTokens }
                  : {}),
                ...(constraints.nonInteractive !== undefined
                  ? { nonInteractive: constraints.nonInteractive }
                  : {}),
                ...(constraints.toolAllowlist !== undefined
                  ? { toolAllowlist: constraints.toolAllowlist }
                  : {}),
                ...(constraints.toolDenylist !== undefined
                  ? { toolDenylist: constraints.toolDenylist }
                  : {}),
                ...(constraints.fork !== undefined ? { fork: constraints.fork } : {}),
                ...(constraints.allowNestedSpawn !== undefined
                  ? { allowNestedSpawn: constraints.allowNestedSpawn }
                  : {}),
                ...(constraints.timeoutMs !== undefined
                  ? { timeoutMs: constraints.timeoutMs }
                  : {}),
                ...(constraints.absoluteDeadlineMs !== undefined
                  ? { absoluteDeadlineMs: constraints.absoluteDeadlineMs }
                  : {}),
              },
              ...(hasAnyConstraint ? { constraints } : {}),
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
