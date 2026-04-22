/**
 * handleAskDecision factory for the permissions middleware.
 *
 * Extracted from middleware.ts to keep file sizes under 800 lines.
 * Accepts all closure dependencies as explicit factory parameters.
 */

import { classifyCommand, UNSAFE_PREFIX } from "@koi/bash-classifier";
import type { AuditSink } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { ToolHandler, ToolRequest, ToolResponse, TurnContext } from "@koi/core/middleware";
import type { PermissionDecision } from "@koi/core/permission-backend";
import { KoiRuntimeError } from "@koi/errors";
import type { ApprovalStore } from "./approval-store.js";
import type { PermissionsMiddlewareConfig } from "./config.js";
import type { DenialTracker } from "./denial-tracker.js";
import { validateApprovalDecision } from "./middleware-internals.js";

// Re-declare locally to avoid repeating the return type everywhere
type ValidatedApproval =
  | { readonly kind: "allow" }
  | { readonly kind: "always-allow"; readonly scope: "session" | "always" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "modify"; readonly updatedInput: Record<string, unknown> };

type ApprovalCacheHandle = {
  readonly has: (key: string) => boolean;
  readonly set: (key: string) => void;
  readonly clear: () => void;
};

export interface HandleAskDecisionDeps {
  readonly config: PermissionsMiddlewareConfig;
  readonly auditSink: AuditSink | undefined;
  readonly clock: () => number;
  readonly approvalTimeoutMs: number;
  readonly persistentStore: ApprovalStore | undefined;
  readonly persistentAgentId: string | undefined;
  readonly backendFingerprint: string;
  readonly inflightApprovals: Map<string, Promise<unknown>>;
  readonly inflightKeysBySession: Map<string, Set<string>>;
  readonly alwaysAllowedBySession: Map<string, Set<string>>;
  readonly getTracker: (sessionId: string) => DenialTracker;
  readonly getApprovalCache: (sessionId: string) => ApprovalCacheHandle | undefined;
  readonly emitApprovalStep: (
    ctx: TurnContext,
    toolId: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    startMs: number,
    coalesced?: boolean,
  ) => void;
  readonly auditApprovalOutcome: (
    ctx: TurnContext,
    resource: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    durationMs: number,
    sink: AuditSink,
    coalesced?: boolean,
    remembered?: boolean,
  ) => void;
  readonly computeApprovalCacheKey: (
    backendFingerprint: string,
    sessionId: string,
    userId: string,
    agentId: string,
    toolId: string,
    input: unknown,
    context: string | undefined,
    requestMeta: unknown,
    approvalReason: string,
    grantKey: string,
  ) => string | undefined;
  readonly serializeTurnContext: (ctx: TurnContext) => string | undefined;
}

export function createHandleAskDecision(deps: HandleAskDecisionDeps): {
  readonly handleAskDecision: (
    ctx: TurnContext,
    request: ToolRequest,
    resource: string,
    grantKey: string,
    next: ToolHandler,
    decision: PermissionDecision & { readonly effect: "ask" },
    dispatchApprovalOutcome?: (d: PermissionDecision) => void,
  ) => Promise<ToolResponse>;
} {
  const {
    config,
    auditSink,
    clock,
    approvalTimeoutMs,
    persistentStore,
    persistentAgentId,
    backendFingerprint,
    inflightApprovals,
    inflightKeysBySession,
    alwaysAllowedBySession,
    getTracker,
    getApprovalCache,
    emitApprovalStep,
    auditApprovalOutcome,
    computeApprovalCacheKey,
    serializeTurnContext,
  } = deps;

  async function handleAskDecision(
    ctx: TurnContext,
    request: ToolRequest,
    resource: string,
    grantKey: string,
    next: ToolHandler,
    decision: PermissionDecision & { readonly effect: "ask" },
    dispatchApprovalOutcome?: (d: PermissionDecision) => void,
  ): Promise<ToolResponse> {
    const approvalHandler = ctx.requestApproval;

    if (approvalHandler === undefined) {
      throw new KoiRuntimeError({
        code: "PERMISSION",
        message: `Tool "${request.toolId}" requires approval but no approval handler is configured`,
        retryable: false,
      });
    }

    // Check persistent always-allow grants (cross-session, SQLite-backed).
    // Fail-open: if the store throws (corrupt DB, lock contention), fall through
    // to the session check and ultimately to the user prompt. This is fail-safe —
    // a broken store means more prompts, not silent denials or silent allows.
    // Persistent grants require a real user identity — anonymous sessions
    // must not share a durable principal, so we skip the store entirely.
    // Use persistentAgentId if configured (stable across restarts) — falls back
    // to the per-process agentId for multi-agent runtimes.
    const persistentUserId = ctx.session.userId;
    const persistentAid = persistentAgentId ?? ctx.session.agentId;
    if (persistentStore !== undefined && persistentUserId !== undefined) {
      try {
        // Key persistent grants by `grantKey` (exact-command hash) so
        // approving `bash:git status` does not auto-approve the stricter
        // `bash:git status --short` or the materially different
        // `bash:git push --force`. Distinct argv → distinct hash → fresh
        // prompt.
        //
        // Legacy fallback is OFF by default: a blanket `bash` grant
        // stored before prefix enrichment must not retroactively
        // authorize newly-scoped commands. Operators migrating from
        // pre-enrichment deployments can opt in via
        // `legacyBashGrantFallback: true` to preserve existing grants
        // during a rollout window. Even with the flag, `!complex`
        // structural forms and dangerous-pattern matches always force
        // a fresh approval.
        const hasExact = persistentStore.has(persistentUserId, persistentAid, grantKey);
        let hasLegacy = false;
        if (
          !hasExact &&
          config.legacyBashGrantFallback === true &&
          grantKey !== request.toolId &&
          persistentStore.has(persistentUserId, persistentAid, request.toolId)
        ) {
          const rawForLegacy = config.resolveBashCommand?.(request.toolId, request.input) ?? "";
          const isComplexForm = resource === `${request.toolId}:${UNSAFE_PREFIX}`;
          const isDangerous =
            rawForLegacy.trim().length > 0 &&
            classifyCommand(rawForLegacy.trim()).severity !== null;
          hasLegacy = !isComplexForm && !isDangerous;
        }
        if (hasExact || hasLegacy) {
          const persistentStartMs = clock();
          getTracker(ctx.session.sessionId as string).record({
            toolId: resource,
            reason: `auto-approved (persistent always-allow grant, agent: ${ctx.session.agentId})`,
            timestamp: persistentStartMs,
            principal: ctx.session.agentId,
            turnIndex: ctx.turnIndex,
            source: "approval",
          });
          emitApprovalStep(
            ctx,
            request.toolId,
            { kind: "always-allow", scope: "always" },
            request.input,
            persistentStartMs,
          );
          if (auditSink !== undefined) {
            auditApprovalOutcome(
              ctx,
              resource,
              { kind: "always-allow", scope: "always" },
              request.input,
              clock() - persistentStartMs,
              auditSink,
              /* coalesced */ false,
              /* remembered */ true,
            );
          }
          // Dispatch before next() so the permission outcome is recorded even if the tool throws
          dispatchApprovalOutcome?.({ effect: "allow" });
          return next(request);
        }
      } catch {
        // Fall through to session/cache/prompt — fail-open.
      }
    }

    // Check always-allowed set (from prior "always-allow" decisions).
    // Session bypass is keyed by agentId + grantKey (exact-command
    // hash). A user's "a" press approves THIS command + argv, not every
    // later invocation of the same prefix. When enrichment is off,
    // grantKey falls back to the plain tool id, preserving the original
    // one-approve-per-tool behavior.
    const alwaysAllowKey = `${ctx.session.agentId}\0${grantKey}`;
    const sessionAlwaysAllowed = alwaysAllowedBySession.get(ctx.session.sessionId as string);
    if (sessionAlwaysAllowed?.has(alwaysAllowKey)) {
      const alwaysAllowStartMs = clock();
      getTracker(ctx.session.sessionId as string).record({
        toolId: resource,
        reason: `auto-approved (always-allow session rule, agent: ${ctx.session.agentId})`,
        timestamp: alwaysAllowStartMs,
        principal: ctx.session.agentId,
        turnIndex: ctx.turnIndex,
        source: "approval",
      });
      emitApprovalStep(
        ctx,
        request.toolId,
        { kind: "always-allow", scope: "session" },
        request.input,
        alwaysAllowStartMs,
      );
      // Dispatch before next() so the permission outcome is recorded even if the tool throws
      dispatchApprovalOutcome?.({ effect: "allow" });
      return next(request);
    }

    // Check approval cache (per-session)
    const approvalCache = getApprovalCache(ctx.session.sessionId as string);
    if (approvalCache !== undefined) {
      const userId = ctx.session.userId ?? "__anonymous__";
      const ctxStr = serializeTurnContext(ctx);
      const cacheKey = computeApprovalCacheKey(
        backendFingerprint,
        ctx.session.sessionId as string,
        userId,
        ctx.session.agentId,
        request.toolId,
        request.input,
        ctxStr,
        request.metadata,
        decision.reason,
        grantKey,
      );

      if (cacheKey !== undefined && approvalCache.has(cacheKey)) {
        emitApprovalStep(ctx, request.toolId, { kind: "allow" }, request.input, clock());
        // Dispatch before next() so the permission outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        return next(request);
      }
    }

    // Build dedup key for in-flight coordination
    const dedupUserId = ctx.session.userId ?? "__anonymous__";
    const dedupCtx = serializeTurnContext(ctx);
    const dedupKey = computeApprovalCacheKey(
      backendFingerprint,
      ctx.session.sessionId as string,
      dedupUserId,
      ctx.session.agentId,
      request.toolId,
      request.input,
      dedupCtx,
      request.metadata,
      decision.reason,
      grantKey,
    );

    // Coalesce concurrent identical asks onto a single pending approval
    if (dedupKey !== undefined) {
      const inflight = inflightApprovals.get(dedupKey);
      if (inflight !== undefined) {
        // Another call is already waiting for approval — wait for its result
        const coalescedStartMs = clock();
        // let: rawResult is assigned in try, used after
        let rawResult: unknown;
        try {
          rawResult = await inflight;
        } catch (e: unknown) {
          // Leader timed out or handler threw — emit failure step for this follower
          const reason =
            e instanceof KoiRuntimeError && e.code === "TIMEOUT" ? "timeout" : "handler_error";
          emitApprovalStep(
            ctx,
            request.toolId,
            { kind: "deny", reason },
            request.input,
            coalescedStartMs,
            true,
          );
          if (e instanceof KoiRuntimeError) throw e;
          throw new KoiRuntimeError({
            code: "INTERNAL",
            message: `Coalesced approval error for "${request.toolId}"`,
            retryable: false,
            cause: e,
          });
        }
        const result = validateApprovalDecision(rawResult);

        // Emit approval-outcome audit + trajectory for this coalesced caller.
        // Marked coalesced: true so downstream systems know this reused an existing
        // human decision rather than prompting a new one.
        const coalescedDurationMs = clock() - coalescedStartMs;
        if (result !== undefined && auditSink !== undefined) {
          auditApprovalOutcome(
            ctx,
            resource,
            result,
            request.input,
            coalescedDurationMs,
            auditSink,
            true,
          );
        }
        if (result !== undefined) {
          emitApprovalStep(ctx, request.toolId, result, request.input, coalescedStartMs, true);
        } else {
          // Malformed coalesced response — emit failure step so it's observable
          emitApprovalStep(
            ctx,
            request.toolId,
            { kind: "deny", reason: "malformed_response" },
            request.input,
            coalescedStartMs,
            true,
          );
        }

        if (result === undefined || result.kind === "deny") {
          dispatchApprovalOutcome?.({
            effect: "deny",
            reason: `Tool "${request.toolId}" denied (coalesced approval)`,
          });
          throw new KoiRuntimeError({
            code: "PERMISSION",
            message: `Tool "${request.toolId}" denied (coalesced approval)`,
            retryable: false,
          });
        }
        // Dispatch allow before next() so outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        if (result.kind === "modify") {
          return next({ ...request, input: result.updatedInput });
        }
        return next(request);
      }
    }

    // Request approval with timeout
    const approvalStartMs = clock();
    const ac = new AbortController();

    // When approvalTimeoutMs is Infinity (default, see #1759), the timeout
    // leg is omitted entirely — users get unbounded time to respond to
    // interactive permission prompts. Agent-to-agent callers that need a
    // hung-handler backstop should pass a finite value explicitly.
    const approvalRace: readonly Promise<unknown>[] = [
      approvalHandler({
        toolId: request.toolId,
        input: request.input,
        reason: decision.reason,
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
        // Forward the per-invocation correlation id (UI-only — never
        // touches policy or cache identity). The TUI permission bridge
        // reads this to dispatch a per-call timer reset. (#1759 round 6)
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
      }),
      ...(Number.isFinite(approvalTimeoutMs)
        ? [
            new Promise<never>((_, reject) => {
              const timerId = setTimeout(() => {
                reject(
                  new KoiRuntimeError({
                    code: "TIMEOUT",
                    message: `Approval for "${request.toolId}" timed out after ${approvalTimeoutMs}ms`,
                    retryable: false,
                  }),
                );
              }, approvalTimeoutMs);
              ac.signal.addEventListener("abort", () => clearTimeout(timerId), { once: true });
            }),
          ]
        : []),
      // Race against the turn/session abort signal so an aborted turn
      // (Ctrl+C / agent:clear) cannot win approval and execute the tool
      // in what the user now believes is a fresh session.
      ...(ctx.signal !== undefined
        ? (() => {
            // Capture signal before the Promise closure so TypeScript narrows it
            // to AbortSignal (not AbortSignal | undefined) inside the callback.
            const turnSignal = ctx.signal;
            return [
              new Promise<never>((_, reject) => {
                if (turnSignal.aborted) {
                  reject(
                    new KoiRuntimeError({
                      code: "PERMISSION",
                      message: `Approval for "${request.toolId}" cancelled: turn was aborted`,
                      retryable: false,
                    }),
                  );
                  return;
                }
                turnSignal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      new KoiRuntimeError({
                        code: "PERMISSION",
                        message: `Approval for "${request.toolId}" cancelled: turn was aborted`,
                        retryable: false,
                      }),
                    ),
                  { once: true },
                );
              }),
            ];
          })()
        : []),
    ];

    const approvalPromise = Promise.race(approvalRace).finally(() => {
      ac.abort();
      if (dedupKey !== undefined) {
        inflightApprovals.delete(dedupKey);
        // Also remove from per-session index
        inflightKeysBySession.get(ctx.session.sessionId as string)?.delete(dedupKey);
      }
    });

    // Register in-flight so concurrent callers coalesce
    if (dedupKey !== undefined) {
      inflightApprovals.set(dedupKey, approvalPromise);
      // Track under session so clearSessionApprovals can evict on reset
      const sid = ctx.session.sessionId as string;
      let keys = inflightKeysBySession.get(sid);
      if (keys === undefined) {
        keys = new Set();
        inflightKeysBySession.set(sid, keys);
      }
      keys.add(dedupKey);
    }

    // let: tracks whether an approval step was already emitted in the try block
    let stepEmitted = false;
    try {
      const rawResult = await approvalPromise;

      // Validate approval response at trust boundary — fail closed on malformed
      const approvalResult = validateApprovalDecision(rawResult);
      if (approvalResult === undefined) {
        emitApprovalStep(
          ctx,
          request.toolId,
          { kind: "deny", reason: "malformed_response" },
          request.input,
          approvalStartMs,
        );
        stepEmitted = true;
        dispatchApprovalOutcome?.({ effect: "deny", reason: "malformed_response" });
        throw new KoiRuntimeError({
          code: "PERMISSION",
          message: `Malformed approval response for "${request.toolId}" — failing closed`,
          retryable: false,
        });
      }

      // Emit second audit entry and trajectory step for the approval outcome
      const approvalDurationMs = clock() - approvalStartMs;
      if (auditSink !== undefined) {
        auditApprovalOutcome(
          ctx,
          resource,
          approvalResult,
          request.input,
          approvalDurationMs,
          auditSink,
        );
      }
      emitApprovalStep(ctx, request.toolId, approvalResult, request.input, approvalStartMs);
      stepEmitted = true;

      if (approvalResult.kind === "deny") {
        getTracker(ctx.session.sessionId as string).record({
          toolId: resource,
          reason: approvalResult.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: "approval",
        });

        dispatchApprovalOutcome?.({ effect: "deny", reason: approvalResult.reason });
        throw new KoiRuntimeError({
          code: "PERMISSION",
          message: `Tool "${request.toolId}" denied by approval handler: ${approvalResult.reason}`,
          retryable: false,
        });
      }

      // Handle "always-allow" — add to session's always-allowed set.
      // Keyed by agentId + grantKey (exact-command hash) so an approval
      // covers THIS command + argv only. A different argv of the same
      // prefix (e.g. `git push --force`) must prompt again. For scope
      // "always", also persist to durable storage (SQLite) under the
      // same exact-command grant key.
      if (approvalResult.kind === "always-allow") {
        const sid = ctx.session.sessionId as string;
        let allowed = alwaysAllowedBySession.get(sid);
        if (allowed === undefined) {
          allowed = new Set();
          alwaysAllowedBySession.set(sid, allowed);
        }
        const sessionGrantKey = `${ctx.session.agentId}\0${grantKey}`;
        allowed.add(sessionGrantKey);

        // Persist to durable storage if scope is "always", store is configured,
        // and a real user identity exists. Anonymous sessions cannot create durable
        // grants — they silently downgrade to session scope.
        // Fail-safe: if persist throws, the tool still executes (approval was given)
        // but permanence is not recorded. The user gets re-prompted next session.
        const grantUserId = ctx.session.userId;
        const grantAgentId = persistentAgentId ?? ctx.session.agentId;
        if (
          approvalResult.scope === "always" &&
          persistentStore !== undefined &&
          grantUserId !== undefined
        ) {
          try {
            persistentStore.grant(grantUserId, grantAgentId, grantKey, clock());
          } catch {
            // Approval was given — execute the tool. Permanence just wasn't recorded.
          }
        }

        getTracker(sid).record({
          toolId: resource,
          reason: `always-allow granted (scope: ${approvalResult.scope})`,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: "approval",
        });

        // Dispatch before next() so the permission outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        return next(request);
      }

      // Handle "modify" — use updated input
      // Never cache modify results: the input rewrite is the safety mechanism,
      // and caching would replay the original unsafe input on subsequent calls
      if (approvalResult.kind === "modify") {
        // Dispatch before next() so the permission outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        return next({ ...request, input: approvalResult.updatedInput });
      }

      // Cache allow-only approvals (never modify — see above)
      if (approvalCache !== undefined) {
        const userId = ctx.session.userId ?? "__anonymous__";
        const ctxStr = serializeTurnContext(ctx);
        const cacheKey = computeApprovalCacheKey(
          backendFingerprint,
          ctx.session.sessionId as string,
          userId,
          ctx.session.agentId,
          request.toolId,
          request.input,
          ctxStr,
          request.metadata,
          decision.reason,
          grantKey,
        );
        if (cacheKey !== undefined) approvalCache.set(cacheKey);
      }

      // "allow" — dispatch before next() so outcome is recorded even if the tool throws
      dispatchApprovalOutcome?.({ effect: "allow" });
      return next(request);
    } catch (e: unknown) {
      // Emit a failure trajectory step for timeout/handler errors so they
      // are observable in ATIF even though no valid decision was received.
      // Skip if a step was already emitted (e.g., a deny that throws after emitting).
      if (!stepEmitted) {
        const reason =
          e instanceof KoiRuntimeError && e.code === "TIMEOUT" ? "timeout" : "handler_error";
        emitApprovalStep(
          ctx,
          request.toolId,
          { kind: "deny", reason },
          request.input,
          approvalStartMs,
        );
      }
      if (e instanceof KoiRuntimeError) throw e;
      throw new KoiRuntimeError({
        code: "INTERNAL",
        message: `Approval handler error for "${request.toolId}"`,
        retryable: false,
        cause: e,
      });
    }
  }

  return { handleAskDecision };
}
