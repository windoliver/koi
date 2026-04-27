import type {
  CapabilityFragment,
  KoiMiddleware,
  ToolHealthSnapshot as L0ToolHealthSnapshot,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { ModelChunk } from "@koi/core/middleware";

type ModelCallCtx = Parameters<NonNullable<KoiMiddleware["wrapModelCall"]>>[0];
type ToolCallCtx = Parameters<NonNullable<KoiMiddleware["wrapToolCall"]>>[0];

import { KoiRuntimeError } from "@koi/errors";
import type { FeedbackLoopConfig } from "./config.js";
import { defaultRepairStrategy } from "./repair.js";
import { runWithRetry } from "./retry.js";
import type { ToolHealthTracker } from "./tool-health.js";
import { createToolHealthTracker } from "./tool-health.js";
import type { ForgeToolErrorFeedback } from "./types.js";

/**
 * Read-only handle exposing per-session tool-health snapshots in the
 * L0 (`@koi/core`) shape so cross-package consumers (e.g. `@koi/forge-demand`)
 * can wire latency-degradation detection without importing feedback-loop
 * or owning the trackers map. Returns L0's `ToolHealthSnapshot` —
 * `metrics.avgLatencyMs` is computed from the rolling ring entries.
 */
export interface FeedbackLoopHealthHandle {
  /**
   * Read a tool-health snapshot scoped to a SessionContext that the
   * underlying middleware has actually observed. Object-identity
   * resolution prevents an in-process consumer from enumerating
   * snapshots for arbitrary sessionIds — only sessions whose
   * `onSessionStart` ran through THIS middleware are visible. F99
   * regression.
   */
  readonly getSnapshot: (
    session: SessionContext,
    toolId: string,
  ) => L0ToolHealthSnapshot | undefined;
}

/**
 * Middleware return type extended with an optional per-session
 * health-snapshot handle. The handle is present only when
 * `config.forgeHealth` was supplied — without that, the tracker map is
 * never populated and `getSnapshot` would always return `undefined`,
 * which would silently dormant `performance_degradation` in any
 * cross-package consumer that auto-wires by handle presence (F70).
 * Absent vs present is the liveness signal.
 */
export type FeedbackLoopMiddleware = KoiMiddleware & {
  readonly healthHandle?: FeedbackLoopHealthHandle | undefined;
};

const VALIDATION_DEFAULT_MAX_ATTEMPTS = 3;
const TRANSPORT_DEFAULT_MAX_ATTEMPTS = 2;

function hasModelChecks(config: FeedbackLoopConfig): boolean {
  return (
    (config.validators !== undefined && config.validators.length > 0) ||
    (config.gates !== undefined && config.gates.length > 0)
  );
}

function hasTransportRetry(config: FeedbackLoopConfig): boolean {
  // transportMaxAttempts semantics: 0 = no retries, 1 = one retry, etc.
  // Any explicitly set value >= 1 means the caller wants at least one transport retry.
  const maxAttempts = config.retry?.transport?.maxAttempts;
  return maxAttempts !== undefined && maxAttempts >= 1;
}

function hasToolChecks(config: FeedbackLoopConfig): boolean {
  return (
    config.forgeHealth !== undefined ||
    (config.toolValidators !== undefined && config.toolValidators.length > 0) ||
    (config.toolGates !== undefined && config.toolGates.length > 0)
  );
}

/**
 * Detect the `{ error: string; code: string }` in-band failure shape
 * many tools in this monorepo (read, write, edit, todo, etc.) use
 * instead of throwing. Treating these as healthy successes would
 * silently hide real failures from quarantine/demotion logic and
 * also leave feedback-loop and forge-demand disagreeing about the
 * outcome of the same call. Mirrors the same check in
 * `@koi/forge-demand`. F103 regression.
 */
function isInBandToolError(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  if (typeof o.error !== "string" || typeof o.code !== "string") return false;
  // VALIDATION is handled as NEUTRAL via isInBandValidationError. F108.
  if (o.code === "VALIDATION") return false;
  return true;
}

/**
 * Pre-execution validation reject in `{ error, code: "VALIDATION" }` shape.
 * The tool body never ran, so this is NEUTRAL: neither recordSuccess
 * (which would inflate success rate / latency samples for a call that
 * never executed) nor recordFailure (which would quarantine a healthy
 * tool over a caller mistake). F108 regression.
 */
function isInBandValidationError(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return typeof o.error === "string" && typeof o.code === "string" && o.code === "VALIDATION";
}

async function handleToolSuccess(
  toolId: string,
  response: ToolResponse,
  startMs: number,
  tracker: ToolHealthTracker | undefined,
  config: FeedbackLoopConfig,
): Promise<ToolResponse> {
  const latencyMs = Date.now() - startMs;

  // Gates run BEFORE health accounting — one invocation = exactly one health outcome
  if (config.toolGates !== undefined && config.toolGates.length > 0) {
    for (const gate of config.toolGates) {
      const result = await gate.validate(response);
      if (!result.valid) {
        const errors = result.errors ?? [];
        config.onGateFail?.(gate, errors);
        if (gate.countAsHealthFailure === true && tracker !== undefined) {
          tracker.recordFailure(toolId, latencyMs, `gate "${gate.name}" failed`);
          void tracker.checkAndQuarantine(toolId);
          void tracker.checkAndDemote(toolId);
        }
        throw KoiRuntimeError.from(
          "VALIDATION",
          `Gate "${gate.name}" rejected the tool response: ${errors.map((e) => e.message).join("; ")}`,
        );
      }
    }
  }

  if (tracker !== undefined) {
    // Pre-execution VALIDATION rejects: the tool body never ran.
    // Skip both recordSuccess (would inflate success rate) and
    // recordFailure (would quarantine a healthy tool). F108 regression.
    if (isInBandValidationError(response.output)) {
      return response;
    }
    // Classify in-band `{ error, code }` payloads as failures so
    // health metrics, quarantine, and forge-demand stay consistent
    // for the same call. F103 regression.
    if (isInBandToolError(response.output)) {
      const errMsg = (response.output as { readonly error: string }).error;
      tracker.recordFailure(toolId, latencyMs, errMsg);
    } else {
      tracker.recordSuccess(toolId, latencyMs);
    }
    // Fire-and-forget: health I/O must not turn a successful tool call into a failure
    void tracker.checkAndQuarantine(toolId);
    void tracker.checkAndDemote(toolId);
  }

  return response;
}

function handleToolError(
  toolId: string,
  err: unknown,
  startMs: number,
  tracker: ToolHealthTracker | undefined,
): never {
  const latencyMs = Date.now() - startMs;

  if (tracker !== undefined) {
    tracker.recordFailure(toolId, latencyMs, String(err));
    // checkAndQuarantine/checkAndDemote are fire-and-forget here; errors surface via onHealthTransitionError
    void tracker.checkAndQuarantine(toolId);
    void tracker.checkAndDemote(toolId);
  }

  throw err;
}

/**
 * Creates a middleware that validates model responses and tracks tool health.
 *
 * - Model calls: runs validators + gates with automatic retry on validation failure.
 * - Tool calls: checks quarantine status, records health metrics, runs tool gates.
 * - Session lifecycle: creates/disposes a ToolHealthTracker when forgeHealth is configured.
 */
export function createFeedbackLoopMiddleware(config: FeedbackLoopConfig): FeedbackLoopMiddleware {
  // Per-session tracker map: keyed by sessionId to isolate concurrent sessions
  const trackers = new Map<string, ToolHealthTracker>();
  // SessionContext → sessionId binding established at onSessionStart.
  // The exposed healthHandle resolves snapshots through this binding so
  // an in-process consumer who obtained the handle cannot enumerate
  // snapshots for guessed/known sessionIds — only for SessionContext
  // objects this middleware has actually observed. F99 regression.
  const observedSessions = new WeakMap<SessionContext, string>();

  const healthHandle: FeedbackLoopHealthHandle | undefined =
    config.forgeHealth !== undefined
      ? {
          getSnapshot: (
            session: SessionContext,
            toolId: string,
          ): L0ToolHealthSnapshot | undefined => {
            const sid = observedSessions.get(session);
            if (sid === undefined) return undefined;
            return trackers.get(sid)?.getL0Snapshot(toolId);
          },
        }
      : undefined;

  return {
    name: "feedback-loop",
    ...(healthHandle !== undefined ? { healthHandle } : {}),
    priority: 450,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      // Bind the SessionContext to the sessionId observed at start.
      // Every subsequent tracker read/write/teardown resolves through
      // this binding, NOT through ctx.session.sessionId — a host that
      // mutates that field after start cannot redirect tracker writes
      // into another session's bucket. F100 regression.
      observedSessions.set(ctx, ctx.sessionId);
      if (config.forgeHealth !== undefined) {
        trackers.set(ctx.sessionId, createToolHealthTracker(config.forgeHealth));
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // Resolve teardown via the bound id ONLY. A fabricated context
      // (or one whose sessionId was mutated post-start) cannot dispose
      // another tenant's tracker. F100 regression.
      const sid = observedSessions.get(ctx);
      if (sid === undefined) return;
      const tracker = trackers.get(sid);
      if (tracker !== undefined) {
        trackers.delete(sid);
        await tracker.dispose();
      }
      observedSessions.delete(ctx);
    },

    async wrapModelCall(
      _ctx: ModelCallCtx,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (!hasModelChecks(config) && !hasTransportRetry(config)) {
        return next(request);
      }

      return runWithRetry(request, next, {
        validators: config.validators ?? [],
        gates: config.gates ?? [],
        repairStrategy: config.repairStrategy ?? defaultRepairStrategy,
        validationMaxAttempts:
          config.retry?.validation?.maxAttempts ?? VALIDATION_DEFAULT_MAX_ATTEMPTS,
        transportMaxAttempts:
          config.retry?.transport?.maxAttempts ?? TRANSPORT_DEFAULT_MAX_ATTEMPTS,
        onRetry: config.onRetry,
        onGateFail: config.onGateFail,
      });
    },

    // When model validators/gates are configured, streams are buffered to completion
    // before validation. The done chunk carries the full ModelResponse; validation runs
    // on it exactly as in wrapModelCall. On validation retry, the stream is re-run.
    // Transport-only config and no-check config: pass through without buffering.
    async *wrapModelStream(
      _ctx: ModelCallCtx,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (!hasModelChecks(config) && !hasTransportRetry(config)) {
        yield* next(request);
        return;
      }

      // Adapt stream handler to ModelHandler: buffer chunks, return done.response.
      // lastChunks tracks the most recent stream so we can re-yield after validation.
      let lastChunks: readonly ModelChunk[] = [];

      const streamAsModel: ModelHandler = async (req: ModelRequest): Promise<ModelResponse> => {
        const chunks: ModelChunk[] = [];
        for await (const chunk of next(req)) {
          chunks.push(chunk);
          if (chunk.kind === "error") {
            lastChunks = chunks;
            throw Object.assign(new Error(chunk.message), {
              cause: { code: "TRANSPORT_ERROR", retryable: chunk.retryable ?? false },
            });
          }
          if (chunk.kind === "done") {
            lastChunks = chunks;
            return chunk.response;
          }
        }
        throw Object.assign(new Error("Stream ended without done chunk"), {
          cause: { code: "TRANSPORT_ERROR", retryable: false },
        });
      };

      try {
        await runWithRetry(request, streamAsModel, {
          validators: config.validators ?? [],
          gates: config.gates ?? [],
          repairStrategy: config.repairStrategy ?? defaultRepairStrategy,
          validationMaxAttempts:
            config.retry?.validation?.maxAttempts ?? VALIDATION_DEFAULT_MAX_ATTEMPTS,
          transportMaxAttempts:
            config.retry?.transport?.maxAttempts ?? TRANSPORT_DEFAULT_MAX_ATTEMPTS,
          onRetry: config.onRetry,
          onGateFail: config.onGateFail,
        });
      } catch (err) {
        yield { kind: "error", message: String(err), retryable: false };
        return;
      }

      // Validation passed — re-yield the final stream's chunks
      yield* lastChunks;
    },

    async wrapToolCall(
      ctx: ToolCallCtx,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!hasToolChecks(config)) {
        return next(request);
      }

      // Resolve the tracker via the bound id, not ctx.session.sessionId,
      // so a mutated sessionId cannot redirect tool-call writes into
      // another session's tracker. F100 regression.
      const sid = observedSessions.get(ctx.session) ?? ctx.session.sessionId;
      const tracker = trackers.get(sid);
      if (tracker !== undefined && (await tracker.isQuarantined(request.toolId))) {
        const feedback: ForgeToolErrorFeedback = {
          kind: "forge_tool_quarantined",
          brickId: config.forgeHealth?.resolveBrickId(request.toolId),
          toolId: request.toolId,
          message: `Tool "${request.toolId}" is quarantined and cannot execute.`,
        };
        return { output: feedback };
      }

      // Pre-execution validation — fail closed before any side effects
      if (config.toolValidators !== undefined && config.toolValidators.length > 0) {
        const validationErrors: string[] = [];
        for (const validator of config.toolValidators) {
          const result = await validator.validate(request);
          if (!result.valid) {
            for (const e of result.errors ?? []) {
              validationErrors.push(`[${validator.name}] ${e.message}`);
            }
          }
        }
        if (validationErrors.length > 0) {
          throw KoiRuntimeError.from(
            "VALIDATION",
            `Tool request validation failed for "${request.toolId}": ${validationErrors.join("; ")}`,
          );
        }
      }

      const startMs = Date.now();
      // Only wrap next() — gate throws from handleToolSuccess must not go through handleToolError
      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (err: unknown) {
        return handleToolError(request.toolId, err, startMs, tracker);
      }
      return handleToolSuccess(request.toolId, response, startMs, tracker, config);
    },
  };
}
