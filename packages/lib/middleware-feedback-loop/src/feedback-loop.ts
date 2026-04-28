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
  // Stable admission tokens — `sessionId|runId` strings registered at
  // onSessionStart, dropped at onSessionEnd. wrapToolCall admits any
  // SessionContext carrying a registered tuple so hosts that proxy or
  // rebuild SessionContext between calls (with the same engine-issued
  // sessionId+runId) are not hard-failed. F118. Object identity stays
  // the security boundary for `healthHandle.getSnapshot` (F99).
  const admittedTokens = new Set<string>();
  const tokenFor = (s: SessionContext): string => `${s.sessionId}|${s.runId}`;
  // Map ctx → original token at admission time so teardown can revoke
  // the SAME token even if `ctx.session.sessionId`/`runId` is mutated
  // after admission (would otherwise leak the original token). F120.
  const originalTokenByCtx = new WeakMap<SessionContext, string>();
  // Map admission token → bound sessionId so onSessionEnd can resolve
  // tracker cleanup from a rebuilt SessionContext (different JS
  // object, same admission token). Without this, teardown on a
  // rebuilt context would no-op and leak tracker state. F120.
  const sidByToken = new Map<string, string>();

  const healthHandle: FeedbackLoopHealthHandle | undefined =
    config.forgeHealth !== undefined
      ? {
          getSnapshot: (
            session: SessionContext,
            toolId: string,
          ): L0ToolHealthSnapshot | undefined => {
            // Read-only snapshot resolves via the same admission table
            // that gates wrapToolCall (F118 token admission). A rebuilt /
            // proxied SessionContext carrying a registered
            // (sessionId, runId) tuple gets the same view as the original
            // engine-issued object — otherwise auto-wired
            // performance_degradation in forge-demand silently never
            // fires for hosts that proxy SessionContext (F125). The
            // forged-id surface (F99) is still closed: an attacker would
            // need a matching engine-issued runId to forge a token.
            const direct = observedSessions.get(session);
            if (direct !== undefined) return trackers.get(direct)?.getL0Snapshot(toolId);
            const token = originalTokenByCtx.get(session) ?? tokenFor(session);
            if (!admittedTokens.has(token)) return undefined;
            const sid = sidByToken.get(token);
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
      // F122: clear any stale per-ctx admission state from a prior
      // logical session that was torn down via a rebuilt-context
      // alias. Without this, wrap* would prefer the dead token in
      // `originalTokenByCtx` over the freshly-admitted one and
      // hard-reject every tool call on the reused object.
      const previousToken = originalTokenByCtx.get(ctx);
      if (previousToken !== undefined && !admittedTokens.has(previousToken)) {
        originalTokenByCtx.delete(ctx);
        observedSessions.delete(ctx);
      }
      if (!observedSessions.has(ctx)) {
        observedSessions.set(ctx, ctx.sessionId);
      }
      // Capture the token AT admission time so teardown revokes the
      // same one even if sessionId/runId mutate later. F120. Only set
      // when no live admission exists for THIS SessionContext object:
      // a second onSessionStart on an already-admitted object after a
      // sessionId/runId mutation must NOT rebrand the admission to a
      // different tenant (F90).
      if (originalTokenByCtx.get(ctx) === undefined) {
        const token = tokenFor(ctx);
        originalTokenByCtx.set(ctx, token);
        admittedTokens.add(token);
        sidByToken.set(token, ctx.sessionId);
      }
      if (config.forgeHealth !== undefined) {
        trackers.set(ctx.sessionId, createToolHealthTracker(config.forgeHealth));
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // Resolve teardown via the SAME admission token that admission
      // used. Three sources, in priority order:
      //   1. Token captured at admission time on THIS exact
      //      SessionContext object (F120) — survives later mutation.
      //   2. `tokenFor(ctx)` if it is still in admittedTokens —
      //      handles a rebuilt SessionContext object.
      //   3. Legacy WeakMap binding (F100) for older callers.
      // A fabricated context (or one whose sessionId was mutated
      // post-start) cannot dispose another tenant's tracker because
      // (1) wins for legitimately-admitted contexts and (2)/(3)
      // require the attacker to know the engine-issued runId.
      // F128: teardown is authorized by object identity ONLY. The
      // earlier `tokenFor(ctx)` fallback let any caller knowing a
      // (sessionId, runId) tuple dispose another session's tracker —
      // wiping quarantine, demotion, and failure history. Require
      // the original engine-issued ctx (captured at onSessionStart
      // in `originalTokenByCtx`); otherwise teardown is a no-op.
      const originalToken = originalTokenByCtx.get(ctx);
      const resolvedToken =
        originalToken !== undefined && admittedTokens.has(originalToken)
          ? originalToken
          : undefined;
      const sid =
        resolvedToken !== undefined ? sidByToken.get(resolvedToken) : observedSessions.get(ctx);
      if (sid === undefined) return;
      const tracker = trackers.get(sid);
      if (tracker !== undefined) {
        trackers.delete(sid);
        await tracker.dispose();
      }
      observedSessions.delete(ctx);
      originalTokenByCtx.delete(ctx);
      if (resolvedToken !== undefined) {
        admittedTokens.delete(resolvedToken);
        sidByToken.delete(resolvedToken);
      }
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

      // Admit by stable `sessionId|runId` token registered at
      // onSessionStart. Hosts that proxy or rebuild SessionContext
      // between calls (with the same engine-issued ids) are accepted —
      // requiring exact JS-object identity would hard-fail every tool
      // call for them. F118 widens admission. The cross-session
      // tracker-poisoning concern (F100/F111) is unchanged: tracker
      // resolution still keys on the bound `sessionId` field, which
      // came from `onSessionStart` and is not influenced by a later
      // mutation of `ctx.session.sessionId`.
      //
      // Scope: only when `forgeHealth` is configured does this admit
      // gate matter — `toolValidators` and `toolGates` are stateless
      // per-request and run on any context. F116.
      // Trust is sourced from `admittedTokens` only, so onSessionEnd
      // actually revokes access (F120). Use the ORIGINAL token (set
      // at admission time) for sessions admitted via this exact JS
      // object — that survives later mutation of sessionId/runId
      // (F100). Otherwise fall back to the current token to admit a
      // proxied / rebuilt SessionContext (F118).
      const admissionToken = originalTokenByCtx.get(ctx.session) ?? tokenFor(ctx.session);
      const tokenAdmitted = admittedTokens.has(admissionToken);
      if (config.forgeHealth !== undefined && !tokenAdmitted) {
        throw KoiRuntimeError.from(
          "VALIDATION",
          "feedback-loop wrapToolCall received traffic for an unobserved session — " +
            "the engine must call onSessionStart() before wrapToolCall() when " +
            "`forgeHealth` is configured (per-session tracker state requires admission).",
        );
      }
      // Resolve sid via the admitted token (mutation-proof). Empty
      // when the gate above already let traffic through unobserved
      // (no-forgeHealth path).
      const sid = tokenAdmitted ? sidByToken.get(admissionToken) : undefined;
      // F123: do NOT promote token-admitted (rebuilt/proxied) contexts
      // into the privileged `observedSessions` map — that would let a
      // caller holding a live `sessionId|runId` token call
      // `healthHandle.getSnapshot()` for another tenant's tracker.
      // observedSessions is populated ONLY from onSessionStart
      // (engine-issued object identity); wrap traffic does not promote.
      const tracker = sid !== undefined ? trackers.get(sid) : undefined;
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
