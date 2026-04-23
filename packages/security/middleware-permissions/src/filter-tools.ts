/**
 * filterTools factory for the permissions middleware.
 *
 * Extracted from middleware.ts to keep file sizes under 800 lines.
 * Accepts all closure dependencies as explicit factory parameters.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import type { ModelRequest, TurnContext } from "@koi/core/middleware";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import { swallowError } from "@koi/errors";
import type { PermissionsMiddlewareConfig } from "./config.js";
import { DEFAULT_SOFT_DENY_PER_TURN_CAP } from "./config.js";
import type { DenialTracker } from "./denial-tracker.js";
import { decisionCacheKey, denialSource } from "./middleware-internals.js";
import type { SoftDenyLog } from "./soft-deny-log.js";
import type { TurnSoftDenyCounter } from "./turn-soft-deny-counter.js";

const PKG = "@koi/middleware-permissions";

export interface FilterToolsDeps {
  readonly config: PermissionsMiddlewareConfig;
  readonly auditSink: AuditSink | undefined;
  readonly clock: () => number;
  readonly filterCapRecordedKeys: Set<string>;
  readonly getTracker: (sessionId: string) => DenialTracker;
  readonly getTurnSoftDenyCounter: (sessionId: string) => TurnSoftDenyCounter;
  readonly getSoftDenyLog: (sessionId: string) => SoftDenyLog;
  readonly isFallThroughDecision: (d: PermissionDecision) => boolean;
  readonly queryForTool: (
    ctx: TurnContext,
    resource: string,
    requestMetadata?: Record<string, unknown>,
    resolvedPath?: string,
  ) => PermissionQuery;
  readonly resolveBatch: (
    queries: readonly PermissionQuery[],
    sessionId: string,
  ) => Promise<readonly PermissionDecision[]>;
}

function auditFilterDecision(
  ctx: TurnContext,
  resource: string,
  decision: PermissionDecision,
  sink: AuditSink,
  clock: () => number,
): void {
  const entry: AuditEntry = {
    schema_version: 2,
    timestamp: clock(),
    sessionId: ctx.session.sessionId as string,
    agentId: ctx.session.agentId,
    turnIndex: ctx.turnIndex,
    kind: "permission_decision",
    durationMs: 0,
    metadata: {
      permissionCheck: true,
      phase: "filter",
      resource,
      effect: decision.effect,
      ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
    },
  };
  void sink.log(entry).catch((e: unknown) => {
    swallowError(e, { package: PKG, operation: "audit" });
  });
}

export function createFilterTools(deps: FilterToolsDeps): {
  readonly filterTools: (ctx: TurnContext, request: ModelRequest) => Promise<ModelRequest>;
} {
  const {
    config,
    auditSink,
    clock,
    filterCapRecordedKeys,
    getTracker,
    getTurnSoftDenyCounter,
    getSoftDenyLog,
    isFallThroughDecision,
    queryForTool,
    resolveBatch,
  } = deps;

  async function filterTools(ctx: TurnContext, request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;
    if (tools === undefined || tools.length === 0) return request;

    // Include model request metadata so filtering uses the same policy
    // inputs as execution-time wrapToolCall (prevents visibility/auth mismatch)
    const queries = tools.map((t) => queryForTool(ctx, t.name, request.metadata));
    const decisions = await resolveBatch(queries, ctx.session.sessionId as string);

    const sessionTracker = getTracker(ctx.session.sessionId as string);

    // #1650 loop round-9: capture the FINAL enforced decision per tool so
    // reportDecision's filteredTools summary reflects what was actually
    // emitted (hardened reason for soft→hard conversions), not the
    // pre-conversion soft decision.
    const enforcedDecisionByIndex = new Map<number, PermissionDecision>();

    // Tools whose per-command policy is enforced at wrapToolCall via
    // bash prefix enrichment — keep visible at model-time so the
    // execution-time prefix rules are reachable UNLESS the operator
    // has explicitly denied the plain tool id. An explicit deny
    // (non-default-deny) on `bash` must still filter the tool out so
    // operators can turn off bash wholesale via policy.
    const bashVisibleSet = new Set(config.bashVisibleTools ?? []);
    const bypassFilter = (toolName: string, decision: PermissionDecision): boolean => {
      if (config.resolveBashCommand === undefined) return false;
      if (!bashVisibleSet.has(toolName)) return false;
      // Explicit deny overrides the visibility bypass. Default-deny
      // (no rule matches) does NOT — that's exactly the case
      // bashVisibleTools exists to accommodate.
      if (decision.effect === "deny" && !isFallThroughDecision(decision)) return false;
      return true;
    };

    const filtered = tools.filter((tool, i) => {
      // biome-ignore lint/style/noNonNullAssertion: decisions.length === tools.length (resolveBatch returns same length)
      const decision = decisions[i]!;
      // biome-ignore lint/style/noNonNullAssertion: queries built from tools.map — same length as filter callback index
      const query = queries[i]!;
      const sid = ctx.session.sessionId as string;

      if (bypassFilter(tool.name, decision)) {
        // Pass through. Record an allow decision for observability so
        // reporting/audit still see the tool was offered to the model.
        enforcedDecisionByIndex.set(i, { effect: "allow" });
        return true;
      }

      // #1650 loop round-4: audit/dispatch fire AFTER the hard-conversion
      // checks so observers see the FINAL decision shape, not the original
      // soft decision that was about to be hard-converted. Keeps audit sinks
      // consistent with what was actually enforced.
      const emit = (finalDecision: PermissionDecision): void => {
        enforcedDecisionByIndex.set(i, finalDecision);
        if (auditSink !== undefined) {
          auditFilterDecision(ctx, tool.name, finalDecision, auditSink, clock);
        }
        void ctx.dispatchPermissionDecision?.(query, finalDecision);
      };

      if (decision.effect === "deny") {
        const dispositionIsSoft = (decision.disposition ?? "hard") === "soft";
        if (dispositionIsSoft) {
          const cacheKey = decisionCacheKey(query);
          // #1650 loop round-3/4: unkeyable context → hard-convert (mirror
          // execute-time fail-closed). Record in DenialTracker with
          // origin: "soft-conversion" (same vocabulary as execute-time) so
          // observers see a consistent hard denial trail.
          if (cacheKey === undefined) {
            const hardened: PermissionDecision = {
              ...decision,
              disposition: "hard",
              reason: `${decision.reason} (unkeyable context — failing closed)`,
            };
            // #1650 loop round-9: dedup unkeyable filter-time records per
            // (session, turn, toolId). Repeated planning passes in the same
            // turn with unkeyable context would otherwise churn the 1024-entry
            // DenialTracker FIFO and evict native hard-deny history.
            const unkeyableRecordKey = `${sid}\0${ctx.turnIndex}\0unkeyable\0${tool.name}`;
            if (!filterCapRecordedKeys.has(unkeyableRecordKey)) {
              filterCapRecordedKeys.add(unkeyableRecordKey);
              sessionTracker.record({
                toolId: tool.name,
                reason: decision.reason,
                timestamp: clock(),
                principal: ctx.session.agentId,
                turnIndex: ctx.turnIndex,
                source: denialSource(decision),
                queryKey: undefined,
                softness: "hard",
                origin: "soft-conversion",
              });
            }
            emit(hardened);
            return false;
          }
          // #1650 loop round-2/6: if the soft-deny counter is ALREADY at or
          // over cap for this tool in the current turn, stop advertising the
          // tool so the model doesn't burn iterations on guaranteed-hard
          // failures.
          //
          // Trade-off (loop rounds 6→9): previously used a tool-identity
          // prefix peek to catch path-sensitive cap exhaustion, but that
          // over-stripped tools for unrelated intents (different paths) whose
          // future call would have been allowed. Reverting to exact-key peek
          // — path-sensitive cap exhaustion is invisible at planning time;
          // execute-time still enforces (hard-throws on the Nth+1 exact-key
          // deny) and the outer engine max-iterations bounds the worst case.
          // For tools WITHOUT a resolveToolPath callback, filter-time keys
          // match execute-time exactly and this check strips correctly.
          const cap = config.softDenyPerTurnCap ?? DEFAULT_SOFT_DENY_PER_TURN_CAP;
          const turnScopedKey = `${ctx.turnIndex}\0${cacheKey}`;
          const currentCount = getTurnSoftDenyCounter(sid).peek(turnScopedKey);
          if (currentCount >= cap) {
            // #1650 loop round-3: record DenialTracker ONCE per (session, turn,
            // cacheKey). Repeated planning passes in the same turn would
            // otherwise evict native hard-deny history from the bounded FIFO.
            const capRecordKey = `${sid}\0${ctx.turnIndex}\0${cacheKey}`;
            if (!filterCapRecordedKeys.has(capRecordKey)) {
              filterCapRecordedKeys.add(capRecordKey);
              sessionTracker.record({
                toolId: tool.name,
                reason: decision.reason,
                timestamp: clock(),
                principal: ctx.session.agentId,
                turnIndex: ctx.turnIndex,
                source: denialSource(decision),
                queryKey: cacheKey,
                softness: "hard",
                origin: "soft-conversion",
              });
            }
            // Always emit the hardened decision so audit/observers see the
            // final enforced shape (even if tracker dedup suppressed the
            // record-write above).
            const hardened: PermissionDecision = {
              ...decision,
              disposition: "hard",
              reason: `${decision.reason} (soft-deny retry cap ${cap} exceeded this turn)`,
            };
            emit(hardened);
            return false;
          }
          // Soft-deny → keep tool visible. Record in isolated SoftDenyLog so
          // high-volume soft denies don't evict native hard-deny history from
          // the shared DenialTracker budget. Emit the ORIGINAL soft decision
          // (this is what actually happens at planning time — the tool stays
          // visible).
          getSoftDenyLog(sid).record({
            toolId: tool.name,
            reason: decision.reason,
            timestamp: clock(),
            principal: ctx.session.agentId,
            turnIndex: ctx.turnIndex,
            queryKey: cacheKey,
          });
          emit(decision);
          return true;
        }
        // Hard-deny: existing behavior — record with softness+origin, emit, strip.
        sessionTracker.record({
          toolId: tool.name,
          reason: decision.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: denialSource(decision),
          queryKey: decisionCacheKey(query),
          softness: "hard",
          origin: "native",
        });
        emit(decision);
        return false;
      }
      // allow/ask — emit the original decision so audit/observer chain sees it.
      emit(decision);
      return true;
    });

    const filteredCount = tools.length - filtered.length;
    if (filteredCount > 0) {
      // #1650 loop round-9: prefer the enforced (possibly hardened) decision
      // captured during emit over the raw backend decision, so filteredTools
      // reflects the final reason ("unkeyable context — failing closed" /
      // "soft-deny retry cap N exceeded this turn") rather than the original
      // soft-policy reason.
      const filteredDetails = tools
        .map((t, i) => {
          const decision = enforcedDecisionByIndex.get(i) ?? decisions[i];
          return { name: t.name, decision };
        })
        .filter(
          (
            d,
          ): d is {
            readonly name: string;
            readonly decision: { readonly effect: "deny"; readonly reason: string };
          } => d.decision?.effect === "deny",
        )
        .map((d) => ({
          tool: d.name,
          reason: d.decision.reason,
          source: denialSource(d.decision),
        }));
      ctx.reportDecision?.({
        phase: "filter",
        totalTools: tools.length,
        allowedCount: filtered.length,
        filteredCount,
        filteredTools: filteredDetails,
      });
    } else {
      ctx.reportDecision?.({
        phase: "filter",
        totalTools: tools.length,
        allowedCount: tools.length,
        filteredCount: 0,
      });
    }
    if (filtered.length === tools.length) return request;
    return { ...request, tools: filtered };
  }

  return { filterTools };
}
