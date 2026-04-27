/**
 * wrapToolCall factory for the permissions middleware.
 *
 * Extracted from middleware.ts to keep file sizes under 800 lines.
 * Accepts all closure dependencies as explicit factory parameters.
 */

import type { CommandSpec } from "@koi/bash-ast";
import { classifyCommand, UNSAFE_PREFIX } from "@koi/bash-classifier";
import type { AuditSink } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { ToolHandler, ToolRequest, ToolResponse, TurnContext } from "@koi/core/middleware";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import { KoiRuntimeError } from "@koi/errors";
import { evaluateSpecGuard } from "./bash-spec-guard.js";
import type { PermissionsMiddlewareConfig } from "./config.js";
import { DEFAULT_SOFT_DENY_PER_TURN_CAP } from "./config.js";
import type { DenialTracker } from "./denial-tracker.js";
import {
  decisionCacheKey,
  denialSource,
  isEscalated,
  isFailClosed,
  safePreviewJson,
} from "./middleware-internals.js";
import type { SoftDenyLog } from "./soft-deny-log.js";
import type { TurnSoftDenyCounter } from "./turn-soft-deny-counter.js";

export interface WrapToolCallDeps {
  readonly config: PermissionsMiddlewareConfig;
  readonly auditSink: AuditSink | undefined;
  readonly clock: () => number;
  readonly backendSupportsDualKey: boolean;
  readonly enrichResource: (
    toolId: string,
    input: JsonObject | undefined,
  ) => { readonly policy: string; readonly grant: string };
  readonly queryForTool: (
    ctx: TurnContext,
    resource: string,
    requestMetadata?: Record<string, unknown>,
    resolvedPath?: string,
  ) => PermissionQuery;
  readonly resolveDecision: (
    query: PermissionQuery,
    sessionId: string,
  ) => Promise<PermissionDecision>;
  readonly strictestDecision: (
    plain: PermissionDecision,
    enriched: PermissionDecision,
  ) => PermissionDecision;
  readonly auditDecision: (
    ctx: TurnContext,
    resource: string,
    decision: PermissionDecision,
    durationMs: number,
    sink: AuditSink,
  ) => void;
  readonly getTracker: (sessionId: string) => DenialTracker;
  readonly getTurnSoftDenyCounter: (sessionId: string) => TurnSoftDenyCounter;
  readonly getSoftDenyLog: (sessionId: string) => SoftDenyLog;
  readonly handleAskDecision: (
    ctx: TurnContext,
    request: ToolRequest,
    resource: string,
    grantKey: string,
    next: ToolHandler,
    decision: PermissionDecision & { readonly effect: "ask" },
    dispatchApprovalOutcome?: (d: PermissionDecision) => void | Promise<void>,
  ) => Promise<ToolResponse>;
  /** Pre-built spec registry (from createSpecRegistry). */
  readonly specRegistry: ReadonlyMap<string, CommandSpec>;
  /** Whether bash-ast spec-aware enforcement is enabled. */
  readonly specGuardEnabled: boolean;
}

export function createWrapToolCall(deps: WrapToolCallDeps): {
  readonly wrapToolCall: (
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ) => Promise<ToolResponse>;
} {
  const {
    config,
    auditSink,
    clock,
    backendSupportsDualKey,
    enrichResource,
    queryForTool,
    resolveDecision,
    strictestDecision,
    auditDecision,
    getTracker,
    getTurnSoftDenyCounter,
    getSoftDenyLog,
    handleAskDecision,
    specRegistry,
    specGuardEnabled,
  } = deps;

  async function wrapToolCall(
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ): Promise<ToolResponse> {
    // `callId` is a UI/observability identifier carried on a dedicated
    // ToolRequest.callId field (NOT inside `metadata`), so it never
    // enters the backend policy query, the approval cache key, or
    // the in-flight dedup key. (#1759 review round 6)
    // Resolve file path for fs tools so permission rules can match on context.path.
    const resolvedPath = config.resolveToolPath?.(request.toolId, request.input);
    const { policy: enrichedResource, grant: grantKey } = enrichResource(
      request.toolId,
      request.input,
    );
    const enrichedQuery = queryForTool(ctx, enrichedResource, request.metadata, resolvedPath);
    const startMs = clock();
    // Dual-key evaluation: when the enriched resource differs from
    // the plain tool id, consult the backend for BOTH and take the
    // stricter decision. The "effective" resource/query carries
    // forward whichever side won so denial tracking, soft-deny
    // caps, and audit records aggregate under the right bucket —
    // a plain `deny: bash` must aggregate across all subcommand
    // variants, not fragment into per-prefix buckets.
    // `resource` is the observable identity — used for audit,
    // reportDecision, and approval-step payloads. It stays on the
    // enriched form so per-command governance is visible even
    // when a legacy plain-tool rule ultimately produced the
    // decision.
    //
    // `trackingResource` is the denial-tracker + soft-deny bucket.
    // When a plain-tool deny wins, it aggregates subcommand
    // variants under the plain id so retry caps and escalation
    // fire consistently. When the enriched decision wins it uses
    // the enriched resource for per-prefix fidelity.
    // Dual-key merge (marker-aware backends): issue both enriched and
    // plain queries, merge via `strictestDecision`. Unmarked
    // fall-through denies on one key yield to an explicit allow/ask
    // on the other, preserving legacy plain-tool rules while
    // honoring per-prefix policy.
    //
    // Single-key fallback (legacy backends without the marker flag):
    // use only the plain tool id. Safe — avoids hard-denying via
    // unmarked fall-through. Construction emitted a warning so
    // operators know enrichment isn't enforced.
    let resource = enrichedResource;
    let trackingResource = enrichedResource;
    let query = enrichedQuery;
    let decision: PermissionDecision;
    if (!backendSupportsDualKey && enrichedResource !== request.toolId) {
      const plainQuery = queryForTool(ctx, request.toolId, request.metadata, resolvedPath);
      query = plainQuery;
      trackingResource = request.toolId;
      decision = await resolveDecision(query, ctx.session.sessionId as string);
    } else {
      decision = await resolveDecision(query, ctx.session.sessionId as string);
      if (enrichedResource !== request.toolId) {
        const plainQuery = queryForTool(ctx, request.toolId, request.metadata, resolvedPath);
        const plain = await resolveDecision(plainQuery, ctx.session.sessionId as string);
        const combined = strictestDecision(plain, decision);
        if (combined === plain) {
          trackingResource = request.toolId;
          query = plainQuery;
        }
        decision = combined;
      }
    }
    // Structural-complexity ratchet: `!complex` covers compound
    // commands, redirections, subshells, command substitution, env
    // -S, and anything canonicalPrefix could not safely reduce. A
    // broad `allow: bash:*` must NOT silently authorize these —
    // they can hide side effects or nested dangerous payloads.
    //
    // But operators who INTENTIONALLY whitelist compound forms
    // (`allow: ["bash:!complex*"]`) should be honored. Disambiguate
    // by probing with a nonsense resource that a wildcard would
    // still match but an explicit `bash:!complex*` rule would not.
    // If the probe also allows, the original allow came from a
    // wildcard — ratchet to ask. If the probe denies, the operator
    // has an explicit `!complex` rule — honor it.
    if (
      decision.effect === "allow" &&
      enrichedResource !== request.toolId &&
      enrichedResource === `${request.toolId}:${UNSAFE_PREFIX}`
    ) {
      // Probe under the PLAIN tool id so ONLY truly broad
      // wildcards like `bash:*` match it. Narrower rules
      // (`bash:!complex*`, `bash:sudo*`, `bash:python*`) do not
      // match this probe shape, so operators who explicitly
      // whitelist specific prefixes are honored.
      const probeQuery = queryForTool(
        ctx,
        `${request.toolId}:__broad_wildcard_probe__`,
        request.metadata,
        resolvedPath,
      );
      const probe = await resolveDecision(probeQuery, ctx.session.sessionId as string);
      const fromWildcard = probe.effect === "allow";
      if (fromWildcard) {
        decision = {
          effect: "ask",
          reason: "complex/unparseable shell form requires review",
        };
      }
    }
    // Dangerous-command ratchet: if the raw command matches ANY
    // DANGEROUS_PATTERN and the combined decision is "allow",
    // upgrade to "ask" so a human reviews it. Broad allow rules
    // like `allow: bash:*` cannot silently authorize
    // structural-danger forms.
    //
    // BUT: operators who explicitly allow a dangerous prefix
    // (e.g. `allow: bash:sudo`, `allow: bash:python*`,
    // `allow: bash:chmod*`) have opted in deliberately — typically
    // for headless/non-interactive automation. Probe under the
    // plain tool id so ONLY truly broad wildcards match the probe.
    if (decision.effect === "allow" && config.resolveBashCommand !== undefined) {
      const raw = config.resolveBashCommand(request.toolId, request.input);
      if (raw !== undefined && raw.trim().length > 0) {
        const danger = classifyCommand(raw.trim());
        if (danger.severity !== null) {
          const probeQuery = queryForTool(
            ctx,
            `${request.toolId}:__broad_wildcard_probe__`,
            request.metadata,
            resolvedPath,
          );
          const probe = await resolveDecision(probeQuery, ctx.session.sessionId as string);
          const fromWildcard = probe.effect === "allow";
          if (fromWildcard) {
            const categories = Array.from(new Set(danger.matchedPatterns.map((p) => p.category)));
            decision = {
              effect: "ask",
              reason: `dangerous command pattern matched (${categories.join(", ")})`,
            };
          }
        }
      }
    }
    // Bash spec guard: evaluate Write/Read/Network rules + exact-argv enforcement.
    // Runs after the dangerous-command ratchet so that any further downgrade
    // (deny/ask) from semantic rules is respected on top of prefix policy.
    if (specGuardEnabled && decision.effect !== "deny") {
      const raw = config.resolveBashCommand?.(request.toolId, request.input);
      if (raw !== undefined && raw.trim().length > 0) {
        const specOutcome = await evaluateSpecGuard({
          toolId: request.toolId,
          rawCommand: raw,
          currentDecision: decision,
          resolveQuery: (q) => resolveDecision(q, ctx.session.sessionId as string),
          baseQuery: enrichedQuery,
          registry: specRegistry,
          backendSupportsDualKey,
        });
        if (specOutcome.kind === "spec-evaluated") {
          decision = specOutcome.decision;
          if (decision.effect !== "allow") {
            // Audit/report uses the exact argv so incident response can see
            // precisely what was blocked (e.g. `bash:rm /etc/passwd`, not `bash:rm`).
            const exactResource = `${request.toolId}:${raw.trim()}`;
            query = queryForTool(ctx, exactResource, request.metadata, resolvedPath);
            resource = exactResource;
            // Enforcement bookkeeping (soft-deny caps, escalation) uses the
            // prefix-level enrichedResource (e.g. `bash:ssh`) rather than exact argv
            // or fragile whitespace-split command names. enrichedResource is already
            // produced by bash-classifier which handles env assignments, quoted args,
            // and other shell syntax correctly — reuse it here to aggregate all argv
            // variants of the same command under one denial bucket.
            trackingResource = enrichedResource;
          }
        }
      }
    }

    const durationMs = clock() - startMs;

    // Non-deny paths: audit + dispatch here. Deny paths handle their own
    // audit, dispatch, and report inside the deny branch (Task 10 of #1650)
    // so that soft vs hard-converted decisions use the correct final decision object.
    if (decision.effect !== "deny") {
      if (auditSink !== undefined) {
        auditDecision(ctx, resource, decision, durationMs, auditSink);
      }
      void ctx.dispatchPermissionDecision?.(query, decision);
      ctx.reportDecision?.({
        phase: "execute",
        toolId: request.toolId,
        resource,
        toolInput: safePreviewJson(request.input, 300),
        action: decision.effect,
        durationMs,
        ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
        source: denialSource(decision),
      });
    }

    if (decision.effect === "deny") {
      const source = denialSource(decision);
      const disposition = decision.disposition ?? "hard";

      const isSoftCandidate =
        disposition === "soft" &&
        source !== "approval" &&
        !isFailClosed(decision) &&
        !isEscalated(decision); // IS_CACHED does NOT set IS_ESCALATED — cached replays stay soft-eligible

      const sessionId = ctx.session.sessionId as string;

      type DenyDecision = Extract<PermissionDecision, { readonly effect: "deny" }>;

      const hardConvertedDecision = (suffix: string): DenyDecision => ({
        ...decision,
        disposition: "hard" as const,
        reason: `${decision.reason} (${suffix})`,
      });

      const emitDenyAudit = async (finalDecision: DenyDecision): Promise<void> => {
        if (auditSink !== undefined) {
          auditDecision(ctx, resource, finalDecision, durationMs, auditSink);
        }
        void ctx.dispatchPermissionDecision?.(query, finalDecision);
        ctx.reportDecision?.({
          phase: "execute",
          toolId: request.toolId,
          resource,
          toolInput: safePreviewJson(request.input, 300),
          action: "deny",
          durationMs,
          reason: finalDecision.reason,
          source: denialSource(finalDecision),
        });
      };

      if (isSoftCandidate) {
        const cacheKey = decisionCacheKey(query);

        if (cacheKey === undefined) {
          // Unkeyable context — cannot scope the soft-deny counter safely → fail closed.
          const hardened = hardConvertedDecision("unkeyable context — failing closed");
          getTracker(sessionId).record({
            toolId: trackingResource,
            reason: decision.reason,
            timestamp: clock(),
            principal: ctx.session.agentId,
            turnIndex: ctx.turnIndex,
            source,
            queryKey: undefined,
            softness: "hard",
            origin: "soft-conversion",
          });
          await emitDenyAudit(hardened);
          throw new KoiRuntimeError({
            code: "PERMISSION",
            message: hardened.reason,
            retryable: false,
          });
        }

        // Per-turn cap check. Prefix the counter key with turnIndex so
        // overlapping turns in the same session cannot reset or share each
        // other's budget. Loop round-5 fix.
        const cap = config.softDenyPerTurnCap ?? DEFAULT_SOFT_DENY_PER_TURN_CAP;
        const counter = getTurnSoftDenyCounter(sessionId);
        const turnScopedKey = `${ctx.turnIndex}\0${cacheKey}`;
        if (counter.countAndCap(turnScopedKey, cap) === "over_cap") {
          const hardened = hardConvertedDecision(`soft-deny retry cap ${cap} exceeded this turn`);
          getTracker(sessionId).record({
            toolId: trackingResource,
            reason: decision.reason,
            timestamp: clock(),
            principal: ctx.session.agentId,
            turnIndex: ctx.turnIndex,
            source,
            queryKey: cacheKey,
            softness: "hard",
            origin: "soft-conversion",
          });
          await emitDenyAudit(hardened);
          throw new KoiRuntimeError({
            code: "PERMISSION",
            message: hardened.reason,
            retryable: false,
          });
        }

        // Soft path: record in isolated SoftDenyLog (NOT DenialTracker).
        getSoftDenyLog(sessionId).record({
          toolId: trackingResource,
          reason: decision.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          queryKey: cacheKey,
        });
        await emitDenyAudit(decision);
        // Trust-boundary: output contains only toolId, never decision.reason.
        // `blockedByHook: true` is the canonical downstream marker honored
        // by event-trace, middleware-report, and session-transcript to
        // classify this response as a non-execution rather than a successful
        // tool call. Loop round-10 fix.
        // `permissionDenied: true` is the specific signal for #1650 soft-deny.
        return {
          output: `Permission denied for tool "${request.toolId}". This tool is not available in the current scope.`,
          metadata: {
            isError: true,
            blockedByHook: true,
            permissionDenied: true,
            hookName: "permissions",
            toolId: request.toolId,
          },
        };
      }

      // Native hard path: record with origin: "native", dispatch original decision, throw.
      getTracker(sessionId).record({
        toolId: trackingResource,
        reason: decision.reason,
        timestamp: clock(),
        principal: ctx.session.agentId,
        turnIndex: ctx.turnIndex,
        source,
        queryKey: decisionCacheKey(query),
        softness: "hard",
        origin: "native",
      });
      await emitDenyAudit(decision);
      throw new KoiRuntimeError({
        code: "PERMISSION",
        message: decision.reason,
        retryable: false,
      });
    }

    if (decision.effect === "ask") {
      // Pass a dispatch callback so each approval path fires the outcome
      // BEFORE calling next(request) — ensures recording even if the tool throws.
      // Awaited here (not fire-and-forget): ask approvals can persist reusable
      // grants and execute the tool; we want the audit record durable first.
      return handleAskDecision(ctx, request, resource, grantKey, next, decision, async (d) => {
        await ctx.dispatchPermissionDecision?.(query, d);
      });
    }

    // allow
    return next(request);
  }

  return { wrapToolCall };
}
